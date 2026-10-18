import { describe, it, expect, vi } from "vitest";
import { hybridSearch, hydrateChunks } from "../../src/utils/db";

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
});
