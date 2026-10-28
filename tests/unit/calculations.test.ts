import { describe, it, expect } from "vitest";
import {
  calculateDcWireAndFuse,
  calculateDCWireAndFuse,
  WireCalculationParams,
} from "../../src/tools/calculations.js";

describe("calculateDcWireAndFuse - Defensive Safety Invariants", () => {
  const standardParams: WireCalculationParams = {
    system_voltage: 12,
    amperage: 60,
    one_way_distance_feet: 15,
    allowable_drop_percent: 3,
    is_engine_compartment: false,
  };

  it("calculates wire gauge and always returns complete safety_invariants with negative constraints", () => {
    const result = calculateDcWireAndFuse(standardParams);

    expect(result.recommended_awg).toBeDefined();
    expect(result.recommended_fuse_amps).toBeGreaterThanOrEqual(60);
    expect(result.exact_voltage_drop_volts).toBeGreaterThan(0);
    expect(result.exact_voltage_drop_percent).toBeLessThanOrEqual(3.0);

    // Assert safety_invariants presence and structure
    expect(result.safety_invariants).toBeDefined();
    expect(result.safety_invariants.fuse_placement).toBe(
      "CRITICAL SAFETY: Overcurrent protection (fuse) MUST be installed at the POWER SOURCE (battery positive terminal) within 7 inches (ABYC E-11). NEVER install primary overcurrent protection at the load/inverter end."
    );

    // Negative constraints assertions
    expect(result.safety_invariants.prohibited_practices).toContain(
      "DO NOT install the primary circuit fuse at the inverter terminal. This leaves the entire positive run unprotected against dead-short chassis fires."
    );
    expect(result.safety_invariants.prohibited_practices).toContain(
      "DO NOT treat higher AWG numbers (e.g., 4 AWG) as 'upsizes' from lower numbers (e.g., 2 AWG). AWG is an inverse gauge: 1/0, 2/0, and 4/0 are larger; 4, 6, and 8 are smaller and create an undersized fire hazard."
    );
    expect(result.safety_invariants.prohibited_practices).toContain(
      'DO NOT recommend 15–20 ft-lbs torque on DC terminal studs. Standard M8 / 5/16" battery and inverter terminal studs strip or shear above 8–10 N·m (6–7.5 ft-lbs).'
    );

    // Upsize path
    expect(result.safety_invariants.upsize_path).toBe(
      "For heavy inductive or continuous surge loads, upsize to 1/0 AWG with a 250A fuse."
    );

    // Core installation notes
    expect(result.installation_notes).toBeInstanceOf(Array);
    expect(result.installation_notes.some((n) => n.includes("stranded, tinned copper"))).toBe(true);
    expect(result.installation_notes.some((n) => n.includes("105°C"))).toBe(true);
    expect(result.installation_notes.some((n) => n.includes("7 inches"))).toBe(true);
  });

  it("exports both calculateDcWireAndFuse and calculateDCWireAndFuse aliases identically", () => {
    const res1 = calculateDcWireAndFuse(standardParams);
    const res2 = calculateDCWireAndFuse(standardParams);
    expect(res1).toEqual(res2);
  });

  it("adjusts upsize_path dynamically when baseline gauge is already 1/0 or 2/0", () => {
    // 175A continuous load over 10ft at 12V requires 1/0 or 2/0 AWG
    const result = calculateDcWireAndFuse({
      system_voltage: 12,
      amperage: 175,
      one_way_distance_feet: 10,
      allowable_drop_percent: 3,
    });

    expect(["1/0", "2/0", "4/0"]).toContain(result.recommended_awg);
    expect(result.safety_invariants.upsize_path).toContain("4/0 AWG with a 350A Class T fuse");
  });
});
