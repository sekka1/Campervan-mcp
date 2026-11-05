import { describe, it, expect, vi } from "vitest";
import { assessAmbiguity, type AmbiguityCandidate } from "../../src/utils/disambiguation.ts";
import { hybridSearch, hybridSearchDetailed } from "../../src/utils/db.ts";
import { buildClarificationPayload } from "../../src/tools/manuals.ts";

// Neutral, synthetic documents on purpose: the behaviour must hold for any vehicle, appliance or system.
function cand(doc: string, n: number, extra: Partial<AmbiguityCandidate> = {}): AmbiguityCandidate {
  return {
    id: `${doc}#chunk_${n}`,
    document_title: `Title ${doc}`,
    manufacturer: "widgetco",
    model: "alpha",
    market: "us",
    model_year: 2024,
    ...extra,
  };
}

describe("assessAmbiguity", () => {
  const twoEditions = [
    cand("d2024", 1, { model_year: 2024 }),
    cand("d2020", 1, { model_year: 2020 }),
    cand("d2024", 2, { model_year: 2024 }),
    cand("d2020", 2, { model_year: 2020 }),
  ];

  it("asks for the model year when the best results come from editions that differ only by year", () => {
    const c = assessAmbiguity(twoEditions, {});
    expect(c?.needs_clarification).toBe(true);
    expect(c?.missing_context).toEqual(["model_year"]);
    expect(c?.choices.model_year).toEqual(["2020", "2024"]);
    expect(c?.options.map((o) => o.model_year)).toEqual(["2024", "2020"]);
    expect(c?.suggested_question).toContain("model year");
    expect(c?.instruction).toContain("do NOT pick an option yourself");
  });

  it("does not ask about a facet the caller already specified", () => {
    expect(assessAmbiguity(twoEditions, { model_year: 2024 })).toBeUndefined();
  });

  it("does not ask when a specific manual (source) was requested", () => {
    expect(assessAmbiguity(twoEditions, { source: "some_manual" })).toBeUndefined();
  });

  it("asks about several facets at once and counts a chassis filter as a model", () => {
    const mixed = [
      cand("a", 1, { model: "alpha", market: "us" }),
      cand("b", 1, { model: "beta", market: "eu" }),
      cand("a", 2, { model: "alpha", market: "us" }),
      cand("b", 2, { model: "beta", market: "eu" }),
    ];
    expect(assessAmbiguity(mixed, { model_year: 2024 })?.missing_context).toEqual(["model", "market"]);
    expect(assessAmbiguity(mixed, { chassis: "alpha", model_year: 2024 })?.missing_context).toEqual(["market"]);
  });

  it("asks about the manufacturer when unrelated products match a generic question", () => {
    const c = assessAmbiguity(
      [cand("x", 1, { manufacturer: "acme" }), cand("y", 1, { manufacturer: "widgetco" }), cand("x", 2, { manufacturer: "acme" })],
      { model: "alpha", model_year: 2024, market: "us" }
    );
    expect(c?.missing_context).toEqual(["manufacturer"]);
  });

  it("does not ask when there is only one document, or when documents share every facet", () => {
    expect(assessAmbiguity([cand("only", 1), cand("only", 2), cand("only", 3)], {})).toBeUndefined();
    expect(assessAmbiguity([cand("manual_a", 1), cand("manual_b", 1)], {})).toBeUndefined();
  });

  it("ignores a stray low-ranked chunk from another edition", () => {
    const results = [cand("d2024", 1), cand("d2024", 2), cand("d2024", 3), cand("d2024", 4), cand("d2024", 5), cand("d2024", 6), cand("d2020", 1, { model_year: 2020 })];
    expect(assessAmbiguity(results, {})).toBeUndefined();
  });

  it("labels open year ranges and ignores missing facet values", () => {
    const c = assessAmbiguity(
      [
        cand("r", 1, { model_year: 2020, metadata_json: JSON.stringify({ year_start: 2020, year_end: 2022 }) }),
        cand("s", 1, { model_year: 2023, market: undefined }),
      ],
      {}
    );
    expect(c?.choices.model_year).toEqual(["2020-2022", "2023"]);
    expect(c?.missing_context).toEqual(["model_year"]);
  });

  it("returns nothing for an empty result list", () => {
    expect(assessAmbiguity([], {})).toBeUndefined();
  });
});

describe("hybridSearchDetailed clarification gate", () => {
  const vec = new Array(768).fill(0.1) as number[];
  const row = (doc: string, n: number, year: number, text: string) => ({
    id: `${doc}#chunk_${n}`, document_id: doc, document_title: `Doc ${doc}`, category: "other", manufacturer: "widgetco",
    applicable_chassis: "universal", page_number: n, section_title: null, subsystem: "structural", chunk_text: text,
    schematic_r2_key: null, schematic_caption: null, model: "alpha", market: "us",
    metadata_json: JSON.stringify({ year_start: year, year_end: year }),
  });
  const rows = [
    row("d2024", 1, 2024, "The pump bracket is fixed with four bolts and a sealing washer on the rear panel."),
    row("d2020", 1, 2020, "The pump bracket is fixed with four bolts and a sealing washer on the rear panel."),
    row("d2024", 2, 2024, "Tank venting hose routing requires a rising loop near the filler neck assembly."),
    row("d2020", 2, 2020, "Tank venting hose routing requires a rising loop near the filler neck assembly."),
  ];
  const matches = rows.map((r, i) => ({ id: r.id, score: 0.9 - i * 0.01, metadata: { source: "s", text: "" } }));
  const run = (options: Parameters<typeof hybridSearchDetailed>[3]) =>
    hybridSearchDetailed(
      { query: vi.fn().mockResolvedValue({ matches }) } as unknown as VectorizeIndex,
      { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as unknown as D1Database,
      vec,
      options
    );

  it("returns a clarification and no results when editions differ and no year was given", async () => {
    const out = await run({ clarify: true });
    expect(out.results).toEqual([]);
    expect(out.clarification?.missing_context).toEqual(["model_year"]);
  });

  it("answers normally once the year is specified", async () => {
    const out = await run({ clarify: true, model_year: 2024 });
    expect(out.clarification).toBeUndefined();
    expect(out.results.length).toBeGreaterThan(0);
  });

  it("keeps every edition (no newest-wins collapsing) when all variants are requested", async () => {
    const all = await run({ clarify: false, collapseEditions: false });
    expect(all.results.map((r) => r.id)).toEqual(expect.arrayContaining(["d2024#chunk_1", "d2020#chunk_1"]));
    expect(all.results).toHaveLength(4);
    // Default behaviour for a caller that already gave context: near-identical editions collapse (newest wins).
    const collapsed = await run({ clarify: false });
    expect(collapsed.results.map((r) => r.id)).toEqual(["d2024#chunk_1", "d2024#chunk_2"]);
  });

  it("hybridSearch (legacy helper) never asks, it only returns ranked results", async () => {
    const results = await hybridSearch(
      { query: vi.fn().mockResolvedValue({ matches }) } as unknown as VectorizeIndex,
      { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as unknown as D1Database,
      vec,
      {}
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("buildClarificationPayload", () => {
  it("looks like a normal search response with no results plus the clarification", () => {
    const clarification = assessAmbiguity(
      [cand("d2024", 1), cand("d2020", 1, { model_year: 2020 })],
      {}
    )!;
    const payload = buildClarificationPayload("how do I mount the pump", clarification, { manufacturer: "widgetco" });
    expect(payload.count).toBe(0);
    expect(payload.results).toEqual([]);
    expect(payload.needs_clarification).toBe(true);
    expect(payload.retrieval_metadata.needs_clarification).toBe(true);
    expect(payload.retrieval_metadata.retrieval_contract.context_rule).toContain("NO ASSUMED CONTEXT");
    expect(payload.message).toContain("More context needed");
    expect(payload.applied_filters).toEqual({ manufacturer: "widgetco" });
  });
});

describe("search_van_manuals tool handler (end to end with mocks)", () => {
  const row = (doc: string, n: number, year: number) => ({
    id: `${doc}#chunk_${n}`, document_id: doc, document_title: `Doc ${doc}`, category: "other", manufacturer: "widgetco",
    applicable_chassis: "universal", page_number: n, section_title: null, subsystem: "structural",
    chunk_text: `Mounting step ${n} for the pump bracket uses four bolts and a sealing washer on the panel.`,
    schematic_r2_key: null, schematic_caption: null, model: "alpha", market: "us",
    metadata_json: JSON.stringify({ year_start: year, year_end: year }),
  });
  const rows = [row("d2024", 1, 2024), row("d2020", 1, 2020), row("d2024", 2, 2024), row("d2020", 2, 2020)];

  async function callTool(args: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embeddings: [new Array(768).fill(0.1)] }) })
    );
    const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {};
    const fakeMcp = { registerTool: (name: string, _cfg: unknown, h: (typeof handlers)[string]) => void (handlers[name] = h) };
    const { registerManualTools } = await import("../../src/tools/manuals.ts");
    registerManualTools(
      fakeMcp as never,
      { query: vi.fn().mockResolvedValue({ matches: rows.map((r, i) => ({ id: r.id, score: 0.9 - i * 0.01, metadata: { source: "s", text: "" } })) }) } as unknown as VectorizeIndex,
      undefined,
      { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as unknown as D1Database,
      undefined,
      "token",
      "deepinfra"
    );
    const res = await handlers["search_van_manuals"]!({ query: "how is the pump bracket mounted", ...args });
    return JSON.parse(res.content[0]!.text);
  }

  it("returns needs_clarification with options instead of picking an edition", async () => {
    const out = await callTool({});
    expect(out.needs_clarification).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.clarification.missing_context).toEqual(["model_year"]);
    expect(out.clarification.choices.model_year).toEqual(["2020", "2024"]);
    expect(out.retrieval_metadata.retrieval_contract.context_rule).toContain("NO ASSUMED CONTEXT");
  });

  it("answers when the caller supplies the missing context", async () => {
    const out = await callTool({ model_year: 2024 });
    expect(out.needs_clarification).toBeUndefined();
    expect(out.count).toBeGreaterThan(0);
  });

  it("returns every variant, each with its own year, when include_all_variants is set", async () => {
    const out = await callTool({ include_all_variants: true });
    expect(out.needs_clarification).toBeUndefined();
    expect(out.results.map((r: { model_year: number }) => r.model_year).sort()).toEqual([2020, 2020, 2024, 2024]);
  });
});
