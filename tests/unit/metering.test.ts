import { describe, it, expect, vi } from "vitest";
import {
  extractBearerToken,
  hashApiKey,
  getToolCostMicrocents,
  extractMeteredToolCalls,
  authenticateAndCheckBalance,
  recordToolUsage,
  SEARCH_TOOL_COST_MICROCENTS,
  DETERMINISTIC_TOOL_COST_MICROCENTS,
} from "../../src/utils/metering";

describe("extractBearerToken", () => {
  it("extracts token from valid Bearer header", () => {
    expect(extractBearerToken("Bearer sk_live_12345")).toBe("sk_live_12345");
    expect(extractBearerToken("  bearer   my-token-abc  ")).toBe("my-token-abc");
  });

  it("returns null for missing or malformed headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer token with spaces")).toBeNull();
  });
});

describe("hashApiKey", () => {
  it("computes deterministic 64-character lowercase SHA-256 hex digest", async () => {
    const hash1 = await hashApiKey("campervan-secret-key-1");
    const hash2 = await hashApiKey("campervan-secret-key-1");
    const hash3 = await hashApiKey("campervan-secret-key-2");

    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });
});

describe("getToolCostMicrocents & extractMeteredToolCalls", () => {
  it("returns 2000 microcents for search/DB tools and 500 for deterministic tools", () => {
    expect(getToolCostMicrocents("search_van_manuals")).toBe(SEARCH_TOOL_COST_MICROCENTS);
    expect(getToolCostMicrocents("lookup_component_specs")).toBe(SEARCH_TOOL_COST_MICROCENTS);
    expect(getToolCostMicrocents("calculate_wire_gauge")).toBe(DETERMINISTIC_TOOL_COST_MICROCENTS);
    expect(getToolCostMicrocents("calculate_dc_wire_and_fuse")).toBe(DETERMINISTIC_TOOL_COST_MICROCENTS);
    expect(getToolCostMicrocents("chassis_rules")).toBe(DETERMINISTIC_TOOL_COST_MICROCENTS);
    expect(getToolCostMicrocents("unknown_tool")).toBeNull();
  });

  it("extracts metered tool calls from single and batch JSON-RPC payloads", () => {
    const single = extractMeteredToolCalls({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "chassis_rules", arguments: {} },
    });
    expect(single).toEqual([{ id: 1, name: "chassis_rules", costMicrocents: 500 }]);

    const batch = extractMeteredToolCalls([
      { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "search_van_manuals" } },
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "nonexistent" } },
      null,
    ]);
    expect(batch).toEqual([{ id: 11, name: "search_van_manuals", costMicrocents: 2000 }]);
  });
});

describe("authenticateAndCheckBalance", () => {
  function makeMockDb(accountRow: unknown) {
    const first = vi.fn().mockResolvedValue(accountRow);
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    return { db: { prepare } as unknown as D1Database, prepare, bind };
  }

  it("returns 401 when API key hash is not found or inactive", async () => {
    const { db, bind } = makeMockDb(null);
    const expectedHash = await hashApiKey("bad-key");
    const res = await authenticateAndCheckBalance(db, "bad-key", 500);
    expect(bind).toHaveBeenCalledWith(expectedHash);
    expect(res).toEqual({ ok: false, status: 401, error: "Invalid or inactive API key" });
  });

  it("returns 402 when account balance is below required microcents", async () => {
    const { db } = makeMockDb({ id: "acc_1", balance_microcents: 400, is_active: 1 });
    const res = await authenticateAndCheckBalance(db, "valid-key", 500);
    expect(res).toEqual({ ok: false, status: 402, error: "Insufficient account balance" });
  });

  it("returns ok with account record when balance is sufficient", async () => {
    const { db } = makeMockDb({ id: "acc_1", balance_microcents: 10000, is_active: 1 });
    const res = await authenticateAndCheckBalance(db, "valid-key", 2000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.account.id).toBe("acc_1");
      expect(res.account.balance_microcents).toBe(10000);
    }
  });
});

describe("recordToolUsage", () => {
  it("executes atomic UPDATE and INSERT batch and returns true when balance was deducted", async () => {
    const bind = vi.fn().mockReturnThis();
    const prepare = vi.fn().mockReturnValue({ bind });
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
    const db = { prepare, batch } as unknown as D1Database;

    const ok = await recordToolUsage(db, "acc_1", "chassis_rules", 500, 12.4);
    expect(ok).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenNthCalledWith(1, 500, "acc_1", 500);
    expect(bind).toHaveBeenNthCalledWith(2, "acc_1", "chassis_rules", 500, 12);
  });

  it("returns false when conditional UPDATE affected 0 rows (concurrent balance exhaustion)", async () => {
    const bind = vi.fn().mockReturnThis();
    const prepare = vi.fn().mockReturnValue({ bind });
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 0 } }]);
    const db = { prepare, batch } as unknown as D1Database;

    const ok = await recordToolUsage(db, "acc_1", "search_van_manuals", 2000, 5);
    expect(ok).toBe(false);
  });
});
