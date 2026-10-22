import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { calculateDCWireAndFuse } from "../utils/formulas.js";

export function registerElectricalTools(mcp: McpServer): void {
  // -------------------------------------------------------------------------
  // Tool: calculate_dc_wire_and_fuse (Universal Electrical Math)
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "calculate_dc_wire_and_fuse",
    {
      description:
        "Calculates ABYC E-11 compliant DC cable gauge (AWG), exact voltage drop percentage, and overcurrent fuse sizing based on system voltage, amperage, and round-trip circuit distance.",
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
}
