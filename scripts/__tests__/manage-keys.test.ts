import { describe, it, expect, vi } from "vitest";
import {
  generateRawApiKey,
  hashApiKey,
  buildCreateAccountStatement,
  buildFundAccountStatement,
  parseCliArgs,
  runManageKeys,
} from "../manage-keys";

describe("manage-keys helpers", () => {
  it("generates raw API keys with cv_live_ prefix and 48 hex characters", () => {
    const key = generateRawApiKey();
    expect(key.startsWith("cv_live_")).toBe(true);
    expect(key.length).toBe("cv_live_".length + 48);
  });

  it("hashes raw API key with SHA-256 to 64 lowercase hex digits", () => {
    const raw = "cv_live_0123456789abcdef0123456789abcdef0123456789abcdef";
    const hash = hashApiKey(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(raw));
  });

  it("builds SQL statement for account creation with custom balance", () => {
    const stmt = buildCreateAccountStatement("acc_custom", "hash123", 5000000);
    expect(stmt.sql).toContain("INSERT INTO accounts");
    expect(stmt.params).toEqual(["acc_custom", "hash123", 5000000]);
  });

  it("builds SQL statement for funding account", () => {
    const stmt = buildFundAccountStatement("acc_custom", 2500000);
    expect(stmt.sql).toContain("UPDATE accounts SET balance_microcents = balance_microcents + ?");
    expect(stmt.params).toEqual([2500000, "acc_custom"]);
  });

  it("parses CLI args correctly", () => {
    const parsed = parseCliArgs([
      "create",
      "--id",
      "test_acc",
      "--balance",
      "2000000",
      "--local",
      "--database-id",
      "db-123",
    ]);
    expect(parsed).toEqual({
      command: "create",
      id: "test_acc",
      balance: 2000000,
      local: true,
      databaseId: "db-123",
    });
  });

  it("throws on invalid CLI command", () => {
    expect(() => parseCliArgs(["invalid"])).toThrow("Invalid command");
  });

  it("executes create command via remote D1 mock when env vars are set", async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true, result: [] }),
    });
    global.fetch = mockFetch;
    process.env.CLOUDFLARE_ACCOUNT_ID = "cf_acc_1";
    process.env.CLOUDFLARE_API_TOKEN = "cf_token_1";

    const res = await runManageKeys({
      command: "create",
      id: "acc_unit",
      balance: 1000000,
    });

    expect(res.rawKey).toBeDefined();
    expect(res.rawKey?.startsWith("cv_live_")).toBe(true);
    expect(res.message).toContain("acc_unit");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    global.fetch = originalFetch;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });
});
