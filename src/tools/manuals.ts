import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch } from "../utils/db.js";

export interface Env {
  DB?: {
    prepare: (query: string) => {
      bind: (...args: unknown[]) => {
        all: () => Promise<{ results?: Record<string, unknown>[] }>;
      };
    };
  };
  VECTORIZE?: {
    query: (vector: number[], options?: Record<string, unknown>) => Promise<{ matches?: Array<{ id: string; score?: number }> }>;
  };
  VECTOR_INDEX?: {
    query: (vector: number[], options?: Record<string, unknown>) => Promise<{ matches?: Array<{ id: string; score?: number }> }>;
  };
  AI?: {
    run: (model: string, input: Record<string, unknown>) => Promise<{ data?: number[][]; result?: { data?: number[][] } }>;
  };
  ASSETS_BUCKET?: unknown;
  CDN_BASE_URL?: string;
  DEEPINFRA_TOKEN?: string;
  EMBEDDING_PROVIDER?: string;
  [key: string]: unknown;
}

export interface ManualChunkResult {
  id: string;
  document_id: string;
  title: string;
  manufacturer: string;
  page_number: number;
  subsystem?: string;
  chunk_text: string;
  score?: number;
  schematic_image_url?: string;
  schematic_caption?: string;
}

export const SubsystemEnum = z.enum([
  "12v_dc",
  "48v_dc",
  "120v_ac",
  "plumbing",
  "heating_cooling",
  "structural",
  "chassis_interface",
]);

export type Subsystem = z.infer<typeof SubsystemEnum>;

/**
 * Mapping dictionary for common semantic drift terms hallucinated by LLMs.
 */
export const SUBSYSTEM_ALIASES: Record<string, Subsystem> = {
  // heating_cooling aliases (climate, fans, HVAC, heaters, A/C)
  climate: "heating_cooling",
  hvac: "heating_cooling",
  ventilation: "heating_cooling",
  fan: "heating_cooling",
  air_conditioning: "heating_cooling",
  ac_cooling: "heating_cooling",
  heater: "heating_cooling",
  heating: "heating_cooling",
  cooling: "heating_cooling",
  // 12v_dc aliases
  electrical: "12v_dc",
  dc: "12v_dc",
  wiring: "12v_dc",
  battery: "12v_dc",
  // 120v_ac aliases
  ac: "120v_ac",
  inverter_ac: "120v_ac",
  shore_power: "120v_ac",
  // plumbing aliases
  water: "plumbing",
  greywater: "plumbing",
  freshwater: "plumbing",
  // structural aliases
  body: "structural",
  roof: "structural",
  mounting: "structural",
  // chassis_interface aliases
  interface: "chassis_interface",
  can_bus: "chassis_interface",
  signals: "chassis_interface",
  chassis: "chassis_interface",
};

export const SubsystemSchema = z
  .preprocess((val) => {
    if (typeof val === "string") {
      const normalized = val.trim().toLowerCase();
      if (normalized in SUBSYSTEM_ALIASES) {
        return SUBSYSTEM_ALIASES[normalized];
      }
      return normalized;
    }
    return val;
  }, SubsystemEnum.optional())
  .describe(
    "Filter by van subsystem. Allowed values: '12v_dc' (electrical, dc, battery, wiring), '48v_dc', '120v_ac' (ac, inverter, shore power), 'plumbing' (water, tanks), 'heating_cooling' (covers climate, ventilation, fans, A/C, and heaters), 'structural' (body, roof, mounting), 'chassis_interface' (CAN bus, signals). If unsure, omit this field."
  );

export interface SearchFilterOptions {
  chassis?: "ford_transit" | "mercedes_sprinter" | "ram_promaster" | "universal" | string;
  subsystem?: Subsystem | string;
  category?: "chassis" | "climate" | "power" | "plumbing" | "other" | string;
  manufacturer?: string;
  model?: string;
  market?: "us" | "eu" | "global" | string;
  model_year?: number;
  source_filter?: string;
  limit?: number;
  min_score?: number;
}

export interface RetrievalContract {
  strict_grounding_rule: string;
  missing_manual_rule: string;
  no_matches_guidance?: string;
}

export interface SearchVanManualsResponse {
  retrieval_metadata: {
    query: string;
    count: number;
    matches_found: boolean;
    filter_applied?: SearchFilterOptions;
    retrieval_contract: RetrievalContract;
    advice?: string;
  };
  results: ManualChunkResult[];
}

/**
 * Generates embeddings via Cloudflare Workers AI.
 */
async function generateWorkersAiEmbedding(text: string, ai: Ai): Promise<number[]> {
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

/**
 * Generates embeddings via DeepInfra REST endpoint with emergency truncation recovery.
 */
async function generateDeepInfraEmbedding(text: string, token: string): Promise<number[]> {
  const maxChars = 1000;
  let sanitized = text;
  if (sanitized.length > maxChars) {
    const slice = sanitized.slice(0, maxChars);
    const lastSpace = slice.lastIndexOf(" ");
    sanitized = lastSpace > maxChars * 0.8 ? slice.slice(0, lastSpace) : slice;
  }

  const response = await fetch("https://api.deepinfra.com/v1/inference/BAAI/bge-base-en-v1.5", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token.trim(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: [sanitized] }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("DeepInfra API error [HTTP " + response.status + "]: " + errorBody);
    if (
      response.status === 400 &&
      (errorBody.includes("input tokens") ||
        errorBody.includes("context length") ||
        errorBody.includes("input_tokens"))
    ) {
      console.warn("Retrying query with emergency truncation (600 chars)...");
      const emergencyResp = await fetch("https://api.deepinfra.com/v1/inference/BAAI/bge-base-en-v1.5", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token.trim(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: [sanitized.slice(0, 600)] }),
      });
      if (emergencyResp.ok) {
        const emergencyData = (await emergencyResp.json()) as { embeddings: number[][] };
        if (emergencyData && Array.isArray(emergencyData.embeddings) && Array.isArray(emergencyData.embeddings[0])) {
          return emergencyData.embeddings[0];
        }
      }
    }
    throw new Error(
      "DeepInfra embedding request failed with HTTP " + response.status + ": " + errorBody
    );
  }

  const data = (await response.json()) as { embeddings: number[][] };
  if (data && Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0]) && data.embeddings[0].length === 768) {
    return data.embeddings[0];
  }
  throw new Error("DeepInfra returned invalid embedding response structure: " + JSON.stringify(data));
}

export async function generateEmbedding(
  text: string,
  ai?: Ai,
  deepinfraToken?: string,
  embeddingProvider?: string
): Promise<number[]> {
  const provider =
    embeddingProvider?.trim().toLowerCase() ||
    (deepinfraToken ? "deepinfra" : (ai ? "cloudflare" : "deepinfra"));

  if (provider === "deepinfra") {
    if (deepinfraToken && deepinfraToken.trim() !== "") {
      try {
        return await generateDeepInfraEmbedding(text, deepinfraToken);
      } catch (err: unknown) {
        if (ai) {
          console.warn("DeepInfra embedding failed, falling back to Workers AI:", err instanceof Error ? err.message : String(err));
          return await generateWorkersAiEmbedding(text, ai);
        }
        throw err;
      }
    }
    if (ai) {
      console.warn("DEEPINFRA_TOKEN not set; falling back to Workers AI binding.");
      return await generateWorkersAiEmbedding(text, ai);
    }
    console.warn("DEEPINFRA_TOKEN not set and env.AI unavailable; returning zero vector for local dev/testing.");
    return new Array(768).fill(0) as number[];
  }

  // Cloudflare Workers AI
  if (ai) {
    return await generateWorkersAiEmbedding(text, ai);
  }
  console.warn(
    "Workers AI binding (env.AI) is unavailable; returning zero vector for local dev/testing."
  );
  return new Array(768).fill(0) as number[];
}

/**
 * Registers manual search tools on McpServer with directive grounding contracts.
 */
export function registerManualTools(
  mcp: McpServer,
  vectorIndex: VectorizeIndex,
  ai?: Ai,
  db?: D1Database,
  cdnBaseUrl?: string,
  deepinfraToken?: string,
  embeddingProvider?: string
): void {
  // -------------------------------------------------------------------------
  // Tool: search_van_manuals
  // -------------------------------------------------------------------------
  mcp.registerTool(
    "search_van_manuals",
    {
      description:
        `Searches indexed technical documentation, OEM body builder manuals (BEMM), and component guides.
IMPORTANT INSTRUCTIONS FOR LLM CONSUMERS:
- Adhere strictly to the returned 'retrieval_contract'.
- CRITICAL NEGATIVE CONSTRAINT: When a requested third-party component (e.g., MaxxFan, specific aftermarket appliance) is NOT found in the indexed manuals:
  1. State clearly that the component manual is not in the database.
  2. Provide ONLY vehicle-side OEM chassis constraints (e.g., roof bow clearance, sealant requirements).
  3. DO NOT attempt to provide "widely published", "typical", or general specifications for the missing component (especially torque, screw sizes, or cut-out tolerances).
  4. Explicitly state: "Consult the manufacturer's manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation."`,
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
          .describe("Number of most relevant document chunks to return (default 8, max 20)"),
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
        subsystem: SubsystemSchema,
        category: z
          .enum(["chassis", "climate", "power", "plumbing", "other"])
          .optional()
          .describe("Optional document category filter."),
        manufacturer: z
          .string()
          .optional()
          .describe("e.g. ford, mercedes, espar, victron"),
        model: z
          .string()
          .optional()
          .describe("Optional short model name in lowercase (e.g., 'transit', 'sprinter', 'promaster')."),
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
      const queryVector = await generateEmbedding(args.query, ai, deepinfraToken, embeddingProvider);

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
        queryText: args.query,
      });

      const appliedFilters = {
        ...(args.category ? { category: args.category } : {}),
        ...(args.manufacturer ? { manufacturer: args.manufacturer } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.market ? { market: args.market } : {}),
        ...(args.model_year !== undefined ? { model_year: args.model_year } : {}),
        ...(args.chassis ? { chassis: args.chassis } : {}),
        ...(args.subsystem ? { subsystem: args.subsystem } : {}),
        ...(args.source_filter ? { source: args.source_filter } : {}),
      };

      const retrievalContract = {
        strict_grounding_rule:
          "Only provide specifications, dimensions, or torque values if explicitly contained in the retrieved manual chunks below.",
        missing_manual_rule:
          "CRITICAL NEGATIVE CONSTRAINT: When a requested third-party component (e.g., MaxxFan, specific aftermarket appliance) is NOT found in the indexed manuals: 1) State clearly that the component manual is not in the database. 2) Provide ONLY vehicle-side OEM chassis constraints (e.g., roof bow clearance, sealant requirements). 3) DO NOT attempt to provide 'widely published', 'typical', or general specifications for the missing component (especially torque, screw sizes, or cut-out tolerances). 4) Explicitly state: 'Consult the manufacturer\'s manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation.'",
      };

      const payload = {
        retrieval_metadata: {
          query: args.query,
          count: results.length,
          matches_found: results.length > 0,
          filter_applied: appliedFilters,
          retrieval_contract: retrievalContract,
          ...(results.length === 0
            ? {
                advice:
                  "No matching documentation found in the current database for this query. Advise the user to consult the physical manufacturer manual and do not guess fastener or dimensional specs. When a third-party component is not found, provide ONLY vehicle-side OEM constraints and explicitly state: 'Consult the manufacturer\'s manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation.'",
              }
            : {}),
        },
        results:
          results.length === 0
            ? []
            : results.map(({ id, source, document_title, manufacturer, model, market, model_year, ...rest }) => ({
                chunk_id: id,
                source: source && source !== "unknown" ? source : (document_title ?? "unknown"),
                document_title,
                manufacturer: manufacturer && manufacturer !== "unknown" ? manufacturer : undefined,
                model: model ?? undefined,
                market: market ?? undefined,
                model_year: model_year ?? undefined,
                ...rest,
              })),
        count: results.length,
        query: args.query,
        matches_found: results.length > 0,
        applied_filters: appliedFilters,
        ...(results.length === 0
          ? {
              message:
                "No relevant documentation found for the given query.",
            }
          : {}),
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

/**
 * Searches indexed technical documentation across Vectorize and D1.
 */
export async function executeVectorSearch(
  query: string,
  env?: Env,
  filterOptions?: SearchFilterOptions
): Promise<ManualChunkResult[]> {
  if (!query || query.trim() === "") {
    return [];
  }

  const vectorize = env?.VECTOR_INDEX || env?.VECTORIZE;
  const ai = env?.AI;
  const db = env?.DB;

  if (vectorize && db) {
    try {
      let queryVector: number[] = [];
      if (ai) {
        const embeddingResponse = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [query] });
        queryVector = embeddingResponse?.data?.[0] || embeddingResponse?.result?.data?.[0] || [];
      } else if (env?.DEEPINFRA_TOKEN) {
        queryVector = await generateDeepInfraEmbedding(query, String(env.DEEPINFRA_TOKEN));
      }

      const topK = filterOptions?.limit || 3;
      const vectorMatches = await vectorize.query(queryVector, {
        topK,
        returnMetadata: "all",
      });

      if (!vectorMatches?.matches || vectorMatches.matches.length === 0) {
        return [];
      }

      const minScore = filterOptions?.min_score ?? 0.65;
      const validMatches = vectorMatches.matches.filter(
        (m: { score?: number }) => (m.score ?? 1) >= minScore
      );

      if (validMatches.length === 0) {
        return [];
      }

      const chunkIds = validMatches.map((m: { id: string }) => m.id);
      const placeholders = chunkIds.map(() => "?").join(",");
      let sql = `
        SELECT c.id, c.document_id, c.page_number, c.subsystem, c.chunk_text,
               d.title, d.manufacturer, s.r2_key, s.caption
        FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
        LEFT JOIN schematic_images s ON c.schematic_image_id = s.id
        WHERE c.id IN (${placeholders})
      `;

      const binds: (string | number)[] = [...chunkIds];
      if (filterOptions?.subsystem) {
        sql += ` AND c.subsystem = ?`;
        binds.push(filterOptions.subsystem);
      }

      const rows = await db.prepare(sql).bind(...binds).all();
      const cdnUrl = env?.CDN_BASE_URL || "https://assets.campervan-mcp.internal";

      return ((rows?.results as Record<string, unknown>[]) || []).map((row) => ({
        id: String(row.id),
        document_id: String(row.document_id),
        title: String(row.title),
        manufacturer: String(row.manufacturer),
        page_number: Number(row.page_number),
        subsystem: row.subsystem ? String(row.subsystem) : undefined,
        chunk_text: String(row.chunk_text),
        schematic_image_url: row.r2_key ? `${cdnUrl}/${row.r2_key}` : undefined,
        schematic_caption: row.caption ? String(row.caption) : undefined,
      }));
    } catch (err) {
      console.error("[search_van_manuals] Search error:", err);
      return [];
    }
  }

  return [];
}

/**
 * Direct function caller: searchVanManuals
 */
export async function searchVanManuals(
  query: string,
  env?: Env,
  filterOptions?: SearchFilterOptions
): Promise<SearchVanManualsResponse> {
  const searchResults = await executeVectorSearch(query, env, filterOptions);
  const matchesFound = searchResults.length > 0;

  const baseContract: RetrievalContract = {
    strict_grounding_rule:
      "Only provide specifications, dimensions, or torque values if explicitly contained in the retrieved manual chunks below.",
    missing_manual_rule:
      "CRITICAL NEGATIVE CONSTRAINT: When a requested third-party component (e.g., MaxxFan, specific aftermarket appliance) is NOT found in the indexed manuals: 1) State clearly that the component manual is not in the database. 2) Provide ONLY vehicle-side OEM chassis constraints (e.g., roof bow clearance, sealant requirements). 3) DO NOT attempt to provide 'widely published', 'typical', or general specifications for the missing component (especially torque, screw sizes, or cut-out tolerances). 4) Explicitly state: 'Consult the manufacturer\'s manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation.'",
  };

  if (!matchesFound) {
    baseContract.no_matches_guidance =
      "No matching documentation found in the current database for this query. Advise the user to consult the physical manufacturer manual and do not guess fastener or dimensional specs. When a third-party component is not found, provide ONLY vehicle-side OEM constraints and explicitly state: 'Consult the manufacturer\'s manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation.'";

    return {
      retrieval_metadata: {
        query,
        count: 0,
        matches_found: false,
        filter_applied: filterOptions,
        retrieval_contract: baseContract,
        advice:
          "No matching documentation found in the current database for this query. Advise the user to consult the physical manufacturer manual and do not guess fastener or dimensional specs. When a third-party component is not found, provide ONLY vehicle-side OEM constraints and explicitly state: 'Consult the manufacturer\'s manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation.'",
      },
      results: [],
    };
  }

  return {
    retrieval_metadata: {
      query,
      count: searchResults.length,
      matches_found: true,
      filter_applied: filterOptions,
      retrieval_contract: baseContract,
    },
    results: searchResults,
  };
}
