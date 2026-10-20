import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildKnownCandidateIds,
  deleteR2Manifest,
  fetchChunkIdsFromD1,
  runPurge,
  KNOWN_DOCUMENT_PREFIXES,
} from "../purge-manuals";
import { S3Client } from "@aws-sdk/client-s3";

vi.mock("@aws-sdk/client-s3", () => {
  const sendMock = vi.fn();
  return {
    S3Client: vi.fn(() => ({ send: sendMock })),
    DeleteObjectCommand: vi.fn((input) => ({ input, _type: "DeleteObjectCommand" })),
    sendMock,
  };
});

describe("purge-manuals", () => {
  const originalFetch = global.fetch;
  const originalAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const originalApiToken = process.env["CLOUDFLARE_API_TOKEN"];
  const originalD1DatabaseId = process.env["D1_DATABASE_ID"];
  const originalR2AccessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const originalR2SecretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];

  beforeEach(() => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "test-account";
    process.env["CLOUDFLARE_API_TOKEN"] = "test-token";
    process.env["D1_DATABASE_ID"] = "test-db";
    delete process.env["R2_ACCESS_KEY_ID"];
    delete process.env["R2_SECRET_ACCESS_KEY"];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env["CLOUDFLARE_ACCOUNT_ID"] = originalAccountId;
    process.env["CLOUDFLARE_API_TOKEN"] = originalApiToken;
    process.env["D1_DATABASE_ID"] = originalD1DatabaseId;
    process.env["R2_ACCESS_KEY_ID"] = originalR2AccessKeyId;
    process.env["R2_SECRET_ACCESS_KEY"] = originalR2SecretAccessKey;
    vi.clearAllMocks();
  });

  describe("buildKnownCandidateIds", () => {
    it("generates deterministic chunk IDs for each prefix up to maxChunks", () => {
      const ids = buildKnownCandidateIds(["test_prefix"], 3);
      expect(ids).toEqual([
        "test_prefix#chunk_0",
        "test_prefix#chunk_1",
        "test_prefix#chunk_2",
      ]);
    });

    it("includes standard known prefixes by default", () => {
      const ids = buildKnownCandidateIds(undefined, 2);
      expect(ids.some((id) => id.startsWith("MY24_Transit_BEMM"))).toBe(true);
      expect(ids.length).toBe(KNOWN_DOCUMENT_PREFIXES.length * 2);
    });
  });

  describe("fetchChunkIdsFromD1", () => {
    it("returns array of IDs on successful query", async () => {
      global.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            result: [{ results: [{ id: "chunk_1" }, { id: "chunk_2" }] }],
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch;

      const ids = await fetchChunkIdsFromD1("acc1", "tok1", "db1");
      expect(ids).toEqual(["chunk_1", "chunk_2"]);
    });

    it("returns empty array when query fails", async () => {
      global.fetch = vi.fn(async () => new Response("Database error", { status: 500 })) as unknown as typeof fetch;
      const ids = await fetchChunkIdsFromD1("acc1", "tok1", "db1");
      expect(ids).toEqual([]);
    });
  });

  describe("deleteR2Manifest", () => {
    it("sends DeleteObjectCommand to R2 client", async () => {
      const client = new S3Client({});
      const result = await deleteR2Manifest(client, "test-bucket");
      expect(result).toBe(true);
      expect(client.send).toHaveBeenCalled();
    });
  });

  describe("runPurge", () => {
    it("throws if Cloudflare credentials are missing", async () => {
      delete process.env["CLOUDFLARE_ACCOUNT_ID"];
      delete process.env["CLOUDFLARE_API_TOKEN"];

      await expect(runPurge()).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
    });

    it("skips API deletion calls in dry-run mode", async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn(async (url: string | URL) => {
        calledUrls.push(url.toString());
        return new Response("{}", { status: 200 });
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const res = await runPurge({ dryRun: true });
      expect(res.vectorCountDeleted).toBe(0);
      expect(res.d1Cleaned).toBe(false);
      expect(calledUrls.some((u) => u.includes("delete_by_ids"))).toBe(false);
    });

    it("calls delete_by_ids and cleans D1 tables in live mode", async () => {
      const calledUrls: string[] = [];
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        calledUrls.push(url.toString());
        if (url.toString().includes("/d1/database/")) {
          const body = JSON.parse(init?.body as string);
          if (body.sql?.includes("SELECT id")) {
            return new Response(JSON.stringify({ result: [{ results: [{ id: "existing_chunk_1" }] }] }), { status: 200 });
          }
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const res = await runPurge({ dryRun: false });
      expect(res.d1Cleaned).toBe(true);
      expect(calledUrls.some((u) => u.includes("delete_by_ids"))).toBe(true);
      expect(calledUrls.some((u) => u.includes("/d1/database/"))).toBe(true);
    });
  });
});
