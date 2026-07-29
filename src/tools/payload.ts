import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { calculateVanPayload, VAN_SPECS } from "../utils/formulas.js";

export function registerPayloadTools(mcp: McpServer): void {
  mcp.registerTool(
    "calculate_van_payload",
    {
      description:
        "Calculates total component weight against vehicle GVWR (Gross Vehicle Weight Rating) for Sprinter, Transit, and Promaster vans. Returns remaining payload capacity and estimated axle load distribution.",
      inputSchema: {
        van_model: z
          .enum([
            "sprinter_144",
            "sprinter_170",
            "transit_148",
            "transit_148_ext",
            "promaster_136",
            "promaster_159",
          ])
          .describe(
            "Van model variant. Options: sprinter_144, sprinter_170, transit_148, transit_148_ext, promaster_136, promaster_159"
          ),
        components: z
          .array(
            z.object({
              name: z.string().describe("Component name (e.g., 'Battle Born 100Ah LiFePO4 battery')"),
              weight_lbs: z.number().positive().describe("Component weight in pounds"),
              position: z
                .enum(["front", "mid", "rear"])
                .optional()
                .describe(
                  "Position in van: 'front' (cab area), 'mid' (center), 'rear' (back). Defaults to 'mid'"
                ),
            })
          )
          .min(1)
          .describe("List of components to include in payload calculation"),
        occupants_weight_lbs: z
          .number()
          .min(0)
          .default(0)
          .describe("Total weight of occupants in lbs (default 0). Placed at mid-van position."),
      },
    },
    async (args) => {
      const result = calculateVanPayload(
        args.van_model,
        args.components,
        args.occupants_weight_lbs
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Informational tool: list available van models with specs
  mcp.registerTool(
    "list_van_models",
    {
      description:
        "Lists all supported van models with their GVWR, curb weight, maximum payload, and axle ratings.",
      inputSchema: {},
    },
    async () => {
      const models = Object.entries(VAN_SPECS).map(([key, spec]) => ({
        model_key: key,
        gvwr_lbs: spec.gvwr_lbs,
        curb_weight_lbs: spec.curb_weight_lbs,
        max_payload_lbs: spec.gvwr_lbs - spec.curb_weight_lbs,
        front_axle_rating_lbs: spec.front_axle_rating_lbs,
        rear_axle_rating_lbs: spec.rear_axle_rating_lbs,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(models, null, 2) }],
      };
    }
  );
}
