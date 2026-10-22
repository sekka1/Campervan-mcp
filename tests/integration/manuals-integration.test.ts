import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerManualTools } from "../../src/tools/manuals";

describe("Integration: Manual Tools & Ingestion Verification", () => {
  describe("SQL Pattern Isolation in inspect_manual_chunks", () => {
    it("binds the keyword pattern to both chunk_text and section_title and isolates inverter from Customer Connection Point", async () => {
      const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
      const vectorIndex = { query: vi.fn() } as unknown as VectorizeIndex;

      let boundSql = "";
      let boundParams: unknown[] = [];

      const bind = vi.fn((...params: unknown[]) => {
        boundParams = params;
        return {
          all: vi.fn().mockResolvedValue({
            results: [
              {
                id: "chunk_inverter_1",
                page_number: 52,
                section_title: "High Voltage Inverter Module",
                snippet: "The electric powertrain inverter converts 400V DC to 3-phase AC...",
              },
            ],
          }),
        };
      });

      const db = {
        prepare: vi.fn((sql: string) => {
          boundSql = sql;
          return { bind };
        }),
      } as unknown as D1Database;

      registerManualTools(mcp, vectorIndex, undefined, db);

      const registeredTools = (
        mcp as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
          >;
        }
      )._registeredTools;

      const handler = registeredTools["inspect_manual_chunks"].handler;
      const response = await handler({ keyword: "inverter", limit: 3 });

      expect(boundSql).toContain("chunk_text LIKE ? OR section_title LIKE ?");
      expect(boundSql).not.toContain("Customer Connection Point");
      expect(boundParams).toEqual(["%inverter%", "%inverter%", 3]);

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.keyword).toBe("inverter");
      expect(parsed.count).toBe(1);
      expect(parsed.results[0].id).toBe("chunk_inverter_1");
      expect(parsed.results[0].snippet).toContain("inverter");
      expect(parsed.results[0].snippet).not.toContain("Customer Connection Point");
    });
  });

  describe("Fail-Fast on Embedding Failure", () => {
    it("rethrows descriptive error when Workers AI embedding rejects instead of returning zero-vector fallback", async () => {
      const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
      const vectorIndex = { query: vi.fn() } as unknown as VectorizeIndex;

      const ai = {
        run: vi.fn().mockRejectedValue(new Error("Cloudflare Workers AI capacity exceeded (503)")),
      } as unknown as Ai;

      registerManualTools(mcp, vectorIndex, ai);

      const registeredTools = (
        mcp as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
          >;
        }
      )._registeredTools;

      await expect(
        registeredTools["search_van_manuals"].handler({
          query: "Ford Transit auxiliary battery tap",
        })
      ).rejects.toThrow("Failed to generate text embedding via Workers AI (@cf/baai/bge-base-en-v1.5)");


    });
  });

  describe("Metadata Hydration from D1", () => {
    it("hydrates source from document_title and manufacturer from D1 record rather than returning unknown", async () => {
      const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
      const query = vi.fn().mockResolvedValue({
        matches: [
          {
            id: "transit_chunk_173",
            score: 0.74,
            metadata: { text: "CCP1 60A and CCP2 175A on driver seat pedestal", source: "unknown" },
          },
        ],
      });
      const vectorIndex = { query } as unknown as VectorizeIndex;

      const bind = vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            {
              id: "transit_chunk_173",
              document_id: "doc_bemm_2024",
              document_title: "MY24 Ford Transit Body and Equipment Mounting Manual",
              category: "oem_bemm",
              manufacturer: "Ford Motor Company",
              applicable_chassis: "transit",
              page_number: 145,
              section_title: "4.24.4 Customer Connection Points",
              subsystem: "12v_dc",
              chunk_text: "Customer connection points CCP1 (60A) and CCP2 (175A)...",
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

      const registeredTools = (
        mcp as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
          >;
        }
      )._registeredTools;

      const response = await registeredTools["search_van_manuals"].handler({
        query: "CCP2 customer connection point",
      });

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.count).toBe(1);
      const chunk = parsed.results[0];

      expect(chunk.source).toBe("MY24 Ford Transit Body and Equipment Mounting Manual");
      expect(chunk.document_title).toBe("MY24 Ford Transit Body and Equipment Mounting Manual");
      expect(chunk.manufacturer).toBe("Ford Motor Company");
      expect(chunk.source).not.toBe("unknown");
      expect(chunk.manufacturer).not.toBe("unknown");
    });
  });
});
