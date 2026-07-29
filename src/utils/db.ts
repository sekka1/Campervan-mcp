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
