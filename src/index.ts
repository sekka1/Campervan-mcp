import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerElectricalTools } from "./tools/electrical.js";
import { registerManualTools, searchVanManuals, SearchFilterOptions, SearchVanManualsResponse } from "./tools/manuals.js";
import {
  extractBearerToken,
  extractMeteredToolCalls,
  authenticateAndCheckBalance,
  recordBatchToolUsage,
  isAuthEnabled,
  isMeteringAllowAll,
  type MeteredToolCall,
} from "./utils/metering.js";
import { calculateDCWireAndFuse, WireCalculationParams, WireCalculationResult } from "./utils/formulas.js";

export { calculateDCWireAndFuse as calculateDcWireAndFuse, calculateDCWireAndFuse };
export { searchVanManuals };
export type { WireCalculationParams, WireCalculationResult, SearchFilterOptions, SearchVanManualsResponse };

export interface Env {
  DB: D1Database;
  VECTOR_INDEX: VectorizeIndex;
  AI?: Ai;
  CDN_BASE_URL?: string;
  DEEPINFRA_TOKEN?: string;
  EMBEDDING_PROVIDER?: string;
  AUTH_ENABLED?: string;
  METERING_ALLOW_ALL?: string;
  [key: string]: unknown;
}

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
          description: "Nominal DC system voltage in volts: 12, 24, or 48",
        },
        amperage: {
          type: "number",
          description: "Circuit design current or continuous load in amps",
        },
        one_way_distance_feet: {
          type: "number",
          description: "One-way cable run distance in feet from source to load",
        },
        allowable_drop_percent: {
          type: "number",
          enum: [3, 10],
          description: "Maximum allowable voltage drop percentage: 3% for critical circuits, 10% for non-critical",
        },
        is_engine_compartment: {
          type: "boolean",
          description: "Whether the cable run passes through an engine compartment",
        },
      },
      required: ["system_voltage", "amperage", "one_way_distance_feet"],
    },
  },
  {
    name: "search_van_manuals",
    description: `Searches indexed technical documentation, OEM body builder manuals (BEMM), and component guides.
IMPORTANT INSTRUCTIONS FOR LLM CONSUMERS:
- Adhere strictly to the returned 'retrieval_contract'.
- CRITICAL NEGATIVE CONSTRAINT: When a requested third-party component (e.g., MaxxFan, specific aftermarket appliance) is NOT found in the indexed manuals:
  1. State clearly that the component manual is not in the database.
  2. Provide ONLY vehicle-side OEM chassis constraints (e.g., roof bow clearance, sealant requirements).
  3. DO NOT attempt to provide "widely published", "typical", or general specifications for the missing component (especially torque, screw sizes, or cut-out tolerances).
  4. Explicitly state: "Consult the manufacturer's manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation."`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        chassis: {
          type: "string",
          description: "Optional chassis filter (e.g., 'transit', 'sprinter', 'promaster')",
        },
        subsystem: {
          type: "string",
          description:
            "Filter by van subsystem. Allowed values: '12v_dc' (electrical, dc, battery, wiring), '48v_dc', '120v_ac' (ac, inverter, shore power), 'plumbing' (water, tanks), 'heating_cooling' (covers climate, ventilation, fans, A/C, and heaters), 'structural' (body, roof, mounting), 'chassis_interface' (CAN bus, signals). If unsure, omit this field.",
        },
        manufacturer: {
          type: "string",
          description: "Optional manufacturer filter",
        },
        limit: {
          type: "number",
          description: "Number of most relevant document chunks to return",
        },
      },
      required: ["query"],
    },
  },
];

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export async function handleMcpRequest(
  body: JsonRpcRequest,
  env?: Env,
  _accountId?: string
): Promise<JsonRpcResponse> {
  const { id, method, params } = body;

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};

    if (name === "calculate_dc_wire_and_fuse") {
      try {
        const result = calculateDCWireAndFuse(args as unknown as WireCalculationParams);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
            structured: result as unknown as Record<string, unknown>,
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: err instanceof Error ? err.message : "Invalid wire calculation parameters",
          },
        };
      }
    }

    if (name === "search_van_manuals") {
      try {
        const filterOptions: SearchFilterOptions = {
          chassis: args?.chassis as string | undefined,
          subsystem: args?.subsystem as string | undefined,
          manufacturer: args?.manufacturer as string | undefined,
          limit: args?.limit as number | undefined,
        };
        const result = await searchVanManuals(args?.query as string, env, filterOptions);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
            structured: result as unknown as Record<string, unknown>,
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Error executing manuals search",
          },
        };
      }
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const authEnabled = isAuthEnabled(env.AUTH_ENABLED);
    const allowAllMetering = isMeteringAllowAll(env.METERING_ALLOW_ALL);
    const shouldEnforceMetering = !allowAllMetering;
    let meteredCalls: MeteredToolCall[] = [];
    let authenticatedAccountId: string | undefined;

    if (authEnabled || shouldEnforceMetering) {
      if (request.method === "POST") {
        try {
          const cloned = await request.clone().json();
          meteredCalls = extractMeteredToolCalls(cloned);
        } catch {
          // Non-JSON or malformed body will be handled by the MCP transport
        }
      }

      const totalRequiredMicrocents = meteredCalls.reduce(
        (sum, call) => sum + call.costMicrocents,
        0
      );

      const authHeader = request.headers.get("Authorization");
      const token = extractBearerToken(authHeader);

      if (!token) {
        return new Response(
          JSON.stringify({ error: "Missing or invalid API key" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      const authResult = await authenticateAndCheckBalance(
        env.DB,
        token,
        Math.max(1, totalRequiredMicrocents),
        shouldEnforceMetering
      );

      if (!authResult.ok) {
        return new Response(
          JSON.stringify({ error: authResult.error }),
          { status: authResult.status, headers: { "Content-Type": "application/json" } }
        );
      }

      authenticatedAccountId = authResult.account.id;
    }

    const startTime = Date.now();
    const mcp = new McpServer({
      name: "Campervan Technical & Electrical MCP",
      version: "1.0.0",
    });

    // Register modular tool groups
    registerElectricalTools(mcp);
    registerManualTools(
      mcp,
      env.VECTOR_INDEX,
      env.AI,
      env.DB,
      env.CDN_BASE_URL,
      env.DEEPINFRA_TOKEN,
      env.EMBEDDING_PROVIDER
    );

    // Use stateless transport for Cloudflare Workers (no persistent sessions)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await mcp.connect(transport);
    const response = await transport.handleRequest(request);

    if (
      shouldEnforceMetering &&
      authenticatedAccountId &&
      meteredCalls.length > 0 &&
      response.status === 200
    ) {
      let successfulCalls = meteredCalls;
      try {
        const respBody = await response.clone().json();
        const respItems = Array.isArray(respBody) ? respBody : [respBody];
        successfulCalls = meteredCalls.filter((call) => {
          const matchingResp =
            respItems.find(
              (r) => r && typeof r === "object" && (r as { id?: unknown }).id === call.id
            ) ??
            (respItems.length === 1 &&
            meteredCalls.length === 1 &&
            respItems[0] &&
            typeof respItems[0] === "object" &&
            (respItems[0] as { id?: unknown }).id === undefined
              ? respItems[0]
              : undefined);

          if (!matchingResp || typeof matchingResp !== "object") return false;
          const typedResp = matchingResp as {
            error?: unknown;
            result?: { isError?: boolean };
          };
          return !typedResp.error && typedResp.result?.isError !== true;
        });
      } catch {
        // Non-JSON 200 stream: bill all metered calls
      }

      if (successfulCalls.length > 0) {
        const elapsedMs = Date.now() - startTime;
        const deducted = await recordBatchToolUsage(
          env.DB,
          authenticatedAccountId,
          successfulCalls,
          elapsedMs
        );

        if (!deducted) {
          return new Response(
            JSON.stringify({ error: "Insufficient account balance" }),
            { status: 402, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    }

    return response;
  },
};
