import { describe, it, expect } from "vitest";
import {
  evaluateChassisRules,
  normalizeChassisId,
  normalizeRuleCategory,
} from "../../src/utils/formulas";

describe("normalizeChassisId", () => {
  it("normalizes Ford Transit variants", () => {
    expect(normalizeChassisId("ford_transit")).toEqual({
      canonical: "ford_transit",
      alias: "transit",
    });
    expect(normalizeChassisId("transit")).toEqual({
      canonical: "ford_transit",
      alias: "transit",
    });
    expect(normalizeChassisId("Ford Transit 148 EXT")).toEqual({
      canonical: "ford_transit",
      alias: "transit",
    });
  });

  it("normalizes Mercedes Sprinter variants", () => {
    expect(normalizeChassisId("mercedes_sprinter")).toEqual({
      canonical: "mercedes_sprinter",
      alias: "sprinter",
    });
    expect(normalizeChassisId("sprinter")).toEqual({
      canonical: "mercedes_sprinter",
      alias: "sprinter",
    });
    expect(normalizeChassisId("Mercedes-Benz VS30")).toEqual({
      canonical: "mercedes_sprinter",
      alias: "sprinter",
    });
  });

  it("normalizes RAM ProMaster variants", () => {
    expect(normalizeChassisId("ram_promaster")).toEqual({
      canonical: "ram_promaster",
      alias: "promaster",
    });
    expect(normalizeChassisId("promaster")).toEqual({
      canonical: "ram_promaster",
      alias: "promaster",
    });
    expect(normalizeChassisId("RAM 2500")).toEqual({
      canonical: "ram_promaster",
      alias: "promaster",
    });
  });

  it("falls back to universal for unknown chassis", () => {
    expect(normalizeChassisId("universal")).toEqual({
      canonical: "universal",
      alias: "universal",
    });
    expect(normalizeChassisId("custom_box_truck")).toEqual({
      canonical: "universal",
      alias: "universal",
    });
  });
});

describe("normalizeRuleCategory", () => {
  it("maps roof and rack terms to roof_load", () => {
    expect(normalizeRuleCategory("roof_load")).toBe("roof_load");
    expect(normalizeRuleCategory("roof_rack")).toBe("roof_load");
    expect(normalizeRuleCategory("solar_mounting")).toBe("roof_load");
  });

  it("maps electrical, ground, alternator, and CCP/EK1 terms to electrical_tap", () => {
    expect(normalizeRuleCategory("electrical")).toBe("electrical_tap");
    expect(normalizeRuleCategory("electrical_ground")).toBe("electrical_tap");
    expect(normalizeRuleCategory("alternator")).toBe("electrical_tap");
    expect(normalizeRuleCategory("ccp2")).toBe("electrical_tap");
    expect(normalizeRuleCategory("ek1")).toBe("electrical_tap");
  });

  it("maps cutting, drilling, and pillar terms to structural_cutting", () => {
    expect(normalizeRuleCategory("drilling")).toBe("structural_cutting");
    expect(normalizeRuleCategory("cut")).toBe("structural_cutting");
    expect(normalizeRuleCategory("structural_pillars")).toBe("structural_cutting");
  });

  it("maps floor, tie-down, and tank terms to floor_mounting", () => {
    expect(normalizeRuleCategory("floor_mounting")).toBe("floor_mounting");
    expect(normalizeRuleCategory("tie_down")).toBe("floor_mounting");
    expect(normalizeRuleCategory("water_tank")).toBe("floor_mounting");
  });

  it("maps heater, exhaust, and ventilation terms to heating_ventilation", () => {
    expect(normalizeRuleCategory("heating_ventilation")).toBe("heating_ventilation");
    expect(normalizeRuleCategory("diesel_heater")).toBe("heating_ventilation");
    expect(normalizeRuleCategory("exhaust")).toBe("heating_ventilation");
  });

  it("returns general for unrecognized rule types", () => {
    expect(normalizeRuleCategory("paint_color")).toBe("general");
  });
});

describe("evaluateChassisRules", () => {
  it("returns specific roof load rules for promaster (150 lbs limit)", () => {
    const result = evaluateChassisRules("ram_promaster", "roof_load");
    expect(result.canonical_chassis).toBe("ram_promaster");
    expect(result.chassis_alias).toBe("promaster");
    expect(result.rule_category).toBe("roof_load");
    expect(result.max_roof_load_lbs).toBe(150);
    expect(result.guidance).toContain("150 lbs");
    expect(result.is_compliant).toBe(true);
  });

  it("returns specific roof load rules for sprinter (220 lbs baseline without rails, 330 lbs with rails)", () => {
    const result = evaluateChassisRules("mercedes_sprinter", "roof_load");
    expect(result.canonical_chassis).toBe("mercedes_sprinter");
    expect(result.max_roof_load_lbs).toBe(220);
    expect(result.guidance).toContain("330 lbs");
    expect(result.guidance).toContain("220 lbs");
  });

  it("returns electrical CCP1/CCP2 rules for transit (60A single stud limit)", () => {
    const result = evaluateChassisRules("ford_transit", "electrical");
    expect(result.canonical_chassis).toBe("ford_transit");
    expect(result.rule_category).toBe("electrical_tap");
    expect(result.max_alternator_tap_amps).toBe(60);
    expect(result.guidance).toContain("CCP1/CCP2");
    expect(result.oem_connection_point).toContain("CCP2");
  });

  it("returns EK1 electrical rules for sprinter (25A conservative EK1 Terminal 30 baseline)", () => {
    const result = evaluateChassisRules("sprinter", "electrical_tap");
    expect(result.canonical_chassis).toBe("mercedes_sprinter");
    expect(result.max_alternator_tap_amps).toBe(25);
    expect(result.guidance).toContain("EK1");
  });

  it("returns structural cutting and no-drill rules across chassis", () => {
    for (const chassis of ["ford_transit", "mercedes_sprinter", "ram_promaster", "universal"]) {
      const result = evaluateChassisRules(chassis, "drilling");
      expect(result.rule_category).toBe("structural_cutting");
      expect(result.prohibited_practices.length).toBeGreaterThan(0);
      expect(result.allowed_practices.length).toBeGreaterThan(0);
    }
  });

  it("returns floor mounting and heating/ventilation rules across chassis", () => {
    for (const chassis of ["transit", "sprinter", "promaster", "universal"]) {
      const floorRes = evaluateChassisRules(chassis, "floor_mounting");
      expect(floorRes.rule_category).toBe("floor_mounting");
      expect(floorRes.oem_connection_point).toBeTruthy();

      const heatRes = evaluateChassisRules(chassis, "heating_ventilation");
      expect(heatRes.rule_category).toBe("heating_ventilation");
      expect(heatRes.oem_connection_point).toBeTruthy();
    }
  });

  it("flags non-compliant proposed roof loads when exceeding OEM limit", () => {
    const nonCompliant = evaluateChassisRules("ram_promaster", "roof_load", {
      proposed_roof_load_lbs: 220,
    });
    expect(nonCompliant.is_compliant).toBe(false);
    expect(nonCompliant.compliance_warnings[0]).toContain("NON-COMPLIANT");
    expect(nonCompliant.compliance_warnings[0]).toContain("220 lbs");

    const compliant = evaluateChassisRules("ram_promaster", "roof_load", {
      proposed_roof_load_lbs: 120,
    });
    expect(compliant.is_compliant).toBe(true);
    expect(compliant.compliance_warnings).toHaveLength(0);
  });

  it("flags non-compliant proposed alternator tap current when exceeding OEM stud rating", () => {
    const nonCompliant = evaluateChassisRules("ford_transit", "electrical_tap", {
      proposed_tap_amps: 100,
    });
    expect(nonCompliant.is_compliant).toBe(false);
    expect(nonCompliant.compliance_warnings[0]).toContain("NON-COMPLIANT");
    expect(nonCompliant.compliance_warnings[0]).toContain("100A");

    const compliant = evaluateChassisRules("ford_transit", "electrical_tap", {
      proposed_tap_amps: 50,
    });
    expect(compliant.is_compliant).toBe(true);
    expect(compliant.compliance_warnings).toHaveLength(0);
  });

  it("returns general guidance for unknown rule categories and still validates proposals", () => {
    const result = evaluateChassisRules("universal", "random");
    expect(result.rule_category).toBe("general");
    expect(result.guidance).toContain("Refer to the OEM Body and Equipment Mounting Manual");
    expect(result.max_roof_load_lbs).toBe(200);
    expect(result.max_alternator_tap_amps).toBe(50);

    // Proposals passed with unrelated or general rule_type must still be checked
    const crossCategoryRoof = evaluateChassisRules("ram_promaster", "floor_mounting", {
      proposed_roof_load_lbs: 220,
    });
    expect(crossCategoryRoof.is_compliant).toBe(false);
    expect(crossCategoryRoof.compliance_warnings[0]).toContain("NON-COMPLIANT");

    const generalNonCompliant = evaluateChassisRules("ram_promaster", "random", {
      proposed_roof_load_lbs: 220,
      proposed_tap_amps: 80,
    });
    expect(generalNonCompliant.is_compliant).toBe(false);
    expect(generalNonCompliant.compliance_warnings).toHaveLength(2);
  });
});
