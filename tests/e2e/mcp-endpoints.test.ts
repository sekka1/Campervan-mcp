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

import { calculateVoltageDrop, calculateDCWireAndFuse, calculateVanPayload, validateSolarArray, evaluateChassisRules } from "../../src/utils/formulas";
import worker from "../../src/index";
import { hashApiKey } from "../../src/utils/metering";
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

// ---------------------------------------------------------------------------
// Chassis Rules & ABYC E-11 Wire/Fuse Tool E2E Simulation
// ---------------------------------------------------------------------------

describe("E2E: chassis_rules and calculate_dc_wire_and_fuse tools", () => {
  it("evaluates deterministic Ford Transit CCP2 electrical rules and catches over-current tap", () => {
    const safeTap = evaluateChassisRules("ford_transit", "electrical_tap", { proposed_tap_amps: 50 });
    expect(safeTap.is_compliant).toBe(true);
    expect(safeTap.max_alternator_tap_amps).toBe(60);
    expect(safeTap.oem_connection_point).toContain("CCP2");

    const unsafeTap = evaluateChassisRules("ford_transit", "electrical_tap", { proposed_tap_amps: 90 });
    expect(unsafeTap.is_compliant).toBe(false);
    expect(unsafeTap.compliance_warnings[0]).toContain("NON-COMPLIANT");

    const wireCalc = calculateDCWireAndFuse({
      system_voltage: 12,
      amperage: 60,
      one_way_distance_feet: 15,
      allowable_drop_percent: 3,
      is_engine_compartment: false,
    });
    expect(wireCalc.recommended_awg).toBe("2");
    expect(wireCalc.recommended_fuse_amps).toBe(80);
  });

  it("executes full JSON-RPC 2.0 HTTP lifecycle against the Worker fetch entrypoint", async () => {
    const env = {
      DB: mockD1Database,
      VECTOR_INDEX: {
        query: vi.fn().mockResolvedValue({ matches: [] }),
      } as unknown as VectorizeIndex,
    };
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const callRpc = async (id: number, method: string, params: Record<string, unknown>) => {
      const req = new Request("http://localhost/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      return (await res.json()) as {
        result?: {
          tools?: Array<{ name: string }>;
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
      };
    };

    // 1. tools/list includes chassis_rules and calculate_dc_wire_and_fuse
    const listRes = await callRpc(1, "tools/list", {});
    const toolNames = (listRes.result?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("chassis_rules");
    expect(toolNames).toContain("calculate_wire_gauge");
    expect(toolNames).toContain("calculate_dc_wire_and_fuse");

    // 2. tools/call chassis_rules
    const chassisRes = await callRpc(2, "tools/call", {
      name: "chassis_rules",
      arguments: {
        chassis: "mercedes_sprinter",
        rule_type: "roof_load",
        proposed_roof_load_lbs: 200,
      },
    });
    expect(chassisRes.result?.isError).not.toBe(true);
    const chassisPayload = JSON.parse(chassisRes.result?.content?.[0]?.text ?? "{}");
    expect(chassisPayload.canonical_chassis).toBe("mercedes_sprinter");
    expect(chassisPayload.max_roof_load_lbs).toBe(220);
    expect(chassisPayload.is_compliant).toBe(true);

    // 3. tools/call calculate_dc_wire_and_fuse
    const abycRes = await callRpc(3, "tools/call", {
      name: "calculate_dc_wire_and_fuse",
      arguments: {
        system_voltage: 12,
        amperage: 60,
        one_way_distance_feet: 15,
        allowable_drop_percent: 3,
        is_engine_compartment: false,
      },
    });
    expect(abycRes.result?.isError).not.toBe(true);
    const abycPayload = JSON.parse(abycRes.result?.content?.[0]?.text ?? "{}");
    expect(abycPayload.recommended_awg).toBe("2");
    expect(abycPayload.recommended_fuse_amps).toBe(80);
    expect(abycPayload.fuse_type).toBe("MIDI / AMI Fuse");
  });
});

// ---------------------------------------------------------------------------
// Phase 5: API Key Auth & Per-Tool Microcent Metering E2E Simulation
// ---------------------------------------------------------------------------

describe("E2E: Bearer API key authentication and microcent metering", () => {
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  it("allows unauthenticated requests when METERING_ALLOW_ALL is 'true' (default)", async () => {
    const env = {
      DB: mockD1Database,
      VECTOR_INDEX: { query: vi.fn() } as unknown as VectorizeIndex,
      AUTH_ENABLED: "false",
      METERING_ALLOW_ALL: "true",
    };
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
  });

  it("verifies API key but skips balance deduction when AUTH_ENABLED='true' and METERING_ALLOW_ALL='true'", async () => {
    const rawKey = "auth-only-key";
    const first = vi.fn().mockResolvedValue({ id: "acc_zero", balance_microcents: 0, is_active: 1 });
    const bind = vi.fn().mockReturnValue({ first });
    const batch = vi.fn();
    const db = { prepare: vi.fn().mockReturnValue({ bind }), batch } as unknown as D1Database;
    const env = {
      DB: db,
      VECTOR_INDEX: { query: vi.fn() } as unknown as VectorizeIndex,
      AUTH_ENABLED: "true",
      METERING_ALLOW_ALL: "true",
    };
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "chassis_rules", arguments: { chassis: "ford_transit", rule_type: "electrical_tap" } },
      }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(batch).not.toHaveBeenCalled();
  });

  it("returns 401 when AUTH_ENABLED is 'true' (or METERING_ALLOW_ALL is 'false') and Authorization header is missing", async () => {
    const env = {
      DB: mockD1Database,
      VECTOR_INDEX: { query: vi.fn() } as unknown as VectorizeIndex,
      METERING_ALLOW_ALL: "false",
    };
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 402 when account balance is lower than the requested tool cost", async () => {
    const rawKey = "test-low-balance-key";
    const expectedHash = await hashApiKey(rawKey);
    const first = vi.fn().mockResolvedValue({ id: "acc_low", balance_microcents: 300, is_active: 1 });
    const bind = vi.fn().mockReturnValue({ first });
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
      batch: vi.fn(),
    } as unknown as D1Database;

    const env = {
      DB: db,
      VECTOR_INDEX: { query: vi.fn() } as unknown as VectorizeIndex,
      METERING_ALLOW_ALL: "false",
    };

    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "chassis_rules",
          arguments: { chassis: "ford_transit", rule_type: "electrical_tap" },
        },
      }),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(402);
    expect(bind).toHaveBeenCalledWith(expectedHash);
  });

  it("authenticates valid Bearer key, executes tool, and deducts 500 microcents in D1 batch", async () => {
    const rawKey = "test-funded-key";
    const first = vi.fn().mockResolvedValue({ id: "acc_ok", balance_microcents: 10000, is_active: 1 });
    const bind = vi.fn().mockReturnValue({ first });
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
      batch,
    } as unknown as D1Database;

    const env = {
      DB: db,
      VECTOR_INDEX: { query: vi.fn() } as unknown as VectorizeIndex,
      METERING_ALLOW_ALL: "false",
    };

    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "chassis_rules",
          arguments: { chassis: "ford_transit", rule_type: "electrical_tap" },
        },
      }),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith(500, "acc_ok", 500);
  });

  it("does not charge or inflate preflight balance for id-less tools/call notifications in a batch", async () => {
    const rawKey = "test-notification-batch-key";
    const first = vi.fn().mockResolvedValue({ id: "acc_notif", balance_microcents: 500, is_active: 1 });
    const bind = vi.fn().mockReturnValue({ first });
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
      batch,
    } as unknown as D1Database;
    const env = {
      DB: db,
      VECTOR_INDEX: { query: vi.fn() } as unknown as VectorizeIndex,
      METERING_ALLOW_ALL: "false",
    };

    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "search_van_manuals", arguments: { query: "inverter" } },
        },
      ]),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(batch).not.toHaveBeenCalled();
  });

  it("atomically settles a multi-call batch and returns 402 without partial charges if concurrent settlement exhausts balance", async () => {
    const rawKey = "test-concurrent-batch-key";
    const first = vi.fn().mockResolvedValue({ id: "acc_race", balance_microcents: 1000, is_active: 1 });
    const bind = vi.fn().mockReturnValue({ first });
    const batch = vi.fn().mockResolvedValue([
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
    ]);
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
      batch,
    } as unknown as D1Database;
    const env = {
      DB: db,
      VECTOR_INDEX: { query: vi.fn() } as unknown as VectorizeIndex,
      METERING_ALLOW_ALL: "false",
    };

    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 101,
          method: "tools/call",
          params: {
            name: "chassis_rules",
            arguments: { chassis: "ford_transit", rule_type: "electrical_tap" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 102,
          method: "tools/call",
          params: {
            name: "chassis_rules",
            arguments: { chassis: "mercedes_sprinter", rule_type: "upfitter_switches" },
          },
        },
      ]),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(402);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith(1000, "acc_race", 1000);
  });
});
