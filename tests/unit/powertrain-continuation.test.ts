import { describe, it, expect } from "vitest";
import { promoteNonBevNeighbors, extractNeutralSectionContext, type HydratedChunk } from "../../src/utils/db.ts";

const bevMeta = JSON.stringify({ fuel: "bev", powertrain: "bev" });
const iceMeta = JSON.stringify({ fuel: "ice", powertrain: "ice" });

function chunk(id: string, page: number, meta: string, extra: Partial<HydratedChunk> = {}): HydratedChunk {
  return {
    id,
    document_id: "doc",
    document_title: "2024 Ford Transit (US)",
    category: "chassis",
    manufacturer: "ford",
    applicable_chassis: "transit",
    page_number: page,
    section_title: null,
    subsystem: "chassis_interface",
    chunk_text: "text",
    schematic_r2_key: null,
    schematic_caption: null,
    metadata_json: meta,
    ...extra,
  };
}

function mockDb(rows: HydratedChunk[]) {
  return {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: rows }) }),
    }),
  } as unknown as Parameters<typeof promoteNonBevNeighbors>[0];
}

describe("promoteNonBevNeighbors", () => {
  it("promotes non-BEV neighbours of a top-ranked BEV chunk, inheriting rank and section title", async () => {
    const parent = chunk("doc#chunk_1", 150, bevMeta, { section_title: "4.25 Grounding" });
    const neighbours = [
      chunk("doc#chunk_2", 151, iceMeta, { schematic_r2_key: "p151.png" }),
      chunk("doc#chunk_3", 152, bevMeta),
      chunk("doc#chunk_4", 153, iceMeta),
    ];
    const matches = [{ id: parent.id, score: 0.8, metadata: { source: "s", text: "" } }];
    const hydrated = new Map([[parent.id, parent]]);

    await promoteNonBevNeighbors(mockDb(neighbours), matches, hydrated);

    expect(matches.map((m) => m.id)).toEqual(["doc#chunk_1", "doc#chunk_2", "doc#chunk_4"]);
    expect(matches[1]!.score).toBeLessThan(0.8);
    expect(hydrated.get("doc#chunk_2")!.section_title).toBe("4.25 Grounding (continued on p151)");
    expect(hydrated.has("doc#chunk_3")).toBe(false);
  });

  it("does nothing when the top hits are not BEV", async () => {
    const parent = chunk("doc#chunk_1", 10, iceMeta);
    const matches = [{ id: parent.id, score: 0.8, metadata: { source: "s", text: "" } }];
    const hydrated = new Map([[parent.id, parent]]);

    await promoteNonBevNeighbors(mockDb([chunk("doc#chunk_2", 11, iceMeta)]), matches, hydrated);

    expect(matches).toHaveLength(1);
  });

  it("does not duplicate chunks already in the candidate set", async () => {
    const parent = chunk("doc#chunk_1", 150, bevMeta);
    const existing = chunk("doc#chunk_2", 151, iceMeta);
    const matches = [
      { id: parent.id, score: 0.8, metadata: { source: "s", text: "" } },
      { id: existing.id, score: 0.79, metadata: { source: "s", text: "" } },
    ];
    const hydrated = new Map([[parent.id, parent], [existing.id, existing]]);

    await promoteNonBevNeighbors(mockDb([existing]), matches, hydrated);

    expect(matches.map((m) => m.id)).toEqual(["doc#chunk_1", "doc#chunk_2"]);
  });

  it("inserts promoted chunks immediately after their parent, ahead of lower-ranked peers", async () => {
    const parent = chunk("doc#chunk_1", 150, bevMeta, { section_title: "4.25 Grounding" });
    const peer = chunk("other#chunk_9", 40, iceMeta, { document_id: "other" });
    const matches = [
      { id: parent.id, score: 0.8, metadata: { source: "s", text: "" } },
      { id: peer.id, score: 0.7, metadata: { source: "s", text: "" } },
    ];
    const hydrated = new Map([[parent.id, parent], [peer.id, peer]]);

    await promoteNonBevNeighbors(mockDb([chunk("doc#chunk_2", 151, iceMeta)]), matches, hydrated);

    expect(matches.map((m) => m.id)).toEqual(["doc#chunk_1", "doc#chunk_2", "other#chunk_9"]);
  });

  it("moves an already-present, low-ranked continuation up next to the parent without duplicating it", async () => {
    const parent = chunk("doc#chunk_1", 150, bevMeta, { section_title: "4.25 Grounding" });
    const lowRanked = chunk("doc#chunk_2", 151, iceMeta);
    const fillers = Array.from({ length: 10 }, (_, i) => ({
      id: `f#chunk_${i}`,
      score: 0.7 - i * 0.01,
      metadata: { source: "s", text: "" },
    }));
    const matches = [
      { id: parent.id, score: 0.8, metadata: { source: "s", text: "" } },
      ...fillers,
      { id: lowRanked.id, score: 0.3, metadata: { source: "s", text: "" } },
    ];
    const hydrated = new Map([[parent.id, parent], [lowRanked.id, lowRanked]]);

    await promoteNonBevNeighbors(mockDb([lowRanked]), matches, hydrated);

    expect(matches.map((m) => m.id).filter((id) => id === lowRanked.id)).toHaveLength(1);
    expect(matches[1]!.id).toBe(lowRanked.id);
    expect(matches[1]!.score).toBeGreaterThan(0.79);
  });

  it("stops at a section boundary instead of promoting an unrelated section", async () => {
    const parent = chunk("doc#chunk_1", 150, bevMeta, { section_title: "4.25 Grounding" });
    const neighbours = [
      chunk("doc#chunk_2", 151, iceMeta, { chunk_text: "figure labels 49 50 51" }),
      chunk("doc#chunk_3", 152, iceMeta, { chunk_text: "4.26 Battery Isolation Switch Mount the switch", section_title: "4.26 Battery Isolation Switch" }),
      chunk("doc#chunk_4", 153, iceMeta, { chunk_text: "more text" }),
    ];
    const matches = [{ id: parent.id, score: 0.8, metadata: { source: "s", text: "" } }];
    const hydrated = new Map([[parent.id, parent]]);

    await promoteNonBevNeighbors(mockDb(neighbours), matches, hydrated);

    expect(matches.map((m) => m.id)).toEqual(["doc#chunk_1", "doc#chunk_2"]);
  });

  it("keeps a neighbour's own heading when it continues the same section with a sub-heading", async () => {
    const parent = chunk("doc#chunk_1", 150, bevMeta, { section_title: "4.25 Grounding" });
    const sub = chunk("doc#chunk_2", 151, iceMeta, {
      chunk_text: "4.25.2 Ground Torque Tighten to spec",
      section_title: "4.25.2 Ground Torque",
    });
    const matches = [{ id: parent.id, score: 0.8, metadata: { source: "s", text: "" } }];
    const hydrated = new Map([[parent.id, parent]]);

    await promoteNonBevNeighbors(mockDb([sub]), matches, hydrated);

    expect(hydrated.get("doc#chunk_2")!.section_title).toBe("4.25.2 Ground Torque");
  });
});

describe("extractNeutralSectionContext", () => {
  const opener =
    "Date of Publication: 04/2024 ACME VAN & E-VAN 150 Electrical 4.25 Mounting 4.25.1 Anchor Points " +
    "CAUTIONS: Only use the anchor points indicated. Using other points may affect integrity. " +
    "Make sure every fastener is tightened to the correct torque. " +
    "WARNING: Paths for High Voltage components on the E-VAN BEV must not be altered. " +
    "This may require a welded stud on the body panel. " +
    "NOTE: On E-VAN BEV applications create your own anchor. " +
    "E185976b 22 2123 18 7 8 15 9 27 28 29 1 3 4 BEV Common Points";

  it("keeps variant-neutral CAUTION prose and drops variant-specific blocks and figure labels", () => {
    const notes = extractNeutralSectionContext(opener);
    expect(notes).toContain("Only use the anchor points indicated.");
    expect(notes).toContain("tightened to the correct torque.");
    expect(notes).not.toMatch(/BEV|High Voltage|welded stud|E185976b|2123/);
  });

  it("returns an empty string when there are no CAUTION/WARNING/NOTE blocks", () => {
    expect(extractNeutralSectionContext("4.25 Mounting plain descriptive text without any block keyword here")).toBe("");
    expect(extractNeutralSectionContext(null)).toBe("");
  });

  it("is attached to the first promoted continuation only", async () => {
    const parent = chunk("doc#chunk_1", 150, bevMeta, { section_title: "4.25 Mounting", chunk_text: opener });
    const neighbours = [
      chunk("doc#chunk_2", 151, iceMeta, { chunk_text: "figure labels 49 50 51" }),
      chunk("doc#chunk_3", 153, iceMeta, { chunk_text: "table rows" }),
    ];
    const matches = [{ id: parent.id, score: 0.8, metadata: { source: "s", text: "" } }];
    const hydrated = new Map([[parent.id, parent]]);

    await promoteNonBevNeighbors(mockDb(neighbours), matches, hydrated);

    expect(hydrated.get("doc#chunk_2")!.chunk_text).toContain("Only use the anchor points indicated.");
    expect(hydrated.get("doc#chunk_2")!.chunk_text).toContain("preceding p150 opener");
    expect(hydrated.get("doc#chunk_3")!.chunk_text).toBe("table rows");
  });
});
