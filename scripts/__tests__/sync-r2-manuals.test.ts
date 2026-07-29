import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  };
});

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => Buffer.from("mock-pdf-bytes")),
  mkdtempSync: vi.fn(() => "/tmp/r2-manual-mock"),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async () => ({})),
  extractText: vi.fn(async () => ({
    text: "Sample Manual Page 1. The heater operates on 12V DC power and requires proper ventilation.",
    totalPages: 1,
  })),
}));

import { NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  buildR2DeleteCandidateIds,
  buildR2ManualChunks,
  computeSyncDelta,
  createR2Client,
  deriveManualTitleFromKey,
  downloadR2ObjectToTemp,
  fetchManifest,
  filterPdfObjects,
  getR2Endpoint,
  listAllR2Objects,
  MANIFEST_KEY,
  parseSyncArgs,
  processAddedModifiedR2Object,
  processDeletedR2Object,
  R2_BUCKET_NAME,
  runSync,
  sanitizeR2Key,
  writeManifest,
} from "../sync-r2-manuals";

// ---------------------------------------------------------------------------
// Vector ID / naming helpers
// ---------------------------------------------------------------------------

describe("sanitizeR2Key", () => {
  it("translates a top-level PDF key into an ID-safe token", () => {
    expect(sanitizeR2Key("velit-heater-manual.pdf")).toBe("velit_heater_manual_pdf");
  });

  it("translates nested subfolder keys into deterministic vector IDs", () => {
    expect(sanitizeR2Key("electrical/victron/multiplus.pdf")).toBe("electrical_victron_multiplus_pdf");
    expect(sanitizeR2Key("heaters/velit-2026.pdf")).toBe("heaters_velit_2026_pdf");
  });
});

describe("deriveManualTitleFromKey", () => {
  it("derives a human-readable title using only the final path segment", () => {
    expect(deriveManualTitleFromKey("electrical/victron/multiplus.pdf")).toBe("Multiplus");
    expect(deriveManualTitleFromKey("heaters/velit-2026.pdf")).toBe("Velit 2026");
  });
});

describe("buildR2ManualChunks", () => {
  it("builds chunks with deterministic nested-path IDs and metadata", () => {
    const text = "The heater operates on 12V DC power and requires proper ventilation for safe operation.";
    const chunks = buildR2ManualChunks("electrical/victron/multiplus.pdf", text);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].id).toBe("electrical_victron_multiplus_pdf#chunk_0");
    expect(chunks[0].metadata).toMatchObject({
      filename: "electrical/victron/multiplus.pdf",
      manual_title: "Multiplus",
      title: "Multiplus",
      doc_type: "manual",
      category: "technical",
      chunk_index: 0,
      total_chunks: chunks.length,
    });
  });

  it("classifies travel/ paths as road_trip_guide/travel metadata", () => {
    const chunks = buildR2ManualChunks("travel/vancouver_island.pdf", "Remote routes and camping spots.");
    expect(chunks[0].metadata).toMatchObject({ doc_type: "road_trip_guide", category: "travel" });
  });

  it("classifies specs/ and hardware/ paths as product_spec/hardware metadata", () => {
    const chunks = buildR2ManualChunks("specs/inverter.pdf", "Inverter specifications.");
    expect(chunks[0].metadata).toMatchObject({ doc_type: "product_spec", category: "hardware" });
  });
});

describe("buildR2DeleteCandidateIds", () => {
  it("generates deterministic candidate IDs for nested keys", () => {
    const ids = buildR2DeleteCandidateIds("electrical/victron/multiplus.pdf", 3);
    expect(ids).toEqual([
      "electrical_victron_multiplus_pdf#chunk_0",
      "electrical_victron_multiplus_pdf#chunk_1",
      "electrical_victron_multiplus_pdf#chunk_2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// R2 client / config
// ---------------------------------------------------------------------------

describe("R2_BUCKET_NAME", () => {
  it("defaults to the campervan-mcp bucket", () => {
    expect(R2_BUCKET_NAME).toBe("campervan-mcp");
  });
});

describe("getR2Endpoint", () => {
  const originalEnv = process.env["R2_ENDPOINT_URL"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["R2_ENDPOINT_URL"];
    } else {
      process.env["R2_ENDPOINT_URL"] = originalEnv;
    }
  });

  it("defaults to the Cloudflare R2 S3-compatible endpoint for the account", () => {
    delete process.env["R2_ENDPOINT_URL"];
    expect(getR2Endpoint("acct123")).toBe("https://acct123.r2.cloudflarestorage.com");
  });

  it("honors R2_ENDPOINT_URL override for local/E2E testing", () => {
    process.env["R2_ENDPOINT_URL"] = "http://127.0.0.1:9999";
    expect(getR2Endpoint("acct123")).toBe("http://127.0.0.1:9999");
  });
});

describe("createR2Client", () => {
  it("constructs an S3Client with account ID and API token as credentials", () => {
    createR2Client("acct123", "token123");
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "auto",
        credentials: { accessKeyId: "acct123", secretAccessKey: "token123" },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Listing / filtering
// ---------------------------------------------------------------------------

describe("listAllR2Objects", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("paginates through ContinuationToken until IsTruncated is false", async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: "a.pdf", ETag: '"etag-a"' }],
        IsTruncated: true,
        NextContinuationToken: "token-1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "b.pdf", ETag: '"etag-b"' }],
        IsTruncated: false,
      });

    const client = new S3Client({});
    const objects = await listAllR2Objects(client, "campervan-mcp");

    expect(objects).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array when the bucket has no objects", async () => {
    sendMock.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });
    const client = new S3Client({});
    const objects = await listAllR2Objects(client, "campervan-mcp");
    expect(objects).toEqual([]);
  });
});

describe("filterPdfObjects", () => {
  it("keeps only .pdf keys, including nested subfolders", () => {
    const filtered = filterPdfObjects([
      { Key: "heaters/velit-2026.pdf", ETag: '"e1"' },
      { Key: "electrical/victron/multiplus.pdf", ETag: '"e2"' },
      { Key: "readme.txt", ETag: '"e3"' },
      { Key: MANIFEST_KEY, ETag: '"e4"' },
    ]);

    expect(filtered).toEqual([
      { key: "heaters/velit-2026.pdf", etag: "e1" },
      { key: "electrical/victron/multiplus.pdf", etag: "e2" },
    ]);
  });

  it("strips quotes from ETags", () => {
    const filtered = filterPdfObjects([{ Key: "a.pdf", ETag: '"abc123"' }]);
    expect(filtered[0].etag).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("fetchManifest", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("parses the manifest JSON from R2 when it exists", async () => {
    sendMock.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify({ "a.pdf": { etag: "e1", chunkCount: 3 } }) },
    });

    const client = new S3Client({});
    const manifest = await fetchManifest(client, "campervan-mcp");
    expect(manifest).toEqual({ "a.pdf": { etag: "e1", chunkCount: 3 } });
  });

  it("returns an empty manifest when the object does not exist (NoSuchKey)", async () => {
    sendMock.mockRejectedValueOnce(new NoSuchKey({ message: "not found", $metadata: {} }));

    const client = new S3Client({});
    const manifest = await fetchManifest(client, "campervan-mcp");
    expect(manifest).toEqual({});
  });

  it("re-throws unexpected errors", async () => {
    sendMock.mockRejectedValueOnce(new Error("boom"));
    const client = new S3Client({});
    await expect(fetchManifest(client, "campervan-mcp")).rejects.toThrow("boom");
  });
});

describe("writeManifest", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it("uploads the manifest as JSON to the manifest key", async () => {
    const client = new S3Client({});
    await writeManifest(client, "campervan-mcp", { "a.pdf": { etag: "e1", chunkCount: 2 } });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command.input.Key).toBe(MANIFEST_KEY);
    expect(JSON.parse(command.input.Body)).toEqual({ "a.pdf": { etag: "e1", chunkCount: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

describe("computeSyncDelta", () => {
  it("flags new keys not present in the manifest as added", () => {
    const delta = computeSyncDelta([{ key: "a.pdf", etag: "e1" }], {});
    expect(delta.addedOrModified).toEqual([{ key: "a.pdf", etag: "e1" }]);
    expect(delta.deleted).toEqual([]);
  });

  it("flags keys whose ETag changed as modified", () => {
    const delta = computeSyncDelta([{ key: "a.pdf", etag: "e2" }], { "a.pdf": { etag: "e1", chunkCount: 1 } });
    expect(delta.addedOrModified).toEqual([{ key: "a.pdf", etag: "e2" }]);
  });

  it("does not flag unchanged keys", () => {
    const delta = computeSyncDelta([{ key: "a.pdf", etag: "e1" }], { "a.pdf": { etag: "e1", chunkCount: 1 } });
    expect(delta.addedOrModified).toEqual([]);
  });

  it("flags manifest entries missing from R2 as deleted", () => {
    const delta = computeSyncDelta([], { "old.pdf": { etag: "e1", chunkCount: 1 } });
    expect(delta.deleted).toEqual(["old.pdf"]);
  });

  it("flags every current object as added/modified when forceReindex is true", () => {
    const delta = computeSyncDelta([{ key: "a.pdf", etag: "e1" }], { "a.pdf": { etag: "e1", chunkCount: 1 } }, true);
    expect(delta.addedOrModified).toEqual([{ key: "a.pdf", etag: "e1" }]);
  });
});

// ---------------------------------------------------------------------------
// CLI / Env Argument Parsing
// ---------------------------------------------------------------------------

describe("parseSyncArgs", () => {
  it("recognizes --dry-run and --force-reindex flags", () => {
    const options = parseSyncArgs(["--dry-run", "--force-reindex"], {});
    expect(options.dryRun).toBe(true);
    expect(options.forceReindex).toBe(true);
  });

  it("recognizes FORCE_REINDEX=true environment variable", () => {
    const options = parseSyncArgs([], { FORCE_REINDEX: "true" });
    expect(options.forceReindex).toBe(true);
  });

  it("defaults to false for both flags", () => {
    const options = parseSyncArgs([], {});
    expect(options.dryRun).toBe(false);
    expect(options.forceReindex).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Downloading / processing
// ---------------------------------------------------------------------------

describe("downloadR2ObjectToTemp", () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.mocked(mkdtempSync).mockReturnValue("/tmp/r2-manual-mock");
  });

  it("streams the object body to a temp file and returns its path", async () => {
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });

    const client = new S3Client({});
    const path = await downloadR2ObjectToTemp(client, "campervan-mcp", "heaters/velit-2026.pdf");

    expect(path).toBe("/tmp/r2-manual-mock/manual.pdf");
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(path, new Uint8Array([1, 2, 3]));
  });

  it("throws when the R2 object has no body", async () => {
    sendMock.mockResolvedValueOnce({ Body: undefined });
    const client = new S3Client({});
    await expect(downloadR2ObjectToTemp(client, "campervan-mcp", "missing.pdf")).rejects.toThrow(
      /returned an empty body/
    );
  });
});

describe("processDeletedR2Object", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.mocked(S3Client).mockImplementation(() => ({ send: sendMock }) as unknown as S3Client);
  });

  it("skips network calls in dry-run mode", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await processDeletedR2Object("electrical/victron/multiplus.pdf", "acct123", "token123", true);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("issues delete requests for candidate IDs when not in dry-run mode", async () => {
    const mockFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    global.fetch = mockFetch as unknown as typeof fetch;

    await processDeletedR2Object("electrical/victron/multiplus.pdf", "acct123", "token123", false);

    expect(mockFetch).toHaveBeenCalled();
  });
});

describe("processAddedModifiedR2Object", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("mock-pdf-bytes"));
    vi.mocked(mkdtempSync).mockReturnValue("/tmp/r2-manual-mock");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.mocked(S3Client).mockImplementation(() => ({ send: sendMock }) as unknown as S3Client);
  });

  it("skips embedding/upsert network calls in dry-run mode but still returns chunk count", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new S3Client({});
    const chunkCount = await processAddedModifiedR2Object(
      client,
      "campervan-mcp",
      "heaters/velit-2026.pdf",
      "acct123",
      "token123",
      true
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(chunkCount).toBeGreaterThan(0);
  });

  it("downloads, parses, embeds, and upserts chunks when not in dry-run mode", async () => {
    const calledUrls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calledUrls.push(url.toString());
      if (url.toString().includes("/ai/run/")) {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ result: { data: body.text.map(() => Array(768).fill(0.1)) } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new S3Client({});
    const chunkCount = await processAddedModifiedR2Object(
      client,
      "campervan-mcp",
      "electrical/victron/multiplus.pdf",
      "acct123",
      "token123",
      false
    );

    expect(chunkCount).toBeGreaterThan(0);
    expect(calledUrls.some((url) => url.includes("/ai/run/"))).toBe(true);
    expect(calledUrls.some((url) => url.includes("/upsert"))).toBe(true);
    expect(vi.mocked(rmSync)).toHaveBeenCalled();
  });

  it("cleans up the temp file even when parsing throws", async () => {
    const { extractText } = await import("unpdf");
    vi.mocked(extractText).mockRejectedValueOnce(new Error("bad pdf"));

    const client = new S3Client({});
    await expect(
      processAddedModifiedR2Object(client, "campervan-mcp", "broken.pdf", "acct123", "token123", true)
    ).rejects.toThrow("bad pdf");

    expect(vi.mocked(rmSync)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// High-level orchestration
// ---------------------------------------------------------------------------

describe("runSync", () => {
  const originalFetch = global.fetch;
  const originalAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const originalApiToken = process.env["CLOUDFLARE_API_TOKEN"];

  beforeEach(() => {
    sendMock.mockReset();
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("mock-pdf-bytes"));
    vi.mocked(mkdtempSync).mockReturnValue("/tmp/r2-manual-mock");
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acct123";
    process.env["CLOUDFLARE_API_TOKEN"] = "token123";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env["CLOUDFLARE_ACCOUNT_ID"] = originalAccountId;
    process.env["CLOUDFLARE_API_TOKEN"] = originalApiToken;
    vi.mocked(S3Client).mockImplementation(() => ({ send: sendMock }) as unknown as S3Client);
  });

  it("throws when Cloudflare credentials are missing", async () => {
    delete process.env["CLOUDFLARE_ACCOUNT_ID"];
    delete process.env["CLOUDFLARE_API_TOKEN"];

    await expect(runSync({ dryRun: false, forceReindex: false })).rejects.toThrow(
      /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/
    );
  });

  it("exits gracefully without network calls when there are no changes", async () => {
    sendMock
      .mockResolvedValueOnce({ Contents: [{ Key: "a.pdf", ETag: '"e1"' }], IsTruncated: false }) // list
      .mockResolvedValueOnce({
        Body: { transformToString: async () => JSON.stringify({ "a.pdf": { etag: "e1", chunkCount: 1 } }) },
      }); // manifest fetch

    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await runSync({ dryRun: false, forceReindex: false });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("processes deletions and additions and writes the updated manifest", async () => {
    sendMock
      .mockResolvedValueOnce({ Contents: [{ Key: "heaters/velit-2026.pdf", ETag: '"e2"' }], IsTruncated: false }) // list
      .mockResolvedValueOnce({
        Body: {
          transformToString: async () =>
            JSON.stringify({
              "heaters/velit-2026.pdf": { etag: "e1", chunkCount: 1 },
              "old/removed.pdf": { etag: "e0", chunkCount: 1 },
            }),
        },
      }) // manifest fetch
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }) // download PDF
      .mockResolvedValueOnce({}); // manifest write

    const calledUrls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calledUrls.push(url.toString());
      if (url.toString().includes("/ai/run/")) {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ result: { data: body.text.map(() => Array(768).fill(0.1)) } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await runSync({ dryRun: false, forceReindex: false });

    expect(calledUrls.some((url) => url.includes("delete_by_ids"))).toBe(true);
    expect(calledUrls.some((url) => url.includes("/ai/run/"))).toBe(true);
    expect(calledUrls.some((url) => url.includes("/upsert"))).toBe(true);

    const manifestWriteCall = sendMock.mock.calls[sendMock.mock.calls.length - 1][0];
    const writtenManifest = JSON.parse(manifestWriteCall.input.Body);
    expect(writtenManifest["heaters/velit-2026.pdf"]).toMatchObject({ etag: "e2" });
    expect(writtenManifest["old/removed.pdf"]).toBeUndefined();
  });
});
