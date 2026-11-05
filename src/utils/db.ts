/**
 * Helper wrappers for Cloudflare D1 (SQL) and Vectorize (vector search) bindings.
 */

import { assessAmbiguity, type Clarification } from "./disambiguation.js";

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
  try {
    const queryOptions: VectorizeQueryOptions = {
      topK: options.topK ?? 8,
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
  } catch (err: unknown) {
    // Fail fast (AGENTS.md): never mask a Vectorize outage with fabricated results or a default vehicle.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Vectorize query failed: ${msg}`);
    throw new Error(`Vectorize search failed: ${msg}`);
  }
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
  model?: string | null;
  market?: string | null;
  metadata_json?: string | null;
}

export interface HydrateFilterOptions {
  category?: string;
  manufacturer?: string;
  model?: string;
  market?: "us" | "eu" | "global";
  model_year?: number;
}

/**
 * Fetch full chunk text and provenance from D1 for the given chunk IDs
 * (the IDs returned by the Vectorize kNN query).
 */
export const CONTINUATION_CUE_REGEX =
  /(?:refer to the following|diagrams that follow|table that follows|following figures|refer to|following|table|figure|see figure|see table|see below|details below|ground points|grounding)/i;

export const ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "arent", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "cant", "cannot", "could", "couldnt", "did", "didnt", "do", "does",
  "doesnt", "doing", "dont", "down", "during", "each", "few", "for", "from", "further", "had",
  "hadnt", "has", "hasnt", "have", "havent", "having", "he", "hed", "hell", "hes", "her",
  "here", "heres", "hers", "herself", "him", "himself", "his", "how", "hows", "i", "id", "ill",
  "im", "ive", "if", "in", "into", "is", "isnt", "it", "its", "itself", "lets", "me", "more",
  "most", "mustnt", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only",
  "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "regarding", "same",
  "shant", "she", "shed", "shell", "shes", "should", "shouldnt", "so", "some", "such", "than",
  "that", "thats", "the", "their", "theirs", "them", "themselves", "then", "there", "theres",
  "these", "they", "theyd", "theyll", "theyre", "theyve", "this", "those", "through", "to",
  "too", "under", "until", "up", "very", "was", "wasnt", "we", "wed", "well", "were", "werent",
  "what", "whats", "when", "whens", "where", "wheres", "which", "while", "who", "whos", "whom",
  "why", "whys", "with", "wont", "would", "wouldnt", "you", "youd", "youll", "youre", "youve",
  "your", "yours", "yourself", "yourselves",
]);

/**
 * Strips common English stop words and extracts distinct technical keywords (length >= 3).
 */
export function tokenizeQuery(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim());
  const tokens = words.filter(
    (w) => w.length >= 3 && !ENGLISH_STOP_WORDS.has(w)
  );

  return Array.from(new Set(tokens));
}

/**
 * Indicators that the user specifically requested an electric/BEV vehicle configuration.
 */
export const BEV_INDICATOR_TOKENS: ReadonlyArray<string> = [
  "bev",
  "e-transit",
  "etransit",
  "electric",
  "esprinter",
  "ev",
  "battery electric",
];

/**
 * Checks if the user query contains explicit BEV/electric indicator tokens.
 */
export function queryContainsBevIndicators(query?: string): boolean {
  if (!query) return false;
  const lower = query.toLowerCase();
  return BEV_INDICATOR_TOKENS.some((token) => {
    // If token has non-letters (like hyphen or space), check direct substring
    if (token.includes("-") || token.includes(" ")) {
      return lower.includes(token);
    }
    // Word boundary check for short tokens like "bev" or "ev"
    const regex = new RegExp(`\\b${token}\\b`, "i");
    return regex.test(lower);
  });
}

export const BEV_CONTENT_REGEX =
  /\b(bev|e-transit|etransit|esprinter|promaster[\s-]ev|traction battery|hv battery|megabrace|high[\s-]voltage\s+(?:battery|traction|system|interlock|disconnect|cable|inverter)|e185976b)\b/i;

export const COMBUSTION_CONTENT_REGEX =
  /\b(ice|gas|gasoline|diesel|alternator|om654|ecoboost)\b/i;

/**
 * Repeating page header/footer text (e.g. "Abc = BEV Only  Abc = ICE Only" legends and
 * "TRANSIT & E-TRANSIT" banners) that must not count as powertrain evidence.
 */
export function stripPageBoilerplate(text: string): string {
  return text
    .replace(/\bAbc\s*=\s*[A-Za-z]+\s+Only\b/gi, " ")
    .replace(/\b(\w+)\s*&\s*E-?\1(?![A-Za-z])/gi, " ");
}

/**
 * Extracts fuel / powertrain classification from chunk metadata or text.
 * Returns 'bev' if electric, 'ice' if internal combustion, or undefined if neutral/universal.
 */
export function extractChunkFuelType(chunk: {
  metadata_json?: string | null;
  document_title?: string | null;
  chunk_text?: string | null;
  source?: string | null;
}): "bev" | "ice" | undefined {
  if (chunk.metadata_json) {
    try {
      const meta = typeof chunk.metadata_json === "string" ? JSON.parse(chunk.metadata_json) : chunk.metadata_json;
      if (meta?.fuel) {
        const fuel = String(meta.fuel).toLowerCase().trim();
        if (fuel === "bev" || fuel === "electric") return "bev";
        if (fuel === "ice" || fuel === "gas" || fuel === "gasoline" || fuel === "diesel") return "ice";
        // Explicitly shared / mixed content: powertrain-neutral, do not infer from text.
        if (fuel === "all") return undefined;
      }
      if (meta?.powertrain) {
        const pt = String(meta.powertrain).toLowerCase().trim();
        if (pt === "bev" || pt === "electric") return "bev";
        if (pt === "ice" || pt === "gas" || pt === "gasoline" || pt === "diesel") return "ice";
      }
    } catch {}
  }

  // Check document title or source name
  const title = stripPageBoilerplate(`${chunk.document_title || ""} ${chunk.source || ""}`).toLowerCase();
  if (
    title.includes("e-transit") ||
    title.includes("etransit") ||
    title.includes("esprinter") ||
    title.includes("all-electric") ||
    title.includes("battery electric")
  ) {
    return "bev";
  }

  // Check chunk text for explicit propulsion markers if present
  if (chunk.chunk_text) {
    const cleaned = stripPageBoilerplate(chunk.chunk_text);
    const hasBev = BEV_CONTENT_REGEX.test(cleaned);
    const hasIce = COMBUSTION_CONTENT_REGEX.test(cleaned);
    if (hasBev && hasIce) return undefined; // mixed content is powertrain-neutral
    if (hasBev) return "bev";
    if (hasIce) return "ice";
  }

  return undefined;
}

/**
 * Checks if two chunks share compatible powertrains.
 * Prevents stitching BEV continuation text or inheriting BEV schematics into an ICE parent chunk (and vice versa).
 */
export function arePowertrainsCompatible(
  parent: { metadata_json?: string | null; document_title?: string | null; chunk_text?: string | null; source?: string | null },
  sibling: { metadata_json?: string | null; document_title?: string | null; chunk_text?: string | null; source?: string | null }
): boolean {
  const parentFuel = extractChunkFuelType(parent);
  const sibFuel = extractChunkFuelType(sibling);

  if (parentFuel === "ice" && sibFuel === "bev") return false;
  if (parentFuel === "bev" && sibFuel === "ice") return false;

  return true;
}

/**
 * Reciprocal Rank Fusion (RRF) for fusing vector similarity ranks and keyword match ranks.
 */
export function reciprocalRankFusion(
  vectorRankedIds: string[],
  keywordRankedIds: string[],
  k = 60
): string[] {
  const scores = new Map<string, number>();

  vectorRankedIds.forEach((id, rank) => {
    const score = 1 / (k + rank + 1);
    scores.set(id, (scores.get(id) ?? 0) + score);
  });

  keywordRankedIds.forEach((id, rank) => {
    const score = 1 / (k + rank + 1);
    scores.set(id, (scores.get(id) ?? 0) + score);
  });

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

/** SQL conditions (and params) restricting keyword statistics/search to the caller's filters. Aliases: c = chunks, d = documents. */
function buildKeywordScopeConditions(filters: HydrateFilterOptions): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.category) {
    conditions.push(`LOWER(COALESCE(c.category, d.category, '')) = ?`);
    params.push(filters.category.toLowerCase().trim());
  }

  if (filters.manufacturer) {
    const m = filters.manufacturer.toLowerCase().trim();
    conditions.push(
      `(LOWER(COALESCE(c.manufacturer, d.manufacturer, '')) = ? OR ? LIKE '%' || LOWER(COALESCE(c.manufacturer, d.manufacturer, '')) || '%' OR LOWER(COALESCE(c.manufacturer, d.manufacturer, '')) LIKE '%' || ? || '%')`
    );
    params.push(m, m, m);
  }
  if (filters.model) {
    const m = filters.model.toLowerCase().trim();
    conditions.push(
      `(LOWER(COALESCE(c.model, d.model, '')) = ? OR ? LIKE '%' || LOWER(COALESCE(c.model, d.model, '')) || '%' OR LOWER(COALESCE(c.model, d.model, '')) LIKE '%' || ? || '%')`
    );
    params.push(m, m, m);
  }

  if (filters.market) {
    conditions.push(`LOWER(COALESCE(c.market, d.market, 'global')) IN (?, 'global')`);
    params.push(filters.market.toLowerCase().trim());
  }

  if (filters.model_year !== undefined) {
    const metaExpr = `COALESCE(c.metadata_json, d.metadata_json)`;
    conditions.push(
      `(json_extract(${metaExpr}, '$.year_start') IS NULL OR (CAST(json_extract(${metaExpr}, '$.year_start') AS INTEGER) <= ? AND CAST(COALESCE(json_extract(${metaExpr}, '$.year_end'), json_extract(${metaExpr}, '$.year_start')) AS INTEGER) >= ?))`
    );
    params.push(filters.model_year, filters.model_year);
  }

  return { conditions, params };
}

/** A token found in more than this share of a document's chunks carries no ranking signal. */
export const BOILERPLATE_TOKEN_DOC_RATIO = 0.6;
/** Ignore documents smaller than this when judging how common a token is (tiny docs skew ratios). */
const BOILERPLATE_MIN_DOC_CHUNKS = 20;

/**
 * Finds, per document, the query tokens that appear in most of that document's chunks (page banners, the
 * make/model/year printed on every page, section footers). Such a token matches everything in that document
 * equally, so in keyword ranking it only pulls in unrelated chunks and crowds out the real answer; semantic search
 * and the metadata filters already handle "which vehicle".
 *
 * Returns token -> ids of documents in which it is boilerplate. Suppression is PER DOCUMENT: a word that is
 * boilerplate in one manual still matches normally in every other manual. Within a document, if every query token
 * would be suppressed, none are (keyword search would otherwise lose all signal there). Measured in the caller's
 * filter scope with no hardcoded vocabulary; returns an empty map if statistics are unavailable.
 */
export async function findBoilerplateTokensByDocument(
  db: D1Database,
  tokens: string[],
  filters: HydrateFilterOptions = {}
): Promise<Map<string, Set<string>>> {
  const suppressed = new Map<string, Set<string>>();
  if (tokens.length < 2) return suppressed;
  try {
    const scope = buildKeywordScopeConditions(filters);
    const selects = tokens.map(
      (_, i) => `SUM(CASE WHEN LOWER(c.chunk_text) LIKE ? THEN 1 ELSE 0 END) AS t${i}`
    );
    const query = `SELECT c.document_id AS doc, COUNT(*) AS n, ${selects.join(", ")}
      FROM document_chunks c JOIN documents d ON d.id = c.document_id
      ${scope.conditions.length > 0 ? `WHERE ${scope.conditions.join(" AND ")}` : ""}
      GROUP BY c.document_id`;
    const { results } = await db
      .prepare(query)
      .bind(...tokens.map((t) => `%${t}%`), ...scope.params)
      .all<Record<string, number | string>>();

    for (const row of results ?? []) {
      const n = Number(row["n"]);
      if (!(n >= BOILERPLATE_MIN_DOC_CHUNKS)) continue; // tiny documents skew ratios
      const flagged = tokens.filter((_, i) => Number(row[`t${i}`] ?? 0) / n > BOILERPLATE_TOKEN_DOC_RATIO);
      if (flagged.length === 0 || flagged.length === tokens.length) continue;
      for (const token of flagged) {
        const docs = suppressed.get(token) ?? new Set<string>();
        docs.add(String(row["doc"]));
        suppressed.set(token, docs);
      }
    }
  } catch (err) {
    console.warn("Boilerplate-token statistics unavailable; using all tokens:", err);
    return new Map();
  }
  return suppressed;
}

/**
 * Searches D1 for chunks matching query tokens and ranks by distinct token matches.
 */
export async function searchD1KeywordCandidates(
  db: D1Database,
  tokens: string[],
  filters: HydrateFilterOptions = {},
  limit = 20
): Promise<Array<{ id: string; score: number }>> {
  if (tokens.length === 0) return [];

  const queryTokens = tokens.slice(0, 8);
  const suppressed = await findBoilerplateTokensByDocument(db, queryTokens, filters);
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Per token: an optional "this document does not treat the token as boilerplate" guard.
  const guardFor = (token: string): { sql: string; ids: string[] } => {
    const ids = Array.from(suppressed.get(token) ?? []);
    return ids.length === 0
      ? { sql: "1=1", ids }
      : { sql: `c.document_id NOT IN (${ids.map(() => "?").join(", ")})`, ids };
  };

  const scoreParts = queryTokens.map((t) => {
    const g = guardFor(t);
    params.push(...g.ids, `%${t}%`, ...g.ids, `%${t}%`);
    return `(CASE WHEN ${g.sql} AND LOWER(c.chunk_text) LIKE ? THEN 2 ELSE 0 END + CASE WHEN ${g.sql} AND LOWER(COALESCE(c.section_title, '')) LIKE ? THEN 3 ELSE 0 END)`;
  });

  const tokenOrClauses = queryTokens.map((t) => {
    const g = guardFor(t);
    params.push(...g.ids, `%${t}%`, `%${t}%`);
    return `(${g.sql} AND (LOWER(c.chunk_text) LIKE ? OR LOWER(COALESCE(c.section_title, '')) LIKE ?))`;
  });

  conditions.push(`(${tokenOrClauses.join(" OR ")})`);

  const scope = buildKeywordScopeConditions(filters);
  conditions.push(...scope.conditions);
  params.push(...scope.params);

  const query = `
    SELECT c.id,
           (${scoreParts.join(" + ")}) AS match_score
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY match_score DESC
    LIMIT ${limit}
  `;

  try {
    const { results } = await db.prepare(query).bind(...params).all<{ id: string; match_score: number }>();
    return (results ?? []).map((r) => ({ id: r.id, score: r.match_score }));
  } catch (err) {
    console.warn("Keyword search failed:", err);
    return [];
  }
}

export function formatDisplayName(val: string): string {
  const lower = val.toLowerCase().trim();
  if (lower === "ford") return "Ford";
  if (lower === "mercedes-benz" || lower === "mercedes") return "Mercedes-Benz";
  if (lower === "ram") return "Ram";
  if (lower === "transit") return "Transit";
  if (lower === "transit_custom" || lower === "transit-custom") return "Transit Custom";
  if (lower === "sprinter") return "Sprinter";
  if (lower === "promaster") return "ProMaster";
  return val
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function buildCanonicalTitle(doc: {
  document_title?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  market?: string | null;
  metadata_json?: string | null;
}): string {
  if (!doc.manufacturer || !doc.model) {
    return doc.document_title || "Unknown Manual";
  }

  let yearStart: number | undefined;
  let yearEnd: number | undefined;
  let chassisCode: string | undefined;

  if (doc.metadata_json) {
    try {
      const parsed = typeof doc.metadata_json === "string" ? JSON.parse(doc.metadata_json) : doc.metadata_json;
      if (parsed) {
        if (parsed.year_start) yearStart = Number(parsed.year_start);
        if (parsed.year_end) yearEnd = Number(parsed.year_end);
        if (parsed.chassis_code) chassisCode = String(parsed.chassis_code);
      }
    } catch {}
  }

  const mfg = formatDisplayName(doc.manufacturer);
  const mdl = formatDisplayName(doc.model);
  const mkt = (doc.market || "global").toUpperCase();
  const yearStr = yearStart
    ? yearEnd && yearEnd !== yearStart
      ? `${yearStart}-${yearEnd}`
      : `${yearStart}`
    : "";
  const codeStr = chassisCode ? `, ${chassisCode}` : "";

  const titleCore = `${mfg} ${mdl} (${mkt}${codeStr})`;
  const canonical = yearStr ? `${yearStr} ${titleCore}` : titleCore;

  if (doc.document_title && !doc.document_title.toLowerCase().includes(doc.model.toLowerCase())) {
    return `${canonical} [${doc.document_title}]`;
  }
  return canonical;
}

export function normalizeChunkForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/date of publication:\s*\d{1,2}\/\d{2,4}/gi, "")
    .replace(/page\s*\d+/gi, "")
    .replace(/chunk\s*\d+/gi, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeTokenOverlap(textA: string, textB: string): number {
  const tokensA = new Set(textA.split(" ").filter((w) => w.length >= 3));
  const tokensB = new Set(textB.split(" ").filter((w) => w.length >= 3));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const minSize = Math.min(tokensA.size, tokensB.size);
  return intersection / minSize;
}

export function extractYearFromChunk(chunk: HybridSearchResult): number {
  if (chunk.model_year && chunk.model_year > 0) return chunk.model_year;
  const match = chunk.id.match(/\b(202[0-9])\b/);
  if (match) return parseInt(match[1]!, 10);
  return 0;
}

export function deduplicateCrossEditionChunks(
  chunks: HybridSearchResult[]
): HybridSearchResult[] {
  const result: HybridSearchResult[] = [];
  const seenIds = new Set<string>();

  for (const current of chunks) {
    // 1. Strict deduplication by chunk ID: exact same chunk_id never appears twice
    if (seenIds.has(current.id)) {
      continue;
    }

    const normCurrent = normalizeChunkForDedup(current.text);
    const mfg = (current.manufacturer || "").toLowerCase();
    const mdl = (current.model || "").toLowerCase();
    const mkt = (current.market || "global").toLowerCase();
    const curYear = extractYearFromChunk(current);

    const curParsed = current.id.match(/^(.+)#chunk_\d+$/);
    const curDoc = curParsed ? curParsed[1] : current.id;

    let duplicateIndex = -1;
    for (let i = 0; i < result.length; i++) {
      const existing = result[i]!;
      if (existing.id === current.id) {
        duplicateIndex = i;
        break;
      }

      const exMfg = (existing.manufacturer || "").toLowerCase();
      const exMdl = (existing.model || "").toLowerCase();
      const exMkt = (existing.market || "global").toLowerCase();
      const exYear = extractYearFromChunk(existing);

      const exParsed = existing.id.match(/^(.+)#chunk_\d+$/);
      const exDoc = exParsed ? exParsed[1] : existing.id;

      // Only deduplicate between DIFFERENT editions/documents of the same vehicle family & market
      const isDifferentEdition = curDoc !== exDoc || (curYear !== exYear && curYear > 0 && exYear > 0);
      const curFuel = current.fuel_type || extractChunkFuelType({
        metadata_json: current.metadata_json,
        document_title: current.document_title,
        source: current.source,
        chunk_text: current.text,
      });
      const exFuel = existing.fuel_type || extractChunkFuelType({
        metadata_json: existing.metadata_json,
        document_title: existing.document_title,
        source: existing.source,
        chunk_text: existing.text,
      });
      const isPowertrainMismatch =
        curFuel &&
        exFuel &&
        curFuel !== exFuel &&
        (curFuel === "bev" || exFuel === "bev");

      if (
        mfg &&
        exMfg &&
        mfg === exMfg &&
        mdl === exMdl &&
        mkt === exMkt &&
        isDifferentEdition &&
        !isPowertrainMismatch
      ) {
        const normExisting = normalizeChunkForDedup(existing.text);
        const overlap = computeTokenOverlap(normCurrent, normExisting);
        if (overlap >= 0.80) {
          duplicateIndex = i;
          break;
        }
      }
    }

    if (duplicateIndex === -1) {
      seenIds.add(current.id);
      result.push(current);
    } else {
      const existing = result[duplicateIndex]!;
      const exYear = extractYearFromChunk(existing);
      if (curYear > exYear || (curYear === exYear && current.score > existing.score)) {
        seenIds.delete(existing.id);
        seenIds.add(current.id);
        result[duplicateIndex] = current;
      }
    }
  }

  return result;
}

export async function hydrateChunks(
  db: D1Database,
  ids: string[],
  filters: HydrateFilterOptions = {}
): Promise<Map<string, HydratedChunk>> {
  const map = new Map<string, HydratedChunk>();
  if (ids.length === 0) return map;

  const buildQueryAndParams = (f: HydrateFilterOptions) => {
    const placeholders = ids.map(() => "?").join(", ");
    const conditions: string[] = [`c.id IN (${placeholders})`];
    const params: unknown[] = [...ids];

    if (f.category) {
      conditions.push(`LOWER(COALESCE(c.category, d.category, '')) = ?`);
      params.push(f.category.toLowerCase().trim());
    }

    if (f.manufacturer) {
      const m = f.manufacturer.toLowerCase().trim();
      conditions.push(
        `(LOWER(COALESCE(c.manufacturer, d.manufacturer, '')) = ? OR ? LIKE '%' || LOWER(COALESCE(c.manufacturer, d.manufacturer, '')) || '%' OR LOWER(COALESCE(c.manufacturer, d.manufacturer, '')) LIKE '%' || ? || '%')`
      );
      params.push(m, m, m);
    }

    if (f.model) {
      const m = f.model.toLowerCase().trim();
      conditions.push(
        `(LOWER(COALESCE(c.model, d.model, '')) = ? OR ? LIKE '%' || LOWER(COALESCE(c.model, d.model, '')) || '%' OR LOWER(COALESCE(c.model, d.model, '')) LIKE '%' || ? || '%')`
      );
      params.push(m, m, m);
    }

    if (f.market) {
      conditions.push(`LOWER(COALESCE(c.market, d.market, 'global')) IN (?, 'global')`);
      params.push(f.market.toLowerCase().trim());
    }

    if (f.model_year !== undefined) {
      const metaExpr = `COALESCE(c.metadata_json, d.metadata_json)`;
      conditions.push(
        `(json_extract(${metaExpr}, '$.year_start') IS NULL OR (CAST(json_extract(${metaExpr}, '$.year_start') AS INTEGER) <= ? AND CAST(COALESCE(json_extract(${metaExpr}, '$.year_end'), json_extract(${metaExpr}, '$.year_start')) AS INTEGER) >= ?))`
      );
      params.push(f.model_year, f.model_year);
    }

    const query = `SELECT c.id, c.document_id, d.title AS document_title,
                COALESCE(c.category, d.category) AS category,
                COALESCE(c.manufacturer, d.manufacturer) AS manufacturer,
                d.applicable_chassis, c.page_number, c.section_title, c.subsystem, c.chunk_text,
                s.r2_key AS schematic_r2_key, s.caption AS schematic_caption,
                COALESCE(c.model, d.model) AS model,
                COALESCE(c.market, d.market) AS market,
                COALESCE(c.metadata_json, d.metadata_json) AS metadata_json
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
         LEFT JOIN schematic_images s ON s.id = c.schematic_image_id
         WHERE ${conditions.join(" AND ")}`;

    return { query, params };
  };

  // Progressive (Stepwise) Filter Relaxation:
  // Stage 1: All filters (category, manufacturer, model, market, model_year)
  // Stage 2: Drop category (keep manufacturer, model, market, model_year)
  // Stage 3: Drop model (keep manufacturer, market, model_year)
  // Stage 4: Keep only market and model_year
  const stages: HydrateFilterOptions[] = [
    filters,
    { manufacturer: filters.manufacturer, model: filters.model, market: filters.market, model_year: filters.model_year },
    { manufacturer: filters.manufacturer, market: filters.market, model_year: filters.model_year },
    { market: filters.market, model_year: filters.model_year },
  ];

  for (const stageFilters of stages) {
    const { query, params } = buildQueryAndParams(stageFilters);
    const { results } = await db
      .prepare(query)
      .bind(...params)
      .all<HydratedChunk>();

    if (results && results.length > 0) {
      for (const row of results) map.set(row.id, row);
      break;
    }
  }

  // Forward Neighbor / Continuation Chunk Expansion:
  // For top primary hits (up to 3) and ANY chunk containing figure/table/grounding continuation cues,
  // automatically fetch and append forward sibling chunks (#chunk_{index+1}, #chunk_{index+2}).
  const siblingIdsToFetch = new Set<string>();
  const allPrimaryChunks = ids.map((id) => map.get(id)).filter((c): c is HydratedChunk => Boolean(c));

  allPrimaryChunks.forEach((chunk, index) => {
    const parsed = chunk.id.match(/^(.+)#chunk_(\d+)$/);
    if (!parsed) return;
    const docPrefix = parsed[1]!;
    const idx = parseInt(parsed[2]!, 10);
    const hasCue =
      CONTINUATION_CUE_REGEX.test(chunk.chunk_text) ||
      CONTINUATION_CUE_REGEX.test(chunk.section_title || "");

    if (index < 3 || hasCue) {
      siblingIdsToFetch.add(`${docPrefix}#chunk_${idx + 1}`);
      siblingIdsToFetch.add(`${docPrefix}#chunk_${idx + 2}`);
    }
  });

  for (const existingId of map.keys()) {
    siblingIdsToFetch.delete(existingId);
  }

  const sibMap = new Map<string, HydratedChunk>();
  if (siblingIdsToFetch.size > 0) {
    const sibPlaceholders = Array.from(siblingIdsToFetch).map(() => "?").join(", ");
    const sibQuery = `SELECT c.id, c.document_id, d.title AS document_title,
                COALESCE(c.category, d.category) AS category,
                COALESCE(c.manufacturer, d.manufacturer) AS manufacturer,
                d.applicable_chassis, c.page_number, c.section_title, c.subsystem, c.chunk_text,
                s.r2_key AS schematic_r2_key, s.caption AS schematic_caption,
                COALESCE(c.model, d.model) AS model,
                COALESCE(c.market, d.market) AS market,
                COALESCE(c.metadata_json, d.metadata_json) AS metadata_json
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
         LEFT JOIN schematic_images s ON s.id = c.schematic_image_id
         WHERE c.id IN (${sibPlaceholders})`;

    try {
      const sibResults = await db.prepare(sibQuery).bind(...Array.from(siblingIdsToFetch)).all<HydratedChunk>();
      for (const row of sibResults.results ?? []) {
        sibMap.set(row.id, row);
      }
    } catch (err) {
      console.warn("Forward continuation hydration failed:", err);
    }
  }

  for (const chunk of allPrimaryChunks) {
    const parsed = chunk.id.match(/^(.+)#chunk_(\d+)$/);
    if (!parsed) continue;
    const docPrefix = parsed[1]!;
    const idx = parseInt(parsed[2]!, 10);
    const sib1 = sibMap.get(`${docPrefix}#chunk_${idx + 1}`) ?? map.get(`${docPrefix}#chunk_${idx + 1}`);

    if (sib1 && sib1.document_id === chunk.document_id && arePowertrainsCompatible(chunk, sib1)) {
      const sectionLabel = sib1.section_title ? ` (${sib1.section_title})` : "";
      chunk.chunk_text += `\n\n[Continuation from next section/table${sectionLabel}]:\n${sib1.chunk_text}`;

      if (!chunk.schematic_r2_key && sib1.schematic_r2_key) {
        chunk.schematic_r2_key = sib1.schematic_r2_key;
        chunk.schematic_caption = sib1.schematic_caption;
      }

      const hasContinuationCue = CONTINUATION_CUE_REGEX.test(chunk.chunk_text);
      const sharesPage = sib1.page_number === chunk.page_number;
      if (hasContinuationCue || sharesPage) {
        const sib2 = sibMap.get(`${docPrefix}#chunk_${idx + 2}`) ?? map.get(`${docPrefix}#chunk_${idx + 2}`);
        if (sib2 && sib2.document_id === chunk.document_id && arePowertrainsCompatible(chunk, sib2)) {
          const sec2Label = sib2.section_title ? ` (${sib2.section_title})` : "";
          chunk.chunk_text += `\n\n[Continuation${sec2Label}]:\n${sib2.chunk_text}`;
          if (!chunk.schematic_r2_key && sib2.schematic_r2_key) {
            chunk.schematic_r2_key = sib2.schematic_r2_key;
            chunk.schematic_caption = sib2.schematic_caption;
          }
        }
      }
    }
  }

  return map;
}

/**
 * Variant-neutral section notes.
 *
 * When a section opener is dropped because it is tagged for another variant (e.g. BEV for an ICE query),
 * its CAUTION / WARNING / NOTE blocks are often still universally applicable ("use only the points indicated",
 * "tighten to the specified torque"). This keeps the blocks that contain no variant-specific marker and drops:
 *  - any sentence naming the other variant (BEV_CONTENT_REGEX),
 *  - the rest of that block (later sentences usually depend on the dropped one), and
 *  - non-prose text such as figure labels and table cells.
 * Generic: it knows nothing about any vehicle or component. Returns "" when nothing qualifies.
 */
export function extractNeutralSectionContext(text: string | null | undefined, maxChars = 800): string {
  if (!text) return "";
  const cleaned = stripPageBoilerplate(text).replace(/\s+/g, " ");
  const BLOCK = /^(?:CAUTIONS?|WARNINGS?|NOTES?|IMPORTANT)\s*:/;
  const start = cleaned.search(/\b(?:CAUTIONS?|WARNINGS?|NOTES?|IMPORTANT)\s*:/);
  if (start < 0) return "";

  const kept: string[] = [];
  let dropping = false;
  for (const raw of cleaned.slice(start).split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
    const sentence = raw.trim();
    if (BLOCK.test(sentence)) dropping = false;
    if (BEV_CONTENT_REGEX.test(sentence)) {
      dropping = true;
      continue;
    }
    if (dropping) continue;
    const words = sentence.split(/\s+/);
    const proseWords = words.filter((w) => /^[A-Za-z][A-Za-z'’,;:()/-]*[.!?]?$/.test(w)).length;
    if (words.length < 4 || proseWords / words.length < 0.7) continue;
    kept.push(sentence);
  }
  return kept.join(" ").slice(0, maxChars).trim();
}

/** Numbered section headings such as "4.25 Grounding" or "4.25.1 Ground Points" (at least two levels). */
const SECTION_HEADING_REGEX = /\b(\d{1,2}(?:\.\d{1,3}){1,3})\s+[A-Z][A-Za-z]/g;

/** Numbered headings found in a chunk's own text (page boilerplate removed), in order. */
export function extractSectionNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(stripPageBoilerplate(text).matchAll(SECTION_HEADING_REGEX), (m) => m[1]!);
}

/** "4.25.1" -> "4.25": the top two levels identify the section a chunk belongs to. */
function sectionRoot(num: string): string {
  return num.split(".").slice(0, 2).join(".");
}

/**
 * Powertrain-aware section continuation.
 *
 * A manual section can open on a page tagged BEV (its intro text names the BEV figure) while the
 * ICE figure and table that complete the section sit on the following pages. For a non-BEV query
 * the BEV parent is later dropped, which would also lose its ICE continuation (stitching refuses to
 * cross powertrains). So for the top-ranked BEV chunks we promote their non-BEV neighbours from the
 * next few pages, inserting them immediately after the parent so they inherit its rank even when the
 * final comparator treats peers as ties.
 *
 * Section continuity: walking forward page by page, we stop at the first neighbour whose text starts
 * a numbered heading outside the parent's section (or any numbered heading, if the parent's section
 * cannot be determined), so an unrelated section never inherits the parent's rank or label.
 * Neighbours that are already candidates are moved up next to the parent instead of duplicated.
 * Mutates `matches` and `hydrated`.
 */
export async function promoteNonBevNeighbors(
  db: D1Database,
  matches: ManualChunk[],
  hydrated: Map<string, HydratedChunk>,
  opts: { maxParents?: number; pageWindow?: number; maxPerParent?: number } = {}
): Promise<void> {
  const maxParents = opts.maxParents ?? 3;
  const pageWindow = opts.pageWindow ?? 3;
  const maxPerParent = opts.maxPerParent ?? 3;

  const parents = matches
    .slice(0, maxParents)
    .map((m) => ({ match: m, chunk: hydrated.get(m.id) }))
    .filter((p): p is { match: ManualChunk; chunk: HydratedChunk } => {
      return Boolean(p.chunk) && extractChunkFuelType(p.chunk!) === "bev";
    });

  for (const { match, chunk } of parents) {
    try {
      const { results } = await db
        .prepare(
          `SELECT c.id, c.document_id, d.title AS document_title,
                  COALESCE(c.category, d.category) AS category,
                  COALESCE(c.manufacturer, d.manufacturer) AS manufacturer,
                  d.applicable_chassis, c.page_number, c.section_title, c.subsystem, c.chunk_text,
                  s.r2_key AS schematic_r2_key, s.caption AS schematic_caption,
                  COALESCE(c.model, d.model) AS model,
                  COALESCE(c.market, d.market) AS market,
                  COALESCE(c.metadata_json, d.metadata_json) AS metadata_json
           FROM document_chunks c
           JOIN documents d ON d.id = c.document_id
           LEFT JOIN schematic_images s ON s.id = c.schematic_image_id
           WHERE c.document_id = ? AND c.page_number > ? AND c.page_number <= ?
           ORDER BY c.page_number, c.id`
        )
        .bind(chunk.document_id, chunk.page_number, chunk.page_number + pageWindow)
        .all<HydratedChunk>();

      // Prefer the parent's own heading; fall back to the first heading in its text (later numbers are
      // usually cross-references such as "Refer to: 5.1.2 Welding").
      const parentNumber =
        extractSectionNumbers(chunk.section_title)[0] ?? extractSectionNumbers(chunk.chunk_text)[0];
      const parentRoot = parentNumber ? sectionRoot(parentNumber) : null;
      const parentHeadingLabel = chunk.section_title && extractSectionNumbers(chunk.section_title).length > 0
        ? chunk.section_title
        : null;

      const sectionNotes = extractNeutralSectionContext(chunk.chunk_text);
      const withNotes = (row: HydratedChunk): HydratedChunk =>
        sectionNotes
          ? {
              ...row,
              chunk_text: `[Section notes from page ${chunk.page_number}, the opener of this section (variant-specific sentences omitted); the content below starts on page ${row.page_number} and may continue onto later pages]: ${sectionNotes}\n\n${row.chunk_text}`,
            }
          : row;

      let promoted = 0;
      let insertAt = matches.findIndex((m) => m.id === match.id) + 1;
      for (const row of results ?? []) {
        if (promoted >= maxPerParent) break;

        const headings = extractSectionNumbers(row.chunk_text);
        const leavesSection = parentRoot
          ? headings.some((h) => sectionRoot(h) !== parentRoot)
          : headings.length > 0;
        if (leavesSection) break; // section boundary: nothing further belongs to the parent

        if (extractChunkFuelType(row) === "bev") continue;

        const existingIdx = matches.findIndex((m) => m.id === row.id);
        if (existingIdx !== -1) {
          // Already a candidate (possibly ranked below top_k): move it up beside the parent.
          if (existingIdx < insertAt) continue;
          const [existing] = matches.splice(existingIdx, 1);
          existing!.score = Math.max(existing!.score, match.score - 0.001 * (promoted + 1));
          matches.splice(insertAt, 0, existing!);
          if (promoted === 0 && hydrated.has(row.id)) hydrated.set(row.id, withNotes(hydrated.get(row.id)!));
        } else {
          const label =
            extractSectionNumbers(row.section_title).length > 0
              ? row.section_title
              : parentHeadingLabel
                ? `${parentHeadingLabel} (continued on p${row.page_number})`
                : row.section_title;
          const labelled = { ...row, section_title: label };
          hydrated.set(row.id, promoted === 0 ? withNotes(labelled) : labelled);
          matches.splice(insertAt, 0, {
            id: row.id,
            score: match.score - 0.001 * (promoted + 1),
            metadata: { ...match.metadata },
          });
        }
        insertAt++;
        promoted++;
      }
    } catch (err) {
      console.warn("Non-BEV neighbour promotion failed:", err);
    }
  }
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
  schematic_url?: string;
  schematic_caption?: string;
  schematic_markdown?: string;
  model?: string;
  market?: string;
  model_year?: number;
  metadata_json?: string;
  fuel_type?: "bev" | "ice";
}

/** Joins the CDN base URL and an R2 key into a public image URL. */
export function buildSchematicUrl(cdnBaseUrl: string, r2Key: string | null): string | null {
  if (!cdnBaseUrl || !r2Key) return null;
  const base = cdnBaseUrl.replace(/\/+$/, "");
  const key = r2Key.replace(/^\/+/, "");
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export interface HybridSearchOptions {
  topK?: number;
  source?: string;
  chassis?: string;
  subsystem?: string;
  cdnBaseUrl?: string;
  category?: string;
  manufacturer?: string;
  model?: string;
  market?: "us" | "eu" | "global";
  model_year?: number;
  queryText?: string;
  /**
   * When true, return a clarification (and no results) if the best results come from several documents that
   * differ in a facet (manufacturer / model / model year / market) the caller did not specify. Default false.
   */
  clarify?: boolean;
  /** When false, near-identical chunks from different editions are all kept (no "newest wins" collapsing). Default true. */
  collapseEditions?: boolean;
}

export interface HybridSearchOutcome {
  results: HybridSearchResult[];
  /** Present (with empty results) when more context (year / model / ...) is needed to answer without assuming a variant. */
  clarification?: Clarification;
}

/**
 * Hybrid search: kNN lookup in Vectorize, then hydrate the matching IDs from D1.
 * Chunks not yet present in D1 (legacy vectors) fall back to Vectorize metadata text.
 * `chassis` and `subsystem` filters require matching Vectorize metadata indexes.
 * Returns only the ranked results; see `hybridSearchDetailed` for the clarification outcome.
 */
export async function hybridSearch(
  vectorIndex: VectorizeIndex,
  db: D1Database | undefined,
  queryVector: number[],
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult[]> {
  return (await hybridSearchDetailed(vectorIndex, db, queryVector, options)).results;
}

/** Hybrid search that can also report that more context (year / model / ...) is needed. */
export async function hybridSearchDetailed(
  vectorIndex: VectorizeIndex,
  db: D1Database | undefined,
  queryVector: number[],
  options: HybridSearchOptions = {}
): Promise<HybridSearchOutcome> {
  const filter: VectorizeVectorMetadataFilter = {};
  if (options.source) filter["source"] = { $eq: options.source };
  if (options.chassis) {
    const rawChassis = options.chassis.toLowerCase().trim();
    const shortChassis = rawChassis.includes("transit")
      ? "transit"
      : rawChassis.includes("sprinter")
        ? "sprinter"
        : rawChassis.includes("promaster")
          ? "promaster"
          : rawChassis;
    filter["chassis"] = { $in: Array.from(new Set([shortChassis, "universal"])) };
  }
  if (options.subsystem) filter["subsystem"] = { $eq: options.subsystem };

  const effectiveModel = options.model;
  const effectiveMarket = options.market;
  const requestedTopK = options.topK ?? 8;
  const candidatePoolSize = Math.max(requestedTopK * 3, 24);

  let matches = await searchManuals(vectorIndex, queryVector, {
    topK: candidatePoolSize,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  });

  // If Vectorize metadata filtering (e.g. over-specific subsystem or chassis) yields 0 matches,
  // fall back to unfiltered semantic search so relevant chunks are not lost.
  if (matches.length === 0 && Object.keys(filter).length > 0) {
    matches = await searchManuals(vectorIndex, queryVector, {
      topK: candidatePoolSize,
    });
  }
  if (db && options.queryText) {
    const tokens = tokenizeQuery(options.queryText);
    if (tokens.length > 0) {
      const keywordCandidates = await searchD1KeywordCandidates(db, tokens, {
        category: options.category,
        manufacturer: options.manufacturer,
        model: effectiveModel,
        market: effectiveMarket,
        model_year: options.model_year,
      });

      if (keywordCandidates.length > 0) {
        const fusedIds = reciprocalRankFusion(
          matches.map((m) => m.id),
          keywordCandidates.map((k) => k.id)
        );

        const matchById = new Map(matches.map((m) => [m.id, m]));
        const reorderedMatches: ManualChunk[] = [];
        for (const id of fusedIds) {
          const existing = matchById.get(id);
          if (existing) {
            reorderedMatches.push(existing);
          } else {
            reorderedMatches.push({
              id,
              score: 0.75,
              metadata: { source: "d1_keyword_search", text: "" },
            });
          }
        }
        matches = reorderedMatches.slice(0, candidatePoolSize);
      }
    }
  }

  const hydrated = db
    ? await hydrateChunks(db, matches.map((m) => m.id), {
        category: options.category,
        manufacturer: options.manufacturer,
        model: effectiveModel,
        market: effectiveMarket,
        model_year: options.model_year,
      })
    : new Map<string, HydratedChunk>();

  // Powertrain-aware continuation: keep the ICE figure/table that completes a BEV-tagged section opener.
  if (db && !queryContainsBevIndicators(options.queryText)) {
    await promoteNonBevNeighbors(db, matches, hydrated);
  }

  const hasFilters = Boolean(
    options.category ||
      options.manufacturer ||
      options.model ||
      options.market ||
      options.model_year !== undefined
  );

  const fusedRank = new Map(matches.map((m, i) => [m.id, i]));

  let mappedResults = matches
    .filter((m) => {
      if (hasFilters && db) {
        return hydrated.has(m.id);
      }
      return true;
    })
    .map((m): HybridSearchResult => {
    const h = hydrated.get(m.id);
    if (!h) {
      return { id: m.id, score: m.score, source: m.metadata.source, page: m.metadata.page, section: m.metadata.section, text: m.metadata.text };
    }
    let modelYear: number | undefined;
    if (h.metadata_json) {
      try {
        const metaObj = typeof h.metadata_json === "string" ? JSON.parse(h.metadata_json) : h.metadata_json;
        if (metaObj?.year_start) {
          modelYear = Number(metaObj.year_start);
        }
      } catch {}
    }

    const canonicalTitle = buildCanonicalTitle({
      document_title: h.document_title,
      manufacturer: h.manufacturer,
      model: h.model,
      market: h.market,
      metadata_json: h.metadata_json,
    });

    const sourceName = canonicalTitle || (m.metadata.source && m.metadata.source !== "unknown" ? m.metadata.source : h.document_title);

    const rawFuelType = extractChunkFuelType({
      metadata_json: h.metadata_json,
      document_title: h.document_title,
      source: m.metadata.source,
      chunk_text: h.chunk_text,
    });

    return {
      id: m.id,
      score: m.score,
      source: sourceName,
      page: h.page_number,
      section: h.section_title ?? undefined,
      text: h.chunk_text,
      document_title: canonicalTitle,
      category: h.category,
      manufacturer: h.manufacturer,
      applicable_chassis: h.applicable_chassis,
      subsystem: h.subsystem,
      model: h.model ?? undefined,
      market: h.market ?? undefined,
      model_year: modelYear,
      metadata_json: h.metadata_json ?? undefined,
      ...(rawFuelType ? { fuel_type: rawFuelType } : {}),
      ...(h.schematic_r2_key ? { schematic_r2_key: h.schematic_r2_key } : {}),
      ...(h.schematic_r2_key && options.cdnBaseUrl
        ? (() => {
            const url = buildSchematicUrl(options.cdnBaseUrl, h.schematic_r2_key);
            if (!url) return {};
            const captionOrTitle = h.schematic_caption || canonicalTitle || "OEM Diagram";
            return {
              schematic_url: url,
              schematic_markdown: `![${captionOrTitle}](${url})`,
            };
          })()
        : {}),
      ...(h.schematic_caption ? { schematic_caption: h.schematic_caption } : {}),
    };
  })
  ;

  // Check whether query contains explicit BEV tokens
  const isBevQuery = queryContainsBevIndicators(options.queryText);

  // For a non-BEV query, BEV chunks are dropped whenever any non-BEV chunk exists (ICE-by-default policy).
  const dropBevForNonBevQuery = (items: HybridSearchResult[]): HybridSearchResult[] => {
    if (isBevQuery) return items;
    const nonBev = items.filter((chunk) => (chunk.fuel_type || extractChunkFuelType(chunk)) !== "bev");
    return nonBev.length > 0 ? nonBev : items;
  };

  // No assumed context: if the best results come from several documents that differ in a facet the caller did
  // not specify (model year, model, manufacturer, market), ask instead of silently picking one (e.g. "newest").
  // Assessed BEFORE edition de-duplication, which would otherwise hide the fact that editions differ.
  if (options.clarify) {
    const clarification = assessAmbiguity(dropBevForNonBevQuery(mappedResults).slice(0, requestedTopK), {
      manufacturer: options.manufacturer,
      model: options.model,
      chassis: options.chassis,
      market: options.market,
      model_year: options.model_year,
      source: options.source,
    });
    if (clarification) return { results: [], clarification };
  }

  // Deduplicate by chunk ID and (optionally) near-identical chunks across editions within the same context.
  mappedResults = options.collapseEditions === false
    ? mappedResults.filter((r, i, arr) => arr.findIndex((o) => o.id === r.id) === i)
    : deduplicateCrossEditionChunks(mappedResults);

  // Generic ranking priority:
  // 1. Exact model match (when options.model is specified) ranks ahead of derivative/compound models
  // 2. (No market/year/vehicle preference: unspecified context is asked about, never assumed.)
  // 3. Intelligent Powertrain / Fuel Bias: Default to ICE unless BEV indicators were explicitly provided
  mappedResults.sort((a, b) => {
    if (options.model) {
      const reqModel = options.model.toLowerCase().trim();
      const aExact = (a.model || "").toLowerCase() === reqModel ? 1 : 0;
      const bExact = (b.model || "").toLowerCase() === reqModel ? 1 : 0;
      if (aExact !== bExact) {
        return bExact - aExact;
      }
    }

    // Powertrain bias:
    // If not a BEV query, prioritize ICE / neutral chunks ahead of BEV chunks.
    // If an explicit BEV query, prioritize BEV chunks.
    const aFuel = a.fuel_type || extractChunkFuelType(a);
    const bFuel = b.fuel_type || extractChunkFuelType(b);
    if (!isBevQuery) {
      const aIsIce = aFuel !== "bev" ? 1 : 0;
      const bIsIce = bFuel !== "bev" ? 1 : 0;
      if (aIsIce !== bIsIce) {
        return bIsIce - aIsIce;
      }
    } else {
      const aIsBev = aFuel === "bev" ? 1 : 0;
      const bIsBev = bFuel === "bev" ? 1 : 0;
      if (aIsBev !== bIsBev) {
        return bIsBev - aIsBev;
      }
    }

    // Final tie-break: the fused (RRF) rank. Raw `score` is NOT comparable across sources: keyword-only
    // candidates carry a fixed synthetic score (0.75) that would outrank genuine cosine similarities and
    // discard the fusion order. Promoted continuations sit right after their parent in `matches`.
    return (fusedRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (fusedRank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });

  // Step 3 Post-Retrieval Re-Ranking & Filtering:
  // If not an explicit BEV query, strictly filter out fuel === 'bev' chunks if non-BEV chunks exist.
  // Only return BEV chunks if isBevQuery is true or if zero non-BEV chunks matched.
  mappedResults = dropBevForNonBevQuery(mappedResults);

  return { results: mappedResults.slice(0, requestedTopK) };
}
