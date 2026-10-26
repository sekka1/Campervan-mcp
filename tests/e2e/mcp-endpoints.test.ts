import { callMcpTool } from "../../scripts/promptfoo-mcp-provider.mjs";
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { hashApiKey } from "../../src/utils/metering";

describe("E2E: Lean Campervan MCP Server Endpoints", () => {
  const mockD1Database = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
    batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
  } as unknown as D1Database;

  const mockVectorize = {
    query: vi.fn().mockResolvedValue({ matches: [] }),
    upsert: vi.fn(),
    insert: vi.fn(),
    getByIds: vi.fn(),
    deleteByIds: vi.fn(),
    describe: vi.fn(),
  } as unknown as VectorizeIndex;

  const mockAi = {
    run: vi.fn().mockResolvedValue({
      data: [new Array(768).fill(0.01)],
    }),
  } as unknown as Ai;

  const env = {
    DB: mockD1Database,
    VECTOR_INDEX: mockVectorize,
    AI: mockAi,
    AUTH_ENABLED: "false",
    METERING_ALLOW_ALL: "true",
  };

  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  it("tools/list returns strictly the 3 lean tools", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    const data = await res.json();
    const tools = data.result.tools as Array<{ name: string; description: string }>;
    const toolNames = tools.map((t) => t.name);

    // Strictly expect only the lean tools
    expect(toolNames).toContain("calculate_dc_wire_and_fuse");
    expect(toolNames).toContain("search_van_manuals");
    expect(toolNames).toContain("inspect_manual_chunks");
    expect(toolNames).toHaveLength(3);

    // Verify deprecated hardcoded tools are NOT registered
    expect(toolNames).not.toContain("chassis_rules");
    expect(toolNames).not.toContain("calculate_van_payload");
    expect(toolNames).not.toContain("lookup_component_specs");
  });

  it("tools/call calculate_dc_wire_and_fuse returns ABYC E-11 compliant calculations", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "calculate_dc_wire_and_fuse",
          arguments: {
            system_voltage: 12,
            amperage: 60,
            one_way_distance_feet: 15,
            allowable_drop_percent: 3,
            is_engine_compartment: false,
          },
        },
      }),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    const data = await res.json();
    const content = JSON.parse(data.result.content[0].text);
    expect(content.recommended_awg).toBe("2");
    expect(content.round_trip_feet).toBe(30);
    expect(content.recommended_fuse_amps).toBe(80);
    expect(content.fuse_type).toBe("MIDI / AMI Fuse");
  });

  it("tools/call search_van_manuals queries semantic search and returns results", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "search_van_manuals",
          arguments: {
            query: "Ford Transit auxiliary battery tap",
          },
        },
      }),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    const data = await res.json();
    const content = JSON.parse(data.result.content[0].text);
    expect(content.query).toBe("Ford Transit auxiliary battery tap");
  });

  it("authenticates Bearer token when AUTH_ENABLED is true", async () => {
    const rawApiKey = "camper_test_key_xyz";
    const apiKeyHash = await hashApiKey(rawApiKey);

    const authDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn((keyHash: string) => ({
          first: vi.fn(async () => {
            if (keyHash === apiKeyHash) {
              return { id: "acc_auth_test", balance_microcents: 50_000, is_active: 1 };
            }
            return null;
          }),
        })),
      }),
      batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]),
    } as unknown as D1Database;

    const authEnv = {
      ...env,
      DB: authDb,
      AUTH_ENABLED: "true",
      METERING_ALLOW_ALL: "false",
    };

    // Unauthorized request
    const unauthReq = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const unauthRes = await worker.fetch(unauthReq, authEnv, ctx);
    expect(unauthRes.status).toBe(401);

    // Authorized request
    const authReq = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawApiKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const authRes = await worker.fetch(authReq, authEnv, ctx);
    expect(authRes.status).toBe(200);
  });
  it("callMcpTool from promptfoo-mcp-provider.mjs succeeds against real worker transport", async () => {
    const customFetch = async (url: string, init?: RequestInit) => {
      const req = new Request(url, init);
      return worker.fetch(req, env, ctx);
    };

    // Test calculate_dc_wire_and_fuse
    const wireContent = await callMcpTool(
      "http://localhost/",
      "calculate_dc_wire_and_fuse",
      { system_voltage: 12, one_way_distance_feet: 15, amperage: 60 },
      customFetch as unknown as typeof fetch
    );
    expect(wireContent).toHaveLength(1);
    expect(wireContent[0]?.type).toBe("text");
    const wireData = JSON.parse(wireContent[0]?.text);
    expect(wireData.recommended_awg).toBe("2");

    // Test search_van_manuals
    const manualContent = await callMcpTool(
      "http://localhost/",
      "search_van_manuals",
      { query: "Ford Transit auxiliary battery tap" },
      customFetch as unknown as typeof fetch
    );
    expect(manualContent).toHaveLength(1);
    expect(manualContent[0]?.type).toBe("text");
    const manualData = JSON.parse(manualContent[0]?.text);
    expect(manualData.query).toBe("Ford Transit auxiliary battery tap");
  });
});
