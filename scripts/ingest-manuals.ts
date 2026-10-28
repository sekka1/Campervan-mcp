/**
 * Ingestion and Embedding Pipeline for Campervan Manuals
 * Supports dual embedding providers: DeepInfra (default) and Cloudflare Workers AI
 * Both providers emit 768-dimensional vectors using BAAI/bge-base-en-v1.5
 */

export type EmbeddingProvider = "deepinfra" | "cloudflare";

export interface EmbeddingOptions {
  provider?: EmbeddingProvider;
  deepinfraToken?: string;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  batchSize?: number;
}

export interface DeepInfraResponse {
  embeddings: number[][];
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface CloudflareResponse {
  result: {
    data: number[][];
    shape?: number[];
  };
  success: boolean;
  errors?: unknown[];
  messages?: unknown[];
}

export const EMBEDDING_DIMENSION = 768;
export const DEFAULT_BATCH_SIZE = 32;
export const DEEPINFRA_ENDPOINT = "https://api.deepinfra.com/v1/inference/BAAI/bge-base-en-v1.5";
export const CLOUDFLARE_MODEL = "@cf/baai/bge-base-en-v1.5";

/**
 * Validates credentials and returns normalized options
 */
function resolveConfig(options?: EmbeddingOptions): {
  provider: EmbeddingProvider;
  deepinfraToken?: string;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  batchSize: number;
} {
  const envProvider = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  const rawProvider = options?.provider || (envProvider ? (envProvider as EmbeddingProvider) : "deepinfra");

  if (rawProvider !== "deepinfra" && rawProvider !== "cloudflare") {
    throw new Error(
      `Unsupported embedding provider '${rawProvider}'. Allowed values are 'deepinfra' or 'cloudflare'.`
    );
  }

  const batchSize = options?.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;

  if (rawProvider === "deepinfra") {
    const token = options?.deepinfraToken || process.env.DEEPINFRA_TOKEN;
    if (!token || token.trim() === "") {
      throw new Error(
        "Missing credential for DeepInfra: DEEPINFRA_TOKEN is required when EMBEDDING_PROVIDER is 'deepinfra'."
      );
    }
    return {
      provider: "deepinfra",
      deepinfraToken: token.trim(),
      batchSize,
    };
  }

  // Cloudflare
  const accountId = options?.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = options?.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN;

  const missing: string[] = [];
  if (!accountId || accountId.trim() === "") missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!apiToken || apiToken.trim() === "") missing.push("CLOUDFLARE_API_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing credential(s) for Cloudflare Workers AI: ${missing.join(", ")} required when EMBEDDING_PROVIDER is 'cloudflare'.`
    );
  }

  return {
    provider: "cloudflare",
    cloudflareAccountId: accountId!.trim(),
    cloudflareApiToken: apiToken!.trim(),
    batchSize,
  };
}

/**
 * Splits array into chunks of specified maximum size
 */
function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Asserts all vectors conform to 768-dimensional geometry
 */
function assertVectorDimensions(vectors: number[][]): void {
  if (!Array.isArray(vectors)) {
    throw new Error(`Embedding response format invalid: expected an array of vectors.`);
  }

  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];
    if (!Array.isArray(vec)) {
      throw new Error(
        `Dimensionality mismatch at index ${i}: Expected embedding vector array of dimension ${EMBEDDING_DIMENSION}, but received ${typeof vec}.`
      );
    }
    if (vec.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Dimensionality mismatch at index ${i}: Expected embedding vector of dimension ${EMBEDDING_DIMENSION}, but received vector of length ${vec.length}.`
      );
    }
  }
}

/**
 * Generate 768-dimensional embeddings for a batch of text chunks
 * using either DeepInfra (default) or Cloudflare Workers AI.
 */
export async function generateEmbeddings(
  texts: string[],
  options?: EmbeddingOptions
): Promise<number[][]> {
  if (!texts || texts.length === 0) {
    return [];
  }

  const config = resolveConfig(options);
  const batches = chunkArray(texts, config.batchSize);
  const allEmbeddings: number[][] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];

    if (config.provider === "deepinfra") {
      const response = await fetch(DEEPINFRA_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.deepinfraToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: batch }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`DeepInfra API error [HTTP ${response.status}]: ${errorBody}`);
        throw new Error(
          `DeepInfra embedding request failed with HTTP ${response.status}: ${errorBody}`
        );
      }

      const data = (await response.json()) as DeepInfraResponse;
      if (!data || !Array.isArray(data.embeddings)) {
        throw new Error(`DeepInfra response missing 'embeddings' array: ${JSON.stringify(data)}`);
      }

      assertVectorDimensions(data.embeddings);
      allEmbeddings.push(...data.embeddings);
    } else {
      // Cloudflare Workers AI
      const url = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${CLOUDFLARE_MODEL}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.cloudflareApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: batch }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`Cloudflare Workers AI API error [HTTP ${response.status}]: ${errorBody}`);
        throw new Error(
          `Cloudflare Workers AI embedding request failed with HTTP ${response.status}: ${errorBody}`
        );
      }

      const data = (await response.json()) as CloudflareResponse;
      if (!data.success && data.success !== undefined) {
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

      assertVectorDimensions(vectors);
      allEmbeddings.push(...vectors);
    }
  }

  return allEmbeddings;
}
