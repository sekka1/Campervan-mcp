import { describe, it, expect } from "vitest";
import {
  calculateVoltageDrop,
  AWG_TABLE,
} from "../../src/utils/formulas";

describe("calculateVoltageDrop", () => {
  describe("basic wire sizing", () => {
    it("should recommend 8 AWG for 20A, 10ft, 12V with 3% drop", () => {
      const result = calculateVoltageDrop(20, 10, 12, 3);
      // requiredCM = 21.4 * 20 * 10 / 0.36 = 11,888.9 CM -> smallest gauge meeting it is 8 AWG
      expect(result.recommended_awg).toBe("8");
      expect(typeof result.recommended_awg).toBe("string");
      expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
      expect(result.fuse_size_amps).toBeGreaterThanOrEqual(20);
    });

    it("should recommend the smallest (thinnest) adequate gauge rather than always the largest", () => {
      // A tiny 1A load over a short run should never need heavy 4/0 cable.
      const result = calculateVoltageDrop(1, 10, 12, 3);
      expect(result.recommended_awg).toBe("18");
    });

    it("should handle 12V system correctly", () => {
      const result = calculateVoltageDrop(30, 15, 12, 3);
      expect(result.voltage_drop_volts).toBeLessThanOrEqual(0.36); // 3% of 12V
      expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
    });

    it("should handle 24V system with larger wire run", () => {
      const result = calculateVoltageDrop(50, 20, 24, 3);
      expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
      expect(result.fuse_size_amps).toBeGreaterThanOrEqual(50 * 1.25);
    });

    it("should handle 48V system", () => {
      const result = calculateVoltageDrop(40, 25, 48, 3);
      expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
      expect(result.recommended_awg).toBeDefined();
    });

    it("should allow up to 10% drop for non-critical loads", () => {
      const result3pct = calculateVoltageDrop(10, 50, 12, 3);
      const result10pct = calculateVoltageDrop(10, 50, 12, 10);
      // Higher allowable drop should result in smaller wire (higher AWG number or same)
      expect(result10pct.voltage_drop_pct).toBeLessThanOrEqual(10);
      expect(result3pct.voltage_drop_pct).toBeLessThanOrEqual(3);
    });
  });

  describe("fuse sizing", () => {
    it("should size fuse at 125% of load rounded to standard size", () => {
      // 20A load → 25A fuse (20 * 1.25 = 25)
      const result = calculateVoltageDrop(20, 5, 12, 3);
      expect(result.fuse_size_amps).toBe(25);
    });

    it("should round up to next standard fuse size", () => {
      // 8A load → 10A fuse (8 * 1.25 = 10)
      const result = calculateVoltageDrop(8, 5, 12, 3);
      expect(result.fuse_size_amps).toBe(10);
    });

    it("should handle large loads", () => {
      // 100A load → 125A fuse (100 * 1.25 = 125)
      const result = calculateVoltageDrop(100, 5, 12, 3);
      expect(result.fuse_size_amps).toBe(125);
    });
  });

  describe("output structure", () => {
    it("should return all required fields", () => {
      const result = calculateVoltageDrop(30, 10, 12, 3);
      expect(result).toHaveProperty("recommended_awg");
      expect(result).toHaveProperty("voltage_drop_volts");
      expect(result).toHaveProperty("voltage_drop_pct");
      expect(result).toHaveProperty("fuse_size_amps");
      expect(result).toHaveProperty("conductor_resistance_ohms");
      expect(result).toHaveProperty("notes");
    });

    it("should return numeric values for numeric fields", () => {
      const result = calculateVoltageDrop(30, 10, 12, 3);
      expect(typeof result.voltage_drop_volts).toBe("number");
      expect(typeof result.voltage_drop_pct).toBe("number");
      expect(typeof result.fuse_size_amps).toBe("number");
      expect(typeof result.conductor_resistance_ohms).toBe("number");
    });

    it("should include system voltage in notes", () => {
      const result = calculateVoltageDrop(30, 10, 12, 3);
      expect(result.notes).toContain("12V");
    });
  });

  describe("edge cases", () => {
    it("should throw on zero amps", () => {
      expect(() => calculateVoltageDrop(0, 10, 12, 3)).toThrow("currentAmps must be positive");
    });

    it("should throw on negative amps", () => {
      expect(() => calculateVoltageDrop(-5, 10, 12, 3)).toThrow("currentAmps must be positive");
    });

    it("should throw on zero length", () => {
      expect(() => calculateVoltageDrop(20, 0, 12, 3)).toThrow("lengthFeet must be positive");
    });

    it("should throw on negative length", () => {
      expect(() => calculateVoltageDrop(20, -5, 12, 3)).toThrow("lengthFeet must be positive");
    });

    it("should throw on zero voltage", () => {
      expect(() => calculateVoltageDrop(20, 10, 0, 3)).toThrow("systemVoltage must be positive");
    });

    it("should throw on invalid drop percentage (0)", () => {
      expect(() => calculateVoltageDrop(20, 10, 12, 0)).toThrow(
        "allowableDropPct must be between 0 and 100"
      );
    });

    it("should throw on drop percentage over 100", () => {
      expect(() => calculateVoltageDrop(20, 10, 12, 101)).toThrow(
        "allowableDropPct must be between 0 and 100"
      );
    });

    it("should handle very long wire run by falling back to largest available gauge", () => {
      // 100A, 200ft, 12V at 3% is beyond standard wire table — expects fallback to largest gauge
      const result = calculateVoltageDrop(100, 200, 12, 3);
      expect(result.recommended_awg).toBe("4/0"); // Falls back to largest gauge
      expect(result.voltage_drop_pct).toBeGreaterThan(3); // Exceeds target but returns best available
    });

    it("should handle minimal current (1A)", () => {
      const result = calculateVoltageDrop(1, 10, 12, 3);
      expect(result).toBeDefined();
      expect(result.voltage_drop_pct).toBeGreaterThan(0);
    });
  });

  describe("AWG table integrity", () => {
    it("should have entries in descending circular mil order", () => {
      for (let i = 0; i < AWG_TABLE.length - 1; i++) {
        expect(AWG_TABLE[i].circularMils).toBeGreaterThan(AWG_TABLE[i + 1].circularMils);
      }
    });

    it("should have entries in descending ampacity order", () => {
      for (let i = 0; i < AWG_TABLE.length - 1; i++) {
        expect(AWG_TABLE[i].maxAmps).toBeGreaterThanOrEqual(AWG_TABLE[i + 1].maxAmps);
      }
    });
  });
});

import { validateSolarArray } from "../../src/utils/formulas";

describe("validateSolarArray", () => {
  // Standard 200W panel spec
  const standardPanel = {
    watts: 200,
    voc_stc: 24.3,
    isc_amps: 8.7,
    voc_temp_coeff_pct_per_c: -0.3,
  };

  // Victron SmartSolar 150/100 MPPT spec
  const mppt = {
    max_input_voltage: 150,
    mppt_voltage_min: 12,
    mppt_voltage_max: 100,
    max_input_current_amps: 40,
  };

  describe("safe configurations", () => {
    it("should pass single panel in single string (1S1P)", () => {
      const result = validateSolarArray(standardPanel, 1, 1, mppt, -10);
      expect(result.is_safe).toBe(true);
      expect(result.mppt_voltage_ok).toBe(true);
      expect(result.mppt_current_ok).toBe(true);
    });

    it("should pass 2 panels in series (2S1P)", () => {
      const result = validateSolarArray(standardPanel, 2, 1, mppt, -10);
      // Cold Voc = 24.3 * (1 + (-0.3/100) * (-10-25)) = 24.3 * 1.105 = ~26.85 per panel
      // 2 series = ~53.7V, well under 150V
      expect(result.is_safe).toBe(true);
      expect(result.cold_weather_voc_volts).toBeCloseTo(53.7, 0);
    });

    it("should pass 4 panels in series (4S1P)", () => {
      const result = validateSolarArray(standardPanel, 4, 1, mppt, -10);
      // 4 * ~26.85 = ~107.4V, under 150V
      expect(result.is_safe).toBe(true);
    });

    it("should pass 4 parallel strings of 1 panel (1S4P)", () => {
      const result = validateSolarArray(standardPanel, 1, 4, mppt, -10);
      // Isc = 8.7 * 4 = 34.8A, under 40A
      expect(result.is_safe).toBe(true);
      expect(result.total_isc_amps).toBeCloseTo(34.8, 1);
    });
  });

  describe("unsafe configurations", () => {
    it("should fail if cold Voc exceeds max input voltage", () => {
      // 6 panels in series: ~6 * 26.85 = ~161V, exceeds 150V max
      const result = validateSolarArray(standardPanel, 6, 1, mppt, -10);
      expect(result.is_safe).toBe(false);
      expect(result.mppt_voltage_ok).toBe(false);
      expect(result.messages.some((m) => m.includes("DANGER"))).toBe(true);
    });

    it("should fail if array current exceeds MPPT max", () => {
      // 5 parallel strings: 5 * 8.7 = 43.5A, exceeds 40A max
      const result = validateSolarArray(standardPanel, 1, 5, mppt, -10);
      expect(result.is_safe).toBe(false);
      expect(result.mppt_current_ok).toBe(false);
    });
  });

  describe("temperature effects", () => {
    it("should produce higher Voc at lower temperatures", () => {
      const cold = validateSolarArray(standardPanel, 2, 1, mppt, -20);
      const warm = validateSolarArray(standardPanel, 2, 1, mppt, 25);
      expect(cold.cold_weather_voc_volts).toBeGreaterThan(warm.cold_weather_voc_volts);
    });

    it("should use default temperature of -10°C", () => {
      const withDefault = validateSolarArray(standardPanel, 2, 1, mppt);
      const withExplicit = validateSolarArray(standardPanel, 2, 1, mppt, -10);
      expect(withDefault.cold_weather_voc_volts).toBe(withExplicit.cold_weather_voc_volts);
    });
  });

  describe("output structure", () => {
    it("should return all required fields", () => {
      const result = validateSolarArray(standardPanel, 2, 1, mppt);
      expect(result).toHaveProperty("is_safe");
      expect(result).toHaveProperty("cold_weather_voc_volts");
      expect(result).toHaveProperty("total_watts");
      expect(result).toHaveProperty("total_isc_amps");
      expect(result).toHaveProperty("mppt_voltage_ok");
      expect(result).toHaveProperty("mppt_current_ok");
      expect(result).toHaveProperty("messages");
      expect(Array.isArray(result.messages)).toBe(true);
    });

    it("should calculate total watts correctly", () => {
      // 2S x 2P = 4 panels x 200W = 800W
      const result = validateSolarArray(standardPanel, 2, 2, mppt);
      expect(result.total_watts).toBe(800);
    });
  });
});
