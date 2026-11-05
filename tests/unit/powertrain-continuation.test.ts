import { describe, it, expect } from "vitest";
import { promoteNonBevNeighbors, type HydratedChunk } from "../../src/utils/db.ts";

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
    const matches = [{ id: parent.id, score: 0.8, metadata: { source: "s", text: "" } }];
    const hydrated = new Map([[parent.id, parent], [existing.id, existing]]);

    await promoteNonBevNeighbors(mockDb([existing]), matches, hydrated);

    expect(matches).toHaveLength(1);
  });
});
