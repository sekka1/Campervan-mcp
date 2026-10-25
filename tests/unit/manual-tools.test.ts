import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerManualTools } from "../../src/tools/manuals";

describe("registerManualTools - search_van_manuals", () => {
  it("registers search_van_manuals and executes hybridSearch with normalized chassis", async () => {
    const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
    const query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "doc_1_chunk_0",
          score: 0.95,
          metadata: { text: "CCP2 175A single point connection", source: "transit_bemm", chassis: "transit" },
        },
      ],
    });
    const vectorIndex = { query } as unknown as VectorizeIndex;

    const bind = vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: "doc_1_chunk_0",
            document_id: "doc_1",
            document_title: "Ford Transit BEMM",
            category: "oem_bemm",
            manufacturer: "Ford",
            applicable_chassis: "transit",
            page_number: 148,
            section_title: "Auxiliary Power",
            subsystem: "12v_dc",
            chunk_text: "CCP2 connection under driver seat: 175A max single, 60A continuous.",
            schematic_r2_key: "schematics/doc_1/p148-0.png",
            schematic_caption: "CCP2 Location",
          },
        ],
      }),
    });
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
    } as unknown as D1Database;

    const runAi = vi.fn().mockResolvedValue({
      data: [new Array(768).fill(0.05)],
    });
    const ai = { run: runAi } as unknown as Ai;

    registerManualTools(mcp, vectorIndex, ai, db, "https://cdn.example.com");

    // Retrieve tool handler from mcp instance
    const registeredTools = (mcp as unknown as { _registeredTools: Record<string, { handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools;
    expect(registeredTools["search_van_manuals"]).toBeDefined();

    const toolHandler = registeredTools["search_van_manuals"].handler;
    const response = await toolHandler({
      query: "Ford Transit CCP2 alternator connection",
      chassis: "ford_transit",
      subsystem: "12v_dc",
      top_k: 3,
    });

    expect(runAi).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
      text: ["Ford Transit CCP2 alternator connection"],
    });
    expect(query).toHaveBeenCalledWith(expect.any(Array), {
      topK: 3,
      returnMetadata: "all",
      filter: {
        chassis: { $in: ["transit", "universal"] },
        subsystem: { $eq: "12v_dc" },
      },
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].chunk_id).toBe("doc_1_chunk_0");
    expect(parsed.results[0].manufacturer).toBe("Ford");
    expect(parsed.results[0].schematic_url).toBe("https://cdn.example.com/schematics/doc_1/p148-0.png");
    expect(parsed.results[0].schematic_markdown).toBe("[CCP2 Location](https://cdn.example.com/schematics/doc_1/p148-0.png)");
  });

  it("returns graceful empty payload when no matches found", async () => {
    const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
    const vectorIndex = { query: vi.fn().mockResolvedValue({ matches: [] }) } as unknown as VectorizeIndex;
    registerManualTools(mcp, vectorIndex);

    const registeredTools = (mcp as unknown as { _registeredTools: Record<string, { handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools;
    const response = await registeredTools["search_van_manuals"].handler({
      query: "obscure nonexistent query",
      chassis: "ram_promaster",
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.results).toEqual([]);
    expect(parsed.message).toBe("No relevant documentation found for the given query.");
    expect(parsed.applied_filters).toEqual({ chassis: "ram_promaster" });
  });

  it("fails fast with clear error message when Workers AI embedding throws", async () => {
    const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
    const vectorIndex = { query: vi.fn() } as unknown as VectorizeIndex;
    const ai = {
      run: vi.fn().mockRejectedValue(new Error("Rate limit exceeded on @cf/baai/bge-base-en-v1.5")),
    } as unknown as Ai;

    registerManualTools(mcp, vectorIndex, ai);
    const registeredTools = (mcp as unknown as { _registeredTools: Record<string, { handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools;

    await expect(
      registeredTools["search_van_manuals"].handler({
        query: "Transit CCP2 location",
        chassis: "ford_transit",
      })
    ).rejects.toThrow("Failed to generate text embedding via Workers AI");
  });

  it("registers and executes inspect_manual_chunks when D1 db is provided", async () => {
    const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
    const vectorIndex = { query: vi.fn() } as unknown as VectorizeIndex;
    const bind = vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: "MY24_Transit#chunk_42",
            page_number: 148,
            section_title: "4.6.3 Power Connections",
            snippet: "The CCP2 is located on the driver seat pedestal...",
          },
        ],
      }),
    });
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
    } as unknown as D1Database;

    registerManualTools(mcp, vectorIndex, undefined, db);
    const registeredTools = (mcp as unknown as { _registeredTools: Record<string, { handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools;

    expect(registeredTools["inspect_manual_chunks"]).toBeDefined();
    const res = await registeredTools["inspect_manual_chunks"].handler({
      keyword: "CCP2",
      limit: 2,
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.keyword).toBe("CCP2");
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].section_title).toBe("4.6.3 Power Connections");
    expect(bind).toHaveBeenCalledWith("%CCP2%", "%CCP2%", 2);
  });

  it("defaults to top_k 8 and populates source and manufacturer from D1 in search_van_manuals", async () => {
    const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
    const query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "chunk_abc",
          score: 0.88,
          metadata: { text: "Ford Transit auxiliary battery tap", source: "unknown" },
        },
      ],
    });
    const vectorIndex = { query } as unknown as VectorizeIndex;
    const bind = vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: "chunk_abc",
            document_id: "doc_ford_1",
            document_title: "Ford Transit BEMM 2024",
            category: "oem_bemm",
            manufacturer: "Ford",
            applicable_chassis: "transit",
            page_number: 145,
            section_title: "4.24.4 Customer Connection Points",
            subsystem: "12v_dc",
            chunk_text: "CCP1 60A and CCP2 175A connection points on driver seat pedestal",
            schematic_r2_key: null,
            schematic_caption: null,
          },
        ],
      }),
    });
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
    } as unknown as D1Database;

    registerManualTools(mcp, vectorIndex, undefined, db);
    const registeredTools = (mcp as unknown as { _registeredTools: Record<string, { handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools;

    const res = await registeredTools["search_van_manuals"].handler({
      query: "Customer Connection Points CCP1 CCP2 driver seat",
    });

    // Verify topK defaults to 8
    expect(query).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ topK: 8 }));

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].chunk_id).toBe("chunk_abc");
    // Verify source and manufacturer populated from D1 instead of "unknown"
    expect(parsed.results[0].source).toBe("Ford Transit BEMM 2024");
    expect(parsed.results[0].document_title).toBe("Ford Transit BEMM 2024");
    expect(parsed.results[0].manufacturer).toBe("Ford");
  });

  it("verifies search_van_manuals input schema defaults top_k to 8 when omitted", () => {
    const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
    const vectorIndex = { query: vi.fn() } as unknown as VectorizeIndex;
    registerManualTools(mcp, vectorIndex);

    const registeredTools = (mcp as unknown as { _registeredTools: Record<string, { inputSchema: { shape: { top_k: { parse: (val: unknown) => number } } } }> })._registeredTools;
    const searchTool = registeredTools["search_van_manuals"];
    expect(searchTool).toBeDefined();

    const parsed = searchTool.inputSchema.shape.top_k.parse(undefined);
    expect(parsed).toBe(8);
  });

});
