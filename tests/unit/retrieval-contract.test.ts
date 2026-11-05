import { describe, it, expect } from "vitest";
import { buildBaseRetrievalContract, searchVanManuals } from "../../src/tools/manuals.ts";

const NEW_RULES = ["evidence_rule", "recommendation_rule", "completeness_and_warnings_rule"] as const;

describe("retrieval contract grounding rules", () => {
  it("defines the evidence, recommendation and completeness rules", () => {
    const contract = buildBaseRetrievalContract();
    expect(contract.evidence_rule).toContain("GENERAL GUIDANCE");
    expect(contract.evidence_rule).toContain("calculate_dc_wire_and_fuse");
    expect(contract.evidence_rule).toContain("Never invent or guess section numbers");
    expect(contract.recommendation_rule).toContain("documented for <purpose>, not documented for auxiliary use");
    expect(contract.completeness_and_warnings_rule).toContain("CAUTION / WARNING / NOTE");
  });

  it("keeps the new rules vehicle-, component- and model-year-agnostic (AGENTS.md anti-hardcoding rule)", () => {
    const contract = buildBaseRetrievalContract();
    const FORBIDDEN = /\b(ford|transit|sprinter|promaster|ram|dodge|mercedes|victron|bemm|e-transit|20\d{2})\b/i;
    for (const key of NEW_RULES) {
      expect(contract[key], key).not.toMatch(FORBIDDEN);
    }
    expect(contract.answer_checklist.join(" ")).not.toMatch(FORBIDDEN);
  });

  it("provides a short answer checklist covering the highest-value rules", () => {
    const { answer_checklist: list } = buildBaseRetrievalContract();
    expect(list).toHaveLength(6);
    const joined = list.join(" ");
    expect(joined).toContain("NOT an approval list");
    expect(joined).toContain("missing numbers");
    expect(joined).toContain("General guidance (not from the indexed manuals)");
    expect(list.every((item) => item.length < 400)).toBe(true);
  });

  it("states that inclusion in a list is not approval and forbids picking items in own advice", () => {
    const contract = buildBaseRetrievalContract();
    expect(contract.evidence_rule).toContain("Inclusion in a table or list is not approval");
    expect(contract.recommendation_rule).toContain("must not pick, rank or endorse specific items");
  });

  it("is attached to responses with and without matches", async () => {
    const noMatch = await searchVanManuals("anything");
    for (const key of NEW_RULES) {
      expect(noMatch.retrieval_metadata.retrieval_contract[key]).toBeTruthy();
    }
  });
});
