import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => Buffer.from("mock-pdf-bytes")),
}));

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async () => ({})),
  extractText: vi.fn(async () => ({
    text: "Sample Manual Page 1. The heater operates on 12V DC power and requires proper ventilation.",
    totalPages: 1,
  })),
}));

import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import {
  batchArray,
  buildDeleteCandidateIds,
  buildManualChunks,
  CHUNK_OVERLAP_CHARS,
  CHUNK_SIZE_CHARS,
  classifyDocPath,
  deleteVectorsByIds,
  deriveManualTitle,
  describeApiFailure,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_MODEL,
  generateChunkId,
  generateEmbeddings,
  MAX_DELETE_CANDIDATE_CHUNKS,
  parseArgs,
  PDF_PARSE_VERBOSITY,
  processAddedModifiedFile,
  processDeletedFile,
  recursiveSplitText,
  runIngestion,
  sanitizeFilename,
  upsertVectors,
  VECTORIZE_INDEX_NAME,
} from "../ingest-manuals";

// ---------------------------------------------------------------------------
// Filenames / IDs / Titles
// ---------------------------------------------------------------------------

describe("sanitizeFilename", () => {
  it("replaces non-alphanumeric characters with underscores", () => {
    expect(sanitizeFilename("velit-heater-manual.pdf")).toBe("velit_heater_manual_pdf");
  });

  it("handles nested directory paths by using only the basename", () => {
    expect(sanitizeFilename("docs/manuals/velit-heater-manual.pdf")).toBe("velit_heater_manual_pdf");
  });

  it("collapses consecutive special characters and trims edges", () => {
    expect(sanitizeFilename("__weird__file name!!.pdf")).toBe("weird_file_name_pdf");
  });
});

describe("generateChunkId", () => {
  it("formats deterministic chunk IDs", () => {
    expect(generateChunkId("velit_heater_manual_pdf", 42)).toBe("velit_heater_manual_pdf#chunk_42");
    expect(generateChunkId("velit_heater_manual_pdf", 0)).toBe("velit_heater_manual_pdf#chunk_0");
  });

  it("truncates long sanitized filenames so the ID stays under Vectorize's 64-byte limit", () => {
    const sanitizedName = sanitizeFilename(
      "MY24_Transit _BEMM_V363N_20APR24_J2_V2_R2_(downloaded_30JUL24).pdf"
    );
    const id = generateChunkId(sanitizedName, 0);

    expect(Buffer.byteLength(id, "utf8")).toBeLessThanOrEqual(64);
    expect(id).toBe("MY24_Transit_BEMM_V363N_20APR24_J2_V2_R2#chunk_0");
  });

  it("does not leave a trailing underscore when truncating on a separator boundary", () => {
    const id = generateChunkId("a".repeat(40) + "_", 5);
    expect(id).toBe(`${"a".repeat(40)}#chunk_5`);
  });
});

describe("deriveManualTitle", () => {
  it("derives a human-readable title from a filename", () => {
    expect(deriveManualTitle("velit-heater-manual.pdf")).toBe("Velit Heater Manual");
  });

  it("handles underscores and mixed casing", () => {
    expect(deriveManualTitle("docs/manuals/ford_transit_body_builder.pdf")).toBe("Ford Transit Body Builder");
  });
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe("recursiveSplitText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = recursiveSplitText("short text", CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS);
    expect(chunks).toEqual(["short text"]);
  });

  it("splits long text into chunks no larger than chunkSize", () => {
    const longText = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} of the manual.`).join(" ");
    const chunks = recursiveSplitText(longText, 100, 20);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("applies overlap between consecutive chunks", () => {
    const blockA = "A".repeat(40);
    const blockB = "B".repeat(40);
    const chunks = recursiveSplitText(`${blockA}\n\n${blockB}`, 50, 10);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(blockA);
    // The second chunk should be prefixed with the trailing 10 characters of the first chunk.
    expect(chunks[1]).toBe("A".repeat(10) + blockB);
  });

  it("returns an empty array for empty input", () => {
    expect(recursiveSplitText("", 500, 50)).toEqual([]);
    expect(recursiveSplitText("   ", 500, 50)).toEqual([]);
  });

  it("splits on paragraph and word boundaries before falling back to characters", () => {
    const text = "a".repeat(600);
    const chunks = recursiveSplitText(text, 500, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].length).toBeLessThanOrEqual(500);
  });
});

describe("buildManualChunks", () => {
  it("builds chunks with deterministic IDs and full metadata", () => {
    const text = "The heater operates on 12V DC power and requires proper ventilation for safe operation.";
    const chunks = buildManualChunks("velit-heater-manual.pdf", text);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].id).toBe("velit_heater_manual_pdf#chunk_0");
    expect(chunks[0].metadata).toMatchObject({
      filename: "velit-heater-manual.pdf",
      manual_title: "Velit Heater Manual",
      title: "Velit Heater Manual",
      doc_type: "manual",
      category: "technical",
      chunk_index: 0,
      total_chunks: chunks.length,
    });
    expect(chunks[0].metadata.text).toBe(chunks[0].text);
  });

  it("assigns sequential chunk_index and consistent total_chunks", () => {
    const longText = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} of the manual document.`).join(" ");
    const chunks = buildManualChunks("docs/manuals/big-manual.pdf", longText);

    chunks.forEach((chunk, index) => {
      expect(chunk.metadata.chunk_index).toBe(index);
      expect(chunk.metadata.total_chunks).toBe(chunks.length);
    });
  });

  it("classifies travel/guides paths as road_trip_guide/travel metadata", () => {
    const chunks = buildManualChunks("travel/vancouver-island.pdf", "Remote routes and camping spots.");
    expect(chunks[0].metadata).toMatchObject({ doc_type: "road_trip_guide", category: "travel" });

    const guideChunks = buildManualChunks("guides/boondocking.pdf", "Boondocking tips.");
    expect(guideChunks[0].metadata).toMatchObject({ doc_type: "road_trip_guide", category: "travel" });
  });

  it("classifies specs/hardware paths as product_spec/hardware metadata", () => {
    const chunks = buildManualChunks("specs/victron-multiplus.pdf", "Product specifications.");
    expect(chunks[0].metadata).toMatchObject({ doc_type: "product_spec", category: "hardware" });

    const hardwareChunks = buildManualChunks("hardware/pump.pdf", "Pump specs.");
    expect(hardwareChunks[0].metadata).toMatchObject({ doc_type: "product_spec", category: "hardware" });
  });

  it("defaults unmapped/manuals paths to manual/technical metadata", () => {
    const chunks = buildManualChunks("docs/manuals/velit-heater.pdf", "Heater manual text.");
    expect(chunks[0].metadata).toMatchObject({ doc_type: "manual", category: "technical" });
  });
});

describe("classifyDocPath", () => {
  it("maps travel/ and guides/ prefixes to road_trip_guide/travel", () => {
    expect(classifyDocPath("travel/vancouver_island.pdf")).toEqual({
      docType: "road_trip_guide",
      category: "travel",
    });
    expect(classifyDocPath("guides/boondocking.pdf")).toEqual({
      docType: "road_trip_guide",
      category: "travel",
    });
  });

  it("maps specs/ and hardware/ prefixes to product_spec/hardware", () => {
    expect(classifyDocPath("specs/victron_multiplus.pdf")).toEqual({
      docType: "product_spec",
      category: "hardware",
    });
    expect(classifyDocPath("hardware/pump.pdf")).toEqual({
      docType: "product_spec",
      category: "hardware",
    });
  });

  it("maps manuals/ and unmapped prefixes to manual/technical", () => {
    expect(classifyDocPath("manuals/velit-heater.pdf")).toEqual({
      docType: "manual",
      category: "technical",
    });
    expect(classifyDocPath("electrical/victron/multiplus.pdf")).toEqual({
      docType: "manual",
      category: "technical",
    });
  });

  it("is case-insensitive when matching folder prefixes", () => {
    expect(classifyDocPath("Travel/Vancouver.pdf")).toEqual({
      docType: "road_trip_guide",
      category: "travel",
    });
  });
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe("batchArray", () => {
  it("batches items in groups of the given size", () => {
    const items = Array.from({ length: 60 }, (_, i) => i);
    const batches = batchArray(items, 25);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(25);
    expect(batches[1]).toHaveLength(25);
    expect(batches[2]).toHaveLength(10);
  });

  it("respects the embedding batch size constant (25-50 range)", () => {
    expect(EMBEDDING_BATCH_SIZE).toBeGreaterThanOrEqual(25);
    expect(EMBEDDING_BATCH_SIZE).toBeLessThanOrEqual(50);
  });

  it("returns an empty array when given no items", () => {
    expect(batchArray([], 25)).toEqual([]);
  });
});

describe("describeApiFailure", () => {
  it("appends a credentials troubleshooting hint for 401 responses", () => {
    expect(describeApiFailure(401, "Unauthorized")).toBe(
      "401 Unauthorized (verify CLOUDFLARE_ACCOUNT_ID and that CLOUDFLARE_API_TOKEN has Workers AI + Vectorize edit permissions and has not expired)"
    );
  });

  it("appends a credentials troubleshooting hint for 403 responses", () => {
    expect(describeApiFailure(403, "Forbidden")).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("does not append a hint for other status codes", () => {
    expect(describeApiFailure(500, "Internal Server Error")).toBe("500 Internal Server Error");
    expect(describeApiFailure(400, "Bad Request")).toBe("400 Bad Request");
  });
});

describe("buildDeleteCandidateIds", () => {
  it("generates the deterministic ID prefix for every candidate chunk index", () => {
    const ids = buildDeleteCandidateIds("docs/manuals/old-manual.pdf", 5);
    expect(ids).toEqual([
      "old_manual_pdf#chunk_0",
      "old_manual_pdf#chunk_1",
      "old_manual_pdf#chunk_2",
      "old_manual_pdf#chunk_3",
      "old_manual_pdf#chunk_4",
    ]);
  });

  it("defaults to MAX_DELETE_CANDIDATE_CHUNKS candidates", () => {
    const ids = buildDeleteCandidateIds("docs/manuals/old-manual.pdf");
    expect(ids).toHaveLength(MAX_DELETE_CANDIDATE_CHUNKS);
  });
});

// ---------------------------------------------------------------------------
// CLI / Env Argument Parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --added-modified and --deleted flags", () => {
    const options = parseArgs(
      ["--added-modified", "docs/manuals/a.pdf docs/manuals/b.pdf", "--deleted", "docs/manuals/c.pdf"],
      {}
    );

    expect(options.addedModified).toEqual(["docs/manuals/a.pdf", "docs/manuals/b.pdf"]);
    expect(options.deleted).toEqual(["docs/manuals/c.pdf"]);
    expect(options.dryRun).toBe(false);
  });

  it("recognizes the --dry-run flag", () => {
    const options = parseArgs(["--dry-run"], {});
    expect(options.dryRun).toBe(true);
    expect(options.addedModified).toEqual([]);
    expect(options.deleted).toEqual([]);
  });

  it("falls back to ADDED_MODIFIED_FILES / DELETED_FILES environment variables", () => {
    const options = parseArgs([], {
      ADDED_MODIFIED_FILES: "docs/manuals/a.pdf docs/manuals/b.pdf",
      DELETED_FILES: "docs/manuals/c.pdf",
    });

    expect(options.addedModified).toEqual(["docs/manuals/a.pdf", "docs/manuals/b.pdf"]);
    expect(options.deleted).toEqual(["docs/manuals/c.pdf"]);
  });

  it("returns empty lists when nothing is provided", () => {
    const options = parseArgs([], {});
    expect(options.addedModified).toEqual([]);
    expect(options.deleted).toEqual([]);
    expect(options.dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare REST API interactions (mocked fetch)
// ---------------------------------------------------------------------------

describe("generateEmbeddings", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends the text batch to the Workers AI REST endpoint and returns embeddings", async () => {
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe(`https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/${EMBEDDING_MODEL}`);
      expect(init?.headers).toMatchObject({ Authorization: ["Bearer", "token123"].join(" ") });
      const body = JSON.parse(init?.body as string);
      expect(body.text).toEqual(["chunk one", "chunk two"]);

      return new Response(
        JSON.stringify({ result: { data: [Array(768).fill(0.1), Array(768).fill(0.2)] } }),
        { status: 200 }
      );
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const embeddings = await generateEmbeddings(["chunk one", "chunk two"], "acct123", "token123");

    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(768);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws a clean error when the Workers AI API returns a 5xx response", async () => {
    global.fetch = vi.fn(async () => new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;

    await expect(generateEmbeddings(["chunk"], "acct123", "token123")).rejects.toThrow(
      /Workers AI embedding request failed: 500/
    );
  });

  it("throws a clean error when the Workers AI API returns a 4xx response", async () => {
    global.fetch = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

    await expect(generateEmbeddings(["chunk"], "acct123", "badtoken")).rejects.toThrow(
      /Workers AI embedding request failed: 401.*CLOUDFLARE_API_TOKEN/
    );
  });
});

describe("upsertVectors", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends vectors as NDJSON to the Vectorize upsert endpoint", async () => {
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe(
        `https://api.cloudflare.com/client/v4/accounts/acct123/vectorize/v2/indexes/${VECTORIZE_INDEX_NAME}/upsert`
      );
      expect(init?.headers).toMatchObject({ "Content-Type": "application/x-ndjson" });

      const lines = (init?.body as string).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ id: "a#chunk_0" });

      return new Response("{}", { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await upsertVectors("acct123", "token123", [
      { id: "a#chunk_0", values: [0.1], metadata: { text: "a" } },
      { id: "a#chunk_1", values: [0.2], metadata: { text: "b" } },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does nothing when given an empty vector list", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await upsertVectors("acct123", "token123", []);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws a clean error on a non-2xx Vectorize response", async () => {
    global.fetch = vi.fn(async () => new Response("Bad Request", { status: 400 })) as unknown as typeof fetch;

    await expect(
      upsertVectors("acct123", "token123", [{ id: "a#chunk_0", values: [0.1], metadata: {} }])
    ).rejects.toThrow(/Vectorize upsert request failed: 400/);
  });
});

describe("deleteVectorsByIds", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends the delete_by_ids request with the given IDs", async () => {
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe(
        `https://api.cloudflare.com/client/v4/accounts/acct123/vectorize/v2/indexes/${VECTORIZE_INDEX_NAME}/delete_by_ids`
      );
      const body = JSON.parse(init?.body as string);
      expect(body.ids).toEqual(["old_pdf#chunk_0", "old_pdf#chunk_1"]);

      return new Response("{}", { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await deleteVectorsByIds("acct123", "token123", ["old_pdf#chunk_0", "old_pdf#chunk_1"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does nothing when given an empty ID list", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await deleteVectorsByIds("acct123", "token123", []);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws a clean error on a non-2xx Vectorize response", async () => {
    global.fetch = vi.fn(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;

    await expect(deleteVectorsByIds("acct123", "token123", ["a#chunk_0"])).rejects.toThrow(
      /Vectorize delete request failed: 404/
    );
  });
});

// ---------------------------------------------------------------------------
// High-level orchestration
// ---------------------------------------------------------------------------

describe("processDeletedFile", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips network calls in dry-run mode", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await processDeletedFile("docs/manuals/old.pdf", "acct123", "token123", true);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("issues delete requests for candidate IDs when not in dry-run mode", async () => {
    const mockFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    global.fetch = mockFetch as unknown as typeof fetch;

    await processDeletedFile("docs/manuals/old.pdf", "acct123", "token123", false);

    expect(mockFetch).toHaveBeenCalled();
  });
});

describe("processAddedModifiedFile", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("mock-pdf-bytes"));
    vi.mocked(extractText).mockResolvedValue({
      text: "The heater operates on 12V DC power and requires proper ventilation for safe operation.",
      totalPages: 1,
    } as never);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips embedding/upsert network calls in dry-run mode", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await processAddedModifiedFile("tests/fixtures/sample-manual.pdf", "acct123", "token123", true);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("parses, embeds, and upserts chunks when not in dry-run mode", async () => {
    const calledUrls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calledUrls.push(url.toString());
      if (url.toString().includes("/ai/run/")) {
        const body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ result: { data: body.text.map(() => Array(768).fill(0.1)) } }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await processAddedModifiedFile("tests/fixtures/sample-manual.pdf", "acct123", "token123", false);

    expect(calledUrls.some((url) => url.includes("/ai/run/"))).toBe(true);
    expect(calledUrls.some((url) => url.includes("/upsert"))).toBe(true);
  });

  it("calls getDocumentProxy with errors-only verbosity to suppress benign PDF.js warning spam", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    await processAddedModifiedFile("tests/fixtures/sample-manual.pdf", "acct123", "token123", true);

    expect(getDocumentProxy).toHaveBeenCalledWith(expect.any(Uint8Array), { verbosity: PDF_PARSE_VERBOSITY });
  });
});

describe("runIngestion", () => {
  const originalFetch = global.fetch;
  const originalAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const originalApiToken = process.env["CLOUDFLARE_API_TOKEN"];

  beforeEach(() => {
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("mock-pdf-bytes"));
    vi.mocked(extractText).mockResolvedValue({
      text: "The heater operates on 12V DC power and requires proper ventilation for safe operation.",
      totalPages: 1,
    } as never);
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acct123";
    process.env["CLOUDFLARE_API_TOKEN"] = "token123";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env["CLOUDFLARE_ACCOUNT_ID"] = originalAccountId;
    process.env["CLOUDFLARE_API_TOKEN"] = originalApiToken;
    vi.restoreAllMocks();
  });

  it("exits gracefully without invoking fetch when there are no changes", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(runIngestion({ addedModified: [], deleted: [], dryRun: false })).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when Cloudflare credentials are missing", async () => {
    delete process.env["CLOUDFLARE_ACCOUNT_ID"];
    delete process.env["CLOUDFLARE_API_TOKEN"];

    await expect(
      runIngestion({ addedModified: ["docs/manuals/a.pdf"], deleted: [], dryRun: false })
    ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
  });

  it("processes deleted files before added/modified files", async () => {
    const calledUrls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calledUrls.push(url.toString());
      if (url.toString().includes("/ai/run/")) {
        const body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ result: { data: body.text.map(() => Array(768).fill(0.1)) } }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await runIngestion({
      addedModified: ["tests/fixtures/sample-manual.pdf"],
      deleted: ["docs/manuals/old.pdf"],
      dryRun: false,
    });

    const deleteIndex = calledUrls.findIndex((url) => url.includes("delete_by_ids"));
    const upsertIndex = calledUrls.findIndex((url) => url.includes("/upsert"));
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(upsertIndex).toBeGreaterThan(deleteIndex);
  });
});
