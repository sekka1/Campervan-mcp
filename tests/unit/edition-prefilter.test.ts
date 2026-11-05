import { describe, it, expect, vi } from "vitest";
import { hybridSearchDetailed, MAX_FILTERED_CANDIDATE_POOL } from "../../src/utils/db.ts";

// Neutral fixtures: three editions of one product. The behaviour must hold for any manual set.
const vec = new Array(768).fill(0.1) as number[];
const chunk = (doc: string, n: number) => ({
  id: `${doc}#chunk_${n}`, document_id: doc, document_title: `Doc ${doc}`, category: "other", manufacturer: "widgetco",
  applicable_chassis: "universal", page_number: n, section_title: null, subsystem: "structural",
  chunk_text: `Unique passage ${doc} ${n} about mounting brackets and sealing washers on the rear panel`,
  schematic_r2_key: null, schematic_caption: null, model: "alpha", market: "us",
  metadata_json: JSON.stringify({ year_start: Number(doc.slice(1)), year_end: null }),
});
const rows = [chunk("d2024", 1), chunk("d2024", 2), chunk("d2020", 1), chunk("d2027", 1)];
// Candidate pool in which the requested edition (d2024) is a small minority, as with near-identical editions.
const pool = ["d2020#chunk_1", "d2027#chunk_1", "d2020#chunk_2", "d2027#chunk_2", "d2024#chunk_1", "d2024#chunk_2"].map((id, i) => ({
  id, score: 0.9 - i * 0.01, metadata: { source: "s", text: "" },
}));

function setup(scope: "narrow" | "all" | "unusable" | "throws") {
  const hydrateIds: string[][] = [];
  const seenSql: string[] = [];
  const query = vi.fn().mockResolvedValue({ matches: pool });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      all: async () => {
        seenSql.push(sql);
        if (sql.includes("ON 1 = 0")) {
          if (scope === "throws") throw new Error("d1 unavailable");
          if (scope === "unusable") return { results: [{ id: "d2024" }, { id: "d2020" }] }; // no `ok` column
          const ok = scope === "narrow" ? { d2024: 1, d2020: 0, d2027: 0 } : { d2024: 1, d2020: 1, d2027: 1 };
          return { results: Object.entries(ok).map(([id, v]) => ({ id, ok: v })) };
        }
        if (sql.includes("c.id IN")) hydrateIds.push(params.filter((p): p is string => typeof p === "string" && p.includes("#chunk_")));
        return { results: rows };
      },
    }),
  }));
  const run = (options: Parameters<typeof hybridSearchDetailed>[3]) =>
    hybridSearchDetailed({ query } as unknown as VectorizeIndex, { prepare } as unknown as D1Database, vec, options);
  return { run, query, hydrateIds, seenSql };
}

describe("edition pre-filter before ranking", () => {
  it("fetches the largest pool and keeps only candidates of the allowed edition when the filters narrow the corpus", async () => {
    const t = setup("narrow");
    await t.run({ model_year: 2024, topK: 8 });

    expect(t.query).toHaveBeenCalledWith(vec, expect.objectContaining({ topK: MAX_FILTERED_CANDIDATE_POOL, returnMetadata: "indexed" }));
    // Only d2024 candidates reach hydration; without the pre-filter the d2020/d2027 ones would crowd the pool.
    expect(t.hydrateIds[0]).toEqual(["d2024#chunk_1", "d2024#chunk_2"]);
  });

  it("keeps the normal pool when the filters do not exclude any document", async () => {
    const t = setup("all");
    await t.run({ model_year: 2024, topK: 8 });

    expect(t.query).toHaveBeenCalledWith(vec, expect.objectContaining({ topK: 24, returnMetadata: "all" }));
    expect(t.hydrateIds[0]).toContain("d2020#chunk_1"); // nothing was pre-filtered
  });

  it("does not even look up editions when no edition-narrowing filter is given", async () => {
    const t = setup("narrow");
    await t.run({ topK: 8 });
    expect(t.seenSql.some((s) => s.includes("ON 1 = 0"))).toBe(false);
    expect(t.query).toHaveBeenCalledWith(vec, expect.objectContaining({ topK: 24 }));
  });

  it("falls back to filtering after ranking when the edition lookup fails or returns an unusable shape", async () => {
    for (const mode of ["throws", "unusable"] as const) {
      const t = setup(mode);
      const out = await t.run({ model_year: 2024, topK: 8 });
      expect(t.query).toHaveBeenCalledWith(vec, expect.objectContaining({ topK: 24, returnMetadata: "all" }));
      expect(out.results.length).toBeGreaterThan(0);
    }
  });

  it("retries without the metadata filter, still pre-filtered, when the Vectorize metadata filter matches nothing", async () => {
    const t = setup("narrow");
    t.query.mockReset();
    t.query.mockResolvedValueOnce({ matches: [] }).mockResolvedValueOnce({ matches: pool });

    await t.run({ model_year: 2024, subsystem: "structural", topK: 8 });

    expect(t.query).toHaveBeenCalledTimes(2);
    expect(t.query.mock.calls[0]![1]).toMatchObject({ topK: MAX_FILTERED_CANDIDATE_POOL, filter: { subsystem: { $eq: "structural" } } });
    expect(t.query.mock.calls[1]![1].filter).toBeUndefined();
    expect(t.hydrateIds[0]).toEqual(["d2024#chunk_1", "d2024#chunk_2"]);
  });
});
