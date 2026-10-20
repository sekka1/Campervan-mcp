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
    const without = await hybridSearch(makeIndex([match]).index, makeDb([row]).db, vec);
    expect(without[0]?.schematic_url).toBeUndefined();
  });
});
