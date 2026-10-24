import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch } from "../utils/db.js";

/**
 * Simple embedding generation using Cloudflare AI text embeddings.
 * Falls back to a zero vector if AI binding is unavailable (e.g., local dev).
 *
 * Uses the `@cf/baai/bge-base-en-v1.5` model via the `AI` binding, which
 * produces 768-dimensional vectors, matching the dimensionality of the
 * `van_manuals_index` Vectorize index populated by
 * `scripts/ingest-manuals.ts` and the ingest-manuals GitHub Actions workflow.
 */
async function generateEmbedding(text: string, ai?: Ai): Promise<number[]> {
  if (ai) {
    try {
      const response = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [text] });
      const result = response as unknown as { data: number[][] };
      if (result && Array.isArray(result.data) && Array.isArray(result.data[0]) && result.data[0].length > 0) {
        return result.data[0];
      }
      throw new Error(
        "Workers AI returned invalid embedding response structure: " + JSON.stringify(response)
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Workers AI embedding error for model @cf/baai/bge-base-en-v1.5:", msg);
      throw new Error(
        "Failed to generate text embedding via Workers AI (@cf/baai/bge-base-en-v1.5): " + msg
      );
    }
  }

  // Fallback: return zero vector only for local development/testing without an AI binding
  console.warn(
    "Workers AI binding (env.AI) is unavailable; returning zero vector for local dev/testing."
  );
  return new Array(768).fill(0) as number[];
}

export function registerManualTools(mcp: McpServer, vectorIndex: VectorizeIndex, ai?: Ai, db?: D1Database, cdnBaseUrl?: string): void {
  // -------------------------------------------------------------------------
  // Tool: search_van_manuals
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "search_van_manuals",
    {
      description:
        "Searches vetted OEM vehicle manuals (Ford Transit, Mercedes Sprinter, Ram ProMaster), electrical components (Victron, Renogy, REDARC), and upfitter standards. Returns authoritative text chunks, torque specs, part numbers, and schematic links. CRITICAL: When referencing diagrams in your response, you MUST use the exact 'schematic_markdown' or 'schematic_url' string verbatim without altering the character casing, as Cloudflare R2 object storage keys are strictly case-sensitive.",
      inputSchema: {
        query: z
          .string()
          .min(3)
          .describe(
            "Natural language search query (e.g., 'Transit body builder roof load rating', 'Velit heater E3 error code', 'MultiPlus wiring diagram')"
          ),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(8)
          .describe("Number of most relevant document chunks to return (default 5, max 20)"),
        source_filter: z
          .string()
          .optional()
          .describe(
            "Optional filter to restrict search to a specific manual source (e.g., 'ford_transit_body_builder', 'victron_multiplus', 'velit_heater')"
          ),
        chassis: z
          .string()
          .optional()
          .describe("Optional chassis filter (e.g., 'transit', 'sprinter', 'promaster'); 'universal' documents are always included"),
        subsystem: z
          .enum(["12v_dc", "48v_dc", "120v_ac", "plumbing", "heating_cooling", "structural", "chassis_interface"])
          .optional()
          .describe("Optional subsystem filter"),
        category: z
          .enum(["chassis", "climate", "power", "plumbing", "other"])
          .optional()
          .describe("Filter by equipment category: chassis, climate, power, plumbing, other"),
        manufacturer: z
          .string()
          .optional()
          .describe("e.g. ford, mercedes, espar, victron"),
        model: z
          .string()
          .optional()
          .describe("e.g. transit, sprinter, airtronic_s2, multiplus_ii"),
        market: z
          .enum(["us", "eu", "global"])
          .default("us")
          .optional()
          .describe("Regional market filter: us, eu, or global (default us)"),
        model_year: z
          .number()
          .int()
          .optional()
          .describe("Filter by vehicle or appliance model year (e.g. 2024)"),
      },
    },
    async (args) => {
      const queryVector = await generateEmbedding(args.query, ai);

      const results = await hybridSearch(vectorIndex, db, queryVector, {
        topK: args.top_k ?? 8,
        ...(cdnBaseUrl ? { cdnBaseUrl } : {}),
        ...(args.source_filter ? { source: args.source_filter } : {}),
        ...(args.chassis ? { chassis: args.chassis } : {}),
        ...(args.subsystem ? { subsystem: args.subsystem } : {}),
        ...(args.category ? { category: args.category } : {}),
        ...(args.manufacturer ? { manufacturer: args.manufacturer } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.market ? { market: args.market } : {}),
        ...(args.model_year !== undefined ? { model_year: args.model_year } : {}),
      });

      const payload =
        results.length === 0
          ? {
              results: [],
              message: "No relevant documentation found for the given query.",
              query: args.query,
            }
          : {
              results: results.map(({ id, source, document_title, manufacturer, ...rest }) => ({
                chunk_id: id,
                source: source && source !== "unknown" ? source : (document_title ?? "unknown"),
                document_title,
                manufacturer: manufacturer && manufacturer !== "unknown" ? manufacturer : undefined,
                ...rest,
              })),
              count: results.length,
              query: args.query,
            };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );
  // -------------------------------------------------------------------------
  // Diagnostic Tool: inspect_manual_chunks
  // -------------------------------------------------------------------------
  if (db) {
    mcp.registerTool(
      "inspect_manual_chunks",
      {
        description:
          "Internal diagnostic tool to inspect ingested manual chunks from the D1 database using SQL text pattern matching.",
        inputSchema: {
          keyword: z
            .string()
            .min(1)
            .describe("Keyword or pattern to search in chunk_text (e.g., CCP2, Customer Connection Point)"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(8)
            .optional()
            .describe("Maximum number of matching chunks to return (default 5)"),
        },
      },
      async (args) => {
        const limit = args.limit ?? 5;
        const pattern = "%" + args.keyword + "%";
        const queryResult = await db
          .prepare(
            "SELECT id, page_number, section_title, substr(chunk_text, 1, 150) AS snippet FROM document_chunks WHERE chunk_text LIKE ? OR section_title LIKE ? LIMIT ?"
          )
          .bind(pattern, pattern, limit)
          .all<{ id: string; page_number: number; section_title: string | null; snippet: string }>();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  keyword: args.keyword,
                  count: queryResult.results.length,
                  results: queryResult.results,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}
