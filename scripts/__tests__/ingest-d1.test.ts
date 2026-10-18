import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChunksFromPages,
  buildD1DeleteStatements,
  buildD1UpsertStatements,
  buildDocumentRecord,
  buildManualChunks,
  classifyChassis,
  classifyD1Category,
  classifySubsystem,
  deriveManufacturer,
  executeD1Statements,
  getD1DatabaseId,
  splitTextByWords,
  SUBSYSTEMS,
} from "../ingest-manuals";

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("splitTextByWords", () => {
  it("returns no chunks for empty text", () => {
    expect(splitTextByWords("  ")).toEqual([]);
  });

  it("keeps short text in a single chunk", () => {
    expect(splitTextByWords("a b c")).toEqual(["a b c"]);
  });

  it("chunks at 500 words with 100 words of overlap", () => {
    const chunks = splitTextByWords(words(1000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0].split(" ")).toHaveLength(500);
    expect(chunks[1].split(" ")[0]).toBe("w400");
    expect(chunks[1].split(" ").slice(0, 100)).toEqual(chunks[0].split(" ").slice(400));
    expect(chunks[2].split(" ")).toHaveLength(200);
  });

  it("does not emit a trailing chunk containing only overlap", () => {
    expect(splitTextByWords(words(500))).toHaveLength(1);
  });
});

describe("classification", () => {
  it("infers chassis from the path with a universal fallback", () => {
    expect(classifyChassis("docs/manuals/ford-transit/bemm.pdf")).toBe("transit");
    expect(classifyChassis("sprinter/guide.pdf")).toBe("sprinter");
    expect(classifyChassis("ProMaster/upfitter.pdf")).toBe("promaster");
    expect(classifyChassis("victron/multiplus.pdf")).toBe("universal");
  });

  it("infers a CHECK-valid subsystem from text, then path", () => {
    expect(classifySubsystem("Wire the 12V battery to the busbar")).toBe("12v_dc");
    expect(classifySubsystem("48V lithium bank")).toBe("48v_dc");
    expect(classifySubsystem("Connect shore power to the inverter")).toBe("120v_ac");
    expect(classifySubsystem("Fill the fresh water tank")).toBe("plumbing");
    expect(classifySubsystem("Diesel heater exhaust")).toBe("heating_cooling");
    expect(classifySubsystem("Maximum roof load")).toBe("structural");
    expect(classifySubsystem("nothing relevant", "plumbing/guide.pdf")).toBe("plumbing");
    expect(classifySubsystem("nothing relevant")).toBe("chassis_interface");
    for (const text of ["a", "12v", "water", "roof"]) {
      expect(SUBSYSTEMS).toContain(classifySubsystem(text));
    }
  });

  it("maps paths to D1 document categories", () => {
    expect(classifyD1Category("travel/vancouver.pdf")).toBe("forum_consensus");
    expect(classifyD1Category("specs/inverter.pdf")).toBe("component_manual");
    expect(classifyD1Category("ford/transit-bemm.pdf")).toBe("oem_bemm");
    expect(classifyD1Category("standards/abyc-e11.pdf")).toBe("code_standard");
    expect(classifyD1Category("heaters/velit.pdf")).toBe("component_manual");
  });

  it("derives manufacturer from the containing folder", () => {
    expect(deriveManufacturer("electrical/victron/multiplus.pdf")).toBe("victron");
    expect(deriveManufacturer("docs/manuals/a.pdf")).toBe("unknown");
    expect(deriveManufacturer("a.pdf")).toBe("unknown");
  });
});

describe("buildChunksFromPages", () => {
  it("tracks page numbers, sequential IDs and chassis/subsystem metadata", () => {
    const chunks = buildChunksFromPages({
      sanitizedName: "doc_pdf",
      filename: "transit/doc.pdf",
      classificationPath: "transit/doc.pdf",
      title: "Doc",
      pages: ["Wire the 12V battery", "", "Fill the water tank"],
    });
    expect(chunks.map((c) => c.id)).toEqual(["doc_pdf#chunk_0", "doc_pdf#chunk_1"]);
    expect(chunks.map((c) => c.pageNumber)).toEqual([1, 3]);
    expect(chunks[0].metadata).toMatchObject({ chassis: "transit", subsystem: "12v_dc", total_chunks: 2 });
    expect(chunks[1].metadata.subsystem).toBe("plumbing");
  });

  it("buildManualChunks adds chassis and subsystem metadata", () => {
    const [chunk] = buildManualChunks("heaters/velit.pdf", "The heater needs ventilation.");
    expect(chunk.pageNumber).toBe(1);
    expect(chunk.metadata).toMatchObject({ chassis: "universal", subsystem: "heating_cooling" });
  });
});

describe("D1 statements", () => {
  const chunks = buildManualChunks("transit/bemm.pdf", "Roof load limits for the body builder.");
  const doc = buildDocumentRecord("transit_bemm_pdf", "Bemm", "transit/bemm.pdf", "transit/bemm.pdf");

  it("builds a document record satisfying the D1 CHECK constraints", () => {
    expect(doc).toEqual({
      id: "transit_bemm_pdf",
      title: "Bemm",
      category: "oem_bemm",
      manufacturer: "transit",
      applicableChassis: "transit",
      rawR2Path: "transit/bemm.pdf",
    });
  });

  it("clears old chunks, upserts the document, then inserts chunks keyed by vector ID", () => {
    const statements = buildD1UpsertStatements(doc, chunks);
    expect(statements).toHaveLength(2 + chunks.length);
    expect(statements[0].sql).toContain("DELETE FROM document_chunks");
    expect(statements[1].sql).toContain("INSERT INTO documents");
    expect(statements[2].params).toEqual([
      chunks[0].id,
      "transit_bemm_pdf",
      1,
      null,
      "structural",
      chunks[0].text,
      7,
      Math.ceil(7 * 1.3),
    ]);
  });

  it("builds delete statements for a document", () => {
    expect(buildD1DeleteStatements("x").map((s) => s.params)).toEqual([["x"], ["x"]]);
  });
});

describe("executeD1Statements / getD1DatabaseId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the database ID from env", () => {
    expect(getD1DatabaseId({ D1_DATABASE_ID: "abc" })).toBe("abc");
    expect(getD1DatabaseId({})).toBeUndefined();
  });

  it("posts statements in batches to the D1 query endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const statements = Array.from({ length: 120 }, (_, i) => ({ sql: "SELECT ?", params: [i] }));
    await executeD1Statements("acct", "tok", "db1", statements);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/acct/d1/database/db1/query");
    expect(JSON.parse(init.body as string).batch).toHaveLength(50);
  });

  it("throws on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(executeD1Statements("a", "t", "d", [{ sql: "x", params: [] }])).rejects.toThrow(/D1 query/);
  });
});
