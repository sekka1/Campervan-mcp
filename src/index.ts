/**
 * Campervan MCP Server - Edge Runtime Entrypoint
 * Provides MCP tool registration and JSON-RPC 2.0 handlers for LLMs
 * with embedded safety invariants and strict retrieval grounding contracts.
 */

import { calculateDcWireAndFuse, WireCalculationParams } from "./tools/calculations.ts";
import { searchVanManuals, SearchFilterOptions, Env } from "./tools/manuals.ts";

export { calculateDcWireAndFuse } from "./tools/calculations.ts";
export { searchVanManuals } from "./tools/manuals.ts";
export type { Env };

export const MCP_TOOLS = [
  {
    name: "calculate_dc_wire_and_fuse",
    description: `Calculates recommended DC wire gauge (AWG), fuse ampacity, and voltage drop for campervan electrical installations.
IMPORTANT SAFETY INSTRUCTIONS FOR LLM CONSUMERS:
- AWG is an inverse scale: 1/0 and 2/0 are larger than 2 AWG; 4 AWG is smaller. Never recommend a higher numerical AWG as an upsize.
- Overcurrent protection (fuse) must ALWAYS be placed within 7 inches of the battery (power source), NEVER at the inverter or load.
- Always include the returned 'safety_invariants' in user-facing answers.`,
    inputSchema: {
      type: "object",
      properties: {
        system_voltage: {
          type: "number",
          enum: [12, 24, 48],
          description: "Nominal DC system voltage (12V, 24V, or 48V)."
        },
        amperage: {
          type: "number",
          description: "Continuous current draw in Amperes."
        },
        one_way_distance_feet: {
          type: "number",
          description: "One-way distance in feet between power source and load."
        },
        allowable_drop_percent: {
          type: "number",
          enum: [3, 10],
          description: "Allowable voltage drop percentage (3% for critical loads/electronics, 10% for non-critical loads)."
        },
        is_engine_compartment: {
          type: "boolean",
          description: "Whether conductors run through engine compartment requiring 105°C ambient thermal derating."
        }
      },
      required: ["system_voltage", "amperage", "one_way_distance_feet", "allowable_drop_percent"]
    }
  },
  {
    name: "search_van_manuals",
    description: `Searches indexed technical documentation, OEM body builder manuals (BEMM), and component guides.
IMPORTANT INSTRUCTIONS FOR LLM CONSUMERS:
- Adhere strictly to the returned 'retrieval_contract'.
- If the specific vehicle manual, appliance manual, or component is not present in the search results, state clearly that the documentation is not available in the database. Never hallucinate torque specs, screw sizes, or part numbers.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Technical search query or specification question."
        },
        chassis: {
          type: "string",
          enum: ["ford_transit", "mercedes_sprinter", "ram_promaster", "universal"],
          description: "Target van platform."
        },
        subsystem: {
          type: "string",
          enum: [
            "12v_dc",
            "48v_dc",
            "120v_ac",
            "plumbing",
            "heating_cooling",
            "structural",
            "chassis_interface"
          ],
          description: "Target technical subsystem."
        },
        manufacturer: {
          type: "string",
          description: "Equipment manufacturer (e.g., Ford, Victron, Dometic, Espar)."
        },
        limit: {
          type: "number",
          description: "Maximum number of chunks to return (default 3)."
        }
      },
      required: ["query"]
    }
  }
];

export async function handleMcpRequest(
  body: any,
  env?: Env,
  _accountId?: string
): Promise<any> {
  const { id, method, params } = body;

  // MCP Protocol Tool Discovery
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS
      }
    };
  }

  // MCP Protocol Tool Call
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};

    if (name === "calculate_dc_wire_and_fuse") {
      try {
        const result = calculateDcWireAndFuse(args as WireCalculationParams);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ],
            structured: result
          }
        };
      } catch (err: any) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: err?.message || "Invalid wire calculation parameters"
          }
        };
      }
    }

    if (name === "search_van_manuals") {
      try {
        const filterOptions: SearchFilterOptions = {
          chassis: args?.chassis,
          subsystem: args?.subsystem,
          manufacturer: args?.manufacturer,
          limit: args?.limit
        };
        const result = await searchVanManuals(args?.query, env, filterOptions);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ],
            structured: result
          }
        };
      } catch (err: any) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: err?.message || "Error executing manuals search"
          }
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Tool '${name}' not found.`
      }
    };
  }

  // MCP Handshake initialization
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: "campervan-mcp",
          version: "1.0.0"
        }
      }
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32600,
      message: "Invalid JSON-RPC request"
    }
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // MCP JSON-RPC Endpoint
    if (request.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/")) {
      try {
        const body = await request.json();
        const response = await handleMcpRequest(body, env);
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error: invalid JSON" }
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          server: "campervan-mcp",
          tools: MCP_TOOLS.map((t) => t.name)
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Campervan MCP Server Online", { status: 200 });
  }
};
