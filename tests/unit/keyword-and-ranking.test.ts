import { describe, it, expect, vi } from "vitest";
import { dropBoilerplateTokens, hybridSearch } from "../../src/utils/db.ts";

// Neutral, synthetic data on purpose: these behaviours must hold for any manual, vehicle or system.
function dfDb(rows: Array<Record<string, number | string>> | Error) {
  const all = vi.fn().mockImplementation(async () => {
    if (rows instanceof Error) throw rows;
    return { results: rows };
  });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, bind, prepare };
}

describe("dropBoilerplateTokens", () => {
  it("drops tokens present in most chunks of a document and keeps discriminating ones", async () => {
    const { db, bind } = dfDb([{ doc: "d", n: 100, t0: 85, t1: 78, t2: 20 }]);
    const kept = await dropBoilerplateTokens(db, ["acme", "model9", "pump"]);
    expect(kept).toEqual(["pump"]);
    expect(bind.mock.calls[0]).toEqual(["%acme%", "%model9%", "%pump%"]);
  });

  it("keeps every token when all of them look like boilerplate", async () => {
    const { db } = dfDb([{ doc: "d", n: 100, t0: 90, t1: 95 }]);
    expect(await dropBoilerplateTokens(db, ["acme", "model9"])).toEqual(["acme", "model9"]);
  });

  it("ignores very small documents when judging how common a token is", async () => {
    const { db } = dfDb([{ doc: "tiny", n: 5, t0: 5, t1: 1 }]);
    expect(await dropBoilerplateTokens(db, ["acme", "pump"])).toEqual(["acme", "pump"]);
  });

  it("does not query for a single token and falls back to all tokens if statistics fail", async () => {
    const single = dfDb([]);
    expect(await dropBoilerplateTokens(single.db, ["pump"])).toEqual(["pump"]);
    expect(single.prepare).not.toHaveBeenCalled();

    const failing = dfDb(new Error("d1 unavailable"));
    expect(await dropBoilerplateTokens(failing.db, ["acme", "pump"])).toEqual(["acme", "pump"]);
  });
});

describe("hybridSearch final ordering", () => {
  it("keeps the fused (RRF) order instead of letting keyword-only synthetic scores outrank real similarity", async () => {
    const row = (id: string, text: string) => ({
      id, document_id: "d", document_title: "Doc", category: "chassis", manufacturer: "acme",
      applicable_chassis: "universal", page_number: 1, section_title: null, subsystem: "structural",
      chunk_text: text, schematic_r2_key: null, schematic_caption: null, metadata_json: null,
    });
    const rows = [row("d#chunk_1", "alpha text one"), row("d#chunk_5", "beta text five"), row("d#chunk_9", "gamma text nine")];
    const keywordRows = [{ id: "d#chunk_5", match_score: 9 }, { id: "d#chunk_9", match_score: 8 }];

    const prepare = vi.fn().mockImplementation((sql: string) => ({
      bind: () => ({
        all: async () =>
          sql.includes("GROUP BY") ? { results: [] } : sql.includes("match_score") ? { results: keywordRows } : { results: rows },
      }),
    }));
    // chunk_9 is keyword-only (synthetic 0.75); chunk_1 / chunk_5 have lower real cosine scores.
    const query = vi.fn().mockResolvedValue({
      matches: [
        { id: "d#chunk_1", score: 0.72, metadata: { source: "s", text: "" } },
        { id: "d#chunk_5", score: 0.71, metadata: { source: "s", text: "" } },
      ],
    });

    const res = await hybridSearch(
      { query } as unknown as VectorizeIndex,
      { prepare } as unknown as D1Database,
      new Array(768).fill(0.1) as number[],
      { queryText: "widget bracket", topK: 8 }
    );

    // Fusion: chunk_5 (vector #2 + keyword #1) > chunk_1 (vector #1) > chunk_9 (keyword #2).
    // Sorting by raw score would have produced chunk_9 (0.75) first.
    expect(res.map((r) => r.id)).toEqual(["d#chunk_5", "d#chunk_1", "d#chunk_9"]);
  });
});
