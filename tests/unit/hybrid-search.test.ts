import { describe, it, expect, vi } from "vitest";
import { buildSchematicUrl, hybridSearch, hydrateChunks } from "../../src/utils/db";

function makeIndex(matches: unknown[]) {
  const query = vi.fn().mockResolvedValue({ matches });
  return { index: { query } as unknown as VectorizeIndex, query };
}

function makeDb(rows: unknown[]) {
  const bind = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: rows }) });
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
    const { db, prepare, bind } = makeDb([]);
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
    expect(sql).toContain("json_extract(COALESCE(c.metadata_json, d.metadata_json), '$.year_start')");

    expect(bind).toHaveBeenCalledWith("chunk_1", "chassis", "ford", "transit", "us", 2024, 2024);
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

});
