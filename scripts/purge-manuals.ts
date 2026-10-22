#!/usr/bin/env tsx
/**
 * scripts/purge-manuals.ts
 *
 * Dedicated pipeline to purge all manual chunks, documents, and vector embeddings
 * from Cloudflare Vectorize, Cloudflare D1, and R2 manifest state.
 *
 * Usage:
 *   npx tsx scripts/purge-manuals.ts
 *   npx tsx scripts/purge-manuals.ts --dry-run
 *
 * Prerequisites:
 *   - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables set
 *   - (optional) D1_DATABASE_ID to clean D1 document tables (default from cloudflare.config.ts)
 *   - (optional) R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to remove .manifest.json
 */

import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  batchArray,
  CLOUDFLARE_API_BASE,
  deleteVectorsByIds,
  describeApiFailure,
  executeD1Statements,
  getD1DatabaseId,
  MAX_DELETE_CANDIDATE_CHUNKS,
  VECTORIZE_DELETE_BATCH_SIZE,
  VECTORIZE_INDEX_NAME,
} from "./ingest-manuals";
import { createR2Client, MANIFEST_KEY, R2_BUCKET_NAME } from "./sync-r2-manuals";

export interface PurgeOptions {
  dryRun?: boolean;
  extraPrefixes?: string[];
}

export const KNOWN_DOCUMENT_PREFIXES = [
  "MY24_Transit_BEMM_V363N_20APR24_J2_V2_R2",
  "MY24_Transit__BEMM_V363N_20APR24_J2_V2_R2",
  "transit_bemm_pdf",
  "ford_transit_body_builder",
  "velit_heater_manual_pdf",
  "e2e_test_sample_manual_1785428891164_pdf",
];

/** Queries all existing chunk IDs directly from D1 document_chunks table. */
export async function fetchChunkIdsFromD1(
  accountId: string,
  apiToken: string,
  databaseId: string
): Promise<string[]> {
  try {
    const response = await fetch(`${CLOUDFLARE_API_BASE}/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        params: [],
        sql: "SELECT id FROM document_chunks LIMIT 10000;",
      }),
    });
    if (!response.ok) {
      console.warn(`Could not query D1 chunk IDs: ${describeApiFailure(response.status, await response.text())}`);
      return [];
    }
    const data = (await response.json()) as { result?: Array<{ results?: Array<{ id: string }> }> };
    const rows = data.result?.[0]?.results ?? [];
    return rows.map((r) => r.id).filter(Boolean);
  } catch (err) {
    console.warn("Failed fetching chunk IDs from D1:", err);
    return [];
  }
}

/** Generates candidate vector IDs for known prefixes to ensure Vectorize is fully cleaned. */
export function buildKnownCandidateIds(prefixes: string[] = KNOWN_DOCUMENT_PREFIXES, maxChunks: number = MAX_DELETE_CANDIDATE_CHUNKS): string[] {
  const ids: string[] = [];
  for (const prefix of prefixes) {
    for (let i = 0; i < maxChunks; i++) {
      ids.push(`${prefix}#chunk_${i}`);
    }
  }
  return ids;
}

/** Deletes the manifest file from R2 so future sync runs do not retain stale state. */
export async function deleteR2Manifest(client: S3Client, bucket: string = R2_BUCKET_NAME): Promise<boolean> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY }));
    return true;
  } catch (err) {
    console.warn(`Could not delete R2 manifest from "${bucket}":`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Executes full purge of manual vector chunks and D1 relational records. */
export async function runPurge(options: PurgeOptions = {}): Promise<{
  vectorCountDeleted: number;
  d1Cleaned: boolean;
  manifestDeleted: boolean;
}> {
  const dryRun = options.dryRun ?? false;
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"];

  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required.");
  }

  const d1DatabaseId = getD1DatabaseId();
  const vectorIdsToDelete = new Set<string>();

  // 1. Gather IDs from D1 if available
  if (d1DatabaseId) {
    console.log(`Checking D1 database ${d1DatabaseId} for existing chunk IDs...`);
    const d1Ids = await fetchChunkIdsFromD1(accountId, apiToken, d1DatabaseId);
    console.log(`Found ${d1Ids.length} chunk IDs in D1.`);
    for (const id of d1Ids) vectorIdsToDelete.add(id);
  }

  // 2. Add known candidate IDs
  const prefixes = [...KNOWN_DOCUMENT_PREFIXES, ...(options.extraPrefixes ?? [])];
  const candidateIds = buildKnownCandidateIds(prefixes);
  for (const id of candidateIds) vectorIdsToDelete.add(id);

  const allVectorIds = Array.from(vectorIdsToDelete);
  console.log(`Targeting ${allVectorIds.length} candidate vector IDs for deletion in Vectorize index "${VECTORIZE_INDEX_NAME}".`);

  let vectorCountDeleted = 0;
  if (dryRun) {
    console.log(`[dry-run] Would delete ${allVectorIds.length} vector IDs from Vectorize.`);
  } else {
    for (const batch of batchArray(allVectorIds, VECTORIZE_DELETE_BATCH_SIZE)) {
      await deleteVectorsByIds(accountId, apiToken, batch);
      vectorCountDeleted += batch.length;
    }
    console.log(`✓ Deleted vector batches from Vectorize.`);
  }

  // 3. Clean D1 database tables
  let d1Cleaned = false;
  if (d1DatabaseId) {
    if (dryRun) {
      console.log(`[dry-run] Would delete all rows from document_chunks, schematic_images, and documents in D1.`);
    } else {
      console.log(`Purging D1 manual tables...`);
      // Delete in strict foreign-key order: document_chunks references schematic_images and documents,
      // and schematic_images references documents.
      await executeD1Statements(accountId, apiToken, d1DatabaseId, [
        { sql: "DELETE FROM document_chunks;", params: [] },
        { sql: "DELETE FROM schematic_images;", params: [] },
        { sql: "DELETE FROM documents;", params: [] },
      ]);
      console.log(`✓ Cleared D1 tables: document_chunks, schematic_images, documents.`);
      d1Cleaned = true;
    }
  }

  // 4. Remove .manifest.json from R2
  let manifestDeleted = false;
  const r2AccessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const r2SecretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];
  if (r2AccessKeyId && r2SecretAccessKey) {
    if (dryRun) {
      console.log(`[dry-run] Would delete "${MANIFEST_KEY}" from R2 bucket "${R2_BUCKET_NAME}".`);
    } else {
      console.log(`Deleting "${MANIFEST_KEY}" from R2 bucket "${R2_BUCKET_NAME}"...`);
      const r2Client = createR2Client(accountId, r2AccessKeyId, r2SecretAccessKey);
      manifestDeleted = await deleteR2Manifest(r2Client, R2_BUCKET_NAME);
      if (manifestDeleted) {
        console.log(`✓ Deleted R2 manifest.`);
      }
    }
  }

  return { vectorCountDeleted, d1Cleaned, manifestDeleted };
}

// CLI entrypoint
const isMain = typeof require !== "undefined" ? require.main === module : (process.argv[1]?.includes("purge-manuals") ?? false);
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  runPurge({ dryRun })
    .then(() => {
      console.log("Purge completed successfully.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Purge failed:", err);
      process.exit(1);
    });
}
