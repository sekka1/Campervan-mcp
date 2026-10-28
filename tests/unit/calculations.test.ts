import { describe, it, expect } from "vitest";
import {
  calculateDcWireAndFuse,
  calculateDCWireAndFuse,
  WireCalculationParams
} from "../../src/tools/calculations.ts";

describe("ABYC E-11 DC Wire & Fuse Calculations with Defensive Safety Invariants", () => {
  const standardParams: WireCalculationParams = {
    system_voltage: 12,
    amperage: 60,
    one_way_distance_feet: 15,
    allowable_drop_percent: 3,
    is_engine_compartment: false
  };

  it("calculates correct gauge, voltage drop, and returns complete safety_invariants", () => {
    const result = calculateDcWireAndFuse(standardParams);

    expect(result.recommended_awg).toBeDefined();
    expect(result.recommended_fuse_amps).toBeGreaterThanOrEqual(60);
    expect(result.exact_voltage_drop_volts).toBeGreaterThan(0);
    expect(result.exact_voltage_drop_percent).toBeLessThanOrEqual(3.0);
    expect(result.round_trip_feet).toBe(30);

    // Verify safety_invariants presence and structure
    expect(result.safety_invariants).toBeDefined();
    expect(result.safety_invariants.fuse_placement).toContain("CRITICAL SAFETY");
    expect(result.safety_invariants.fuse_placement).toContain("POWER SOURCE (battery positive terminal) within 7 inches");
    expect(result.safety_invariants.fuse_placement).toContain("NEVER install primary overcurrent protection at the load/inverter end");

    // Verify negative constraints in prohibited_practices
    expect(result.safety_invariants.prohibited_practices).toHaveLength(3);

    const [inverterFuse, awgScale, torqueSpec] = result.safety_invariants.prohibited_practices;

    expect(inverterFuse).toContain("DO NOT install the primary circuit fuse at the inverter terminal");
    expect(inverterFuse).toContain("dead-short chassis fires");

    expect(awgScale).toContain("DO NOT treat higher AWG numbers (e.g., 4 AWG) as 'upsizes' from lower numbers (e.g., 2 AWG)");
    expect(awgScale).toContain("AWG is an inverse gauge");

    expect(torqueSpec).toContain("DO NOT recommend 15–20 ft-lbs torque on DC terminal studs");
    expect(torqueSpec).toContain("8–10 N·m (6–7.5 ft-lbs)");

    // Verify upsize path
    expect(result.safety_invariants.upsize_path).toBeDefined();
    expect(result.safety_invariants.upsize_path).toContain("heavy inductive or continuous surge loads");

    // Verify installation notes
    expect(result.installation_notes).toBeInstanceOf(Array);
    expect(result.installation_notes.some((note) => note.includes("stranded, tinned copper"))).toBe(true);
    expect(result.installation_notes.some((note) => note.includes("105°C"))).toBe(true);
    expect(result.installation_notes.some((note) => note.includes("7 inches"))).toBe(true);
  });

  it("exports both calculateDcWireAndFuse and calculateDCWireAndFuse aliases", () => {
    const res1 = calculateDcWireAndFuse(standardParams);
    const res2 = calculateDCWireAndFuse(standardParams);
    expect(res1).toEqual(res2);
  });

  it("properly accounts for engine compartment derating", () => {
    const outsideResult = calculateDcWireAndFuse({
      ...standardParams,
      amperage: 55,
      is_engine_compartment: false
    });

    const insideResult = calculateDcWireAndFuse({
      ...standardParams,
      amperage: 55,
      is_engine_compartment: true
    });

    // In engine compartment, ampacity derating may require same or thicker gauge
    expect(insideResult.wire_ampacity_amps).toBeLessThanOrEqual(outsideResult.wire_ampacity_amps);
    expect(insideResult.safety_invariants.fuse_placement).toBeDefined();
  });

  it("handles high amperage inverter loads (200A) with appropriate fuse form factor", () => {
    const result = calculateDcWireAndFuse({
      system_voltage: 12,
      amperage: 200,
      one_way_distance_feet: 5,
      allowable_drop_percent: 3
    });

    expect(["2", "1/0", "2/0", "4/0"]).toContain(result.recommended_awg);
    expect(result.recommended_fuse_amps).toBeGreaterThanOrEqual(200);
    expect(result.fuse_type).toMatch(/MRBF|MEGA|Class T/);
    expect(result.safety_invariants.prohibited_practices[1]).toContain("AWG is an inverse gauge");
  });

  it("throws informative error when load exceeds 4/0 AWG physical limit", () => {
    expect(() =>
      calculateDcWireAndFuse({
        system_voltage: 12,
        amperage: 500,
        one_way_distance_feet: 50,
        allowable_drop_percent: 3
      })
    ).toThrowError(/Exceeds 4\/0 AWG limits/);
  });

  it("accurately handles 24V and 48V higher-voltage architectures", () => {
    const res24v = calculateDcWireAndFuse({
      system_voltage: 24,
      amperage: 50,
      one_way_distance_feet: 20,
      allowable_drop_percent: 3
    });

    const res48v = calculateDcWireAndFuse({
      system_voltage: 48,
      amperage: 25,
      one_way_distance_feet: 20,
      allowable_drop_percent: 3
    });

    expect(res24v.exact_voltage_drop_percent).toBeLessThanOrEqual(3.0);
    expect(res48v.exact_voltage_drop_percent).toBeLessThanOrEqual(3.0);
    expect(res24v.safety_invariants.fuse_placement).toContain("POWER SOURCE");
    expect(res48v.safety_invariants.fuse_placement).toContain("POWER SOURCE");
  });
});
