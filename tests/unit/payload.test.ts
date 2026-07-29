import { describe, it, expect } from "vitest";
import {
  calculateVanPayload,
  VAN_SPECS,
  type PayloadComponent,
} from "../../src/utils/formulas";

describe("calculateVanPayload", () => {
  describe("basic payload calculation", () => {
    it("should calculate payload for sprinter_144 with single component", () => {
      const components: PayloadComponent[] = [
        { name: "100Ah LiFePO4 Battery", weight_lbs: 29, position: "mid" },
      ];
      const result = calculateVanPayload("sprinter_144", components);
      expect(result.total_added_weight_lbs).toBe(29);
      expect(result.remaining_payload_lbs).toBeGreaterThan(0);
      expect(result.within_gvwr).toBe(true);
    });

    it("should calculate correct remaining payload", () => {
      const spec = VAN_SPECS["sprinter_144"];
      const maxPayload = spec.gvwr_lbs - spec.curb_weight_lbs;

      const components: PayloadComponent[] = [{ name: "Fridge", weight_lbs: 50 }];
      const result = calculateVanPayload("sprinter_144", components);
      expect(result.remaining_payload_lbs).toBe(maxPayload - 50);
    });

    it("should flag within_gvwr as false when overloaded", () => {
      // Max payload for sprinter_144 = 8550 - 5200 = 3350 lbs
      const components: PayloadComponent[] = [
        { name: "Very Heavy Load", weight_lbs: 4000 },
      ];
      const result = calculateVanPayload("sprinter_144", components);
      expect(result.within_gvwr).toBe(false);
      expect(result.remaining_payload_lbs).toBeLessThan(0);
    });

    it("should sum multiple components", () => {
      const components: PayloadComponent[] = [
        { name: "Battery 1", weight_lbs: 29 },
        { name: "Battery 2", weight_lbs: 29 },
        { name: "Water Tank", weight_lbs: 150 },
        { name: "Cabinetry", weight_lbs: 200 },
      ];
      const result = calculateVanPayload("sprinter_144", components);
      expect(result.total_added_weight_lbs).toBe(408);
    });
  });

  describe("van models", () => {
    it("should support all defined van models", () => {
      const models = Object.keys(VAN_SPECS);
      const components: PayloadComponent[] = [{ name: "Test", weight_lbs: 100 }];

      for (const model of models) {
        const result = calculateVanPayload(model, components);
        expect(result.van_model).toBe(model);
        expect(result.within_gvwr).toBe(true);
      }
    });

    it("should throw for unknown van model", () => {
      const components: PayloadComponent[] = [{ name: "Test", weight_lbs: 100 }];
      expect(() => calculateVanPayload("unknown_van", components)).toThrow(
        'Unknown van model: "unknown_van"'
      );
    });

    it("should have correct GVWR for sprinter_144", () => {
      expect(VAN_SPECS["sprinter_144"].gvwr_lbs).toBe(8550);
    });

    it("should have correct GVWR for transit_148", () => {
      expect(VAN_SPECS["transit_148"].gvwr_lbs).toBe(8600);
    });

    it("should have correct GVWR for promaster_136", () => {
      expect(VAN_SPECS["promaster_136"].gvwr_lbs).toBe(8550);
    });
  });

  describe("axle distribution", () => {
    it("should distribute front-position weight mostly to front axle", () => {
      const components: PayloadComponent[] = [
        { name: "Front Cabinet", weight_lbs: 100, position: "front" },
      ];
      const result = calculateVanPayload("sprinter_144", components);
      // 70% of 100 = 70 lbs added to front
      const spec = VAN_SPECS["sprinter_144"];
      const curbFront = spec.curb_weight_lbs * 0.48;
      expect(result.estimated_front_axle_lbs).toBeCloseTo(curbFront + 70, 0);
    });

    it("should distribute rear-position weight mostly to rear axle", () => {
      const components: PayloadComponent[] = [
        { name: "Rear Garage", weight_lbs: 200, position: "rear" },
      ];
      const result = calculateVanPayload("sprinter_144", components);
      // 80% of 200 = 160 lbs added to rear
      const spec = VAN_SPECS["sprinter_144"];
      const curbRear = spec.curb_weight_lbs * 0.52;
      expect(result.estimated_rear_axle_lbs).toBeCloseTo(curbRear + 160, 0);
    });

    it("should default unspecified position to mid", () => {
      const withMid: PayloadComponent[] = [
        { name: "Component", weight_lbs: 100, position: "mid" },
      ];
      const withDefault: PayloadComponent[] = [{ name: "Component", weight_lbs: 100 }];

      const resultMid = calculateVanPayload("sprinter_144", withMid);
      const resultDefault = calculateVanPayload("sprinter_144", withDefault);
      expect(resultMid.estimated_front_axle_lbs).toBe(resultDefault.estimated_front_axle_lbs);
      expect(resultMid.estimated_rear_axle_lbs).toBe(resultDefault.estimated_rear_axle_lbs);
    });

    it("should flag axle overload when rear is exceeded", () => {
      // Rear axle limit for sprinter_144 = 5060 lbs
      // Curb rear = 5200 * 0.52 = 2704 lbs
      // Available rear: 5060 - 2704 = 2356 lbs
      // Adding 3000 lbs at rear (80% = 2400 lbs → exceeds available)
      const components: PayloadComponent[] = [
        { name: "Heavy Rear Load", weight_lbs: 3000, position: "rear" },
      ];
      const result = calculateVanPayload("sprinter_144", components);
      expect(result.rear_axle_ok).toBe(false);
    });
  });

  describe("occupants weight", () => {
    it("should include occupants weight in total", () => {
      const components: PayloadComponent[] = [{ name: "Gear", weight_lbs: 100 }];
      const result = calculateVanPayload("sprinter_144", components, 350);
      expect(result.total_added_weight_lbs).toBe(450);
    });

    it("should default occupants weight to 0", () => {
      const components: PayloadComponent[] = [{ name: "Gear", weight_lbs: 100 }];
      const resultWithout = calculateVanPayload("sprinter_144", components);
      const resultWith = calculateVanPayload("sprinter_144", components, 0);
      expect(resultWithout.total_added_weight_lbs).toBe(resultWith.total_added_weight_lbs);
    });
  });

  describe("output structure", () => {
    it("should return all required fields", () => {
      const components: PayloadComponent[] = [{ name: "Test", weight_lbs: 100 }];
      const result = calculateVanPayload("sprinter_144", components);

      expect(result).toHaveProperty("total_added_weight_lbs");
      expect(result).toHaveProperty("remaining_payload_lbs");
      expect(result).toHaveProperty("within_gvwr");
      expect(result).toHaveProperty("estimated_front_axle_lbs");
      expect(result).toHaveProperty("estimated_rear_axle_lbs");
      expect(result).toHaveProperty("front_axle_ok");
      expect(result).toHaveProperty("rear_axle_ok");
      expect(result).toHaveProperty("components");
      expect(result).toHaveProperty("van_model");
      expect(result).toHaveProperty("notes");
    });

    it("should include component breakdown in result", () => {
      const components: PayloadComponent[] = [
        { name: "Battery Pack", weight_lbs: 58, position: "mid" },
        { name: "Water System", weight_lbs: 120, position: "rear" },
      ];
      const result = calculateVanPayload("sprinter_144", components);
      expect(result.components).toHaveLength(2);
      expect(result.components[0].name).toBe("Battery Pack");
      expect(result.components[1].name).toBe("Water System");
    });

    it("should include GVWR info in notes", () => {
      const components: PayloadComponent[] = [{ name: "Test", weight_lbs: 50 }];
      const result = calculateVanPayload("sprinter_144", components);
      expect(result.notes).toContain("8,550");
    });

    it("should return rounded integer weights", () => {
      const components: PayloadComponent[] = [{ name: "Test", weight_lbs: 33.7 }];
      const result = calculateVanPayload("sprinter_144", components);
      expect(Number.isInteger(result.total_added_weight_lbs)).toBe(true);
      expect(Number.isInteger(result.remaining_payload_lbs)).toBe(true);
    });
  });

  describe("VAN_SPECS integrity", () => {
    it("should have 6 van models defined", () => {
      expect(Object.keys(VAN_SPECS)).toHaveLength(6);
    });

    it("should have GVWR greater than curb weight for all models", () => {
      for (const [model, spec] of Object.entries(VAN_SPECS)) {
        expect(spec.gvwr_lbs).toBeGreaterThan(spec.curb_weight_lbs);
        expect(spec.gvwr_lbs - spec.curb_weight_lbs).toBeGreaterThan(0);
        expect(spec.front_axle_rating_lbs).toBeGreaterThan(0);
        expect(spec.rear_axle_rating_lbs).toBeGreaterThan(0);
        void model; // suppress unused var warning
      }
    });
  });
});
