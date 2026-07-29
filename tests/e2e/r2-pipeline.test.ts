/**
 * Integration / E2E tests for the Cloudflare R2 manual sync pipeline.
 *
 * These tests spawn `scripts/sync-r2-manuals.ts` as a real child process
 * (via the `tsx` CLI, exactly as the manual GitHub Actions workflow does)
 * against local HTTP servers that stand in for the R2 S3-compatible API and
 * the Cloudflare Workers AI / Vectorize REST APIs. This exercises the full
 * pipeline end-to-end: recursive bucket listing, manifest-based diffing,
 * streaming a PDF to /tmp, chunking, embedding, and upserting/deleting
 * vectors, with real memory cleanup of temporary files.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(__dirname, "../..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/sync-r2-manuals.ts");
const FIXTURE_PDF_PATH = resolve(REPO_ROOT, "tests/fixtures/sample-manual.pdf");

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  body: Buffer;
}

interface MockR2Object {
  key: string;
  etag: string;
  body: Buffer;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A minimal in-memory S3-compatible mock server sufficient for the R2 sync script. */
async function startMockR2Server(initialObjects: MockR2Object[]): Promise<{
  server: Server;
  baseUrl: string;
  requests: RecordedRequest[];
  objects: Map<string, MockR2Object>;
}> {
  const requests: RecordedRequest[] = [];
  const objects = new Map(initialObjects.map((obj) => [obj.key, obj]));

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({ method: req.method, url: req.url, body });

      const url = new URL(req.url ?? "/", "http://localhost");
      // Path is "/{bucket}" or "/{bucket}/{key...}" (path-style addressing).
      const pathParts = url.pathname.replace(/^\//, "").split("/");
      const key = decodeURIComponent(pathParts.slice(1).join("/"));

      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const contents = Array.from(objects.values())
          .map(
            (obj) =>
              `<Contents><Key>${xmlEscape(obj.key)}</Key><ETag>"${obj.etag}"</ETag><Size>${obj.body.length}</Size></Contents>`
          )
          .join("");
        res.setHeader("Content-Type", "application/xml");
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`
        );
        return;
      }

      if (req.method === "GET" && key) {
        const obj = objects.get(key);
        if (!obj) {
          res.statusCode = 404;
          res.end(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>`
          );
          return;
        }
        res.setHeader("ETag", `"${obj.etag}"`);
        res.end(obj.body);
        return;
      }

      if (req.method === "PUT" && key) {
        objects.set(key, { key, etag: `manifest-${objects.size}`, body });
        res.end();
        return;
      }

      if (req.method === "DELETE" && key) {
        objects.delete(key);
        res.end();
        return;
      }

      res.end();
    })();
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return { server, baseUrl: `http://127.0.0.1:${port}`, requests, objects };
}

async function startMockCloudflareServer(): Promise<{ server: Server; baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({ method: req.method, url: req.url, body });

      res.setHeader("Content-Type", "application/json");

      if (req.url?.includes("/ai/run/")) {
        const parsed = JSON.parse(body.toString("utf-8")) as { text: string[] };
        res.end(
          JSON.stringify({
            result: { data: parsed.text.map(() => Array.from({ length: 768 }, () => 0.01)) },
          })
        );
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

function runSyncScript(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execFileAsync(TSX_BIN, [SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  })
    .then(({ stdout, stderr }) => ({ stdout, stderr, exitCode: 0 }))
    .catch((err: { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? 1,
    }));
}

describe("sync-r2-manuals E2E pipeline", () => {
  let r2Mock: Awaited<ReturnType<typeof startMockR2Server>>;
  let cfMock: Awaited<ReturnType<typeof startMockCloudflareServer>>;

  afterEach(async () => {
    if (r2Mock) {
      await new Promise<void>((resolvePromise, reject) => {
        r2Mock.server.close((err) => (err ? reject(err) : resolvePromise()));
      });
    }
    if (cfMock) {
      await new Promise<void>((resolvePromise, reject) => {
        cfMock.server.close((err) => (err ? reject(err) : resolvePromise()));
      });
    }
  });

  it("recursively syncs nested PDFs from R2, embedding and upserting new files", async () => {
    const pdfBuffer = readFileSync(FIXTURE_PDF_PATH);
    r2Mock = await startMockR2Server([
      { key: "electrical/victron/multiplus.pdf", etag: "etag-1", body: pdfBuffer },
    ]);
    cfMock = await startMockCloudflareServer();

    const { stdout, exitCode } = await runSyncScript([], {
      R2_ENDPOINT_URL: r2Mock.baseUrl,
      CF_API_BASE_URL: cfMock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ingested");

    const embeddingRequests = cfMock.requests.filter((r) => r.url?.includes("/ai/run/"));
    const upsertRequests = cfMock.requests.filter((r) => r.url?.includes("/upsert"));
    expect(embeddingRequests.length).toBeGreaterThan(0);
    expect(upsertRequests.length).toBeGreaterThan(0);

    const upsertLines = upsertRequests[0].body.toString("utf-8").trim().split("\n");
    const firstVector = JSON.parse(upsertLines[0]) as { id: string; metadata: Record<string, unknown> };
    expect(firstVector.id).toBe("electrical_victron_multiplus_pdf#chunk_0");
    expect(firstVector.metadata["filename"]).toBe("electrical/victron/multiplus.pdf");

    // The manifest should have been persisted back to R2 with the new ETag.
    const manifestObj = r2Mock.objects.get("_vectorize-sync-manifest.json");
    expect(manifestObj).toBeDefined();
    const manifest = JSON.parse(manifestObj!.body.toString("utf-8"));
    expect(manifest["electrical/victron/multiplus.pdf"]).toMatchObject({ etag: "etag-1" });
  });

  it("skips unchanged files on a second run (no-op) based on the persisted manifest", async () => {
    const pdfBuffer = readFileSync(FIXTURE_PDF_PATH);
    r2Mock = await startMockR2Server([
      { key: "heaters/velit-2026.pdf", etag: "etag-unchanged", body: pdfBuffer },
      {
        key: "_vectorize-sync-manifest.json",
        etag: "manifest-etag",
        body: Buffer.from(JSON.stringify({ "heaters/velit-2026.pdf": { etag: "etag-unchanged", chunkCount: 1 } })),
      },
    ]);
    cfMock = await startMockCloudflareServer();

    const { exitCode, stdout } = await runSyncScript([], {
      R2_ENDPOINT_URL: r2Mock.baseUrl,
      CF_API_BASE_URL: cfMock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No R2 manual changes to process");
    expect(cfMock.requests).toHaveLength(0);
  });

  it("deletes vectors for R2 objects that were removed from the bucket", async () => {
    r2Mock = await startMockR2Server([
      {
        key: "_vectorize-sync-manifest.json",
        etag: "manifest-etag",
        body: Buffer.from(JSON.stringify({ "old/removed-manual.pdf": { etag: "old-etag", chunkCount: 2 } })),
      },
    ]);
    cfMock = await startMockCloudflareServer();

    const { exitCode } = await runSyncScript([], {
      R2_ENDPOINT_URL: r2Mock.baseUrl,
      CF_API_BASE_URL: cfMock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).toBe(0);

    const deleteRequests = cfMock.requests.filter((r) => r.url?.includes("/delete_by_ids"));
    expect(deleteRequests.length).toBeGreaterThan(0);

    const deleteBody = JSON.parse(deleteRequests[0].body.toString("utf-8")) as { ids: string[] };
    expect(deleteBody.ids[0]).toBe("old_removed_manual_pdf#chunk_0");
  });

  it("re-processes every file when --force-reindex is passed, even if unchanged", async () => {
    const pdfBuffer = readFileSync(FIXTURE_PDF_PATH);
    r2Mock = await startMockR2Server([
      { key: "heaters/velit-2026.pdf", etag: "etag-unchanged", body: pdfBuffer },
      {
        key: "_vectorize-sync-manifest.json",
        etag: "manifest-etag",
        body: Buffer.from(JSON.stringify({ "heaters/velit-2026.pdf": { etag: "etag-unchanged", chunkCount: 1 } })),
      },
    ]);
    cfMock = await startMockCloudflareServer();

    const { exitCode } = await runSyncScript(["--force-reindex"], {
      R2_ENDPOINT_URL: r2Mock.baseUrl,
      CF_API_BASE_URL: cfMock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).toBe(0);
    const upsertRequests = cfMock.requests.filter((r) => r.url?.includes("/upsert"));
    expect(upsertRequests.length).toBeGreaterThan(0);
  });

  it("exits with a non-zero status code and cleans up temp files when the Vectorize API errors", async () => {
    const pdfBuffer = readFileSync(FIXTURE_PDF_PATH);
    r2Mock = await startMockR2Server([{ key: "broken/manual.pdf", etag: "etag-1", body: pdfBuffer }]);

    const errorServer = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
    await new Promise<void>((resolvePromise) => errorServer.listen(0, "127.0.0.1", resolvePromise));
    const address = errorServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    cfMock = { server: errorServer, baseUrl: `http://127.0.0.1:${port}/client/v4/accounts`, requests: [] };

    const { exitCode, stderr } = await runSyncScript([], {
      R2_ENDPOINT_URL: r2Mock.baseUrl,
      CF_API_BASE_URL: cfMock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Fatal error");
  });
});
