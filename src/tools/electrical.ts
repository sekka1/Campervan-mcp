import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  calculateVoltageDrop,
  calculateDCWireAndFuse,
  validateSolarArray,
} from "../utils/formulas.js";

export function registerElectricalTools(mcp: McpServer): void {
  // -------------------------------------------------------------------------
  // Tool: calculate_wire_gauge
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "calculate_wire_gauge",
    {
      description:
        "Calculates recommended AWG wire size, conductor resistance, voltage drop percentage, fuse sizing, and ABYC fuse form factor for a DC circuit based on electrical load, one-way wire run distance, system voltage, and engine compartment routing.",
      inputSchema: {
        current_amps: z
          .number()
          .positive()
          .describe("Total circuit current in Amperes (e.g., 30 for a 30A load)"),
        length_feet: z
          .number()
          .positive()
          .describe("One-way wire run distance in feet (not round-trip)"),
        voltage: z
          .enum(["12", "24", "48"])
          .default("12")
          .describe("DC system voltage: 12V, 24V, or 48V"),
        allowable_drop_pct: z
          .number()
          .min(1)
          .max(10)
          .default(3)
          .describe(
            "Maximum allowable voltage drop percentage. Use 3% for critical loads (inverters, chargers), 10% for non-critical (lights, fans)"
          ),
        is_engine_compartment: z
          .boolean()
          .default(false)
          .describe(
            "True if the wire is routed through an engine compartment (applies ABYC E-11 high-temperature ampacity derating)"
          ),
      },
    },
    async (args) => {
      const result = calculateVoltageDrop(
        args.current_amps,
        args.length_feet,
        Number(args.voltage),
        args.allowable_drop_pct,
        args.is_engine_compartment
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: calculate_dc_wire_and_fuse (Strict ABYC E-11 105°C Table)
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "calculate_dc_wire_and_fuse",
    {
      description:
        "Performs deterministic ABYC E-11 compliant DC cable gauge (AWG), voltage drop, and overcurrent fuse sizing using 105°C marine/RV stranded tinned copper ampacity tables.",
      inputSchema: {
        system_voltage: z
          .union([z.literal(12), z.literal(24), z.literal(48)])
          .describe("DC system voltage: 12, 24, or 48"),
        amperage: z
          .number()
          .positive()
          .describe("Continuous circuit current in Amperes"),
        one_way_distance_feet: z
          .number()
          .positive()
          .describe("One-way cable length in feet (doubled internally for round-trip loop)"),
        allowable_drop_percent: z
          .union([z.literal(3), z.literal(10)])
          .default(3)
          .describe("Allowable voltage drop percentage: 3 for critical circuits, 10 for non-critical"),
        is_engine_compartment: z
          .boolean()
          .default(false)
          .describe("True if routed through an engine compartment (applies 105°C engine room ampacity limits)"),
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
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: validate_solar_array
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "validate_solar_array",
    {
      description:
        "Validates a solar panel string configuration (series/parallel) against MPPT charge controller specifications, checking cold-weather open-circuit voltage (Voc) safety and current limits.",
      inputSchema: {
        panel_watts: z
          .number()
          .positive()
          .describe("Rated power of each panel at STC in Watts (e.g., 200)"),
        panel_voc: z
          .number()
          .positive()
          .describe("Open-circuit voltage of each panel at STC (25°C) in Volts (e.g., 24.3)"),
        panel_isc: z
          .number()
          .positive()
          .describe("Short-circuit current of each panel in Amperes (e.g., 8.7)"),
        panel_voc_temp_coeff: z
          .number()
          .describe(
            "Temperature coefficient of Voc in %/°C (typically negative, e.g., -0.3 for -0.3%/°C)"
          ),
        series_panels: z
          .number()
          .int()
          .positive()
          .describe("Number of panels connected in series per string"),
        parallel_strings: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe("Number of parallel strings (default 1)"),
        mppt_max_input_voltage: z
          .number()
          .positive()
          .describe("MPPT controller absolute maximum input voltage in Volts (e.g., 150)"),
        mppt_voltage_min: z
          .number()
          .positive()
          .describe("MPPT operating voltage range minimum in Volts (e.g., 12)"),
        mppt_voltage_max: z
          .number()
          .positive()
          .describe("MPPT operating voltage range maximum in Volts (e.g., 100)"),
        mppt_max_current: z
          .number()
          .positive()
          .describe("MPPT maximum input current in Amperes (e.g., 40)"),
        cold_temp_c: z
          .number()
          .default(-10)
          .describe("Coldest expected installation temperature in °C (default -10°C)"),
      },
    },
    async (args) => {
      const result = validateSolarArray(
        {
          watts: args.panel_watts,
          voc_stc: args.panel_voc,
          isc_amps: args.panel_isc,
          voc_temp_coeff_pct_per_c: args.panel_voc_temp_coeff,
        },
        args.series_panels,
        args.parallel_strings,
        {
          max_input_voltage: args.mppt_max_input_voltage,
          mppt_voltage_min: args.mppt_voltage_min,
          mppt_voltage_max: args.mppt_voltage_max,
          max_input_current_amps: args.mppt_max_current,
        },
        args.cold_temp_c
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
