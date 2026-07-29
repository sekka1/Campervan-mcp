import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryComponentSpecs, getComponentByModel } from "../utils/db.js";

export function registerSpecTools(mcp: McpServer, db: D1Database): void {
  // -------------------------------------------------------------------------
  // Tool: lookup_component_specs
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "lookup_component_specs",
    {
      description:
        "Queries the D1 database for component specifications including terminal stud sizes, maximum continuous amp ratings, dimensions, and idle power draws for electrical components like Victron MultiPlus, Blue Sea busbars, and Velit heaters.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe(
            "Component category filter (e.g., 'inverter_charger', 'busbar', 'battery', 'charge_controller', 'heater', 'solar_panel')"
          ),
        name_filter: z
          .string()
          .optional()
          .describe(
            "Partial name search (e.g., 'MultiPlus', 'Blue Sea', 'Victron'). Case-insensitive."
          ),
        manufacturer: z
          .string()
          .optional()
          .describe("Manufacturer name filter (e.g., 'Victron', 'Blue Sea', 'Renogy')"),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .default(10)
          .describe("Maximum number of results to return (default 10, max 50)"),
      },
    },
    async (args) => {
      const results = await queryComponentSpecs(db, {
        category: args.category,
        nameFilter: args.name_filter,
        manufacturer: args.manufacturer,
        limit: args.limit,
      });

      const payload =
        results.length === 0
          ? { results: [], message: "No components found matching the specified criteria." }
          : { results, count: results.length };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: get_component_by_model
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "get_component_by_model",
    {
      description:
        "Retrieves exact specifications for a component by its model number from the D1 database.",
      inputSchema: {
        model_number: z
          .string()
          .min(1)
          .describe(
            "Exact model number to look up (e.g., 'PMP482500500', '5191', 'BBS030430100')"
          ),
      },
    },
    async (args) => {
      const result = await getComponentByModel(db, args.model_number);

      const payload = result
        ? { found: true, component: result }
        : { found: false, message: `No component found with model number: ${args.model_number}` };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );
}
