import { describe, it, expect, vi } from "vitest";
import { findBoilerplateTokensByDocument, searchD1KeywordCandidates, hybridSearch } from "../../src/utils/db.ts";

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

describe("findBoilerplateTokensByDocument", () => {
  it("flags tokens that are boilerplate in a document, keeping discriminating ones", async () => {
    const { db, bind } = dfDb([{ doc: "A", n: 100, t0: 85, t1: 78, t2: 20 }]);
    const map = await findBoilerplateTokensByDocument(db, ["acme", "model9", "pump"]);
    expect(Array.from(map.keys()).sort()).toEqual(["acme", "model9"]);
    expect(map.get("acme")).toEqual(new Set(["A"]));
    expect(bind.mock.calls[0]).toEqual(["%acme%", "%model9%", "%pump%"]);
  });

  it("suppresses a token only in the documents where it is boilerplate (per document, not globally)", async () => {
    const { db } = dfDb([
      { doc: "A", n: 100, t0: 90, t1: 10 }, // "pump" is on nearly every page of manual A
      { doc: "B", n: 100, t0: 10, t1: 12 }, // but is a normal word in manual B
    ]);
    const map = await findBoilerplateTokensByDocument(db, ["pump", "bracket"]);
    expect(map.get("pump")).toEqual(new Set(["A"]));
    expect(map.get("pump")?.has("B")).toBe(false);
    expect(map.has("bracket")).toBe(false);
  });

  it("suppresses nothing in a document where every token would be boilerplate", async () => {
    const { db } = dfDb([{ doc: "A", n: 100, t0: 90, t1: 95 }]);
    expect((await findBoilerplateTokensByDocument(db, ["acme", "model9"])).size).toBe(0);
  });

  it("ignores very small documents when judging how common a token is", async () => {
    const { db } = dfDb([{ doc: "tiny", n: 5, t0: 5, t1: 1 }]);
    expect((await findBoilerplateTokensByDocument(db, ["acme", "pump"])).size).toBe(0);
  });

  it("does not query for a single token and returns no suppression if statistics fail", async () => {
    const single = dfDb([]);
    expect((await findBoilerplateTokensByDocument(single.db, ["pump"])).size).toBe(0);
    expect(single.prepare).not.toHaveBeenCalled();

    const failing = dfDb(new Error("d1 unavailable"));
    expect((await findBoilerplateTokensByDocument(failing.db, ["acme", "pump"])).size).toBe(0);
  });
});

describe("searchD1KeywordCandidates per-document suppression", () => {
  it("guards a boilerplate token by document id so other documents still match it", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => {
          calls.push({ sql, params });
          return sql.includes("GROUP BY")
            ? { results: [{ doc: "A", n: 100, t0: 90, t1: 10 }, { doc: "B", n: 100, t0: 10, t1: 12 }] }
            : { results: [{ id: "B#chunk_1", match_score: 2 }] };
        },
      }),
    }));

    const res = await searchD1KeywordCandidates({ prepare } as unknown as D1Database, ["pump", "bracket"]);

    const search = calls.find((c) => !c.sql.includes("GROUP BY"))!;
    // "pump" is guarded to exclude document A only; "bracket" is unguarded; B is never excluded.
    expect(search.sql).toContain("c.document_id NOT IN (?)");
    expect(search.params).toContain("A");
    expect(search.params).not.toContain("B");
    expect(search.sql.match(/NOT IN/g)?.length).toBe(3); // 2 in the score expression + 1 in WHERE, for "pump" only
    expect(res).toEqual([{ id: "B#chunk_1", score: 2 }]);
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
