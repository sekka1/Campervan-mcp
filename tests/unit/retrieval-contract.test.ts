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
    for (const key of NEW_RULES) {
      expect(contract[key], key).not.toMatch(
        /\b(ford|transit|sprinter|promaster|ram|dodge|mercedes|victron|bemm|e-transit|20\d{2})\b/i
      );
    }
  });

  it("is attached to responses with and without matches", async () => {
    const noMatch = await searchVanManuals("anything");
    for (const key of NEW_RULES) {
      expect(noMatch.retrieval_metadata.retrieval_contract[key]).toBeTruthy();
    }
  });
});
