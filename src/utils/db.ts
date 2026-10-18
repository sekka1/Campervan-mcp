/**
 * Helper wrappers for Cloudflare D1 (SQL) and Vectorize (vector search) bindings.
 */

// ---------------------------------------------------------------------------
// D1 Helpers
// ---------------------------------------------------------------------------

export interface ComponentSpec {
  id: number;
  name: string;
  category: string;
  manufacturer: string | null;
  model_number: string | null;
  max_continuous_amps: number | null;
  idle_power_watts: number | null;
  weight_lbs: number | null;
  terminal_stud_size: string | null;
  dimensions_inches: string | null;
  notes: string | null;
}

/**
 * Query component specs from D1 by category and/or name filter.
 */
export async function queryComponentSpecs(
  db: D1Database,
  options: {
    category?: string;
    nameFilter?: string;
    manufacturer?: string;
    limit?: number;
  }
): Promise<ComponentSpec[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.category) {
    conditions.push("LOWER(category) = LOWER(?)");
    params.push(options.category);
  }

  if (options.nameFilter) {
    conditions.push("LOWER(name) LIKE LOWER(?)");
    params.push(`%${options.nameFilter}%`);
  }

  if (options.manufacturer) {
    conditions.push("LOWER(manufacturer) LIKE LOWER(?)");
    params.push(`%${options.manufacturer}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = `LIMIT ${options.limit ?? 20}`;

  const query = `
    SELECT id, name, category, manufacturer, model_number,
           max_continuous_amps, idle_power_watts, weight_lbs,
           terminal_stud_size, dimensions_inches, notes
    FROM component_specs
    ${whereClause}
    ORDER BY name ASC
    ${limitClause}
  `;

  const result = await db.prepare(query).bind(...params).all<ComponentSpec>();
  return result.results;
}

/**
 * Get a single component spec by exact model number.
 */
export async function getComponentByModel(
  db: D1Database,
  modelNumber: string
): Promise<ComponentSpec | null> {
  const result = await db
    .prepare(
      "SELECT id, name, category, manufacturer, model_number, max_continuous_amps, idle_power_watts, weight_lbs, terminal_stud_size, dimensions_inches, notes FROM component_specs WHERE LOWER(model_number) = LOWER(?)"
    )
    .bind(modelNumber)
    .first<ComponentSpec>();
  return result ?? null;
}

// ---------------------------------------------------------------------------
// Vectorize Helpers
// ---------------------------------------------------------------------------

export interface ManualChunk {
  id: string;
  score: number;
  metadata: {
    source: string;
    page?: number | undefined;
    section?: string | undefined;
    text: string;
  };
}

/**
 * Search van manuals using Vectorize vector similarity search.
 *
 * NOTE: This function requires a text embedding to be pre-computed and passed in.
 * The caller is responsible for generating the embedding vector.
 */
export async function searchManuals(
  vectorIndex: VectorizeIndex,
  queryVector: number[],
  options: {
    topK?: number;
    filter?: VectorizeVectorMetadataFilter;
  } = {}
): Promise<ManualChunk[]> {
  const queryOptions: VectorizeQueryOptions = {
    topK: options.topK ?? 5,
    returnMetadata: "all",
  };
  if (options.filter !== undefined) {
    queryOptions.filter = options.filter;
  }

  const results = await vectorIndex.query(queryVector, queryOptions);

  return results.matches.map((match) => ({
    id: match.id,
    score: match.score,
    metadata: {
      source: String(match.metadata?.["source"] ?? "unknown"),
      page: match.metadata?.["page"] !== undefined ? Number(match.metadata["page"]) : undefined,
      section: match.metadata?.["section"] !== undefined ? String(match.metadata["section"]) : undefined,
      text: String(match.metadata?.["text"] ?? ""),
    },
  }));
}

/**
 * Insert a document chunk into Vectorize index.
 */
export async function upsertManualChunk(
  vectorIndex: VectorizeIndex,
  id: string,
  vector: number[],
  metadata: {
    source: string;
    page?: number;
    section?: string;
    text: string;
  }
): Promise<void> {
  const vectorMetadata: VectorizeVectorMetadata = {
    source: metadata.source,
    text: metadata.text,
    ...(metadata.page !== undefined ? { page: metadata.page } : {}),
    ...(metadata.section !== undefined ? { section: metadata.section } : {}),
  };
  await vectorIndex.upsert([
    {
      id,
      values: vector,
      metadata: vectorMetadata,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Hybrid Search (Vectorize kNN + D1 hydration)
// ---------------------------------------------------------------------------

export interface HydratedChunk {
  id: string;
  document_id: string;
  document_title: string;
  category: string;
  manufacturer: string;
  applicable_chassis: string;
  page_number: number;
  section_title: string | null;
  subsystem: string;
  chunk_text: string;
  schematic_r2_key: string | null;
  schematic_caption: string | null;
}

/**
 * Fetch full chunk text and provenance from D1 for the given chunk IDs
 * (the IDs returned by the Vectorize kNN query).
 */
export async function hydrateChunks(db: D1Database, ids: string[]): Promise<Map<string, HydratedChunk>> {
  const map = new Map<string, HydratedChunk>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT c.id, c.document_id, d.title AS document_title, d.category, d.manufacturer,
              d.applicable_chassis, c.page_number, c.section_title, c.subsystem, c.chunk_text,
              s.r2_key AS schematic_r2_key, s.caption AS schematic_caption
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN schematic_images s ON s.id = c.schematic_image_id
       WHERE c.id IN (${placeholders})`
    )
    .bind(...ids)
    .all<HydratedChunk>();
  for (const row of results ?? []) map.set(row.id, row);
  return map;
}

export interface HybridSearchResult {
  id: string;
  score: number;
  source: string;
  page?: number | undefined;
  section?: string | undefined;
  text: string;
  document_title?: string;
  category?: string;
  manufacturer?: string;
  applicable_chassis?: string;
  subsystem?: string;
  schematic_r2_key?: string;
  schematic_caption?: string;
}

/**
 * Hybrid search: kNN lookup in Vectorize, then hydrate the matching IDs from D1.
 * Chunks not yet present in D1 (legacy vectors) fall back to Vectorize metadata text.
 * `chassis` and `subsystem` filters require matching Vectorize metadata indexes.
 */
export async function hybridSearch(
  vectorIndex: VectorizeIndex,
  db: D1Database | undefined,
  queryVector: number[],
  options: { topK?: number; source?: string; chassis?: string; subsystem?: string } = {}
): Promise<HybridSearchResult[]> {
  const filter: VectorizeVectorMetadataFilter = {};
  if (options.source) filter["source"] = { $eq: options.source };
  if (options.chassis) filter["chassis"] = { $in: [options.chassis, "universal"] };
  if (options.subsystem) filter["subsystem"] = { $eq: options.subsystem };

  const matches = await searchManuals(vectorIndex, queryVector, {
    topK: options.topK ?? 5,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  });
  const hydrated = db ? await hydrateChunks(db, matches.map((m) => m.id)) : new Map<string, HydratedChunk>();

  return matches.map((m): HybridSearchResult => {
    const h = hydrated.get(m.id);
    if (!h) {
      return { id: m.id, score: m.score, source: m.metadata.source, page: m.metadata.page, section: m.metadata.section, text: m.metadata.text };
    }
    return {
      id: m.id,
      score: m.score,
      source: m.metadata.source,
      page: h.page_number,
      section: h.section_title ?? undefined,
      text: h.chunk_text,
      document_title: h.document_title,
      category: h.category,
      manufacturer: h.manufacturer,
      applicable_chassis: h.applicable_chassis,
      subsystem: h.subsystem,
      ...(h.schematic_r2_key ? { schematic_r2_key: h.schematic_r2_key } : {}),
      ...(h.schematic_caption ? { schematic_caption: h.schematic_caption } : {}),
    };
  });
}
