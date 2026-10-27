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
 *   - (optional) D1_DATABASE_ID to also write `documents`/`document_chunks` rows to D1;
 *     the API token then also needs D1 edit permission
 *   - Vectorize index created:
 *       npx cf vectorize create --name=van_manuals_index --index-config-dimensions=768 --index-config-metric=cosine
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { extractImages, extractText, getDocumentProxy } from "unpdf";
import {
  deriveSectionTitle,
  ensureMathSumPrecisePolyfill,
  isSchematicCandidate,
  renderCompositeSchematic,
  type EncodedSchematic,
  type SchematicImage,
} from "./schematics";

ensureMathSumPrecisePolyfill();
import {
  extractCoverPageText,
  extractDocumentMetadata,
  type UniversalMetadata,
} from "./metadata";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Base URL for the Cloudflare REST API. Overridable via CF_API_BASE_URL for
 * local/E2E testing against a mock HTTP server; defaults to the real API. */
export const CLOUDFLARE_API_BASE =
  process.env["CF_API_BASE_URL"] ?? "https://api.cloudflare.com/client/v4/accounts";
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export type EmbeddingProvider = "deepinfra" | "cloudflare";

export interface EmbeddingOptions {
  provider?: EmbeddingProvider;
  deepinfraToken?: string;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  batchSize?: number;
}

export const DEEPINFRA_EMBEDDING_ENDPOINT =
  "https://api.deepinfra.com/v1/inference/BAAI/bge-base-en-v1.5";
export const EMBEDDING_DIMENSION = 768;

export const VECTORIZE_INDEX_NAME = "van_manuals_index";

export const CHUNK_SIZE_CHARS = 500;
export const CHUNK_OVERLAP_CHARS = 50;

/** Word-based chunking used for the D1 + Vectorize hybrid index. */
export const CHUNK_SIZE_WORDS = 500;
export const CHUNK_OVERLAP_WORDS = 100;
/** Maximum character length for a single text chunk before hard-splitting. */
export const MAX_CHUNK_CHARACTERS = 3000;

/** Hard safety ceiling for characters sent to DeepInfra to avoid exceeding 512 tokens.
 * Technical manuals with tables and specifications have an average token length of ~2.0-2.5 characters,
 * so 1,000 characters provides comfortable margin below 512 tokens. */
export const MAX_DEEPINFRA_INPUT_CHARS = 1000;
export const EMERGENCY_DEEPINFRA_INPUT_CHARS = 600;

export function sanitizeForDeepInfra(text: string, maxChars: number = MAX_DEEPINFRA_INPUT_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.8) {
    return slice.slice(0, lastSpace);
  }
  return slice;
}
/** Maximum allowed UTF-8 bytes for serialized Vectorize metadata (hard limit is 10,240). */
export const MAX_VECTORIZE_METADATA_BYTES = 9500;

/**
 * Enforces a strict UTF-8 byte cap on serialized Vectorize metadata (hard limit 10,240 bytes).
 * Progressively trims metadata.text while preserving multi-byte UTF-8 characters and JSON validity.
 */
export function capVectorMetadataBytes(
  metadata: Record<string, unknown>,
  maxBytes: number = MAX_VECTORIZE_METADATA_BYTES
): Record<string, unknown> {
  const metaCopy = { ...metadata };
  if (typeof metaCopy.text !== "string") {
    return metaCopy;
  }

  let jsonStr = JSON.stringify(metaCopy);
  let currentBytes = Buffer.byteLength(jsonStr, "utf8");

  if (currentBytes <= maxBytes) {
    return metaCopy;
  }

  let text = metaCopy.text;
  while (currentBytes > maxBytes && text.length > 0) {
    const excess = currentBytes - maxBytes;
    const charsToRemove = Math.max(10, Math.ceil(excess / 2));
    text = text.slice(0, Math.max(0, text.length - charsToRemove));
    metaCopy.text = text;
    jsonStr = JSON.stringify(metaCopy);
    currentBytes = Buffer.byteLength(jsonStr, "utf8");
  }

  return metaCopy;
}

/** Rough tokens-per-word ratio used to estimate `token_count` for D1 chunk rows. */
export const TOKENS_PER_WORD = 1.3;

/** D1 REST API accepts a `batch` of statements per request; keep batches modest. */
export const D1_BATCH_SIZE = 50;

export const EMBEDDING_BATCH_SIZE = 25;
export const VECTORIZE_BATCH_SIZE = 100;
export const VECTORIZE_DELETE_BATCH_SIZE = 100;

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
  chassis: string;
  subsystem: string;
  section?: string;
}

export const SUBSYSTEMS = [
  "12v_dc",
  "48v_dc",
  "120v_ac",
  "plumbing",
  "heating_cooling",
  "structural",
  "chassis_interface",
] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

export const D1_CATEGORIES = ["oem_bemm", "component_manual", "forum_consensus", "code_standard"] as const;
export type D1Category = (typeof D1_CATEGORIES)[number];

/** Chassis tag applied to documents that are not specific to a single platform. */
export const UNIVERSAL_CHASSIS = "universal";

const CHASSIS_PATTERNS: Array<[string, RegExp]> = [
  ["transit", /ford[\s_-]*transit|transit/],
  ["sprinter", /sprinter/],
  ["promaster", /pro[\s_-]*master/],
];

/** Infers the applicable chassis from a document path, defaulting to "universal". */
export function classifyChassis(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  for (const [chassis, pattern] of CHASSIS_PATTERNS) {
    if (pattern.test(normalized)) {
      return chassis;
    }
  }
  return UNIVERSAL_CHASSIS;
}

const SUBSYSTEM_PATTERNS: Array<[Subsystem, RegExp]> = [
  ["48v_dc", /\b48\s?v(olt)?s?\b/],
  ["120v_ac", /\b(120|110|230)\s?v(olt)?s?\b|\bshore power\b|\binverter\b|\bac (power|outlet|circuit)\b/],
  ["12v_dc", /\b12\s?v(olt)?s?\b|\bfuse\b|\bbusbar\b|\bbattery\b|\bawg\b/],
  ["plumbing", /\b(plumbing|water|faucet|pump|tank|drain)\b/],
  ["heating_cooling", /\b(heater|heating|cooling|furnace|air conditioner|a\/c|ventilation|diesel)\b/],
  ["structural", /\b(roof|payload|weight|bracket|mounting|structural|rail|load)\b/],
];

/**
 * Infers a subsystem from chunk text (falling back to the document path), using
 * the first matching pattern. Defaults to "chassis_interface".
 */
export function classifySubsystem(text: string, filePath: string = ""): Subsystem {
  for (const haystack of [text.toLowerCase(), filePath.replace(/[\\/_-]+/g, " ").toLowerCase()]) {
    for (const [subsystem, pattern] of SUBSYSTEM_PATTERNS) {
      if (pattern.test(haystack)) {
        return subsystem;
      }
    }
  }
  return "chassis_interface";
}

/** Maps a document path to the D1 `documents.category` CHECK-constrained value. */
export function classifyD1Category(filePath: string): D1Category {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (/\b(abyc|nec|iso|standards?|codes?)\b/.test(normalized.replace(/[_-]+/g, " "))) {
    return "code_standard";
  }
  const { category } = classifyDocPath(filePath);
  if (category === "travel") {
    return "forum_consensus";
  }
  if (category === "hardware") {
    return "component_manual";
  }
  if (/bemm|body[\s_-]*builder|upfitter/.test(normalized)) {
    return "oem_bemm";
  }
  return "component_manual";
}

const GENERIC_FOLDERS = new Set(["docs", "manuals", "specs", "hardware", "travel", "guides"]);

/** Uses the folder directly containing the file as the manufacturer, or "unknown". */
export function deriveManufacturer(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const folder = parts.length > 1 ? parts[parts.length - 2] : "";
  if (!folder || GENERIC_FOLDERS.has(folder.toLowerCase())) {
    return "unknown";
  }
  return folder;
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
  pageNumber: number;
  sectionTitle: string | null;
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

/**
 * Splits text into windows of `chunkSize` words with `overlap` words shared
 * between consecutive chunks.
 */
export function splitTextByWords(
  text: string,
  chunkSize: number = CHUNK_SIZE_WORDS,
  overlap: number = CHUNK_OVERLAP_WORDS
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const step = Math.max(1, chunkSize - overlap);
  const rawChunks: string[] = [];
  for (let start = 0; start < words.length; start += step) {
    rawChunks.push(words.slice(start, start + chunkSize).join(" "));
    if (start + chunkSize >= words.length) {
      break;
    }
  }

  // Hard-split oversized single blocks (e.g. dense Table of Contents or long blocks)
  // so no individual chunk exceeds MAX_CHUNK_CHARACTERS (3,000 chars)
  const boundedChunks: string[] = [];
  for (const chunk of rawChunks) {
    if (chunk.length <= MAX_CHUNK_CHARACTERS) {
      boundedChunks.push(chunk);
    } else {
      const subChunkOverlap = 200;
      let pos = 0;
      while (pos < chunk.length) {
        let end = Math.min(pos + MAX_CHUNK_CHARACTERS, chunk.length);
        if (end < chunk.length) {
          const lastNewline = chunk.lastIndexOf("\n", end);
          if (lastNewline > pos + MAX_CHUNK_CHARACTERS * 0.7) {
            end = lastNewline + 1;
          } else {
            const lastSpace = chunk.lastIndexOf(" ", end);
            if (lastSpace > pos + MAX_CHUNK_CHARACTERS * 0.7) {
              end = lastSpace + 1;
            }
          }
        }
        boundedChunks.push(chunk.slice(pos, end).trim());
        if (end >= chunk.length) break;
        pos = Math.max(pos + 1, end - subChunkOverlap);
      }
    }
  }

  return boundedChunks.filter((c) => c.length > 0);
}

export interface BuildChunksInput {
  /** ID-safe document token used as the prefix of every chunk/vector ID. */
  sanitizedName: string;
  /** Path stored as `metadata.filename`. */
  filename: string;
  /** Path used for chassis/category classification. */
  classificationPath: string;
  title: string;
  /** Page texts (1-indexed page numbers) or a single merged text (treated as page 1). */
  pages: string | string[];
}

/**
 * Chunks each page at ~500 words with 100 words of overlap and tags every chunk with
 * chassis, subsystem and category. Chunk IDs double as the Vectorize vector IDs.
 */
export function buildChunksFromPages(input: BuildChunksInput): ManualChunk[] {
  const { docType, category } = classifyDocPath(input.classificationPath);
  const chassis = classifyChassis(input.classificationPath);
  const pages = Array.isArray(input.pages) ? input.pages : [input.pages];

  const pieces: Array<{ text: string; pageNumber: number; sectionTitle: string | null }> = [];
  pages.forEach((pageText, pageIndex) => {
    const sectionTitle = deriveSectionTitle(pageText);
    for (const text of splitTextByWords(pageText)) {
      pieces.push({ text, pageNumber: pageIndex + 1, sectionTitle });
    }
  });

  return pieces.map(({ text, pageNumber, sectionTitle }, index) => ({
    id: generateChunkId(input.sanitizedName, index),
    text,
    pageNumber,
    sectionTitle,
    metadata: {
      filename: input.filename,
      manual_title: input.title,
      title: input.title,
      doc_type: docType,
      category,
      chunk_index: index,
      total_chunks: pieces.length,
      text,
      chassis,
      subsystem: classifySubsystem(text, input.classificationPath),
      ...(sectionTitle ? { section: sectionTitle } : {}),
    },
  }));
}

/** Builds the full list of manual chunks (with IDs and metadata) for a PDF's text. */
export function buildManualChunks(filePath: string, pages: string | string[]): ManualChunk[] {
  return buildChunksFromPages({
    sanitizedName: sanitizeFilename(filePath),
    filename: basename(filePath),
    classificationPath: filePath,
    title: deriveManualTitle(filePath),
    pages,
  });
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
  optionsOrAccountId?: EmbeddingOptions | string,
  maybeApiToken?: string
): Promise<number[][]> {
  if (!texts || texts.length === 0) {
    return [];
  }

  let options: EmbeddingOptions;
  if (typeof optionsOrAccountId === "string") {
    const envProvider = process.env["EMBEDDING_PROVIDER"]?.trim().toLowerCase() as EmbeddingProvider;
    options = {
      provider: envProvider || "cloudflare",
      cloudflareAccountId: optionsOrAccountId,
      cloudflareApiToken: maybeApiToken,
      deepinfraToken: process.env["DEEPINFRA_TOKEN"],
    };
  } else {
    options = optionsOrAccountId || {};
  }

  const envProvider = process.env["EMBEDDING_PROVIDER"]?.trim().toLowerCase() as EmbeddingProvider;
  const rawProvider =
    options.provider ||
    envProvider ||
    (options.deepinfraToken || process.env["DEEPINFRA_TOKEN"]
      ? "deepinfra"
      : (options.cloudflareAccountId || process.env["CLOUDFLARE_ACCOUNT_ID"]
        ? "cloudflare"
        : "deepinfra"));

  if (rawProvider !== "deepinfra" && rawProvider !== "cloudflare") {
    throw new Error(
      `Unsupported embedding provider: '${rawProvider}'. Allowed values are 'deepinfra' or 'cloudflare'.`
    );
  }

  if (rawProvider === "deepinfra") {
    const token = options.deepinfraToken || process.env["DEEPINFRA_TOKEN"];
    if (!token || token.trim() === "") {
      throw new Error(
        "Missing credential for DeepInfra: DEEPINFRA_TOKEN is required when EMBEDDING_PROVIDER is 'deepinfra'."
      );
    }

    const sanitizedTexts = texts.map((t) => sanitizeForDeepInfra(t));
    const response = await fetch(DEEPINFRA_EMBEDDING_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: sanitizedTexts }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`DeepInfra API error [HTTP ${response.status}]: ${errorBody}`);
      for (let idx = 0; idx < sanitizedTexts.length; idx++) {
        const item = sanitizedTexts[idx];
        console.error(
          `  [Chunk ${idx}]: length=${item.length} chars, preview=${JSON.stringify(item.slice(0, 120))}...`
        );
      }
      if (
        response.status === 400 &&
        (errorBody.includes("input tokens") ||
          errorBody.includes("context length") ||
          errorBody.includes("input_tokens"))
      ) {
        console.warn(
          `DeepInfra context length limit exceeded. Retrying with emergency truncation (${EMERGENCY_DEEPINFRA_INPUT_CHARS} chars)...`
        );
        const emergencyTexts = sanitizedTexts.map((t) =>
          sanitizeForDeepInfra(t, EMERGENCY_DEEPINFRA_INPUT_CHARS)
        );
        const retryResponse = await fetch(DEEPINFRA_EMBEDDING_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inputs: emergencyTexts }),
        });
        if (retryResponse.ok) {
          const retryData = (await retryResponse.json()) as {
            embeddings: number[][];
            usage?: { prompt_tokens: number; total_tokens: number };
          };
          if (
            retryData &&
            Array.isArray(retryData.embeddings) &&
            retryData.embeddings.length === emergencyTexts.length
          ) {
            console.log(
              `Emergency retry succeeded for ${emergencyTexts.length} chunks via DeepInfra.`
            );
            return retryData.embeddings;
          }
        } else {
          const retryErr = await retryResponse.text();
          console.error(
            `Emergency retry failed [HTTP ${retryResponse.status}]: ${retryErr}`
          );
        }
      }
      throw new Error(
        `DeepInfra embedding request failed with HTTP ${response.status}: ${errorBody}`
      );
    }

    const data = (await response.json()) as {
      embeddings: number[][];
      usage?: { prompt_tokens: number; total_tokens: number };
    };
    if (!data || !Array.isArray(data.embeddings)) {
      throw new Error(`DeepInfra response missing 'embeddings' array: ${JSON.stringify(data)}`);
    }

    for (let i = 0; i < data.embeddings.length; i++) {
      const vec = data.embeddings[i];
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Dimensionality mismatch: Expected embedding vector of dimension ${EMBEDDING_DIMENSION}, but received ${Array.isArray(vec) ? vec.length : typeof vec}.`
        );
      }
    }

    return data.embeddings;
  }

  // Cloudflare Workers AI
  const accountId = options.cloudflareAccountId || process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = options.cloudflareApiToken || process.env["CLOUDFLARE_API_TOKEN"];

  if (!accountId || accountId.trim() === "" || !apiToken || apiToken.trim() === "") {
    const missing = [];
    if (!accountId || accountId.trim() === "") missing.push("CLOUDFLARE_ACCOUNT_ID");
    if (!apiToken || apiToken.trim() === "") missing.push("CLOUDFLARE_API_TOKEN");
    throw new Error(
      `Missing credential(s) for Cloudflare Workers AI: ${missing.join(", ")} required when EMBEDDING_PROVIDER is 'cloudflare'.`
    );
  }

  const response = await fetch(`${CLOUDFLARE_API_BASE}/${accountId.trim()}/ai/run/${EMBEDDING_MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Cloudflare Workers AI API error [HTTP ${response.status}]: ${errorBody}`);
    throw new Error(
      `Workers AI embedding request failed: ${describeApiFailure(response.status, errorBody)}`
    );
  }

  const data = (await response.json()) as {
    result: { data: number[][] };
    success?: boolean;
    errors?: unknown[];
  };

  if (data.success === false) {
    throw new Error(
      `Cloudflare Workers AI returned success=false: ${JSON.stringify(data.errors || data)}`
    );
  }

  const vectors = data.result?.data;
  if (!Array.isArray(vectors)) {
    throw new Error(
      `Cloudflare Workers AI response missing 'result.data': ${JSON.stringify(data)}`
    );
  }

  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Dimensionality mismatch: Expected embedding vector of dimension ${EMBEDDING_DIMENSION}, but received ${Array.isArray(vec) ? vec.length : typeof vec}.`
      );
    }
  }

  return vectors;
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

  const ndjson = vectors
    .map((v) => {
      const cappedMetadata = v.metadata
        ? capVectorMetadataBytes(v.metadata as Record<string, unknown>)
        : v.metadata;
      return JSON.stringify({ ...v, metadata: cappedMetadata });
    })
    .join("\n");

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

// ---------------------------------------------------------------------------
// Cloudflare D1 - Document / Chunk Persistence (REST API)
// ---------------------------------------------------------------------------

export interface D1Statement {
  sql: string;
  params: Array<string | number | null>;
}

export interface D1DocumentRecord {
  id: string;
  title: string;
  category: string;
  manufacturer: string;
  applicableChassis: string;
  rawR2Path: string;
  model?: string;
  market?: string;
  metadata_json?: string;
}

/** Returns the D1 database ID from the environment, or undefined when D1 writes are disabled. */
export function getD1DatabaseId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["D1_DATABASE_ID"] || undefined;
}

/** Builds a D1 document record (provenance row) for a manual path. */
export interface CanonicalManualName {
  documentTitle: string;
  canonicalKey: string;
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

export function buildCanonicalManualName(
  meta?: UniversalMetadata | { manufacturer?: string; model?: string; market?: string; metadata?: Record<string, unknown>; metadata_json?: Record<string, unknown> | string } | null,
  fallbackFilename: string = "manual.pdf"
): CanonicalManualName {
  const dir = fallbackFilename.includes("/") ? fallbackFilename.slice(0, fallbackFilename.lastIndexOf("/")) : "";
  const baseName = fallbackFilename.split("/").pop() ?? fallbackFilename;

  if (!meta || !meta.manufacturer || meta.manufacturer === "unknown" || !meta.model || meta.model === "unknown") {
    const rawTitle = deriveManualTitle(baseName);
    return {
      documentTitle: rawTitle,
      canonicalKey: fallbackFilename,
    };
  }

  let parsedYearStart: number | undefined;
  let parsedYearEnd: number | undefined;
  let parsedChassisCode: string | undefined;

  const rawPouch = (meta as { metadata?: unknown }).metadata ?? (meta as { metadata_json?: unknown }).metadata_json;
  if (rawPouch) {
    try {
      const parsed = typeof rawPouch === "string" ? JSON.parse(rawPouch) : rawPouch;
      if (parsed) {
        if (parsed.year_start) parsedYearStart = Number(parsed.year_start);
        if (parsed.year_end) parsedYearEnd = Number(parsed.year_end);
        if (parsed.chassis_code) parsedChassisCode = String(parsed.chassis_code);
      }
    } catch {}
  }

  const yearStr = parsedYearStart
    ? parsedYearEnd && parsedYearEnd !== parsedYearStart
      ? `${parsedYearStart}-${parsedYearEnd}`
      : `${parsedYearStart}`
    : "";

  const mfg = formatDisplayName(meta.manufacturer);
  const mdl = formatDisplayName(meta.model);
  const mkt = (meta.market || "global").toUpperCase();
  const chassisCode = parsedChassisCode ? `, ${parsedChassisCode}` : "";

  const titleCore = `${mfg} ${mdl} (${mkt}${chassisCode})`;
  const documentTitle = yearStr ? `${yearStr} ${titleCore}` : titleCore;

  const slugParts: string[] = [];
  if (yearStr) slugParts.push(yearStr);
  slugParts.push(meta.manufacturer.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  slugParts.push(meta.model.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  slugParts.push((meta.market || "global").toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  if (parsedChassisCode) {
    slugParts.push(parsedChassisCode.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  }
  const cleanBase = `${slugParts.filter(Boolean).join("-")}.pdf`;
  const canonicalKey = dir ? `${dir}/${cleanBase}` : cleanBase;

  return {
    documentTitle,
    canonicalKey,
  };
}

export function buildDocumentRecord(
  id: string,
  title: string,
  classificationPath: string,
  rawR2Path: string,
  metadata?: UniversalMetadata
): D1DocumentRecord {
  const canonical = buildCanonicalManualName(metadata, rawR2Path);
  return {
    id,
    title: canonical.documentTitle || title,
    category: metadata?.category ?? classifyD1Category(classificationPath),
    manufacturer: metadata?.manufacturer ?? deriveManufacturer(classificationPath),
    applicableChassis: classifyChassis(classificationPath),
    rawR2Path,
    model: metadata?.model ?? "unknown",
    market: metadata?.market ?? "global",
    metadata_json: metadata?.metadata_json ?? "{}",
  };
}

/** Statements that remove a document and all of its chunks. */
export function buildD1DeleteStatements(documentId: string): D1Statement[] {
  return [
    { sql: "DELETE FROM document_chunks WHERE document_id = ?", params: [documentId] },
    { sql: "DELETE FROM schematic_images WHERE document_id = ?", params: [documentId] },
    { sql: "DELETE FROM documents WHERE id = ?", params: [documentId] },
  ];
}

/**
 * Statements that (re)write a document, its schematic images and its chunks. Existing chunks
 * and images for the document are removed first (chunks first, because they reference images)
 * so a re-ingest never leaves stale rows behind. `document_chunks.id` equals the Vectorize
 * vector ID, and each chunk links to the first schematic image on its page.
 */
export function buildD1UpsertStatements(
  doc: D1DocumentRecord,
  chunks: ManualChunk[],
  images: SchematicImage[] = []
): D1Statement[] {
  const model = doc.model ?? "unknown";
  const market = doc.market ?? "global";
  const metadataJson = doc.metadata_json ?? "{}";

  const statements: D1Statement[] = [
    { sql: "DELETE FROM document_chunks WHERE document_id = ?", params: [doc.id] },
    { sql: "DELETE FROM schematic_images WHERE document_id = ?", params: [doc.id] },
    {
      sql: `INSERT INTO documents (id, title, category, manufacturer, applicable_chassis, raw_r2_path, model, market, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET title = excluded.title, category = excluded.category,
  manufacturer = excluded.manufacturer, applicable_chassis = excluded.applicable_chassis,
  raw_r2_path = excluded.raw_r2_path, model = excluded.model, market = excluded.market,
  metadata_json = excluded.metadata_json`,
      params: [doc.id, doc.title, doc.category, doc.manufacturer, doc.applicableChassis, doc.rawR2Path, model, market, metadataJson],
    },
  ];

  const imageByPage = new Map<number, string>();
  for (const image of images) {
    if (!imageByPage.has(image.pageNumber)) imageByPage.set(image.pageNumber, image.id);
    statements.push({
      sql: `INSERT INTO schematic_images (id, document_id, page_number, caption, r2_key, mime_type, width, height)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET document_id = excluded.document_id, page_number = excluded.page_number,
  caption = excluded.caption, r2_key = excluded.r2_key, mime_type = excluded.mime_type,
  width = excluded.width, height = excluded.height`,
      params: [image.id, doc.id, image.pageNumber, image.caption, image.r2Key, image.mimeType, image.width, image.height],
    });
  }

  for (const chunk of chunks) {
    const wordCount = chunk.text.split(/\s+/).filter(Boolean).length;
    statements.push({
      sql: `INSERT INTO document_chunks (id, document_id, page_number, section_title, subsystem, chunk_text, word_count, token_count, schematic_image_id, category, manufacturer, model, market, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET document_id = excluded.document_id, page_number = excluded.page_number,
  section_title = excluded.section_title, subsystem = excluded.subsystem, chunk_text = excluded.chunk_text,
  word_count = excluded.word_count, token_count = excluded.token_count,
  schematic_image_id = excluded.schematic_image_id,
  category = excluded.category, manufacturer = excluded.manufacturer, model = excluded.model,
  market = excluded.market, metadata_json = excluded.metadata_json`,
      params: [
        chunk.id,
        doc.id,
        chunk.pageNumber,
        chunk.sectionTitle,
        chunk.metadata.subsystem,
        chunk.text,
        wordCount,
        Math.ceil(wordCount * TOKENS_PER_WORD),
        imageByPage.get(chunk.pageNumber) ?? null,
        doc.category,
        doc.manufacturer,
        model,
        market,
        metadataJson,
      ],
    });
  }

  return statements;
}

/** Executes statements against D1 via the REST API, in batches. */
export async function executeD1Statements(
  accountId: string,
  apiToken: string,
  databaseId: string,
  statements: D1Statement[]
): Promise<void> {
  for (const batch of batchArray(statements, D1_BATCH_SIZE)) {
    const response = await fetch(`${CLOUDFLARE_API_BASE}/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch }),
    });

    if (!response.ok) {
      throw new Error(`D1 query request failed: ${describeApiFailure(response.status, await response.text())}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Schematic Images (extract from PDF -> upload to R2)
// ---------------------------------------------------------------------------

/** Uploads an object to R2 under the given key. */
export type SchematicUploader = (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;

/** Default R2 bucket for schematic images (matches the manual bucket used by sync-r2-manuals). */
export function getSchematicBucketName(env: NodeJS.ProcessEnv = process.env): string {
  return env["R2_BUCKET_NAME"] || "campervan-mcp";
}

/** Uploader that writes to R2 through the Cloudflare REST API (no S3 credentials needed). */
export function createRestSchematicUploader(
  accountId: string,
  apiToken: string,
  bucket: string = getSchematicBucketName()
): SchematicUploader {
  return async (key, bytes, contentType) => {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${CLOUDFLARE_API_BASE}/${accountId}/r2/buckets/${bucket}/objects/${encodedKey}`, {
      method: "PUT",
      headers: { Authorization: "Bearer " + apiToken, "Content-Type": contentType },
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(`R2 upload failed for "${key}": ${describeApiFailure(response.status, await response.text())}`);
    }
  };
}

/**
 * Extracts schematic-sized images from every page of a PDF. Pages whose images cannot be
 * decoded are skipped with a warning so one bad page never fails the whole ingest.
 */
export async function extractSchematics(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  documentId: string,
  title: string,
  chunks: ManualChunk[]
): Promise<EncodedSchematic[]> {
  const sectionByPage = new Map<number, string | null>();
  for (const chunk of chunks) {
    if (!sectionByPage.has(chunk.pageNumber)) sectionByPage.set(chunk.pageNumber, chunk.sectionTitle);
  }

  const schematics: EncodedSchematic[] = [];
  for (let page = 1; page <= pdf.numPages; page++) {
    try {
      const raw = await extractImages(pdf, page);
      const candidates = raw.filter(isSchematicCandidate);
      if (candidates.length > 0) {
        // Page contains an embedded schematic/diagram: render the full composite page
        // so that vector paths, callout numbers (e.g. 49-88), lines, and legends are preserved
        const composite = await renderCompositeSchematic(
          pdf,
          documentId,
          title,
          page,
          sectionByPage.get(page)
        );
        schematics.push(composite);
      }
    } catch (err) {
      console.warn(`Skipping images on page ${page} of "${title}": ${err instanceof Error ? err.message : err}`);
    }
  }
  return schematics;
}

/** Uploads every encoded schematic PNG to R2. */
export async function uploadSchematics(schematics: EncodedSchematic[], upload: SchematicUploader): Promise<void> {
  for (const { image, bytes } of schematics) {
    await upload(image.r2Key, bytes, image.mimeType);
  }
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
  dryRun: boolean,
  d1DatabaseId?: string
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

  if (d1DatabaseId) {
    await executeD1Statements(accountId, apiToken, d1DatabaseId, buildD1DeleteStatements(sanitizeFilename(filePath)));
  }
}

export async function processAddedModifiedFile(
  filePath: string,
  accountId: string,
  apiToken: string,
  dryRun: boolean,
  d1DatabaseId?: string
): Promise<void> {
  const absolutePath = resolve(process.cwd(), filePath);
  const buffer = readFileSync(absolutePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: PDF_PARSE_VERBOSITY });
  const { text } = await extractText(pdf, { mergePages: false });

  const chunks = buildManualChunks(filePath, text);
  console.log(`Parsed "${filePath}" into ${chunks.length} chunks`);

  const documentId = sanitizeFilename(filePath);
  const title = deriveManualTitle(filePath);
  const schematics = d1DatabaseId ? await extractSchematics(pdf, documentId, title, chunks) : [];
  if (schematics.length > 0) {
    console.log(`Found ${schematics.length} schematic images in "${filePath}"`);
  }

  if (dryRun) {
    console.log(`[dry-run] Skipping embedding/upsert for "${filePath}"`);
    return;
  }

  for (const batch of batchArray(chunks, EMBEDDING_BATCH_SIZE)) {
    const embeddings = await generateEmbeddings(
      batch.map((chunk) => chunk.text),
      {
        cloudflareAccountId: accountId,
        cloudflareApiToken: apiToken,
      }
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

  const coverPageText = extractCoverPageText(text);
  const metadata = await extractDocumentMetadata(filePath, coverPageText);
  console.log(
    `Classified "${filePath}" -> category=${metadata.category}, manufacturer=${metadata.manufacturer}, model=${metadata.model}, market=${metadata.market}, metadata=${metadata.metadata_json}`
  );

  if (d1DatabaseId) {
    await uploadSchematics(schematics, createRestSchematicUploader(accountId, apiToken));
    const doc = buildDocumentRecord(documentId, title, filePath, filePath, metadata);
    await executeD1Statements(
      accountId,
      apiToken,
      d1DatabaseId,
      buildD1UpsertStatements(doc, chunks, schematics.map((s) => s.image))
    );
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

  const d1DatabaseId = getD1DatabaseId();
  if (!d1DatabaseId) {
    console.warn("D1_DATABASE_ID is not set; skipping D1 document/chunk writes (Vectorize only).");
  }

  for (const filePath of deleted) {
    await processDeletedFile(filePath, accountId, apiToken, dryRun, d1DatabaseId);
  }

  const total = addedModified.length;
  for (let i = 0; i < total; i++) {
    const filePath = addedModified[i]!;
    console.log(`Processing [${i + 1}/${total}]: "${filePath}"...`);
    await processAddedModifiedFile(filePath, accountId, apiToken, dryRun, d1DatabaseId);
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
