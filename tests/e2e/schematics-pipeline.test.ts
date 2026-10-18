/**
 * E2E tests for Phase 3 (schematic images) of the ingestion pipeline.
 *
 * Spawns `scripts/ingest-manuals.ts` as a real child process against a local HTTP server that
 * stands in for the Cloudflare Workers AI, Vectorize, D1 and R2 REST APIs. The fixture PDF
 * (`tests/fixtures/schematic-manual.pdf`) contains a numbered heading, body text and one embedded
 * 120x120 image, so this exercises real image extraction, PNG encoding, the R2 upload and the
 * D1 statements that link images to chunks.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(__dirname, "../..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/ingest-manuals.ts");
const FIXTURE_PDF = "tests/fixtures/schematic-manual.pdf";

const DOCUMENT_ID = "schematic_manual_pdf";
const EXPECTED_R2_KEY = `schematics/${DOCUMENT_ID}/p1-0.png`;
const EXPECTED_IMAGE_ID = `${DOCUMENT_ID}_p1_img0`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface D1Statement {
  sql: string;
  params: unknown[];
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startMockCloudflareServer(): Promise<{ server: Server; baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      res.setHeader("Content-Type", "application/json");

      if (req.url?.includes("/ai/run/")) {
        const parsed = JSON.parse(body.toString("utf-8")) as { text: string[] };
        res.end(JSON.stringify({ result: { data: parsed.text.map(() => Array.from({ length: 768 }, () => 0.01)) } }));
        return;
      }

      res.end(JSON.stringify({ success: true }));
    })();
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return { server, baseUrl: `http://127.0.0.1:${port}/client/v4/accounts`, requests };
}

function runIngestScript(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execFileAsync(TSX_BIN, [SCRIPT_PATH, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env } })
    .then(({ stdout, stderr }) => ({ stdout, stderr, exitCode: 0 }))
    .catch((err: { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? 1,
    }));
}

function d1Statements(requests: RecordedRequest[]): D1Statement[] {
  return requests
    .filter((r) => r.url?.includes("/d1/database/"))
    .flatMap((r) => (JSON.parse(r.body.toString("utf-8")) as { batch: D1Statement[] }).batch);
}

describe("ingest-manuals schematic images E2E pipeline", () => {
  let mock: Awaited<ReturnType<typeof startMockCloudflareServer>>;

  const baseEnv = () => ({
    CF_API_BASE_URL: mock.baseUrl,
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_API_TOKEN: "test-token",
    R2_BUCKET_NAME: "test-bucket",
  });

  beforeEach(async () => {
    mock = await startMockCloudflareServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      mock.server.close((err) => (err ? reject(err) : resolvePromise()));
    });
  });

  it("extracts the embedded image, uploads it to R2 as a PNG, and links it in D1", async () => {
    const { stdout, exitCode } = await runIngestScript(["--added-modified", FIXTURE_PDF], {
      ...baseEnv(),
      D1_DATABASE_ID: "test-db",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found 1 schematic images");

    // R2 upload: PUT of a valid PNG to the deterministic key.
    const uploads = mock.requests.filter((r) => r.method === "PUT" && r.url?.includes("/r2/buckets/"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe(`/client/v4/accounts/test-account/r2/buckets/test-bucket/objects/${EXPECTED_R2_KEY}`);
    expect(uploads[0].headers["authorization"]).toBe("Bearer test-token");
    expect(uploads[0].headers["content-type"]).toBe("image/png");
    expect(uploads[0].body.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    // IHDR width/height (bytes 16..24) must match the 120x120 source image.
    expect(uploads[0].body.readUInt32BE(16)).toBe(120);
    expect(uploads[0].body.readUInt32BE(20)).toBe(120);

    // The image must be uploaded before the D1 rows that reference it are written.
    const uploadIndex = mock.requests.indexOf(uploads[0]);
    const firstD1Index = mock.requests.findIndex((r) => r.url?.includes("/d1/database/"));
    expect(firstD1Index).toBeGreaterThan(uploadIndex);

    const statements = d1Statements(mock.requests);
    const sqlStartsWith = (prefix: string) => statements.findIndex((s) => s.sql.startsWith(prefix));

    // Re-ingest safety: chunks are deleted before images (chunks reference images), images before inserts.
    const deleteChunks = sqlStartsWith("DELETE FROM document_chunks");
    const deleteImages = sqlStartsWith("DELETE FROM schematic_images");
    const insertImage = sqlStartsWith("INSERT INTO schematic_images");
    const insertChunk = sqlStartsWith("INSERT INTO document_chunks");
    expect(deleteChunks).toBeGreaterThanOrEqual(0);
    expect(deleteImages).toBeGreaterThan(deleteChunks);
    expect(insertImage).toBeGreaterThan(deleteImages);
    expect(insertChunk).toBeGreaterThan(insertImage);

    expect(statements[insertImage].params).toEqual([
      EXPECTED_IMAGE_ID,
      DOCUMENT_ID,
      1,
      "Schematic Manual - page 1: 4.2 BATTERY WIRING",
      EXPECTED_R2_KEY,
      "image/png",
      120,
      120,
    ]);

    // Chunk rows carry the derived section title and link to the page's image.
    const chunkParams = statements[insertChunk].params;
    expect(chunkParams[3]).toBe("4.2 BATTERY WIRING");
    expect(chunkParams[8]).toBe(EXPECTED_IMAGE_ID);
  });

  it("adds the derived section title to the Vectorize metadata", async () => {
    const { exitCode } = await runIngestScript(["--added-modified", FIXTURE_PDF], {
      ...baseEnv(),
      D1_DATABASE_ID: "test-db",
    });
    expect(exitCode).toBe(0);

    const upsert = mock.requests.find((r) => r.url?.includes("/upsert"));
    expect(upsert).toBeDefined();
    const firstVector = JSON.parse(upsert!.body.toString("utf-8").trim().split("\n")[0]) as {
      id: string;
      metadata: Record<string, unknown>;
    };
    expect(firstVector.metadata["section"]).toBe("4.2 BATTERY WIRING");
  });

  it("skips image extraction, R2 uploads and D1 writes when D1_DATABASE_ID is not set", async () => {
    const { exitCode, stdout } = await runIngestScript(["--added-modified", FIXTURE_PDF], baseEnv());

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("schematic images");
    expect(mock.requests.some((r) => r.url?.includes("/r2/buckets/"))).toBe(false);
    expect(mock.requests.some((r) => r.url?.includes("/d1/database/"))).toBe(false);
    // Vectorize ingestion still runs.
    expect(mock.requests.some((r) => r.url?.includes("/upsert"))).toBe(true);
  });

  it("fails the run when the R2 upload fails, without writing D1 rows that point at missing images", async () => {
    await mock.server.close();
    const requests: RecordedRequest[] = [];
    mock.server = createServer((req, res) => {
      void (async () => {
        const body = await readBody(req);
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url?.includes("/r2/buckets/")) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (req.url?.includes("/ai/run/")) {
          const parsed = JSON.parse(body.toString("utf-8")) as { text: string[] };
          res.end(JSON.stringify({ result: { data: parsed.text.map(() => Array.from({ length: 768 }, () => 0.01)) } }));
          return;
        }
        res.end(JSON.stringify({ success: true }));
      })();
    });
    await new Promise<void>((resolvePromise) => mock.server.listen(0, "127.0.0.1", resolvePromise));
    const address = mock.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const { exitCode, stderr } = await runIngestScript(["--added-modified", FIXTURE_PDF], {
      ...baseEnv(),
      CF_API_BASE_URL: `http://127.0.0.1:${port}/client/v4/accounts`,
      D1_DATABASE_ID: "test-db",
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("R2 upload failed");
    expect(requests.some((r) => r.url?.includes("/d1/database/"))).toBe(false);
  });

  it("removes schematic_images rows when a manual is deleted", async () => {
    const { exitCode } = await runIngestScript(["--deleted", FIXTURE_PDF], {
      ...baseEnv(),
      D1_DATABASE_ID: "test-db",
    });
    expect(exitCode).toBe(0);

    const sql = d1Statements(mock.requests).map((s) => s.sql);
    expect(sql).toContain("DELETE FROM schematic_images WHERE document_id = ?");
    expect(sql.indexOf("DELETE FROM document_chunks WHERE document_id = ?")).toBeLessThan(
      sql.indexOf("DELETE FROM schematic_images WHERE document_id = ?")
    );
  });
});
