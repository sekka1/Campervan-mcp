#!/usr/bin/env tsx
/**
 * scripts/e2e-vectorize-smoke-test.ts
 *
 * Real end-to-end smoke test for the R2 -> Vectorize ingestion pipeline.
 * Unlike the mocked tests in `tests/e2e/`, this script talks to the *actual*
 * Cloudflare R2 bucket and Vectorize index using real credentials, run by
 * the `e2e-vector-upload.yml` GitHub Actions workflow whenever a PR touches
 * the vector ingestion code path.
 *
 * It exercises the full lifecycle end-to-end:
 *   1. Uploads a small fixture PDF to R2 under `e2e-test/`.
 *   2. Downloads it back from R2 (round-trips through the bucket).
 *   3. Parses, chunks, and embeds the PDF text.
 *   4. Upserts the resulting vectors into the `van_manuals_index` Vectorize index.
 *   5. Queries Vectorize to confirm the new vectors are retrievable.
 *   6. Deletes the vectors and the R2 object, cleaning up after itself.
 *
 * Usage:
 *   npx tsx scripts/e2e-vectorize-smoke-test.ts
 *
 * Prerequisites (same as scripts/sync-r2-manuals.ts):
 *   - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables set
 *   - R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables set
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { extractText, getDocumentProxy } from "unpdf";
import {
  generateEmbeddings,
  PDF_PARSE_VERBOSITY,
  queryVectors,
  upsertVectors,
  deleteVectorsByIds,
  batchArray,
  VECTORIZE_DELETE_BATCH_SIZE,
  type VectorizeVector,
} from "./ingest-manuals";
import { buildR2DeleteCandidateIds, buildR2ManualChunks, createR2Client, R2_BUCKET_NAME } from "./sync-r2-manuals";

const REPO_ROOT = resolve(__dirname, "..");
const FIXTURE_PDF_PATH = resolve(REPO_ROOT, "tests/fixtures/sample-manual.pdf");

/** Number of attempts (with a short delay between each) when polling Vectorize for eventual consistency. */
const QUERY_RETRY_ATTEMPTS = 6;
const QUERY_RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"];
  const r2AccessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const r2SecretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];

  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required.");
  }
  if (!r2AccessKeyId || !r2SecretAccessKey) {
    throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables are required.");
  }

  const r2Client = createR2Client(accountId, r2AccessKeyId, r2SecretAccessKey);
  const key = `e2e-test/sample-manual-${Date.now()}.pdf`;
  const chunkIds = buildR2DeleteCandidateIds(key);

  const cleanup = async (): Promise<void> => {
    console.log("Cleaning up e2e test artifacts...");
    for (const batch of batchArray(chunkIds, VECTORIZE_DELETE_BATCH_SIZE)) {
      await deleteVectorsByIds(accountId, apiToken, batch).catch((err) =>
        console.error("  Warning: failed to delete test vectors:", err instanceof Error ? err.message : err)
      );
    }
    await r2Client
      .send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
      .catch((err) => console.error("  Warning: failed to delete test R2 object:", err instanceof Error ? err.message : err));
  };

  try {
    // 1. Upload the fixture PDF to R2 under e2e-test/.
    const pdfBytes = readFileSync(FIXTURE_PDF_PATH);
    console.log(`[1/6] Uploading "${key}" to R2 bucket "${R2_BUCKET_NAME}"...`);
    await r2Client.send(
      new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: pdfBytes, ContentType: "application/pdf" })
    );

    // 2. Download it back to prove round-tripping through R2 works.
    console.log("[2/6] Downloading it back from R2...");
    const getResponse = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    const downloadedBytes = await getResponse.Body?.transformToByteArray();
    if (!downloadedBytes || Buffer.compare(Buffer.from(downloadedBytes), pdfBytes) !== 0) {
      throw new Error("Downloaded R2 object does not match the uploaded fixture PDF.");
    }

    // 3. Parse and chunk the PDF text.
    console.log("[3/6] Parsing and chunking the PDF...");
    const pdf = await getDocumentProxy(new Uint8Array(downloadedBytes), { verbosity: PDF_PARSE_VERBOSITY });
    const { text } = await extractText(pdf, { mergePages: true });
    const chunks = buildR2ManualChunks(key, text);
    if (chunks.length === 0) {
      throw new Error("Expected at least one chunk from the fixture PDF, got none.");
    }
    console.log(`  Parsed into ${chunks.length} chunk(s).`);

    // 4. Generate embeddings and upsert into Vectorize.
    console.log("[4/6] Generating embeddings and upserting into Vectorize...");
    const embeddings = await generateEmbeddings(chunks.map((c) => c.text), accountId, apiToken);
    const vectors: VectorizeVector[] = chunks.map((chunk, i) => ({
      id: chunk.id,
      values: embeddings[i],
      metadata: chunk.metadata as unknown as Record<string, unknown>,
    }));
    await upsertVectors(accountId, apiToken, vectors);

    // 5. Query Vectorize to confirm the vectors are retrievable (allowing for eventual consistency).
    console.log("[5/6] Querying Vectorize to confirm the new vectors are retrievable...");
    let found = false;
    for (let attempt = 1; attempt <= QUERY_RETRY_ATTEMPTS && !found; attempt++) {
      const matches = await queryVectors(accountId, apiToken, vectors[0].values, { topK: 5 });
      found = matches.some((match) => match.id === vectors[0].id);
      if (!found) {
        console.log(`  Attempt ${attempt}/${QUERY_RETRY_ATTEMPTS}: vector not yet queryable, retrying...`);
        await sleep(QUERY_RETRY_DELAY_MS);
      }
    }
    if (!found) {
      throw new Error(`Vector "${vectors[0].id}" was not returned by a Vectorize query after upsert.`);
    }
    console.log("  ✓ Query returned the newly-upserted vector.");

    // 6. Delete the vectors and the R2 object.
    console.log("[6/6] Deleting vectors and R2 object...");
    for (const batch of batchArray(chunkIds, VECTORIZE_DELETE_BATCH_SIZE)) {
      await deleteVectorsByIds(accountId, apiToken, batch);
    }
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));

    console.log("✓ E2E Vectorize smoke test passed.");
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/* c8 ignore start */
const isMainModule = typeof require !== "undefined" && require.main === module;

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
/* c8 ignore stop */
