import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncManuals } from "../scripts/sync-r2-manuals.ts";
import { DEEPINFRA_ENDPOINT } from "../scripts/ingest-manuals.ts";

function createMockVector(dim: number = 768): number[] {
  return Array.from({ length: dim }, (_, i) => 0.01 * (i % 10));
}

describe("Sync R2 Manuals Pipeline E2E", () => {
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

  it("successfully syncs default chunks using DeepInfra provider", async () => {
    process.env.DEEPINFRA_TOKEN = "test-token";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        embeddings: [createMockVector(768), createMockVector(768)],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncManuals();

    expect(result.processedCount).toBe(2);
    expect(result.provider).toBe("deepinfra");
    expect(result.dimensions).toBe(768);
    expect(fetchMock).toHaveBeenCalledWith(DEEPINFRA_ENDPOINT, expect.anything());
  });

  it("successfully syncs custom manual chunks with Cloudflare provider toggle", async () => {
    process.env.EMBEDDING_PROVIDER = "cloudflare";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc-e2e";
    process.env.CLOUDFLARE_API_TOKEN = "tok-e2e";

    const customChunks = [
      {
        id: "chunk-custom-1",
        manualTitle: "Sprinter Aux Battery Guide",
        section: "EK1 Strip",
        content: "Connect D+ signal to relay trigger.",
      },
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          data: [createMockVector(768)],
        },
        success: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncManuals(customChunks);

    expect(result.processedCount).toBe(1);
    expect(result.provider).toBe("cloudflare");
    expect(result.dimensions).toBe(768);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acc-e2e/ai/run/@cf/baai/bge-base-en-v1.5",
      expect.anything()
    );
  });
});
