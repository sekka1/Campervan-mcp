import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateEmbeddings,
  EMBEDDING_DIMENSION,
  DEEPINFRA_ENDPOINT,
  CLOUDFLARE_MODEL,
} from "../scripts/ingest-manuals.ts";

// Helper to create a mock vector of specified dimension
function createMockVector(dim: number = EMBEDDING_DIMENSION, seed: number = 0.1): number[] {
  return Array.from({ length: dim }, (_, i) => Number((seed + i * 0.001).toFixed(4)));
}

describe("Embedding Provider Switch (DeepInfra / Cloudflare)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.DEEPINFRA_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("1. Default Provider Selection", () => {
    it("defaults to DeepInfra when EMBEDDING_PROVIDER is unset", async () => {
      process.env.DEEPINFRA_TOKEN = "test-deepinfra-token";

      const mockVectors = [createMockVector(768)];
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: mockVectors,
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await generateEmbeddings(["test chunk"]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        DEEPINFRA_ENDPOINT,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-deepinfra-token",
            "Content-Type": "application/json",
          }),
        })
      );
      expect(result).toEqual(mockVectors);
    });

    it("defaults to DeepInfra when EMBEDDING_PROVIDER is an empty string", async () => {
      process.env.EMBEDDING_PROVIDER = "   ";
      process.env.DEEPINFRA_TOKEN = "token-abc";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [createMockVector(768)] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await generateEmbeddings(["sample text"]);
      expect(fetchMock).toHaveBeenCalledWith(DEEPINFRA_ENDPOINT, expect.anything());
    });
  });

  describe("2. DeepInfra Request Formatting", () => {
    it("formats POST request with Authorization header and inputs payload", async () => {
      const token = "di-secret-token-12345";
      const inputs = ["chunk one", "chunk two"];
      const mockEmbeddings = [createMockVector(768, 0.1), createMockVector(768, 0.2)];

      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          json: async () => ({
            embeddings: mockEmbeddings,
            usage: { prompt_tokens: 24, total_tokens: 24 },
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      const vectors = await generateEmbeddings(inputs, {
        provider: "deepinfra",
        deepinfraToken: token,
      });

      expect(capturedUrl).toBe(DEEPINFRA_ENDPOINT);
      expect(capturedInit?.method).toBe("POST");

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${token}`);
      expect(headers["Content-Type"]).toBe("application/json");

      const parsedBody = JSON.parse(capturedInit?.body as string);
      expect(parsedBody).toEqual({ inputs });
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(768);
      expect(vectors[1]).toHaveLength(768);
    });
  });

  describe("3. Cloudflare Request Formatting", () => {
    it("targets Cloudflare client API with account ID, Authorization, and text payload", async () => {
      const accountId = "cf-acc-98765";
      const apiToken = "cf-token-abcxyz";
      const texts = ["fresh water valve operation"];
      const mockVector = createMockVector(768, 0.5);

      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          json: async () => ({
            result: {
              data: [mockVector],
            },
            success: true,
            errors: [],
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      const vectors = await generateEmbeddings(texts, {
        provider: "cloudflare",
        cloudflareAccountId: accountId,
        cloudflareApiToken: apiToken,
      });

      const expectedUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_MODEL}`;
      expect(capturedUrl).toBe(expectedUrl);
      expect(capturedInit?.method).toBe("POST");

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${apiToken}`);
      expect(headers["Content-Type"]).toBe("application/json");

      const parsedBody = JSON.parse(capturedInit?.body as string);
      expect(parsedBody).toEqual({ text: texts });
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toEqual(mockVector);
      expect(vectors[0]).toHaveLength(768);
    });

    it("respects process.env when provider is cloudflare", async () => {
      process.env.EMBEDDING_PROVIDER = "cloudflare";
      process.env.CLOUDFLARE_ACCOUNT_ID = "env-acc";
      process.env.CLOUDFLARE_API_TOKEN = "env-tok";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: { data: [createMockVector(768)] },
          success: true,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await generateEmbeddings(["test"]);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/env-acc/ai/run/@cf/baai/bge-base-en-v1.5",
        expect.anything()
      );
    });
  });

  describe("4. Missing Credential & Provider Errors", () => {
    it("throws informative error when DEEPINFRA_TOKEN is missing", async () => {
      await expect(
        generateEmbeddings(["text"], { provider: "deepinfra" })
      ).rejects.toThrowError(
        /Missing credential for DeepInfra: DEEPINFRA_TOKEN is required/
      );
    });

    it("throws informative error listing missing Cloudflare credentials", async () => {
      // Both missing
      await expect(
        generateEmbeddings(["text"], { provider: "cloudflare" })
      ).rejects.toThrowError(
        /Missing credential\(s\) for Cloudflare Workers AI: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN/
      );

      // Only API token missing
      await expect(
        generateEmbeddings(["text"], {
          provider: "cloudflare",
          cloudflareAccountId: "acc123",
        })
      ).rejects.toThrowError(
        /Missing credential\(s\) for Cloudflare Workers AI: CLOUDFLARE_API_TOKEN/
      );

      // Only Account ID missing
      await expect(
        generateEmbeddings(["text"], {
          provider: "cloudflare",
          cloudflareApiToken: "tok123",
        })
      ).rejects.toThrowError(
        /Missing credential\(s\) for Cloudflare Workers AI: CLOUDFLARE_ACCOUNT_ID/
      );
    });

    it("throws error for unsupported provider value", async () => {
      // @ts-expect-error Testing invalid runtime value
      await expect(generateEmbeddings(["text"], { provider: "openai" })).rejects.toThrowError(
        /Unsupported embedding provider 'openai'/
      );
    });
  });

  describe("5. Dimensionality Guard", () => {
    it("throws error if DeepInfra returns vectors with dimension != 768", async () => {
      const mock384Vector = createMockVector(384);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            embeddings: [mock384Vector],
          }),
        })
      );

      await expect(
        generateEmbeddings(["dimension check"], {
          provider: "deepinfra",
          deepinfraToken: "fake-tok",
        })
      ).rejects.toThrowError(/Dimensionality mismatch at index 0: Expected embedding vector of dimension 768, but received vector of length 384/);
    });

    it("throws error if Cloudflare returns vectors with dimension != 768", async () => {
      const mock1024Vector = createMockVector(1024);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            result: { data: [mock1024Vector] },
            success: true,
          }),
        })
      );

      await expect(
        generateEmbeddings(["dimension check"], {
          provider: "cloudflare",
          cloudflareAccountId: "acc",
          cloudflareApiToken: "tok",
        })
      ).rejects.toThrowError(/Dimensionality mismatch at index 0: Expected embedding vector of dimension 768, but received vector of length 1024/);
    });
  });

  describe("6. Batching & Edge Cases", () => {
    it("returns empty array immediately if texts array is empty", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await generateEmbeddings([]);
      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("splits texts into batches and aggregates embeddings correctly", async () => {
      const texts = Array.from({ length: 5 }, (_, i) => `item ${i}`);
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const count = body.inputs.length;
        return {
          ok: true,
          json: async () => ({
            embeddings: Array.from({ length: count }, () => createMockVector(768)),
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await generateEmbeddings(texts, {
        provider: "deepinfra",
        deepinfraToken: "token",
        batchSize: 2, // 5 items in chunks of 2 -> 2, 2, 1
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(5);
    });

    it("handles DeepInfra HTTP failures with status code and body in error message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          text: async () => "Rate limit exceeded. Try again in 30s.",
        })
      );

      await expect(
        generateEmbeddings(["text"], {
          provider: "deepinfra",
          deepinfraToken: "token",
        })
      ).rejects.toThrowError(
        /DeepInfra embedding request failed with HTTP 429: Rate limit exceeded/
      );
    });

    it("handles Cloudflare success=false with error details", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            result: null,
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
        })
      );

      await expect(
        generateEmbeddings(["text"], {
          provider: "cloudflare",
          cloudflareAccountId: "acc",
          cloudflareApiToken: "tok",
        })
      ).rejects.toThrowError(
        /Cloudflare Workers AI returned success=false/
      );
    });
  });
});
