/**
 * Campervan Manuals Retrieval Engine with Dynamic Grounding Contracts
 * Integrates Cloudflare Workers AI + Vectorize + D1 while enforcing anti-hallucination contracts
 * for consuming LLMs.
 */

export interface Env {
  DB?: any;
  VECTORIZE?: any;
  AI?: any;
  ASSETS_BUCKET?: any;
  CDN_BASE_URL?: string;
  [key: string]: any;
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

export interface SearchFilterOptions {
  chassis?: "ford_transit" | "mercedes_sprinter" | "ram_promaster" | "universal" | string;
  subsystem?: "12v_dc" | "48v_dc" | "120v_ac" | "plumbing" | "heating_cooling" | "structural" | "chassis_interface" | string;
  manufacturer?: string;
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
 * Searches indexed technical documentation, OEM body builder manuals (BEMM),
 * and component guides across Vectorize and D1.
 * Dynamically enforces grounding contracts to prevent torque/part fabrication.
 */
export async function executeVectorSearch(
  query: string,
  env?: Env,
  filterOptions?: SearchFilterOptions
): Promise<ManualChunkResult[]> {
  if (!query || query.trim() === "") {
    return [];
  }

  // If live Cloudflare Worker bindings exist, perform full kNN vector + D1 search
  if (env?.AI && env?.VECTORIZE && env?.DB) {
    try {
      // 1. Generate Query Vector Embedding via Workers AI
      const embeddingResponse = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [query]
      });
      const queryVector = embeddingResponse?.data?.[0] || embeddingResponse?.result?.data?.[0];

      if (!queryVector) {
        return [];
      }

      // 2. Query Vectorize
      const topK = filterOptions?.limit || 3;
      const vectorMatches = await env.VECTORIZE.query(queryVector, {
        topK,
        returnMetadata: "all"
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

      // 3. Hydrate text chunks and metadata from Cloudflare D1
      const placeholders = chunkIds.map(() => "?").join(",");
      let sql = `
        SELECT c.id, c.document_id, c.page_number, c.subsystem, c.chunk_text,
               d.title, d.manufacturer, s.r2_key, s.caption
        FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
        LEFT JOIN schematic_images s ON c.schematic_image_id = s.id
        WHERE c.id IN (${placeholders})
      `;

      const binds: any[] = [...chunkIds];

      if (filterOptions?.subsystem) {
        sql += ` AND c.subsystem = ?`;
        binds.push(filterOptions.subsystem);
      }

      const rows = await env.DB.prepare(sql).bind(...binds).all();
      const cdnUrl = env.CDN_BASE_URL || "https://assets.campervan-mcp.internal";

      const hydrated: ManualChunkResult[] = (rows?.results || []).map((row: any) => ({
        id: row.id,
        document_id: row.document_id,
        title: row.title,
        manufacturer: row.manufacturer,
        page_number: row.page_number,
        subsystem: row.subsystem,
        chunk_text: row.chunk_text,
        schematic_image_url: row.r2_key ? `${cdnUrl}/${row.r2_key}` : undefined,
        schematic_caption: row.caption || undefined
      }));

      return hydrated;
    } catch (err) {
      console.error("[search_van_manuals] Live vector search encountered error:", err);
      // Fall through to empty or fallback
      return [];
    }
  }

  // When running in an environment without live Vectorize/D1 bindings (e.g. testing or client demo),
  // return empty array unless caller provided custom search executor or mock.
  return [];
}

/**
 * MCP Tool: search_van_manuals
 * Wraps search results with strict grounding invariants and anti-hallucination contracts.
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
      "If the specific manual, model, or component requested by the user is not present in the returned chunks, explicitly state: 'The specific manual for [component/system] is not in the indexed database, so an authoritative specification cannot be provided.' Never guess torque values or document part numbers."
  };

  if (!matchesFound) {
    baseContract.no_matches_guidance =
      "No matching documentation found in the current database for this query. Advise the user to consult the physical manufacturer manual and do not guess fastener or dimensional specs.";

    return {
      retrieval_metadata: {
        query,
        count: 0,
        matches_found: false,
        filter_applied: filterOptions,
        retrieval_contract: baseContract,
        advice:
          "No matching documentation found in the current database for this query. Advise the user to consult the physical manufacturer manual and do not guess fastener or dimensional specs."
      },
      results: []
    };
  }

  return {
    retrieval_metadata: {
      query,
      count: searchResults.length,
      matches_found: true,
      filter_applied: filterOptions,
      retrieval_contract: baseContract
    },
    results: searchResults
  };
}
