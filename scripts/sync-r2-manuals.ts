#!/usr/bin/env tsx
/**
 * scripts/sync-r2-manuals.ts
 *
 * Manually-triggered ingestion pipeline that syncs large PDF manuals stored
 * in the `campervan-mcp` Cloudflare R2 bucket (including nested subfolders)
 * into the `van_manuals_index` Vectorize index.
 *
 * This complements the automated `scripts/ingest-manuals.ts` pipeline (which
 * handles small PDFs committed to `docs/manuals/`) by supporting large files
 * that live in R2 instead of the git repository. All PDF parsing, chunking,
 * and streaming happen locally in GitHub Actions (or any Node.js
 * environment) to avoid Cloudflare Worker CPU/edge limits.
 *
 * Usage:
 *   npx tsx scripts/sync-r2-manuals.ts
 *   npx tsx scripts/sync-r2-manuals.ts --dry-run
 *   FORCE_REINDEX=true npx tsx scripts/sync-r2-manuals.ts
 *
 * Prerequisites:
 *   - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables set
 *     (the API token is used both for the R2 S3-compatible API and for the
 *     Workers AI / Vectorize REST APIs)
 *   - R2 bucket created and populated with PDFs (nested subfolders allowed)
 *   - Vectorize index created:
 *       npx wrangler vectorize create van_manuals_index --dimensions=768 --metric=cosine
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { extractText, getDocumentProxy } from "unpdf";
import {
  batchArray,
  deleteVectorsByIds,
  EMBEDDING_BATCH_SIZE,
  generateChunkId,
  generateEmbeddings,
  MAX_DELETE_CANDIDATE_CHUNKS,
  recursiveSplitText,
  upsertVectors,
  VECTORIZE_BATCH_SIZE,
  VECTORIZE_DELETE_BATCH_SIZE,
  type ManualChunk,
  type ManualChunkMetadata,
  type VectorizeVector,
} from "./ingest-manuals";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const R2_BUCKET_NAME = process.env["R2_BUCKET_NAME"] ?? "campervan-mcp";

/** Overridable via R2_ENDPOINT_URL for local/E2E testing against a mock S3 server. */
export function getR2Endpoint(accountId: string): string {
  return process.env["R2_ENDPOINT_URL"] ?? `https://${accountId}.r2.cloudflarestorage.com`;
}

/** Key of the manifest object (stored in R2 itself) tracking previously-synced state. */
export const MANIFEST_KEY = "_vectorize-sync-manifest.json";

export const PDF_EXTENSION_RE = /\.pdf$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  etag: string;
  chunkCount: number;
}

export type SyncManifest = Record<string, ManifestEntry>;

export interface R2ObjectSummary {
  key: string;
  etag: string;
}

export interface SyncDelta {
  addedOrModified: R2ObjectSummary[];
  deleted: string[];
}

// ---------------------------------------------------------------------------
// R2 Client
// ---------------------------------------------------------------------------

export function createR2Client(accountId: string, apiToken: string): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: getR2Endpoint(accountId),
    // R2 (and our local E2E mock server) only support path-style requests.
    forcePathStyle: true,
    credentials: {
      accessKeyId: accountId,
      secretAccessKey: apiToken,
    },
  });
}

/** Recursively lists every object in the bucket (all subfolders), handling pagination. */
export async function listAllR2Objects(client: S3Client, bucket: string): Promise<_Object[]> {
  const objects: _Object[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );

    objects.push(...(response.Contents ?? []));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/** Filters a raw object listing down to PDF keys (excluding the manifest itself). */
export function filterPdfObjects(objects: _Object[]): R2ObjectSummary[] {
  return objects
    .filter((obj) => obj.Key && obj.Key !== MANIFEST_KEY && PDF_EXTENSION_RE.test(obj.Key))
    .map((obj) => ({
      key: obj.Key as string,
      etag: (obj.ETag ?? "").replace(/"/g, ""),
    }));
}

// ---------------------------------------------------------------------------
// Manifest (diff state) persistence
// ---------------------------------------------------------------------------

export async function fetchManifest(client: S3Client, bucket: string): Promise<SyncManifest> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY }));
    const body = await response.Body?.transformToString();
    return body ? (JSON.parse(body) as SyncManifest) : {};
  } catch (err) {
    if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") {
      return {};
    }
    throw err;
  }
}

export async function writeManifest(client: S3Client, bucket: string, manifest: SyncManifest): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    })
  );
}

// ---------------------------------------------------------------------------
// Diffing (CRUD matrix)
// ---------------------------------------------------------------------------

/**
 * Determines the delta between the current R2 bucket state and the last
 * synced manifest: objects that are new/modified (ETag mismatch or missing
 * from the manifest) and manifest entries whose R2 object no longer exists.
 */
export function computeSyncDelta(
  currentObjects: R2ObjectSummary[],
  manifest: SyncManifest,
  forceReindex: boolean = false
): SyncDelta {
  const currentKeys = new Set(currentObjects.map((obj) => obj.key));

  const addedOrModified = currentObjects.filter((obj) => {
    if (forceReindex) {
      return true;
    }
    const entry = manifest[obj.key];
    return !entry || entry.etag !== obj.etag;
  });

  const deleted = Object.keys(manifest).filter((key) => !currentKeys.has(key));

  return { addedOrModified, deleted };
}

// ---------------------------------------------------------------------------
// Vector ID helpers (path-aware, supports nested subfolders)
// ---------------------------------------------------------------------------

/** Sanitizes a full R2 object key (including subfolder path) into an ID-safe token. */
export function sanitizeR2Key(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Derives a human-readable manual title from an R2 object key. */
export function deriveManualTitleFromKey(key: string): string {
  const name = key.replace(PDF_EXTENSION_RE, "").split("/").pop() ?? key;
  return name
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Builds the full list of manual chunks (with IDs and metadata) for a PDF's text. */
export function buildR2ManualChunks(key: string, text: string): ManualChunk[] {
  const sanitizedName = sanitizeR2Key(key);
  const manualTitle = deriveManualTitleFromKey(key);
  const textChunks = recursiveSplitText(text);
  const totalChunks = textChunks.length;

  return textChunks.map((chunkText, index) => ({
    id: generateChunkId(sanitizedName, index),
    text: chunkText,
    metadata: {
      filename: key,
      manual_title: manualTitle,
      chunk_index: index,
      total_chunks: totalChunks,
      text: chunkText,
    } satisfies ManualChunkMetadata,
  }));
}

/** Builds the full set of deterministic candidate chunk IDs to delete for a removed R2 object. */
export function buildR2DeleteCandidateIds(key: string, maxChunks: number = MAX_DELETE_CANDIDATE_CHUNKS): string[] {
  const sanitizedName = sanitizeR2Key(key);
  const ids: string[] = [];
  for (let i = 0; i < maxChunks; i++) {
    ids.push(generateChunkId(sanitizedName, i));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Streaming / Processing PDFs from R2 (memory safety)
// ---------------------------------------------------------------------------

/** Downloads an R2 object to a temporary file on disk, returning the file path. */
export async function downloadR2ObjectToTemp(client: S3Client, bucket: string, key: string): Promise<string> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await response.Body?.transformToByteArray();

  if (!bytes) {
    throw new Error(`R2 object "${key}" returned an empty body`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "r2-manual-"));
  const tempPath = join(tempDir, "manual.pdf");
  writeFileSync(tempPath, bytes);
  return tempPath;
}

export async function processDeletedR2Object(
  key: string,
  accountId: string,
  apiToken: string,
  dryRun: boolean
): Promise<void> {
  const candidateIds = buildR2DeleteCandidateIds(key);
  console.log(`Deleting up to ${candidateIds.length} candidate vector IDs for "${key}"`);

  if (dryRun) {
    console.log(`[dry-run] Skipping delete request for "${key}"`);
    return;
  }

  for (const batch of batchArray(candidateIds, VECTORIZE_DELETE_BATCH_SIZE)) {
    await deleteVectorsByIds(accountId, apiToken, batch);
  }
}

export async function processAddedModifiedR2Object(
  r2Client: S3Client,
  bucket: string,
  key: string,
  accountId: string,
  apiToken: string,
  dryRun: boolean
): Promise<number> {
  const tempPath = await downloadR2ObjectToTemp(r2Client, bucket, key);

  let chunks: ManualChunk[];
  try {
    const buffer = readFileSync(tempPath);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    chunks = buildR2ManualChunks(key, text);
  } finally {
    // Clean up the temporary file (and its containing directory) immediately.
    rmSync(join(tempPath, ".."), { recursive: true, force: true });
  }

  console.log(`Parsed "${key}" into ${chunks.length} chunks`);

  if (dryRun) {
    console.log(`[dry-run] Skipping embedding/upsert for "${key}"`);
    return chunks.length;
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

  console.log(`✓ Ingested ${chunks.length} chunks from "${key}"`);
  return chunks.length;
}

// ---------------------------------------------------------------------------
// CLI Argument / Environment Parsing
// ---------------------------------------------------------------------------

export interface SyncOptions {
  dryRun: boolean;
  forceReindex: boolean;
}

export function parseSyncArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SyncOptions {
  const dryRun = argv.includes("--dry-run");
  const forceReindex = argv.includes("--force-reindex") || env["FORCE_REINDEX"] === "true";
  return { dryRun, forceReindex };
}

// ---------------------------------------------------------------------------
// Main Sync Logic
// ---------------------------------------------------------------------------

export async function runSync(options: SyncOptions): Promise<void> {
  const { dryRun, forceReindex } = options;

  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"];

  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required.");
  }

  const r2Client = createR2Client(accountId, apiToken);

  console.log(`Listing objects in R2 bucket "${R2_BUCKET_NAME}"...`);
  const allObjects = await listAllR2Objects(r2Client, R2_BUCKET_NAME);
  const pdfObjects = filterPdfObjects(allObjects);
  console.log(`Found ${pdfObjects.length} PDF object(s) in R2.`);

  const manifest = await fetchManifest(r2Client, R2_BUCKET_NAME);
  const delta = computeSyncDelta(pdfObjects, manifest, forceReindex);

  console.log(
    `Delta: ${delta.addedOrModified.length} added/modified, ${delta.deleted.length} deleted` +
      (forceReindex ? " (force re-index enabled)" : "")
  );

  if (delta.addedOrModified.length === 0 && delta.deleted.length === 0) {
    console.log("No R2 manual changes to process. Exiting.");
    return;
  }

  const updatedManifest: SyncManifest = { ...manifest };

  for (const key of delta.deleted) {
    await processDeletedR2Object(key, accountId, apiToken, dryRun);
    delete updatedManifest[key];
  }

  for (const obj of delta.addedOrModified) {
    const chunkCount = await processAddedModifiedR2Object(
      r2Client,
      R2_BUCKET_NAME,
      obj.key,
      accountId,
      apiToken,
      dryRun
    );
    updatedManifest[obj.key] = { etag: obj.etag, chunkCount };
  }

  if (dryRun) {
    console.log("[dry-run] Skipping manifest update.");
    return;
  }

  await writeManifest(r2Client, R2_BUCKET_NAME, updatedManifest);
  console.log("✓ Manifest updated.");
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

/* c8 ignore start */
const isMainModule = typeof require !== "undefined" && require.main === module;

if (isMainModule) {
  const options = parseSyncArgs(process.argv.slice(2));
  runSync(options).catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
/* c8 ignore stop */
