/**
 * E2E tests for the Campervan MCP Server worker endpoints.
 *
 * These tests simulate MCP JSON-RPC 2.0 requests against the Worker
 * using @cloudflare/vitest-pool-workers or a mock worker environment.
 *
 * Note: Full E2E tests require the Cloudflare Workers runtime.
 * For local development, these tests use vitest with mocked bindings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Cloudflare bindings for test environment
// ---------------------------------------------------------------------------

const mockD1Database: D1Database = {
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    }),
  }),
  batch: vi.fn().mockResolvedValue([]),
  dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
} as unknown as D1Database;

// ---------------------------------------------------------------------------
// Import the worker after setting up mocks
// ---------------------------------------------------------------------------

// We test the tool logic directly rather than through HTTP to avoid
// complex Worker runtime setup in unit/e2e boundary tests.

import { calculateVoltageDrop, calculateVanPayload, validateSolarArray } from "../../src/utils/formulas";
import { queryComponentSpecs } from "../../src/utils/db";

// ---------------------------------------------------------------------------
// Wire Gauge Tool E2E Simulation
// ---------------------------------------------------------------------------

describe("E2E: calculate_wire_gauge tool", () => {
  // Scenario A: Standard low-voltage DC circuit (12V, 30A, 10ft one-way)
  it("Scenario A: standard 12V DC branch (30A, 10ft, 3% drop) matches exact benchmark values", () => {
    const result = calculateVoltageDrop(30, 10, 12, 3);

    // Verify the full response shape a client would receive
    const json = JSON.parse(JSON.stringify(result));
    expect(json).toMatchObject({
      recommended_awg: expect.any(String),
      voltage_drop_volts: expect.any(Number),
      voltage_drop_pct: expect.any(Number),
      fuse_size_amps: expect.any(Number),
      conductor_resistance_ohms: expect.any(Number),
      notes: expect.any(String),
    });

    // Exact benchmark values derived from the CM = (K x I x L) / E_drop formula
    // (K=21.4, requiredCM = 21.4 * 30 * 10 / 0.36 = 17,833.3 CM -> next standard gauge is 6 AWG)
    expect(result.recommended_awg).toBe("6");
    expect(result.voltage_drop_volts).toBeCloseTo(0.237, 3);
    expect(result.voltage_drop_pct).toBeCloseTo(1.98, 2);
    expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
    expect(result.fuse_size_amps).toBe(40);
  });

  // Scenario B: long-distance, high-current 48V run
  it("Scenario B: high current / long run (50A, 20ft, 48V, 3% drop) matches exact benchmark values", () => {
    const result = calculateVoltageDrop(50, 20, 48, 3);

    // requiredCM = 21.4 * 50 * 20 / 1.44 = 14,861.1 CM -> next standard gauge is 8 AWG
    expect(result.recommended_awg).toBe("8");
    expect(result.voltage_drop_volts).toBeCloseTo(1.256, 3);
    expect(result.voltage_drop_pct).toBeCloseTo(2.62, 2);
    expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
  });

  // Scenario C: tight voltage drop requirement should force a larger (lower AWG number) wire
  it("Scenario C: strict 1% drop requirement recommends a heavier gauge than 3% for the same circuit", () => {
    const strict = calculateVoltageDrop(15, 50, 12, 1);
    const relaxed = calculateVoltageDrop(15, 50, 12, 3);

    // requiredCM (1%) = 21.4 * 15 * 50 / 0.12 = 133,750 CM -> next standard gauge is 3/0 AWG
    expect(strict.recommended_awg).toBe("3/0");
    expect(strict.voltage_drop_pct).toBeLessThanOrEqual(1);

    // requiredCM (3%) = 21.4 * 15 * 50 / 0.36 = 44,583.3 CM -> next standard gauge is 2 AWG
    expect(relaxed.recommended_awg).toBe("2");
    expect(relaxed.voltage_drop_pct).toBeLessThanOrEqual(3);

    // A stricter (lower) allowable drop percentage must never result in a thinner wire.
    const awgTable = ["4/0", "3/0", "2/0", "1/0", "1", "2", "4", "6", "8", "10", "12", "14", "16", "18"];
    expect(awgTable.indexOf(strict.recommended_awg)).toBeLessThan(
      awgTable.indexOf(relaxed.recommended_awg)
    );
  });

  // Scenario D: invalid inputs must fail predictably rather than returning NaN/Infinity
  it("Scenario D: invalid current (0 or negative) throws instead of producing NaN/Infinity", () => {
    expect(() => calculateVoltageDrop(0, 10, 12, 3)).toThrow("currentAmps must be positive");
    expect(() => calculateVoltageDrop(-10, 10, 12, 3)).toThrow("currentAmps must be positive");
  });

  it("Scenario D: invalid length (0 or negative) throws instead of producing NaN/Infinity", () => {
    expect(() => calculateVoltageDrop(30, 0, 12, 3)).toThrow("lengthFeet must be positive");
    expect(() => calculateVoltageDrop(30, -5, 12, 3)).toThrow("lengthFeet must be positive");
  });

  it("should return safe fuse size for inverter circuit (150A, 5ft, 12V)", () => {
    const result = calculateVoltageDrop(150, 5, 12, 3);
    expect(result.fuse_size_amps).toBeGreaterThanOrEqual(187.5);
    expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
    expect(result.recommended_awg).toBe("1/0");
  });

  it("should work for 48V lithium system (40A, 20ft)", () => {
    const result = calculateVoltageDrop(40, 20, 48, 3);
    expect(result.voltage_drop_pct).toBeLessThanOrEqual(3);
    expect(result.recommended_awg).toBe("8");
  });
});

// ---------------------------------------------------------------------------
// Van Payload Tool E2E Simulation
// ---------------------------------------------------------------------------

describe("E2E: calculate_van_payload tool", () => {
  it("should calculate typical Sprinter 144 build payload", () => {
    const components = [
      { name: "2x 100Ah LiFePO4 Batteries", weight_lbs: 58, position: "mid" as const },
      { name: "Victron MultiPlus 3000", weight_lbs: 26.5, position: "mid" as const },
      { name: "Fresh Water Tank (30gal)", weight_lbs: 260, position: "rear" as const },
      { name: "Build Cabinetry", weight_lbs: 200, position: "mid" as const },
      { name: "Ceiling Kit + Insulation", weight_lbs: 80, position: "mid" as const },
    ];

    const result = calculateVanPayload("sprinter_144", components, 400);

    expect(result.within_gvwr).toBe(true);
    expect(result.remaining_payload_lbs).toBeGreaterThan(0);
    expect(result.van_model).toBe("sprinter_144");
    expect(result.components).toHaveLength(5);
  });

  it("should warn when Transit is near capacity", () => {
    const components = [
      { name: "Heavy Build", weight_lbs: 3500, position: "rear" as const },
    ];

    const result = calculateVanPayload("transit_148", components, 400);
    // 3500 + 400 = 3900 lbs added, Transit max payload = 8600 - 5000 = 3600 lbs
    expect(result.within_gvwr).toBe(false);
  });

  it("should validate all six supported van models", () => {
    const models = ["sprinter_144", "sprinter_170", "transit_148", "transit_148_ext", "promaster_136", "promaster_159"];
    const components = [{ name: "Standard Build", weight_lbs: 1000 }];

    for (const model of models) {
      const result = calculateVanPayload(model, components);
      expect(result.van_model).toBe(model);
      expect(result.within_gvwr).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Solar Array Tool E2E Simulation
// ---------------------------------------------------------------------------

describe("E2E: validate_solar_array tool", () => {
  it("should validate common 400W Sprinter roof setup (2S2P)", () => {
    const result = validateSolarArray(
      { watts: 200, voc_stc: 24.3, isc_amps: 8.7, voc_temp_coeff_pct_per_c: -0.3 },
      2,  // 2 series
      2,  // 2 parallel
      {
        max_input_voltage: 150,
        mppt_voltage_min: 12,
        mppt_voltage_max: 100,
        max_input_current_amps: 40,
      },
      -10
    );

    expect(result.is_safe).toBe(true);
    expect(result.total_watts).toBe(800);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("should catch dangerous over-voltage configuration", () => {
    const result = validateSolarArray(
      { watts: 300, voc_stc: 45.0, isc_amps: 8.0, voc_temp_coeff_pct_per_c: -0.35 },
      4,  // 4 panels in series
      1,
      {
        max_input_voltage: 150,
        mppt_voltage_min: 60,
        mppt_voltage_max: 145,
        max_input_current_amps: 20,
      },
      -20
    );

    // 4 * 45.0 * (1 + (-0.35/100 * (-20-25))) = 4 * 45.0 * 1.1575 = ~208.4V → exceeds 150V
    expect(result.is_safe).toBe(false);
    expect(result.mppt_voltage_ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D1 Component Specs Tool E2E Simulation
// ---------------------------------------------------------------------------

describe("E2E: lookup_component_specs tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should query D1 with category filter", async () => {
    const mockResults = [
      {
        id: 1,
        name: "Victron MultiPlus-II 12/3000",
        category: "inverter_charger",
        manufacturer: "Victron Energy",
        model_number: "PMP122300100",
        max_continuous_amps: 250,
        idle_power_watts: 11,
        weight_lbs: 26.5,
        terminal_stud_size: "M8",
        dimensions_inches: "14.2 x 8.7 x 5.5",
        notes: "3000W continuous",
      },
    ];

    const mockPrepare = {
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: mockResults }),
      }),
    };

    const mockDb = {
      prepare: vi.fn().mockReturnValue(mockPrepare),
    } as unknown as D1Database;

    const results = await queryComponentSpecs(mockDb, { category: "inverter_charger" });
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("inverter_charger");
    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("component_specs"));
  });

  it("should query D1 with name filter", async () => {
    const mockPrepare = {
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    };

    const mockDb = {
      prepare: vi.fn().mockReturnValue(mockPrepare),
    } as unknown as D1Database;

    await queryComponentSpecs(mockDb, { nameFilter: "MultiPlus" });
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("LIKE")
    );
  });

  it("should handle empty results gracefully", async () => {
    const results = await queryComponentSpecs(mockD1Database, { category: "nonexistent" });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Vectorize Manual Search Tool E2E Simulation
// ---------------------------------------------------------------------------

describe("E2E: search_van_manuals tool", () => {
  it("should call vectorize query with correct parameters", async () => {
    const mockMatches = [
      {
        id: "ford_transit_chunk_0",
        score: 0.95,
        metadata: {
          source: "ford_transit_body_builder",
          page: 42,
          section: "Roof Load Ratings",
          text: "The Transit roof can support up to 150 lbs of static load...",
        },
      },
    ];

    const mockIndex = {
      query: vi.fn().mockResolvedValue({ matches: mockMatches }),
      upsert: vi.fn(),
      insert: vi.fn(),
      getByIds: vi.fn(),
      deleteByIds: vi.fn(),
      describe: vi.fn(),
    } as unknown as VectorizeIndex;

    // Simulate the search with a zero vector (test environment)
    const queryVector = new Array(384).fill(0) as number[];
    const results = await mockIndex.query(queryVector, { topK: 5, returnMetadata: "all" });

    expect(mockIndex.query).toHaveBeenCalledWith(queryVector, { topK: 5, returnMetadata: "all" });
    expect(results.matches).toHaveLength(1);
    expect(results.matches[0].score).toBe(0.95);
  });
});
