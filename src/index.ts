import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerElectricalTools } from "./tools/electrical.js";
import { registerPayloadTools } from "./tools/payload.js";
import { registerSpecTools } from "./tools/specs.js";
import { registerManualTools } from "./tools/manuals.js";

export interface Env {
  DB: D1Database;
  VECTOR_INDEX: VectorizeIndex;
  AI?: Ai;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const mcp = new McpServer({
      name: "Campervan Technical & Electrical MCP",
      version: "1.0.0",
    });

    // Register modular tool groups
    registerElectricalTools(mcp);
    registerPayloadTools(mcp);
    registerSpecTools(mcp, env.DB);
    registerManualTools(mcp, env.VECTOR_INDEX, env.AI);

    // Use stateless transport for Cloudflare Workers (no persistent sessions)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await mcp.connect(transport);
    return transport.handleRequest(request);
  },
};
