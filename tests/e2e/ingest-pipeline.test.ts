/**
 * Integration / E2E tests for the PDF manual ingestion pipeline.
 *
 * These tests spawn `scripts/ingest-manuals.ts` as a real child process
 * (via the `tsx` CLI, exactly as the GitHub Actions workflow does) against a
 * local HTTP server that stands in for the Cloudflare Workers AI and
 * Vectorize REST APIs. This exercises the full pipeline end-to-end: CLI
 * argument parsing, real PDF parsing/chunking of the fixture manual, and the
 * exact HTTP requests sent to Cloudflare.
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
const FIXTURE_PDF = "tests/fixtures/sample-manual.pdf";

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  body: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function startMockCloudflareServer(): Promise<{ server: Server; baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({ method: req.method, url: req.url, body });

      res.setHeader("Content-Type", "application/json");

      if (req.url?.includes("/ai/run/")) {
        const parsed = JSON.parse(body) as { text: string[] };
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

function runIngestScript(
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

describe("ingest-manuals E2E pipeline", () => {
  let mock: Awaited<ReturnType<typeof startMockCloudflareServer>>;

  beforeEach(async () => {
    mock = await startMockCloudflareServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      mock.server.close((err) => (err ? reject(err) : resolvePromise()));
    });
  });

  it("parses, chunks, embeds, and upserts a PDF manual (add/modify scenario)", async () => {
    const { stdout, exitCode } = await runIngestScript(["--added-modified", FIXTURE_PDF], {
      CF_API_BASE_URL: mock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ingested");

    const embeddingRequests = mock.requests.filter((r) => r.url?.includes("/ai/run/"));
    const upsertRequests = mock.requests.filter((r) => r.url?.includes("/upsert"));

    expect(embeddingRequests.length).toBeGreaterThan(0);
    expect(upsertRequests.length).toBeGreaterThan(0);

    const embeddingBody = JSON.parse(embeddingRequests[0].body) as { text: string[] };
    expect(embeddingBody.text[0]).toContain("heater");

    const upsertLines = upsertRequests[0].body.trim().split("\n");
    const firstVector = JSON.parse(upsertLines[0]) as { id: string; values: number[]; metadata: Record<string, unknown> };
    expect(firstVector.id).toBe("sample_manual_pdf#chunk_0");
    expect(firstVector.values).toHaveLength(768);
    expect(firstVector.metadata["filename"]).toBe("sample-manual.pdf");
  });

  it("sends deletion requests for the deterministic chunk ID prefix (deletion scenario)", async () => {
    const { exitCode } = await runIngestScript(["--deleted", "docs/manuals/old-manual.pdf"], {
      CF_API_BASE_URL: mock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).toBe(0);

    const deleteRequests = mock.requests.filter((r) => r.url?.includes("/delete_by_ids"));
    expect(deleteRequests.length).toBeGreaterThan(0);

    const deleteBody = JSON.parse(deleteRequests[0].body) as { ids: string[] };
    expect(deleteBody.ids[0]).toBe("old_manual_pdf#chunk_0");
    expect(deleteBody.ids.every((id) => id.startsWith("old_manual_pdf#chunk_"))).toBe(true);
  });

  it("exits gracefully with no network calls when there are no changes (no-op scenario)", async () => {
    const { exitCode } = await runIngestScript([], {
      CF_API_BASE_URL: mock.baseUrl,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).toBe(0);
    expect(mock.requests).toHaveLength(0);
  });

  it("exits with a non-zero status code when the Cloudflare API returns an error", async () => {
    await mock.server.close();
    mock.server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
    await new Promise<void>((resolvePromise) => mock.server.listen(0, "127.0.0.1", resolvePromise));
    const address = mock.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const { exitCode, stderr } = await runIngestScript(["--added-modified", FIXTURE_PDF], {
      CF_API_BASE_URL: `http://127.0.0.1:${port}/client/v4/accounts`,
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Fatal error");
  });
});
