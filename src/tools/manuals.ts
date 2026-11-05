import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, queryContainsBevIndicators, extractChunkFuelType } from "../utils/db.js";

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
  schematic_url?: string;
  schematic_caption?: string;
  schematic_markdown?: string;
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
  /** Short, imperative per-answer checklist; read this first. The longer rules below explain each item. */
  answer_checklist: string[];
  strict_grounding_rule: string;
  missing_manual_rule: string;
  powertrain_rule: string;
  diagram_text_integrity?: string;
  options_enumeration_rule: string;
  schematic_rule: string;
  /** How to separate documented facts from general guidance, and how to attribute them. */
  evidence_rule: string;
  /** How to present options/recommendations without promoting items whose documented purpose is another system. */
  recommendation_rule: string;
  /** How to describe completeness and carry through the manual's own cautions/warnings. */
  completeness_and_warnings_rule: string;
  no_matches_guidance?: string;
  /** Set when a non-BEV query only matched BEV-tagged chunks. */
  powertrain_notice?: string;
}

/** Notice attached when an ICE-default query could only retrieve BEV-tagged chunks. */
export const BEV_ONLY_FALLBACK_NOTICE =
  "NO ICE MATCH FOUND: Every retrieved chunk is tagged BEV / electric (E-Transit, etc.) and the query did not ask for an electric vehicle. State clearly that the indexed ICE (gas/diesel) content for this topic was not retrieved, and that the results below describe the BEV configuration only. Do NOT present BEV callout numbers, ratings, or diagrams as applying to an ICE vehicle.";

/**
 * Builds the vehicle- and component-agnostic retrieval contract returned with every search.
 * Rules here must stay GENERIC (they apply to any chassis, battery system, HVAC, plumbing, etc.);
 * never add vehicle-specific facts. See docs/engineering/retrieval-pipeline.md.
 */
export function buildBaseRetrievalContract(): RetrievalContract {
  return {
    answer_checklist: [
      "1. Open with the CAUTION / WARNING / NOTE text from the retrieved chunks that applies, quoted, with document and page.",
      "2. Give the manual's own method for the user's situation (if one is retrieved) BEFORE listing options or adding advice.",
      "3. When listing items, show each item's documented purpose/use. A list of items documented for specific functions is NOT an approval list: never call them approved, authorized, required or 'the only' ones unless the retrieved text says so.",
      "4. Check numbered lists and sequences for missing numbers; name the gaps and tell the user to verify them in the source document. Do not call a list complete.",
      "5. Cite section and page numbers only as they appear in the retrieved chunks; never name a section, page, part number, rating or standard that is not in a retrieved chunk.",
      "6. Put your own advice LAST under 'General guidance (not from the indexed manuals)': methods and precautions only, no numeric specs, and never pick, rank or endorse items from the documented list (e.g. 'these points are practical'). If the user needs somewhere to connect, point to the manual's approved method, or say none is documented.",
    ],
    strict_grounding_rule:
      "Only provide specifications, dimensions, or torque values if explicitly contained in the retrieved manual chunks below.",
    missing_manual_rule:
      "CRITICAL NEGATIVE CONSTRAINT: When a requested third-party component (e.g., MaxxFan, specific aftermarket appliance) is NOT found in the indexed manuals: 1) State clearly that the component manual is not in the database. 2) Provide ONLY vehicle-side OEM chassis constraints (e.g., roof bow clearance, sealant requirements). 3) DO NOT attempt to provide 'widely published', 'typical', or general specifications for the missing component (especially torque, screw sizes, or cut-out tolerances). 4) Explicitly state: 'Consult the manufacturer\'s manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation.'",
    powertrain_rule:
      "STRICT ICE DEFAULT: Always assume internal combustion engine (ICE / gas / diesel) by default. Deliver exhaustive ICE specifications first. Never gate the response asking if the user has an EV. When an electric/BEV configuration IS explicitly requested, prioritize the electric chassis specifications immediately.",
    diagram_text_integrity:
      "DIAGRAM-TEXT CONSISTENCY: Every callout number, pinout ID, or stud rating in your text MUST match the exact diagram image embedded. Never cite callout numbers from an electric/BEV diagram when describing an ICE vehicle (e.g., do not cite BEV points 1–45 when answering for ICE points 49–88). If the only retrieved diagram has a 'BEV' header and the query is ICE, DO NOT embed that image; explain that the ICE diagram is missing from the indexed results.",
    options_enumeration_rule:
      "BROAD QUERY ENUMERATION: When an inquiry is open-ended (e.g., available ground locations, power taps, or mounting zones), do not group items into vague ranges or pick a single favorite. Present a structured, complete inventory of all documented options from the retrieved chunks using compact Markdown tables with their key differentiating parameters (Location, Stud/Thread Spec, Max Rating, Constraints).",
    schematic_rule:
      "MANDATORY DIAGRAMS: Whenever a chunk contains a 'schematic_url', you MUST embed it inline in your markdown response using: ![<Diagram Title>](<schematic_url>).",
    evidence_rule:
      "EVIDENCE LABELING: Keep documented facts and your own reasoning visibly separate. (1) DOCUMENTED: anything attributed to a manual, manufacturer, OEM, 'the manual' or a section/page/figure number MUST appear in the retrieved chunks; cite the document title and page. Never invent or guess section numbers, page numbers, part numbers, ratings, thresholds, or 'the manufacturer requires/prohibits' statements. (2) GENERAL GUIDANCE: you may add practical engineering advice and explanations from general knowledge, but label it 'General guidance (not from the indexed manuals)', keep it free of invented numeric specs (torque, ratings, gauge, clearances, current limits), and never let it contradict or override a retrieved chunk. (3) EXTERNAL STANDARDS (ABYC, NEC, ISO, etc.): do not state their numeric requirements unless the value comes from a retrieved chunk or from calculate_dc_wire_and_fuse; for wire gauge, voltage drop, and fuse sizing call that tool instead of quoting values from memory. (4) If a chunk does not support a claim you want to make, either drop it or label it as general guidance. (5) When reporting what was NOT retrieved, say only that it was not retrieved; do not state where it is, which page it is on, or what it contains unless a retrieved chunk says so. Avoid absolute claims ('only', 'always', 'never', 'all', 'the full list') about a manual unless the retrieved text itself uses them. (6) Inclusion in a table or list is not approval: a list of items documented for specific functions (ground points, taps, connectors, mounting holes, fittings) does not mean they are approved, authorized or recommended for the user's add-on use; say so only when a retrieved sentence states it, and quote that sentence.",
    recommendation_rule:
      "RECOMMENDATIONS MUST BE TRACEABLE: When listing documented options (mounting points, taps, grounds, locations, connectors), carry through the manual's own descriptive columns (use/purpose, type, rating, constraint) so the reader can see what each option is actually for. Rank or recommend an option as 'preferred/best' only when a documented attribute supports it, and say which one. Never recommend an item whose documented purpose belongs to a different function or system than the user's intended use (examples across domains: a fuel-system, brake, airbag or high-voltage circuit ground used for an add-on load; a potable-water fitting used for waste; a gas-supply or exhaust path repurposed for ventilation; a safety-critical sensor circuit tapped for accessories) unless the retrieved text explicitly permits that use; instead flag it as 'documented for <purpose>, not documented for auxiliary use'. Where the manual names an approved method for add-on loads, present that method first. Your own advice may describe methods and precautions, but it must not pick, rank or endorse specific items from a documented list (point numbers, locations, circuits, connectors): choosing among documented items requires a documented attribute that you cite; otherwise direct the user to the approved method. If no approved method is retrieved, say the retrieved manual documents no add-on location and describe how to create a dedicated one -- never substitute an item from the documented list.",
    completeness_and_warnings_rule:
      "COMPLETENESS AND WARNINGS: Describe a list as 'complete' or 'all' only if you can see every item the source implies; otherwise say 'as retrieved' and call out gaps (for example missing numbers in a sequence) and tell the user to verify them in the source document. Reproduce every CAUTION / WARNING / NOTE in the retrieved chunks that bears on the user's question (for example 'use only the approved locations', required torque, isolation, venting or corrosion-protection requirements), in the manual's own terms, before giving your own advice.",
  };
}


export function isBevOnlyFallback(
  query: string,
  results: ReadonlyArray<object>
): boolean {
  return (
    results.length > 0 &&
    !queryContainsBevIndicators(query) &&
    results.every((r) => (r as { fuel_type?: string }).fuel_type === "bev")
  );
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
- STRICT ICE DEFAULT: Always assume internal combustion engine (ICE / gas / diesel) by default. Deliver exhaustive ICE specifications first. Never gate the response asking if the user has an EV.
- DIAGRAM-TEXT CONSISTENCY: Every callout number, pinout ID, or stud rating in your text MUST match the exact diagram image embedded. Never cite callout numbers from an electric/BEV diagram when describing an ICE vehicle (e.g., do not cite BEV points 1–45 when answering for ICE points 49–88).
- BROAD QUERY ENUMERATION: When an inquiry is open-ended (e.g., connection points, mounting zones), output a structured, complete inventory of all documented options using compact tables or categorized lists with key parameters.
- MANDATORY DIAGRAMS: Whenever a chunk contains a 'schematic_url', embed it inline in markdown: ![<Diagram Title>](<schematic_url>).
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

      const retrievalContract: RetrievalContract = {
        ...buildBaseRetrievalContract(),
        ...(isBevOnlyFallback(args.query, results) ? { powertrain_notice: BEV_ONLY_FALLBACK_NOTICE } : {}),
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
               d.title, d.manufacturer, d.metadata_json, s.r2_key, s.caption
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
      const isBevQuery = queryContainsBevIndicators(query);

      const items = ((rows?.results as Record<string, unknown>[]) || []).map((row) => {
        const schematicUrl = row.r2_key ? `${cdnUrl}/${row.r2_key}` : undefined;
        const captionOrTitle = row.caption ? String(row.caption) : String(row.title || "OEM Diagram");
        const fuelType = extractChunkFuelType({
          metadata_json: row.metadata_json ? String(row.metadata_json) : null,
          document_title: row.title ? String(row.title) : null,
          chunk_text: row.chunk_text ? String(row.chunk_text) : null,
        });

        return {
          id: String(row.id),
          document_id: String(row.document_id),
          title: String(row.title),
          manufacturer: String(row.manufacturer),
          page_number: Number(row.page_number),
          subsystem: row.subsystem ? String(row.subsystem) : undefined,
          chunk_text: String(row.chunk_text),
          schematic_image_url: schematicUrl,
          schematic_url: schematicUrl,
          schematic_caption: row.caption ? String(row.caption) : undefined,
          schematic_markdown: schematicUrl ? `![${captionOrTitle}](${schematicUrl})` : undefined,
          fuel_type: fuelType,
        };
      });

      // Apply fuel-aware prioritization: ICE-first unless explicit BEV query
      items.sort((a, b) => {
        if (!isBevQuery) {
          const aIsIce = a.fuel_type !== "bev" ? 1 : 0;
          const bIsIce = b.fuel_type !== "bev" ? 1 : 0;
          if (aIsIce !== bIsIce) return bIsIce - aIsIce;
        } else {
          const aIsBev = a.fuel_type === "bev" ? 1 : 0;
          const bIsBev = b.fuel_type === "bev" ? 1 : 0;
          if (aIsBev !== bIsBev) return bIsBev - aIsBev;
        }
        return 0;
      });

      return items;
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

  const baseContract: RetrievalContract = buildBaseRetrievalContract();

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
      retrieval_contract: isBevOnlyFallback(query, searchResults)
        ? { ...baseContract, powertrain_notice: BEV_ONLY_FALLBACK_NOTICE }
        : baseContract,
    },
    results: searchResults,
  };
}
