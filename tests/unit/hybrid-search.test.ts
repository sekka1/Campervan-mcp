import { describe, it, expect, vi } from "vitest";
import { buildSchematicUrl, buildCanonicalTitle, computeTokenOverlap, deduplicateCrossEditionChunks, hybridSearch, hydrateChunks, normalizeChunkForDedup, tokenizeQuery, reciprocalRankFusion } from "../../src/utils/db";

function makeIndex(matches: unknown[]) {
  const query = vi.fn().mockResolvedValue({ matches });
  return { index: { query } as unknown as VectorizeIndex, query };
}

function makeDb(rows: unknown[], fallbackRows?: unknown[]) {
  let callCount = 0;
  const bind = vi.fn().mockImplementation(() => ({
    all: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount > 1 && fallbackRows !== undefined) {
        return { results: fallbackRows };
      }
      return { results: rows };
    }),
  }));
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, prepare, bind };
}

describe("hydrateChunks", () => {
  it("returns an empty map without querying when no ids are given", async () => {
    const { db, prepare } = makeDb([]);
    expect((await hydrateChunks(db, [])).size).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("falls back to mock results when Vectorize index throws (e.g., local dev or unsupported binding)", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const query = vi.fn().mockRejectedValue(new Error("Binding VECTOR_INDEX needs to be run remotely"));
    const index = { query } as unknown as VectorizeIndex;
    const results = await hybridSearch(index, undefined, vec, { chassis: "transit" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.text).toContain("transit");
    expect(results[0]?.source).toBe("transit_manual_mock");
  });
});

describe("hybridSearch", () => {
  const vec = new Array(768).fill(0.1) as number[];

  it("hydrates matches from D1 by chunk id", async () => {
    const { index } = makeIndex([{ id: "a", score: 0.9, metadata: { source: "src", text: "meta" } }]);
    const { db, bind } = makeDb([
      {
        id: "a", document_id: "d", document_title: "Doc", category: "oem_bemm", manufacturer: "Ford",
        applicable_chassis: "transit", page_number: 4, section_title: "Roof", subsystem: "structural",
        chunk_text: "full text", schematic_r2_key: "schematics/x.png", schematic_caption: "Cap",
      },
    ]);
    const res = await hybridSearch(index, db, vec, { topK: 3 });
    expect(bind).toHaveBeenCalledWith("a");
    expect(res[0]).toMatchObject({ id: "a", text: "full text", page: 4, manufacturer: "Ford", schematic_r2_key: "schematics/x.png" });
  });

  it("falls back to Vectorize metadata when chunk is not in D1 or DB is absent", async () => {
    const { index } = makeIndex([{ id: "a", score: 0.5, metadata: { source: "src", page: 2, text: "meta" } }]);
    const { db } = makeDb([]);
    expect((await hybridSearch(index, db, vec))[0]).toMatchObject({ text: "meta", page: 2, source: "src" });
    expect((await hybridSearch(index, undefined, vec))[0]?.text).toBe("meta");
  });

  it("builds metadata filters for source, chassis and subsystem", async () => {
    const { index, query } = makeIndex([]);
    await hybridSearch(index, undefined, vec, { source: "s", chassis: "transit", subsystem: "12v_dc" });
    expect(query.mock.calls[0]?.[1].filter).toEqual({
      source: { $eq: "s" },
      chassis: { $in: ["transit", "universal"] },
      subsystem: { $eq: "12v_dc" },
    });
  });

  it("normalizes manufacturer-prefixed chassis names (e.g., ford_transit -> transit)", async () => {
    const { index, query } = makeIndex([]);
    await hybridSearch(index, undefined, vec, { chassis: "ford_transit" });
    expect(query.mock.calls[0]?.[1].filter).toEqual({
      chassis: { $in: ["transit", "universal"] },
    });
  });
});

describe("schematic URLs", () => {
  it("joins the CDN base URL and R2 key", () => {
    expect(buildSchematicUrl("https://cdn.example.com/", "schematics/a b/p1-0.png")).toBe(
      "https://cdn.example.com/schematics/a%20b/p1-0.png"
    );
  });

  it("strips leading slashes from r2Key and trailing slashes from cdnBaseUrl", () => {
    expect(
      buildSchematicUrl(
        "https://pub-655d7d799988450194dfe2dc6d5b1741.r2.dev///",
        "/schematics/MY24_Transit_BEMM_V363N_20APR24_J2_V2_R2_downloaded_30JUL24_1_pdf/p146-0.png"
      )
    ).toBe(
      "https://pub-655d7d799988450194dfe2dc6d5b1741.r2.dev/schematics/MY24_Transit_BEMM_V363N_20APR24_J2_V2_R2_downloaded_30JUL24_1_pdf/p146-0.png"
    );
  });

  it("returns null when cdnBaseUrl or r2Key is empty or null", () => {
    expect(buildSchematicUrl("", "schematics/p1.png")).toBeNull();
    expect(buildSchematicUrl("https://pub-123.r2.dev", null)).toBeNull();
    expect(buildSchematicUrl("https://pub-123.r2.dev", "")).toBeNull();
  });

  it("returns schematic_url only when a CDN base URL is configured", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const row = {
      id: "a", document_id: "d", document_title: "Doc", category: "oem_bemm", manufacturer: "Ford",
      applicable_chassis: "transit", page_number: 4, section_title: null, subsystem: "structural",
      chunk_text: "t", schematic_r2_key: "schematics/d/p4-0.png", schematic_caption: "Cap",
    };
    const match = { id: "a", score: 0.9, metadata: { source: "s", text: "m" } };
    const withCdn = await hybridSearch(makeIndex([match]).index, makeDb([row]).db, vec, { cdnBaseUrl: "https://cdn.test" });
    expect(withCdn[0]?.schematic_url).toBe("https://cdn.test/schematics/d/p4-0.png");
    expect(withCdn[0]?.schematic_markdown).toBe("[Cap](https://cdn.test/schematics/d/p4-0.png)");

    // Test fallback when caption is null/empty
    const rowNoCap = { ...row, schematic_caption: null };
    const withCdnNoCap = await hybridSearch(makeIndex([match]).index, makeDb([rowNoCap]).db, vec, { cdnBaseUrl: "https://cdn.test" });
    expect(withCdnNoCap[0]?.schematic_markdown).toBe("[View OEM Diagram](https://cdn.test/schematics/d/p4-0.png)");

    const without = await hybridSearch(makeIndex([match]).index, makeDb([row]).db, vec);
    expect(without[0]?.schematic_url).toBeUndefined();
    expect(without[0]?.schematic_markdown).toBeUndefined();
  });

describe("universal metadata filtering in hydrateChunks and hybridSearch", () => {
  const vec = new Array(768).fill(0.1) as number[];

  it("applies category, manufacturer, model, market, and model_year SQL filters in hydrateChunks", async () => {
    const dummyRow = {
      id: "chunk_1",
      document_id: "doc_1",
      document_title: "Doc",
      category: "chassis",
      manufacturer: "ford",
      applicable_chassis: "transit",
      page_number: 1,
      section_title: null,
      subsystem: "12v_dc",
      chunk_text: "text",
      schematic_r2_key: null,
      schematic_caption: null,
    };
    const { db, prepare, bind } = makeDb([dummyRow]);
    await hydrateChunks(db, ["chunk_1"], {
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      model_year: 2024,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("c.id IN (?)");
    expect(sql).toContain("LOWER(COALESCE(c.category, d.category, '')) = ?");
    expect(sql).toContain("LOWER(COALESCE(c.manufacturer, d.manufacturer, '')) = ?");
    expect(sql).toContain("LOWER(COALESCE(c.model, d.model, '')) = ?");
    expect(sql).toContain("LOWER(COALESCE(c.market, d.market, 'global')) IN (?, 'global')");
    expect(sql).toContain("json_extract(COALESCE(c.metadata_json, d.metadata_json), '$.year_start') IS NULL");

    expect(bind).toHaveBeenCalledWith("chunk_1", "chassis", "ford", "ford", "ford", "transit", "transit", "transit", "us", 2024, 2024);
  });

  it("excludes chunks tagged with market: eu when querying market: us", async () => {
    const matchUs = { id: "chunk_us", score: 0.9, metadata: { source: "ford", text: "US spec" } };
    const matchEu = { id: "chunk_eu", score: 0.85, metadata: { source: "ford", text: "EU spec" } };
    const { index } = makeIndex([matchUs, matchEu]);

    // DB only returns the hydrated chunk that satisfies market = us (or global)
    const { db } = makeDb([
      {
        id: "chunk_us",
        document_id: "doc_1",
        document_title: "Ford Transit US",
        category: "chassis",
        manufacturer: "ford",
        model: "transit",
        market: "us",
        applicable_chassis: "transit",
        page_number: 1,
        section_title: null,
        subsystem: "chassis_interface",
        chunk_text: "US spec Transit",
        schematic_r2_key: null,
        schematic_caption: null,
      },
    ]);

    const results = await hybridSearch(index, db, vec, { market: "us" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("chunk_us");
    expect(results[0]?.market).toBe("us");
  });

  it("matches model_year: 2024 when metadata_json spans 2020-2024 and excludes 2015-2019", async () => {
    const match2024 = { id: "chunk_2024", score: 0.95, metadata: { source: "ford", text: "2024 spec" } };
    const match2018 = { id: "chunk_2018", score: 0.88, metadata: { source: "ford", text: "2018 spec" } };
    const { index } = makeIndex([match2024, match2018]);

    const { db } = makeDb([
      {
        id: "chunk_2024",
        document_id: "doc_2",
        document_title: "Transit 2020-2024",
        category: "chassis",
        manufacturer: "ford",
        model: "transit",
        market: "us",
        metadata_json: JSON.stringify({ year_start: 2020, year_end: 2024 }),
        applicable_chassis: "transit",
        page_number: 10,
        section_title: "CCP2",
        subsystem: "12v_dc",
        chunk_text: "2020-2024 Transit CCP2 wiring",
        schematic_r2_key: null,
        schematic_caption: null,
      },
    ]);

    const results = await hybridSearch(index, db, vec, { model_year: 2024 });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("chunk_2024");
    expect(results[0]?.metadata_json).toContain("2020");
  });

  it("passes appliance chunk with null year keys when model_year is queried", async () => {
    const match = { id: "chunk_heater", score: 0.92, metadata: { source: "velit", text: "heater" } };
    const { index } = makeIndex([match]);

    const { db } = makeDb([
      {
        id: "chunk_heater",
        document_id: "doc_heater",
        document_title: "Velit Heater",
        category: "climate",
        manufacturer: "velit",
        model: "2026",
        market: "global",
        metadata_json: JSON.stringify({ year_start: null, year_end: null, voltage: 12 }),
        applicable_chassis: "universal",
        page_number: 1,
        section_title: null,
        subsystem: "heating_cooling",
        chunk_text: "12V diesel air heater installation",
        schematic_r2_key: null,
        schematic_caption: null,
      },
    ]);

    const results = await hybridSearch(index, db, vec, { model_year: 2024 });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("chunk_heater");
  });

  it("returns top-k matches across all categories when no filters are supplied", async () => {
    const match1 = { id: "c1", score: 0.95, metadata: { source: "ford", text: "transit" } };
    const match2 = { id: "c2", score: 0.90, metadata: { source: "victron", text: "inverter" } };
    const { index } = makeIndex([match1, match2]);

    const { db } = makeDb([
      {
        id: "c1",
        document_id: "d1",
        document_title: "Transit",
        category: "chassis",
        manufacturer: "ford",
        applicable_chassis: "transit",
        page_number: 1,
        section_title: null,
        subsystem: "chassis_interface",
        chunk_text: "Transit chassis",
        schematic_r2_key: null,
        schematic_caption: null,
      },
      {
        id: "c2",
        document_id: "d2",
        document_title: "MultiPlus",
        category: "power",
        manufacturer: "victron",
        applicable_chassis: "universal",
        page_number: 2,
        section_title: null,
        subsystem: "12v_dc",
        chunk_text: "MultiPlus inverter",
        schematic_r2_key: null,
        schematic_caption: null,
      },
    ]);

    const results = await hybridSearch(index, db, vec);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["c1", "c2"]);
  });
});


  it("recovers via zero-result fallback when LLM passes category: power on a category: chassis document", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const match = { id: "chunk_ccp2", score: 0.94, metadata: { source: "ford", text: "CCP2 175A" } };
    const { index } = makeIndex([match]);

    const transitDoc = {
      id: "chunk_ccp2",
      document_id: "doc_transit",
      document_title: "Ford Transit BEMM",
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata_json: JSON.stringify({ year_start: 2020, year_end: 2024 }),
      applicable_chassis: "transit",
      page_number: 146,
      section_title: "CCP2 Auxiliary Power",
      subsystem: "12v_dc",
      chunk_text: "High current customer connection point CCP2 is rated at 175A",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    // First call with category: power returns empty results [], but fallback returns the transit chunk
    const { db } = makeDb([], [transitDoc]);

    const results = await hybridSearch(index, db, vec, {
      category: "power",
      model: "transit",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("chunk_ccp2");
    expect(results[0]?.document_title).toBe("2020-2024 Ford Transit (US)");
  });

  it("matches model: Ford Transit to transit via bidirectional SQL substring matching", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const match = { id: "chunk_grounding", score: 0.91, metadata: { source: "ford", text: "grounding" } };
    const { index } = makeIndex([match]);

    const transitDoc = {
      id: "chunk_grounding",
      document_id: "doc_transit",
      document_title: "Ford Transit BEMM",
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata_json: "{}",
      applicable_chassis: "transit",
      page_number: 88,
      section_title: "Ground Points",
      subsystem: "12v_dc",
      chunk_text: "Vehicle ground points for auxiliary battery connection",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const { db, prepare, bind } = makeDb([transitDoc]);

    const results = await hybridSearch(index, db, vec, {
      model: "Ford Transit",
    });

    expect(prepare).toHaveBeenCalled();
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("OR ? LIKE '%' || LOWER(COALESCE(c.model, d.model, '')) || '%'");
    expect(bind).toHaveBeenCalledWith("chunk_grounding", "ford transit", "ford transit", "ford transit");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("chunk_grounding");
  });

describe("Universal Tokenization & Reciprocal Rank Fusion (RRF)", () => {
  it("strips standard English stop words and returns distinct technical tokens", () => {
    const query = "Where are the approved chassis grounding points for auxiliary wiring regarding BMS rules?";
    const tokens = tokenizeQuery(query);
    expect(tokens).toContain("approved");
    expect(tokens).toContain("chassis");
    expect(tokens).toContain("grounding");
    expect(tokens).toContain("points");
    expect(tokens).toContain("auxiliary");
    expect(tokens).toContain("wiring");
    expect(tokens).toContain("bms");
    expect(tokens).toContain("rules");

    // Must strip stop words
    expect(tokens).not.toContain("where");
    expect(tokens).not.toContain("are");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("for");
    expect(tokens).not.toContain("regarding");
  });

  it("fuses vector and keyword rankings via Reciprocal Rank Fusion", () => {
    const vectorRanked = ["doc#chunk_1", "doc#chunk_2", "doc#chunk_3"];
    const keywordRanked = ["doc#chunk_3", "doc#chunk_1", "doc#chunk_4"];
    const fused = reciprocalRankFusion(vectorRanked, keywordRanked, 60);

    // doc#chunk_1 (rank 1 in vector, rank 2 in keyword) and doc#chunk_3 (rank 3 in vector, rank 1 in keyword)
    expect(fused[0]).toBe("doc#chunk_1");
    expect(fused[1]).toBe("doc#chunk_3");
    expect(fused).toContain("doc#chunk_2");
    expect(fused).toContain("doc#chunk_4");
  });
});

describe("Universal Forward Continuation Context Expansion", () => {
  it("automatically pulls in chunk_11 when doc#chunk_10 is a top match", async () => {
    const chunk10 = {
      id: "doc_heater#chunk_10",
      document_id: "doc_heater",
      document_title: "Heater Manual",
      category: "climate",
      manufacturer: "velit",
      applicable_chassis: "universal",
      page_number: 14,
      section_title: "Wiring Harness Pinout",
      subsystem: "heating_cooling",
      chunk_text: "Standard wiring harness connector introduction.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const chunk11 = {
      id: "doc_heater#chunk_11",
      document_id: "doc_heater",
      document_title: "Heater Manual",
      category: "climate",
      manufacturer: "velit",
      applicable_chassis: "universal",
      page_number: 14,
      section_title: "Pinout Table",
      subsystem: "heating_cooling",
      chunk_text: "Pin 1: +12V Red, Pin 2: Ground Black, Pin 3: Signal Blue.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    // First query for chunk_10, second query fetches sibling chunk_11
    const { db } = makeDb([chunk10], [chunk11]);
    const hydrated = await hydrateChunks(db, ["doc_heater#chunk_10"]);
    const result = hydrated.get("doc_heater#chunk_10");

    expect(result).toBeDefined();
    expect(result?.chunk_text).toContain("Standard wiring harness connector introduction.");
    expect(result?.chunk_text).toContain("[Continuation from next section/table (Pinout Table)]:");
    expect(result?.chunk_text).toContain("Pin 1: +12V Red, Pin 2: Ground Black, Pin 3: Signal Blue.");
  });

  it("pulls in both chunk_11 and chunk_12 when chunk_10 contains a table/figure continuation cue", async () => {
    const chunk10 = {
      id: "doc_bemm#chunk_10",
      document_id: "doc_bemm",
      document_title: "BEMM Manual",
      category: "chassis",
      manufacturer: "ford",
      applicable_chassis: "transit",
      page_number: 40,
      section_title: "Grounding Locations",
      subsystem: "chassis_interface",
      chunk_text: "For auxiliary grounding, refer to the following figures and tables for stud locations.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const chunk11 = {
      id: "doc_bemm#chunk_11",
      document_id: "doc_bemm",
      document_title: "BEMM Manual",
      category: "chassis",
      manufacturer: "ford",
      applicable_chassis: "transit",
      page_number: 40,
      section_title: "Figure 4-1 Ground Studs",
      subsystem: "chassis_interface",
      chunk_text: "Figure 4-1 shows Point 43 (driver seat base ground stud M8).",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const chunk12 = {
      id: "doc_bemm#chunk_12",
      document_id: "doc_bemm",
      document_title: "BEMM Manual",
      category: "chassis",
      manufacturer: "ford",
      applicable_chassis: "transit",
      page_number: 41,
      section_title: "BMS Warning Note",
      subsystem: "chassis_interface",
      chunk_text: "WARNING: Do not connect auxiliary battery negative directly to the vehicle battery terminal.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const { db } = makeDb([chunk10], [chunk11, chunk12]);
    const hydrated = await hydrateChunks(db, ["doc_bemm#chunk_10"]);
    const result = hydrated.get("doc_bemm#chunk_10");

    expect(result).toBeDefined();
    expect(result?.chunk_text).toContain("refer to the following figures and tables");
    expect(result?.chunk_text).toContain("Point 43 (driver seat base ground stud M8)");
    expect(result?.chunk_text).toContain("WARNING: Do not connect auxiliary battery negative");
  });
});

  it("enforces strict top_k cap (default 8) when 15 contiguous chunks exist in D1 and continuation expansion triggers", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const allMatches = Array.from({ length: 15 }, (_, i) => ({
      id: `doc_bemm#chunk_${i + 1}`,
      score: 0.99 - i * 0.02,
      metadata: { source: "ford", text: `Base text for chunk ${i + 1}` },
    }));

    const { index } = makeIndex(allMatches);

    const contiguousDocs = Array.from({ length: 15 }, (_, i) => ({
      id: `doc_bemm#chunk_${i + 1}`,
      document_id: "doc_bemm",
      document_title: "Ford Transit BEMM",
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata_json: "{}",
      applicable_chassis: "transit",
      page_number: Math.floor(i / 2) + 1,
      section_title: `Section ${i + 1}`,
      subsystem: "12v_dc",
      chunk_text:
        i === 0
          ? "Customer connection points overview: refer to the following figures and tables for ratings."
          : `Specification detail and rules for step ${i + 1}.`,
      schematic_r2_key: null,
      schematic_caption: null,
    }));

    // In a contiguous D1 table, hydrateChunks finds siblings in contiguousDocs
    const { db } = makeDb(contiguousDocs, contiguousDocs);

    const results = await hybridSearch(index, db, vec, {
      topK: 8,
      queryText: "Customer Connection Points CCP1 CCP2 ratings",
    });

    // Must be strictly capped at 8 (not 12 or 15)
    expect(results.length).toBe(8);

    // First chunk must have stitched forward continuation text
    expect(results[0]?.text).toContain("Customer connection points overview");
    expect(results[0]?.text).toContain("[Continuation from next section/table");
    expect(results[0]?.text).toContain("Specification detail and rules for step 2");
  });

describe("Progressive (Stepwise) Filter Relaxation", () => {
  it("relaxes category in Stage 2 when category produces 0 matches but manufacturer and model match", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const match = { id: "doc_bemm#chunk_5", score: 0.95, metadata: { source: "ford", text: "CCP1 60A" } };
    const { index } = makeIndex([match]);

    const transitDoc = {
      id: "doc_bemm#chunk_5",
      document_id: "doc_bemm",
      document_title: "Ford Transit BEMM",
      category: "chassis", // Document is chassis, but query asks for category "power"
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata_json: JSON.stringify({ year_start: 2026 }),
      applicable_chassis: "transit",
      page_number: 10,
      section_title: "Customer Connection Points",
      subsystem: "12v_dc",
      chunk_text: "CCP1 60A and CCP2 175A ratings.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    // Stage 1 (with category: power) returns empty, Stage 2 (category dropped) returns transitDoc
    const { db } = makeDb([], [transitDoc]);

    const results = await hybridSearch(index, db, vec, {
      category: "power",
      manufacturer: "ford",
      model: "transit",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("doc_bemm#chunk_5");
    expect(results[0]?.manufacturer).toBe("ford");
    expect(results[0]?.model).toBe("transit");
    expect(results[0]?.model_year).toBe(2026);
    expect(results[0]?.source).toContain("2026 Ford Transit (US)");
  });
});

describe("buildCanonicalTitle", () => {
  it("builds canonical manual title from metadata", () => {
    const title = buildCanonicalTitle({
      document_title: "2027 Eu Transit",
      manufacturer: "ford",
      model: "transit_custom",
      market: "eu",
      metadata_json: JSON.stringify({ year_start: 2026 }),
    });
    expect(title).toBe("2026 Ford Transit Custom (EU) [2027 Eu Transit]");
  });
});

describe("Cross-Edition Near-Duplicate Deduplication", () => {
  it("normalizes text and computes token overlap between editions", () => {
    const text2024 = "Date of Publication: 04/2024. Page 42. Customer connection point CCP1 is 60A and CCP2 is 175A on seat base.";
    const text2027 = "Date of Publication: 09/2026. Page 44. Customer connection point CCP1 is 60A and CCP2 is 175A on seat base.";

    const norm2024 = normalizeChunkForDedup(text2024);
    const norm2027 = normalizeChunkForDedup(text2027);

    const overlap = computeTokenOverlap(norm2024, norm2027);
    expect(overlap).toBeGreaterThanOrEqual(0.80);
  });

  it("deduplicates identical chunks across different model years, keeping the newest edition", () => {
    const chunk2024 = {
      id: "transit_2024#chunk_10",
      score: 0.95,
      source: "2024 Ford Transit (US)",
      text: "Customer connection points CCP1 (60A) and CCP2 (175A) located on driver seat base.",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      model_year: 2024,
    };

    const chunk2027 = {
      id: "transit_2027#chunk_12",
      score: 0.93,
      source: "2027 Ford Transit (US)",
      text: "Customer connection points CCP1 (60A) and CCP2 (175A) located on driver seat base.",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      model_year: 2027,
    };

    const distinctChunk = {
      id: "transit_2027#chunk_40",
      score: 0.90,
      source: "2027 Ford Transit (US)",
      text: "Auxiliary grounding studs 43 and 44 must not bypass the Battery Monitoring Sensor.",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      model_year: 2027,
    };

    const deduplicated = deduplicateCrossEditionChunks([chunk2024, chunk2027, distinctChunk]);
    expect(deduplicated).toHaveLength(2);
    // Must keep the 2027 edition of the CCP chunk
    const ccpChunk = deduplicated.find((c) => c.text.includes("CCP1 (60A)"));
    expect(ccpChunk?.id).toBe("transit_2027#chunk_12");
    expect(ccpChunk?.model_year).toBe(2027);
  });
});

describe("Continuation Expansion on Non-Top-3 Chunks with Table/Diagram Cues", () => {
  it("expands a rank #5 chunk with forward sibling when text contains table/figure cues", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const matches = Array.from({ length: 6 }, (_, i) => ({
      id: `doc_bemm#chunk_${i + 1}`,
      score: 0.99 - i * 0.05,
      metadata: { source: "ford", text: `Chunk ${i + 1}` },
    }));
    const { index } = makeIndex(matches);

    // Chunk #5 (rank 5, 0-indexed 4) contains "refer to the following figures for ground points"
    const chunk5 = {
      id: "doc_bemm#chunk_5",
      document_id: "doc_bemm",
      document_title: "Ford Transit BEMM",
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata_json: JSON.stringify({ year_start: 2026 }),
      applicable_chassis: "transit",
      page_number: 30,
      section_title: "Grounding Locations",
      subsystem: "12v_dc",
      chunk_text: "For auxiliary electrical installation, refer to the following figures for ground points.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const siblingChunk6 = {
      id: "doc_bemm#chunk_6",
      document_id: "doc_bemm",
      document_title: "Ford Transit BEMM",
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata_json: JSON.stringify({ year_start: 2026 }),
      applicable_chassis: "transit",
      page_number: 30,
      section_title: "Figure 4-1 Ground Studs",
      subsystem: "12v_dc",
      chunk_text: "Point 43: Driver seat pedestal ground stud (M8 torque 25 Nm).",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const { db } = makeDb([chunk5, siblingChunk6], [siblingChunk6]);
    const results = await hybridSearch(index, db, vec, { topK: 6 });

    const r5 = results.find((r) => r.id === "doc_bemm#chunk_5");
    expect(r5).toBeDefined();
    expect(r5?.text).toContain("refer to the following figures for ground points");
    expect(r5?.text).toContain("[Continuation from next section/table");
    expect(r5?.text).toContain("Point 43: Driver seat pedestal ground stud");
  });
});

describe("Generic Model Disambiguation, Market Defaults & Exact Chunk ID Deduplication", () => {
  it("strictly matches exact model so base model queries do not match compound sub-models", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const match1 = { id: "doc_custom#chunk_1", score: 0.90, metadata: { source: "ford", text: "Transit Custom spec" } };
    const match2 = { id: "doc_base#chunk_1", score: 0.85, metadata: { source: "ford", text: "Full size Transit spec" } };
    const { index } = makeIndex([match1, match2]);

    const customChunk = {
      id: "doc_custom#chunk_1",
      document_id: "doc_custom",
      document_title: "Ford Transit Custom BEMM",
      category: "chassis",
      manufacturer: "ford",
      model: "transit_custom",
      market: "eu",
      metadata_json: JSON.stringify({ year_start: 2026 }),
      applicable_chassis: "transit",
      page_number: 10,
      section_title: "Electrical",
      subsystem: "12v_dc",
      chunk_text: "Transit Custom 250A alternator limit.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const baseChunk = {
      id: "doc_base#chunk_1",
      document_id: "doc_base",
      document_title: "Ford Transit BEMM",
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata_json: JSON.stringify({ year_start: 2027 }),
      applicable_chassis: "transit",
      page_number: 20,
      section_title: "Electrical",
      subsystem: "12v_dc",
      chunk_text: "Ford Transit CCP2 175A auxiliary connection point.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const { db } = makeDb([], [baseChunk, customChunk]);

    // Query for base model "transit": exact model must rank ahead of compound sub-model
    const results = await hybridSearch(index, db, vec, {
      manufacturer: "ford",
      model: "transit",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("doc_base#chunk_1");
    expect(results[0]?.model).toBe("transit");
  });

  it("applies default US market ranking when no market filter is specified", async () => {
    const vec = new Array(768).fill(0.1) as number[];
    const matchEu = { id: "doc_eu#chunk_1", score: 0.95, metadata: { source: "mb", text: "EU Spec" } };
    const matchUs = { id: "doc_us#chunk_1", score: 0.80, metadata: { source: "mb", text: "US Spec" } };
    const { index } = makeIndex([matchEu, matchUs]);

    const euChunk = {
      id: "doc_eu#chunk_1",
      document_id: "doc_eu",
      document_title: "Mercedes-Benz Sprinter EU",
      category: "chassis",
      manufacturer: "mercedes-benz",
      model: "sprinter",
      market: "eu",
      metadata_json: JSON.stringify({ year_start: 2025 }),
      applicable_chassis: "sprinter",
      page_number: 10,
      section_title: "Fuses",
      subsystem: "12v_dc",
      chunk_text: "European market sprinter 230V inverter.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const usChunk = {
      id: "doc_us#chunk_1",
      document_id: "doc_us",
      document_title: "Mercedes-Benz Sprinter US",
      category: "chassis",
      manufacturer: "mercedes-benz",
      model: "sprinter",
      market: "us",
      metadata_json: JSON.stringify({ year_start: 2025 }),
      applicable_chassis: "sprinter",
      page_number: 10,
      section_title: "Fuses",
      subsystem: "12v_dc",
      chunk_text: "US market sprinter auxiliary battery connection.",
      schematic_r2_key: null,
      schematic_caption: null,
    };

    const { db } = makeDb([], [euChunk, usChunk]);

    // Query without market: US market should be preferred over EU in rank ordering
    const results = await hybridSearch(index, db, vec, {
      manufacturer: "mercedes-benz",
      model: "sprinter",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("doc_us#chunk_1");
    expect(results[0]?.market).toBe("us");
  });

  it("strictly deduplicates duplicate chunk IDs in search results", () => {
    const chunk1 = {
      id: "sprinter_manual#chunk_42",
      score: 0.95,
      source: "2025 Mercedes-Benz Sprinter",
      text: "Auxiliary battery cutoff relay specifications.",
      manufacturer: "mercedes-benz",
      model: "sprinter",
      market: "us",
      model_year: 2025,
    };
    const chunk1Duplicate = { ...chunk1 };
    const chunk2 = {
      id: "sprinter_manual#chunk_43",
      score: 0.90,
      source: "2025 Mercedes-Benz Sprinter",
      text: "Fuses for auxiliary high current connection point.",
      manufacturer: "mercedes-benz",
      model: "sprinter",
      market: "us",
      model_year: 2025,
    };

    const deduplicated = deduplicateCrossEditionChunks([chunk1, chunk2, chunk1Duplicate]);
    expect(deduplicated).toHaveLength(2);
    expect(deduplicated.map((c) => c.id)).toEqual(["sprinter_manual#chunk_42", "sprinter_manual#chunk_43"]);
  });
});
});
