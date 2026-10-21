import { describe, it, expect } from "vitest";

const RAW_BASE_URL = process.env.BASE_URL;
export const BASE_URL =
  RAW_BASE_URL && RAW_BASE_URL.startsWith("http")
    ? RAW_BASE_URL.replace(/\/+$/, "")
    : "https://campervan-mcp-server.garlandk.workers.dev";

const SHOULD_RUN_LIVE =
  process.env.RUN_LIVE_TESTS === "true" ||
  process.env.LIVE_SMOKE_TEST === "true" ||
  process.env.CI_LIVE_TEST === "true";

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export async function callMcpTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  id: number = 1
): Promise<{ text: string; data: T }> {
  const url = `${BASE_URL}/`;
  const payload = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MCP HTTP request failed (${response.status} ${response.statusText}): ${body}`);
  }

  const json = (await response.json()) as JsonRpcResponse;
  if (json.error) {
    throw new Error(`JSON-RPC Error (${json.error.code}): ${json.error.message}`);
  }

  const text = json.result?.content?.[0]?.text;
  if (!text) {
    throw new Error(`Empty content returned in JSON-RPC result for tool "${toolName}"`);
  }

  const data = JSON.parse(text) as T;
  return { text, data };
}

describe("Post-Deployment Live Smoke Test Suite", () => {
  if (!SHOULD_RUN_LIVE) {
    it.skip("live smoke tests skipped in local/offline test run (run via npm run test:live)", () => {});
    return;
  }

  it("Test A: Embedding Health & Cosine Score Range", async () => {
    console.log("-> [Test A] Querying search_van_manuals for CCP1 CCP2 driver seat...");
    const { data } = await callMcpTool<{
      count: number;
      query: string;
      results: Array<{
        chunk_id: string;
        score: number;
        source: string;
        page?: number;
        section?: string;
        text: string;
      }>;
    }>("search_van_manuals", {
      query: "Customer Connection Points CCP1 CCP2 driver seat",
    });

    console.log(`  Received ${data.results.length} chunks (default top_k: 8)`);
    expect(data.results).toBeDefined();
    expect(data.results.length).toBe(8);

    for (const r of data.results) {
      console.log(`  - Chunk: ${r.chunk_id} | Page: ${r.page} | Score: ${r.score} | Source: "${r.source}"`);
      expect(r.score).not.toBe(-1);
      expect(r.score).toBeGreaterThan(0.6);
      expect(r.score).toBeLessThanOrEqual(1.0);
      expect(r.source).toBeDefined();
      expect(r.source).not.toBe("unknown");
    }
  });

  it("Test B: Critical Document Ingestion Coverage (CCP2 & LK4T Part Number)", async () => {
    console.log("-> [Test B1] Inspecting D1 document_chunks for CCP2...");
    const { data: ccp2Data } = await callMcpTool<{
      keyword: string;
      count: number;
      results: Array<{ id: string; page_number: number; section_title: string; snippet: string }>;
    }>("inspect_manual_chunks", {
      keyword: "CCP2",
      limit: 3,
    });

    console.log(`  Found ${ccp2Data.count} chunks matching CCP2`);
    expect(ccp2Data.count).toBeGreaterThanOrEqual(1);
    for (const r of ccp2Data.results) {
      console.log(`  - Page ${r.page_number} (${r.id}): ${r.snippet.slice(0, 80)}...`);
      expect(r.page_number).toBeGreaterThan(80);
    }

    console.log("-> [Test B2] Inspecting D1 document_chunks for LK4T part number...");
    const { data: lk4tData } = await callMcpTool<{
      keyword: string;
      count: number;
      results: Array<{ id: string; page_number: number; section_title: string; snippet: string }>;
    }>("inspect_manual_chunks", {
      keyword: "LK4T",
      limit: 1,
    });

    console.log(`  Found ${lk4tData.count} chunks matching LK4T`);
    expect(lk4tData.count).toBeGreaterThanOrEqual(1);
    expect(lk4tData.results[0].page_number).toBeGreaterThanOrEqual(90);
    console.log(`  v LK4T found on page ${lk4tData.results[0].page_number}`);
  });

  it("Test C: Deterministic Wire Calculator Tool Call", async () => {
    console.log("-> [Test C] Calling calculate_dc_wire_and_fuse for 50A 12V circuit...");
    const { data } = await callMcpTool<{
      recommended_awg: string;
      round_trip_feet: number;
      exact_voltage_drop_volts: number;
      exact_voltage_drop_percent: number;
      recommended_fuse_amps: number;
      fuse_type: string;
    }>("calculate_dc_wire_and_fuse", {
      system_voltage: 12,
      amperage: 50,
      one_way_distance_feet: 15,
      allowable_drop_percent: 3,
      is_engine_compartment: false,
    });

    console.log(`  Recommended AWG: ${data.recommended_awg}, Fuse: ${data.recommended_fuse_amps}A (${data.fuse_type})`);
    expect(data.round_trip_feet).toBe(30);
    expect(data.exact_voltage_drop_volts).toBeLessThan(0.36);
    expect(data.exact_voltage_drop_percent).toBeLessThan(3.0);
    expect(data.recommended_fuse_amps).toBeGreaterThanOrEqual(70);
    expect(data.recommended_fuse_amps).toBeLessThanOrEqual(80);
    expect(data.fuse_type).toBe("MIDI / AMI Fuse");
  });
});
