import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerElectricalTools } from "./tools/electrical.js";
import { registerPayloadTools } from "./tools/payload.js";
import { registerChassisTools } from "./tools/chassis.js";
import { registerSpecTools } from "./tools/specs.js";
import { registerManualTools } from "./tools/manuals.js";
import {
  extractBearerToken,
  extractMeteredToolCalls,
  authenticateAndCheckBalance,
  recordToolUsage,
  isMeteringAllowAll,
  type MeteredToolCall,
} from "./utils/metering.js";

export interface Env {
  DB: D1Database;
  VECTOR_INDEX: VectorizeIndex;
  AI?: Ai;
  CDN_BASE_URL?: string;
  /**
   * When "true" (current default), all MCP requests bypass API-key auth and microcent billing.
   * Set to "false" to enforce SHA-256 Bearer API-key authentication and per-tool metering.
   */
  METERING_ALLOW_ALL?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const allowAll = isMeteringAllowAll(env.METERING_ALLOW_ALL);

    let meteredCalls: MeteredToolCall[] = [];
    let authenticatedAccountId: string | undefined;

    if (!allowAll) {
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
        Math.max(1, totalRequiredMicrocents)
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
    registerPayloadTools(mcp);
    registerChassisTools(mcp);
    registerSpecTools(mcp, env.DB);
    registerManualTools(mcp, env.VECTOR_INDEX, env.AI, env.DB, env.CDN_BASE_URL);

    // Use stateless transport for Cloudflare Workers (no persistent sessions)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await mcp.connect(transport);
    const response = await transport.handleRequest(request);

    if (
      !allowAll &&
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
            ) ?? (respItems.length === 1 ? respItems[0] : undefined);
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

      const elapsedMs = Date.now() - startTime;
      for (const call of successfulCalls) {
        const deducted = await recordToolUsage(
          env.DB,
          authenticatedAccountId,
          call.name,
          call.costMicrocents,
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
