import { describe, it, expect } from "vitest";
import { findUngroundedClaims, groundingAssertion, parseProviderOutput } from "../grounding-check.mjs";

// Deliberately NOT vehicle-specific: the checker must work for any system (water heater here).
function trace(results: Array<Record<string, unknown>>): string {
  const payload = {
    retrieval_metadata: { retrieval_contract: { evidence_rule: "standards like ABYC, NEC, ISO" } },
    results,
    count: results.length,
  };
  return `MCP Tool Result (search_van_manuals): ${JSON.stringify([{ type: "text", text: JSON.stringify(payload) }])}`;
}

const CHUNK = {
  page: 42,
  section: "3.2 Water Heater Mounting",
  text: "3.2 Water Heater Mounting Secure the bracket with M6 screws to 8.85 ft lb (12 Nm). Part 14K024 supplies 120V. Maximum pressure 45 psi.",
};

describe("grounding-check", () => {
  it("accepts an answer whose specs, sections, pages and parts are all in the evidence", () => {
    const output = `${trace([CHUNK])}\n\nTorque the bracket to **8.85 ft·lb (12 Nm)** (Section 3.2, p. 42). Part 14K024 is rated for 120V and 45 psi.`;
    const res = groundingAssertion(output, { vars: { question: "how do I mount the heater?" } });
    expect(res.reason).toContain("All specs");
    expect(res.pass).toBe(true);
  });

  it("flags invented specs, section/page citations, part numbers and standards", () => {
    const output = `${trace([CHUNK])}\n\nPer Section 4.5.2 (p. 99), loads over 40A need a 10 AWG cable, part 77Z999, and ABYC E-11 requires 25 ft-lb.`;
    const { answer, evidence, pages } = parseProviderOutput(output);
    const kinds = findUngroundedClaims({ answer, evidence, pages }).map((c) => `${c.type}:${c.claim}`);
    expect(kinds).toEqual(
      expect.arrayContaining(["section:Section 4.5.2", "page:page 99", "spec:40A", "spec:10 AWG", "part:77Z999", "standard:ABYC", "spec:25 ft-lb"])
    );
  });

  it("does not count the retrieval contract's instructions as evidence", () => {
    const output = `${trace([CHUNK])}\n\nFollow ABYC guidance.`;
    const res = groundingAssertion(output, {});
    expect(res.pass).toBe(false);
    expect(res.reason).toContain("standard: ABYC");
  });

  it("accepts values restated from the user's question and tool-computed values", () => {
    const calc = `MCP Tool Result (calculate_dc_wire_and_fuse): ${JSON.stringify([{ type: "text", text: JSON.stringify({ recommended_awg: "2 AWG", fuse_amps: 200 }) }])}`;
    const output = `${trace([CHUNK])}\n${calc}\n\nFor your 2000W load use 2 AWG.`;
    const res = groundingAssertion(output, { vars: { question: "size cable for a 2000W load" } });
    expect(res.pass).toBe(true);
  });

  it("ignores ambiguous single letters in prose and table cells", () => {
    const output = `${trace([CHUNK])}\n\n| 62 A Pillar | W | 3 L |\nUse the 3.2 mounting steps.`;
    expect(groundingAssertion(output, {}).pass).toBe(true);
  });

  it("skips when there is no tool evidence", () => {
    expect(groundingAssertion("just an answer with 40A", {}).pass).toBe(true);
  });
});
