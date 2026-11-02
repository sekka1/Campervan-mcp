import { describe, it, expect } from "vitest";
import { calculateBatteryRuntime, calculateSolarStringMppt } from "../../src/utils/formulas.ts";
import { MCP_TOOLS, handleMcpRequest } from "../../src/index.ts";

describe("calculateSolarStringMppt", () => {
  const base = {
    panel_voc: 22.5,
    panel_isc: 9.5,
    voc_temp_coeff_pct_per_c: -0.3,
    coldest_ambient_c: -10,
    mppt_max_input_voltage: 100,
  };

  it("applies cold-temperature Voc correction", () => {
    const r = calculateSolarStringMppt({ ...base, series_count: 4 });
    // 22.5 * (1 + 0.003*35) = 24.8625 per panel
    expect(r.cold_weather_voc_volts).toBeCloseTo(99.45, 2);
    expect(r.mppt_voltage_ok).toBe(true);
    expect(r.max_series_panels).toBe(4);
  });

  it("flags exceeding max input voltage", () => {
    const r = calculateSolarStringMppt({ ...base, series_count: 5 });
    expect(r.is_safe).toBe(false);
    expect(r.mppt_voltage_ok).toBe(false);
  });

  it("checks current across parallel strings", () => {
    const r = calculateSolarStringMppt({ ...base, series_count: 2, parallel_strings: 3, mppt_max_input_current_amps: 20 });
    expect(r.total_isc_amps).toBe(28.5);
    expect(r.mppt_current_ok).toBe(false);
  });
});

describe("calculateBatteryRuntime", () => {
  it("computes runtime with idle, AC duty cycle and DC loads", () => {
    const r = calculateBatteryRuntime({
      battery_voltage: 12.8,
      capacity_ah: 200,
      chemistry: "lifepo4",
      inverter_idle_watts: 20,
      inverter_efficiency: 0.9,
      ac_load_watts: 900,
      ac_duty_cycle: 0.5,
      dc_load_watts: 50,
    });
    expect(r.usable_capacity_wh).toBe(2304);
    expect(r.average_draw_watts).toBe(570);
    expect(r.runtime_hours).toBe(4.04);
  });

  it("uses chemistry-specific usable capacity", () => {
    const r = calculateBatteryRuntime({ battery_voltage: 12, capacity_ah: 100, chemistry: "agm", dc_load_watts: 60 });
    expect(r.usable_capacity_wh).toBe(600);
    expect(r.runtime_hours).toBe(10);
  });

  it("rejects zero load", () => {
    expect(() => calculateBatteryRuntime({ battery_voltage: 12, capacity_ah: 100, chemistry: "agm" })).toThrow();
  });
});

describe("MCP registration", () => {
  it("lists both new tools", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("calculate_solar_string_mppt");
    expect(names).toContain("calculate_battery_runtime");
  });

  it("dispatches calculate_battery_runtime", async () => {
    const res = (await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "calculate_battery_runtime", arguments: { battery_voltage: 12, capacity_ah: 100, chemistry: "agm", dc_load_watts: 60 } } },
      {} as never
    )) as { result: { structured: { runtime_hours: number } } };
    expect(res.result.structured.runtime_hours).toBe(10);
  });
});
