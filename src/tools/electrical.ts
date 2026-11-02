import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { calculateBatteryRuntime, calculateDCWireAndFuse, calculateSolarStringMppt } from "../utils/formulas.js";

export const solarStringShape = {
  panel_voc: z.number().positive().describe("Panel open-circuit voltage at STC in volts"),
  panel_isc: z.number().positive().describe("Panel short-circuit current in amps"),
  voc_temp_coeff_pct_per_c: z
    .number()
    .describe("Voc temperature coefficient in %/°C (negative, e.g. -0.29)"),
  coldest_ambient_c: z.number().describe("Coldest expected ambient temperature in °C"),
  series_count: z.number().int().positive().describe("Panels in series per string"),
  parallel_strings: z.number().int().positive().default(1).describe("Number of parallel strings (default 1)"),
  mppt_max_input_voltage: z.number().positive().describe("MPPT absolute max input voltage in volts"),
  mppt_max_input_current_amps: z.number().positive().optional().describe("MPPT max input current in amps"),
  panel_watts: z.number().nonnegative().optional().describe("Panel rated watts (for total array power)"),
};

export const batteryRuntimeShape = {
  battery_voltage: z.number().positive().describe("Battery nominal voltage in volts"),
  capacity_ah: z.number().positive().describe("Battery capacity in amp-hours"),
  chemistry: z.enum(["lifepo4", "lithium", "agm", "lead_acid"]).describe("Battery chemistry (sets default usable fraction)"),
  usable_fraction: z.number().gt(0).max(1).optional().describe("Override usable capacity fraction (0-1)"),
  inverter_idle_watts: z.number().nonnegative().default(0).describe("Inverter idle consumption in watts"),
  inverter_efficiency: z.number().gt(0).max(1).default(0.9).describe("Inverter efficiency (0-1, default 0.9)"),
  ac_load_watts: z.number().nonnegative().default(0).describe("AC load power in watts"),
  ac_duty_cycle: z.number().min(0).max(1).default(1).describe("Fraction of time AC load runs (0-1)"),
  dc_load_watts: z.number().nonnegative().default(0).describe("DC load power in watts"),
  dc_duty_cycle: z.number().min(0).max(1).default(1).describe("Fraction of time DC load runs (0-1)"),
};

function textResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

export function registerElectricalTools(mcp: McpServer): void {
  // -------------------------------------------------------------------------
  // Tool: calculate_dc_wire_and_fuse (Universal Electrical Math)
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "calculate_dc_wire_and_fuse",
    {
      description:
        `Calculates recommended DC wire gauge (AWG), fuse ampacity, and voltage drop for campervan electrical installations.
IMPORTANT SAFETY INSTRUCTIONS FOR LLM CONSUMERS:
- AWG is an inverse scale: 1/0 and 2/0 are larger than 2 AWG; 4 AWG is smaller. Never recommend a higher numerical AWG as an upsize.
- Overcurrent protection (fuse) must ALWAYS be placed within 7 inches of the battery (power source), NEVER at the inverter or load.
- Always include the returned 'safety_invariants' in user-facing answers.`,
      inputSchema: {
        system_voltage: z
          .union([z.literal(12), z.literal(24), z.literal(48)])
          .describe("Nominal DC system voltage in volts: 12, 24, or 48"),
        amperage: z
          .number()
          .positive()
          .describe("Circuit design current or continuous load in amps"),
        one_way_distance_feet: z
          .number()
          .positive()
          .describe(
            "One-way cable run distance in feet from source to load (doubled internally to calculate round-trip conductor length)"
          ),
        allowable_drop_percent: z
          .union([z.literal(3), z.literal(10)])
          .default(3)
          .describe(
            "Maximum allowable voltage drop percentage: 3% for critical circuits, 10% for non-critical (default 3)"
          ),
        is_engine_compartment: z
          .boolean()
          .default(false)
          .describe(
            "Whether the cable run passes through an engine compartment (applies 50°C ABYC Table VI-A ampacity derating; default false)"
          ),
      },
    },
    async (args) => {
      const result = calculateDCWireAndFuse({
        system_voltage: args.system_voltage,
        amperage: args.amperage,
        one_way_distance_feet: args.one_way_distance_feet,
        allowable_drop_percent: args.allowable_drop_percent,
        is_engine_compartment: args.is_engine_compartment,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  mcp.registerTool(
    "calculate_solar_string_mppt",
    {
      description:
        "Verifies a solar string does not exceed an MPPT controller's max input voltage/current at the coldest expected ambient temperature, using the panel Voc temperature coefficient. Returns cold Voc, safety flags, and the maximum series panel count.",
      inputSchema: solarStringShape,
    },
    async (args) => textResult(calculateSolarStringMppt(args))
  );

  mcp.registerTool(
    "calculate_battery_runtime",
    {
      description:
        "Estimates battery runtime in hours from chemistry/usable capacity, inverter idle consumption, and AC/DC loads with duty cycles.",
      inputSchema: batteryRuntimeShape,
    },
    async (args) => textResult(calculateBatteryRuntime(args))
  );
}
