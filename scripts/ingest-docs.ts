#!/usr/bin/env tsx
/**
 * scripts/ingest-docs.ts
 *
 * Ingests PDF and HTML documentation into Cloudflare Vectorize for RAG search.
 *
 * Usage:
 *   npx tsx scripts/ingest-docs.ts --source <file_or_url> --name <source_name>
 *
 * Prerequisites:
 *   - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables set
 *   - Vectorize index created: npx wrangler vectorize create van_manuals_index --dimensions=384 --metric=cosine
 *
 * Example:
 *   npx tsx scripts/ingest-docs.ts --source ./docs/transit-body-builder.pdf --name ford_transit_body_builder
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const VECTORIZE_API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
const CHUNK_SIZE_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 200;
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocumentChunk {
  id: string;
  text: string;
  metadata: {
    source: string;
    page?: number;
    section?: string;
    text: string;
  };
}

// ---------------------------------------------------------------------------
// Text Chunking
// ---------------------------------------------------------------------------

/**
 * Splits text into overlapping chunks of approximately CHUNK_SIZE_CHARS characters.
 */
function chunkText(
  text: string,
  sourceName: string,
  chunkSize = CHUNK_SIZE_CHARS,
  overlap = CHUNK_OVERLAP_CHARS
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let offset = 0;
  let chunkIndex = 0;

  while (offset < text.length) {
    const end = Math.min(offset + chunkSize, text.length);
    const chunkText = text.slice(offset, end).trim();

    if (chunkText.length > 50) {
      chunks.push({
        id: `${sourceName}_chunk_${chunkIndex}`,
        text: chunkText,
        metadata: {
          source: sourceName,
          text: chunkText,
        },
      });
      chunkIndex++;
    }

    offset += chunkSize - overlap;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding Generation via Cloudflare AI REST API
// ---------------------------------------------------------------------------

async function generateEmbeddings(
  texts: string[],
  accountId: string,
  apiToken: string
): Promise<number[][]> {
  const response = await fetch(
    `${VECTORIZE_API_BASE}/${accountId}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: texts }),
    }
  );

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { result: { data: number[][] } };
  return data.result.data;
}

// ---------------------------------------------------------------------------
// Vectorize Upsert via REST API
// ---------------------------------------------------------------------------

async function upsertVectors(
  accountId: string,
  apiToken: string,
  indexName: string,
  vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>
): Promise<void> {
  // Vectorize API expects NDJSON format
  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");

  const response = await fetch(
    `${VECTORIZE_API_BASE}/${accountId}/vectorize/v2/indexes/${indexName}/upsert`,
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
    throw new Error(`Vectorize upsert error: ${response.status} ${await response.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--source");
  const nameIndex = args.indexOf("--name");
  const indexIndex = args.indexOf("--index");

  if (sourceIndex === -1 || nameIndex === -1) {
    console.error("Usage: npx tsx scripts/ingest-docs.ts --source <file> --name <source_name> [--index <index_name>]");
    process.exit(1);
  }

  const sourcePath = args[sourceIndex + 1];
  const sourceName = args[nameIndex + 1];
  const indexName = indexIndex !== -1 ? args[indexIndex + 1] : "van_manuals_index";

  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"];

  if (!accountId || !apiToken) {
    console.error("Error: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required.");
    process.exit(1);
  }

  console.log(`Ingesting: ${sourcePath} → source="${sourceName}" → index="${indexName}"`);

  // Read source document
  let text: string;
  if (sourcePath.startsWith("http://") || sourcePath.startsWith("https://")) {
    const response = await fetch(sourcePath);
    text = await response.text();
  } else {
    text = readFileSync(resolve(process.cwd(), sourcePath), "utf-8");
  }

  // Chunk the document
  const chunks = chunkText(text, sourceName);
  console.log(`Created ${chunks.length} chunks`);

  // Process in batches
  let processed = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    // Generate embeddings
    const embeddings = await generateEmbeddings(texts, accountId, apiToken);

    // Prepare vectors
    const vectors = batch.map((chunk, idx) => ({
      id: chunk.id,
      values: embeddings[idx],
      metadata: chunk.metadata as Record<string, unknown>,
    }));

    // Upsert to Vectorize
    await upsertVectors(accountId, apiToken, indexName, vectors);

    processed += batch.length;
    console.log(`Progress: ${processed}/${chunks.length} chunks ingested`);
  }

  console.log(`✓ Successfully ingested ${chunks.length} chunks from "${sourceName}"`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
