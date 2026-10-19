import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateChassisRules } from "../utils/formulas.js";

export function registerChassisTools(mcp: McpServer): void {
  mcp.registerTool(
    "chassis_rules",
    {
      description:
        "Provides deterministic OEM mounting, structural cutting/drilling, roof load, floor anchoring, heating fuel tap, and electrical customer connection point (CCP/EK1/Upfitter) rules for Ford Transit, Mercedes Sprinter, RAM ProMaster, and universal campervan chassis.",
      inputSchema: {
        chassis: z
          .enum([
            "ford_transit",
            "mercedes_sprinter",
            "ram_promaster",
            "transit",
            "sprinter",
            "promaster",
            "universal",
          ])
          .describe(
            "Target van chassis (e.g., 'ford_transit', 'mercedes_sprinter', 'ram_promaster', 'transit', 'sprinter', 'promaster', or 'universal')"
          ),
        rule_type: z
          .string()
          .min(1)
          .describe(
            "Rule category to evaluate (e.g., 'electrical_tap', 'roof_load', 'structural_cutting', 'floor_mounting', 'heating_ventilation')"
          ),
        proposed_roof_load_lbs: z
          .number()
          .positive()
          .optional()
          .describe(
            "Optional proposed total dynamic roof load in pounds to check against OEM limits"
          ),
        proposed_tap_amps: z
          .number()
          .positive()
          .optional()
          .describe(
            "Optional proposed continuous alternator/upfitter tap current in Amperes to check against OEM connection limits"
          ),
      },
    },
    async (args) => {
      const result = evaluateChassisRules(args.chassis, args.rule_type, {
        ...(args.proposed_roof_load_lbs !== undefined
          ? { proposed_roof_load_lbs: args.proposed_roof_load_lbs }
          : {}),
        ...(args.proposed_tap_amps !== undefined
          ? { proposed_tap_amps: args.proposed_tap_amps }
          : {}),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
