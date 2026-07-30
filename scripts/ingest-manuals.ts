#!/usr/bin/env tsx
/**
 * scripts/ingest-manuals.ts
 *
 * Automated GitOps ingestion pipeline for PDF manuals stored in `docs/manuals/`.
 *
 * PDF parsing and chunking happen locally in GitHub Actions (or any Node.js
 * environment) to avoid the Cloudflare Worker CPU/edge limits. Embeddings are
 * generated via the Cloudflare Workers AI REST API and vectors are
 * upserted/deleted in Cloudflare Vectorize via its REST API.
 *
 * Usage:
 *   npx tsx scripts/ingest-manuals.ts \
 *     --added-modified "docs/manuals/a.pdf docs/manuals/b.pdf" \
 *     --deleted "docs/manuals/c.pdf"
 *
 *   npx tsx scripts/ingest-manuals.ts --dry-run
 *
 * File lists may also be supplied via the ADDED_MODIFIED_FILES and
 * DELETED_FILES environment variables (space-separated paths), matching the
 * output of tj-actions/changed-files in ingest-manuals.yml.
 *
 * Prerequisites:
 *   - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables set
 *   - Vectorize index created:
 *       npx wrangler vectorize create van_manuals_index --dimensions=768 --metric=cosine
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Base URL for the Cloudflare REST API. Overridable via CF_API_BASE_URL for
 * local/E2E testing against a mock HTTP server; defaults to the real API. */
export const CLOUDFLARE_API_BASE =
  process.env["CF_API_BASE_URL"] ?? "https://api.cloudflare.com/client/v4/accounts";
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const VECTORIZE_INDEX_NAME = "van_manuals_index";

export const CHUNK_SIZE_CHARS = 500;
export const CHUNK_OVERLAP_CHARS = 50;

export const EMBEDDING_BATCH_SIZE = 25;
export const VECTORIZE_BATCH_SIZE = 100;
export const VECTORIZE_DELETE_BATCH_SIZE = 500;

/** Generous upper bound on chunks-per-manual used to build deterministic
 * delete candidate IDs. Vectorize ignores IDs that don't exist, so this only
 * needs to be larger than the largest manual we expect to ingest. */
export const MAX_DELETE_CANDIDATE_CHUNKS = 2000;

/**
 * PDF.js verbosity level passed to `getDocumentProxy`. Restricting this to
 * "errors only" (0) suppresses noisy, non-fatal `Warning: TypeError:
 * Math.sumPrecise is not a function` log spam emitted by the bundled PDF.js
 * build (it feature-detects a not-yet-standard `Math.sumPrecise` API and
 * safely falls back when unavailable) without hiding genuine parsing errors.
 */
export const PDF_PARSE_VERBOSITY = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManualChunkMetadata {
  filename: string;
  manual_title: string;
  title: string;
  doc_type: string;
  category: string;
  chunk_index: number;
  total_chunks: number;
  text: string;
}

/** Result of mapping a file path to its rich metadata classification. */
export interface DocClassification {
  docType: string;
  category: string;
}

/**
 * Maps a file's path to a `doc_type`/`category` pair based on its folder
 * prefix, so travel guides, product specs, and hardware docs can be indexed
 * (and filtered on) alongside standard manuals:
 *   - `travel/`, `guides/`   -> doc_type: "road_trip_guide", category: "travel"
 *   - `specs/`, `hardware/`  -> doc_type: "product_spec",    category: "hardware"
 *   - `manuals/` or anything else (unmapped) -> doc_type: "manual", category: "technical"
 */
export function classifyDocPath(filePath: string): DocClassification {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();

  if (/(^|\/)travel\//.test(normalized) || /(^|\/)guides\//.test(normalized)) {
    return { docType: "road_trip_guide", category: "travel" };
  }

  if (/(^|\/)specs\//.test(normalized) || /(^|\/)hardware\//.test(normalized)) {
    return { docType: "product_spec", category: "hardware" };
  }

  return { docType: "manual", category: "technical" };
}

export interface ManualChunk {
  id: string;
  text: string;
  metadata: ManualChunkMetadata;
}

export interface VectorizeVector {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers: filenames, titles, IDs
// ---------------------------------------------------------------------------

/** Sanitizes a filename (including extension) into an ID-safe token. */
export function sanitizeFilename(filePath: string): string {
  return basename(filePath).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Cloudflare Vectorize enforces a hard 64-byte limit on vector IDs. Sanitized
 * filenames are truncated to this length before the `#chunk_<index>` suffix
 * is appended so the resulting ID always stays comfortably under that cap,
 * even for long original filenames. The full original filename is preserved
 * separately in the vector's `metadata.filename` field.
 */
export const MAX_SANITIZED_NAME_LENGTH = 40;

/** Builds the deterministic vector ID for a given chunk of a manual. */
export function generateChunkId(sanitizedName: string, index: number): string {
  const truncatedName = sanitizedName.slice(0, MAX_SANITIZED_NAME_LENGTH).replace(/_+$/g, "");
  return `${truncatedName}#chunk_${index}`;
}

/** Derives a human-readable manual title from a filename. */
export function deriveManualTitle(filePath: string): string {
  const name = basename(filePath).replace(/\.pdf$/i, "");
  return name
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Text Chunking (RecursiveCharacterTextSplitter-style)
// ---------------------------------------------------------------------------

const DEFAULT_SEPARATORS = ["\n\n", "\n", " ", ""];

/**
 * Recursively splits text on a list of separators (largest first), merging
 * the resulting fragments back together into chunks of at most `chunkSize`
 * characters, with `chunkOverlap` characters of overlap between chunks.
 * Mirrors the behavior of LangChain's RecursiveCharacterTextSplitter.
 */
export function recursiveSplitText(
  text: string,
  chunkSize: number = CHUNK_SIZE_CHARS,
  chunkOverlap: number = CHUNK_OVERLAP_CHARS,
  separators: string[] = DEFAULT_SEPARATORS
): string[] {
  const splitOnSeparator = (input: string, seps: string[]): string[] => {
    if (input.length === 0) {
      return [];
    }
    if (input.length <= chunkSize) {
      return [input];
    }

    const [separator, ...restSeparators] = seps;
    const parts =
      separator === "" || separator === undefined
        ? input.split("")
        : input.split(separator);

    const merged: string[] = [];
    let current = "";

    for (const part of parts) {
      const candidate = current === "" ? part : current + (separator ?? "") + part;

      if (candidate.length <= chunkSize) {
        current = candidate;
        continue;
      }

      if (current !== "") {
        merged.push(current);
      }

      if (part.length > chunkSize) {
        // Part itself is too big; recurse with the remaining separators.
        merged.push(...(restSeparators.length > 0 ? splitOnSeparator(part, restSeparators) : [part]));
        current = "";
      } else {
        current = part;
      }
    }

    if (current !== "") {
      merged.push(current);
    }

    return merged;
  };

  const rawChunks = splitOnSeparator(text.trim(), separators).filter((chunk) => chunk.trim().length > 0);

  if (rawChunks.length === 0) {
    return [];
  }

  // Apply overlap by prefixing each chunk (after the first) with the tail of
  // the previous chunk.
  const overlapped: string[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i];
    if (i === 0 || chunkOverlap <= 0) {
      overlapped.push(chunk.trim());
      continue;
    }
    const previous = rawChunks[i - 1];
    const maxOverlap = Math.max(0, Math.min(chunkOverlap, chunkSize - chunk.length));
    const overlapText = previous.slice(Math.max(0, previous.length - maxOverlap));
    overlapped.push((overlapText + chunk).trim());
  }

  return overlapped.filter((chunk) => chunk.length > 0);
}

/** Builds the full list of manual chunks (with IDs and metadata) for a PDF's text. */
export function buildManualChunks(filePath: string, text: string): ManualChunk[] {
  const sanitizedName = sanitizeFilename(filePath);
  const manualTitle = deriveManualTitle(filePath);
  const { docType, category } = classifyDocPath(filePath);
  const textChunks = recursiveSplitText(text);
  const totalChunks = textChunks.length;

  return textChunks.map((chunkText, index) => ({
    id: generateChunkId(sanitizedName, index),
    text: chunkText,
    metadata: {
      filename: basename(filePath),
      manual_title: manualTitle,
      title: manualTitle,
      doc_type: docType,
      category,
      chunk_index: index,
      total_chunks: totalChunks,
      text: chunkText,
    },
  }));
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

export function batchArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Appends a troubleshooting hint to API error messages when the failure is
 * an authentication/authorization error (401/403), since these are almost
 * always caused by a missing/expired/under-scoped CLOUDFLARE_API_TOKEN
 * rather than a bug in the calling code.
 */
export function describeApiFailure(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return `${status} ${body} (verify CLOUDFLARE_ACCOUNT_ID and that CLOUDFLARE_API_TOKEN has Workers AI + Vectorize edit permissions and has not expired)`;
  }
  return `${status} ${body}`;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI - Embedding Generation
// ---------------------------------------------------------------------------

export async function generateEmbeddings(
  texts: string[],
  accountId: string,
  apiToken: string
): Promise<number[][]> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/${accountId}/ai/run/${EMBEDDING_MODEL}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  if (!response.ok) {
    throw new Error(
      `Workers AI embedding request failed: ${describeApiFailure(response.status, await response.text())}`
    );
  }

  const data = (await response.json()) as { result: { data: number[][] } };
  return data.result.data;
}

// ---------------------------------------------------------------------------
// Cloudflare Vectorize - Upsert / Delete
// ---------------------------------------------------------------------------

export async function upsertVectors(
  accountId: string,
  apiToken: string,
  vectors: VectorizeVector[],
  indexName: string = VECTORIZE_INDEX_NAME
): Promise<void> {
  if (vectors.length === 0) {
    return;
  }

  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");

  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/${accountId}/vectorize/v2/indexes/${indexName}/upsert`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/x-ndjson",
      },
      body: ndjson,
    }
  );

  if (!response.ok) {
    throw new Error(
      `Vectorize upsert request failed: ${describeApiFailure(response.status, await response.text())}`
    );
  }
}

export async function deleteVectorsByIds(
  accountId: string,
  apiToken: string,
  ids: string[],
  indexName: string = VECTORIZE_INDEX_NAME
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/${accountId}/vectorize/v2/indexes/${indexName}/delete_by_ids`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Vectorize delete request failed: ${describeApiFailure(response.status, await response.text())}`
    );
  }
}

export interface VectorizeQueryMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** Queries the Vectorize index for the vectors nearest to `vector`. Used by the E2E smoke test to verify newly-upserted vectors are retrievable. */
export async function queryVectors(
  accountId: string,
  apiToken: string,
  vector: number[],
  options: { topK?: number; returnMetadata?: "none" | "indexed" | "all" } = {},
  indexName: string = VECTORIZE_INDEX_NAME
): Promise<VectorizeQueryMatch[]> {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/${accountId}/vectorize/v2/indexes/${indexName}/query`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vector,
        topK: options.topK ?? 5,
        returnMetadata: options.returnMetadata ?? "all",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Vectorize query request failed: ${describeApiFailure(response.status, await response.text())}`
    );
  }

  const data = (await response.json()) as { result: { matches: VectorizeQueryMatch[] } };
  return data.result.matches;
}

/** Builds the full set of deterministic candidate chunk IDs to delete for a removed manual. */
export function buildDeleteCandidateIds(
  filePath: string,
  maxChunks: number = MAX_DELETE_CANDIDATE_CHUNKS
): string[] {
  const sanitizedName = sanitizeFilename(filePath);
  const ids: string[] = [];
  for (let i = 0; i < maxChunks; i++) {
    ids.push(generateChunkId(sanitizedName, i));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// CLI Argument / Environment Parsing
// ---------------------------------------------------------------------------

export interface IngestOptions {
  addedModified: string[];
  deleted: string[];
  dryRun: boolean;
}

function parseFileList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): IngestOptions {
  const addedModifiedIndex = argv.indexOf("--added-modified");
  const deletedIndex = argv.indexOf("--deleted");
  const dryRun = argv.includes("--dry-run");

  const addedModifiedArg = addedModifiedIndex !== -1 ? argv[addedModifiedIndex + 1] : undefined;
  const deletedArg = deletedIndex !== -1 ? argv[deletedIndex + 1] : undefined;

  const addedModified =
    parseFileList(addedModifiedArg).length > 0
      ? parseFileList(addedModifiedArg)
      : parseFileList(env["ADDED_MODIFIED_FILES"]);

  const deleted =
    parseFileList(deletedArg).length > 0 ? parseFileList(deletedArg) : parseFileList(env["DELETED_FILES"]);

  return { addedModified, deleted, dryRun };
}

// ---------------------------------------------------------------------------
// Main Ingestion Logic
// ---------------------------------------------------------------------------

export async function processDeletedFile(
  filePath: string,
  accountId: string,
  apiToken: string,
  dryRun: boolean
): Promise<void> {
  const candidateIds = buildDeleteCandidateIds(filePath);
  console.log(`Deleting up to ${candidateIds.length} candidate vector IDs for "${filePath}"`);

  if (dryRun) {
    console.log(`[dry-run] Skipping delete request for "${filePath}"`);
    return;
  }

  for (const batch of batchArray(candidateIds, VECTORIZE_DELETE_BATCH_SIZE)) {
    await deleteVectorsByIds(accountId, apiToken, batch);
  }
}

export async function processAddedModifiedFile(
  filePath: string,
  accountId: string,
  apiToken: string,
  dryRun: boolean
): Promise<void> {
  const absolutePath = resolve(process.cwd(), filePath);
  const buffer = readFileSync(absolutePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: PDF_PARSE_VERBOSITY });
  const { text } = await extractText(pdf, { mergePages: true });

  const chunks = buildManualChunks(filePath, text);
  console.log(`Parsed "${filePath}" into ${chunks.length} chunks`);

  if (dryRun) {
    console.log(`[dry-run] Skipping embedding/upsert for "${filePath}"`);
    return;
  }

  for (const batch of batchArray(chunks, EMBEDDING_BATCH_SIZE)) {
    const embeddings = await generateEmbeddings(
      batch.map((chunk) => chunk.text),
      accountId,
      apiToken
    );

    const vectors: VectorizeVector[] = batch.map((chunk, idx) => ({
      id: chunk.id,
      values: embeddings[idx],
      metadata: chunk.metadata as unknown as Record<string, unknown>,
    }));

    for (const vectorBatch of batchArray(vectors, VECTORIZE_BATCH_SIZE)) {
      await upsertVectors(accountId, apiToken, vectorBatch);
    }
  }

  console.log(`✓ Ingested ${chunks.length} chunks from "${filePath}"`);
}

export async function runIngestion(options: IngestOptions): Promise<void> {
  const { addedModified, deleted, dryRun } = options;

  if (addedModified.length === 0 && deleted.length === 0) {
    console.log("No manual files to process. Exiting.");
    return;
  }

  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"];

  if (!accountId || !apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required."
    );
  }

  for (const filePath of deleted) {
    await processDeletedFile(filePath, accountId, apiToken, dryRun);
  }

  for (const filePath of addedModified) {
    await processAddedModifiedFile(filePath, accountId, apiToken, dryRun);
  }
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

/* c8 ignore start */
const isMainModule = typeof require !== "undefined" && require.main === module;

if (isMainModule) {
  const options = parseArgs(process.argv.slice(2));
  runIngestion(options).catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
/* c8 ignore stop */
