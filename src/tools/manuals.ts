import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchManuals } from "../utils/db.js";

/**
 * Simple embedding generation using Cloudflare AI text embeddings.
 * Falls back to a zero vector if AI binding is unavailable (e.g., local dev).
 *
 * In production, this should use the `@cf/baai/bge-small-en-v1.5` model
 * via the `AI` binding, which produces 384-dimensional vectors.
 */
async function generateEmbedding(text: string, ai?: Ai): Promise<number[]> {
  if (ai) {
    const response = await ai.run("@cf/baai/bge-small-en-v1.5", { text: [text] });
    const result = response as unknown as { data: number[][] };
    return result.data[0];
  }

  // Fallback: return zero vector for development/testing
  return new Array(384).fill(0) as number[];
}

export function registerManualTools(mcp: McpServer, vectorIndex: VectorizeIndex, ai?: Ai): void {
  // -------------------------------------------------------------------------
  // Tool: search_van_manuals
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "search_van_manuals",
    {
      description:
        "Searches the vector database of campervan documentation using semantic similarity. Retrieves relevant sections from PDF/HTML manuals including Ford Transit body builder guides, Velit heater error codes, Sprinter wiring diagrams, and Victron equipment manuals.",
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
          .default(5)
          .describe("Number of most relevant document chunks to return (default 5, max 20)"),
        source_filter: z
          .string()
          .optional()
          .describe(
            "Optional filter to restrict search to a specific manual source (e.g., 'ford_transit_body_builder', 'victron_multiplus', 'velit_heater')"
          ),
      },
    },
    async (args) => {
      const queryVector = await generateEmbedding(args.query, ai);

      const filter: VectorizeVectorMetadataFilter | undefined = args.source_filter
        ? { source: { $eq: args.source_filter } }
        : undefined;

      const results = await searchManuals(vectorIndex, queryVector, {
        topK: args.top_k,
        filter,
      });

      const payload =
        results.length === 0
          ? {
              results: [],
              message: "No relevant documentation found for the given query.",
              query: args.query,
            }
          : {
              results: results.map((r) => ({
                score: r.score,
                source: r.metadata.source,
                page: r.metadata.page,
                section: r.metadata.section,
                text: r.metadata.text,
              })),
              count: results.length,
              query: args.query,
            };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );
}
