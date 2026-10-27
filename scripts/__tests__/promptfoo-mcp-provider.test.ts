import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import CampervanPromptfooProvider, { callMcpTool } from "../promptfoo-mcp-provider.mjs";

describe("Promptfoo MCP Provider (2-Turn Tool Loop & Transport Compatibility)", () => {
  it("enforces HTTP 406 when Accept header lacks application/json or text/event-stream", async () => {
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      const accept = headers["Accept"] || headers["accept"] || "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        return new Response("Not Acceptable: must accept both application/json and text/event-stream", {
          status: 406,
          statusText: "Not Acceptable",
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "success" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    // Direct test with bad headers via mockFetch
    await expect(
      mockFetch("http://mock-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      })
    ).rejects.toThrow("HTTP 406");

    // callMcpTool sends correct Accept header and succeeds
    const content = await callMcpTool("http://mock-mcp", "search_van_manuals", { query: "CCP2" }, mockFetch);
    expect(content).toEqual([{ type: "text", text: "success" }]);
  });

  it("handles standard application/json response in 2-turn callApi flow", async () => {
    process.env["DEEPINFRA_TOKEN"] = "test-token";

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/chat/completions")) {
        const body = JSON.parse(init?.body as string);
        const isTurn1 = !body.messages.some((m: { role: string }) => m.role === "tool");

        if (isTurn1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_123",
                        type: "function",
                        function: {
                          name: "calculate_dc_wire_and_fuse",
                          arguments: JSON.stringify({ voltage: 12, distance_feet: 10, amps: 167 }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          // Turn 2
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Recommended 2/0 AWG copper wire and a 250A fuse for 12V 2000W inverter.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      // MCP Server URL
      const headers = (init?.headers || {}) as Record<string, string>;
      const accept = headers["Accept"] || headers["accept"] || "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        return new Response("Not Acceptable", { status: 406 });
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ recommended_awg: "2/0", recommended_fuse_amps: 250, voltage_drop_percent: 2.17 }),
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new CampervanPromptfooProvider({
      config: { model: "deepseek-ai/DeepSeek-V4-Flash-0731" },
      fetchFn: mockFetch,
    });

    const res = await provider.callApi("Calculate wire for 12V 2000W", {});
    expect(res.error).toBeUndefined();
    expect(res.output).toBeDefined();

    // Verify output contains BOTH MCP Tool Result trace AND synthesized response
    expect(res.output).toContain("MCP Tool Result (calculate_dc_wire_and_fuse):");
    expect(res.output).toContain("recommended_awg");
    expect(res.output).toContain("Recommended 2/0 AWG copper wire and a 250A fuse");
  });

  it("handles text/event-stream (SSE) data stream response in 2-turn callApi flow", async () => {
    process.env["DEEPINFRA_TOKEN"] = "test-token";

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/chat/completions")) {
        const body = JSON.parse(init?.body as string);
        const isTurn1 = !body.messages.some((m: { role: string }) => m.role === "tool");

        if (isTurn1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_456",
                        type: "function",
                        function: {
                          name: "search_van_manuals",
                          arguments: JSON.stringify({ query: "Ford Transit CCP1 CCP2" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "CCP1 (60A) and CCP2 (175A) are located on the driver seat pedestal.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      // MCP Server responding with SSE text/event-stream
      const headers = (init?.headers || {}) as Record<string, string>;
      const accept = headers["Accept"] || headers["accept"] || "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        return new Response("Not Acceptable", { status: 406 });
      }

      const ssePayload = [
        ": keepalive",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ results: [{ chunk_id: "doc_1#chunk_10", text: "CCP1 60A and CCP2 175A on seat base" }] }),
              },
            ],
          },
        })}`,
        "",
      ].join("\n");

      return new Response(ssePayload, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const provider = new CampervanPromptfooProvider({
      config: { model: "deepseek-ai/DeepSeek-V4-Flash-0731" },
      fetchFn: mockFetch,
    });

    const res = await provider.callApi("Where is CCP1 and CCP2?", {});
    expect(res.error).toBeUndefined();
    expect(res.output).toContain("MCP Tool Result (search_van_manuals):");
    expect(res.output).toContain("doc_1#chunk_10");
    expect(res.output).toContain("CCP1 (60A) and CCP2 (175A) are located on the driver seat pedestal.");
  });
  it("validates promptfooconfig.yaml includes tightened assertions and anti-hallucination checks", () => {
    const yaml = readFileSync("promptfooconfig.yaml", "utf8");
    // Test 1: Sizing calculation anti-hallucination checks
    expect(yaml).toContain("upsizing to 4 AWG");
    expect(yaml).toContain("2 AWG");
    expect(yaml).toContain("200A");
    expect(yaml).toContain("15-20 ft-lbs");

    // Test 2: Roof cut-out & torque anti-hallucination checks
    expect(yaml).toContain("35 in-lbs");
    expect(yaml).toContain("14\"");

    // Test 3: CCP location & rating assertions
    expect(yaml).toContain("60A");
    expect(yaml).toContain("175A");
    expect(yaml).toContain("seat pedestal");

    // Test 4: Chassis grounding & BMS rules assertions
    expect(yaml).toContain("BMS");
    expect(yaml).toContain("Battery Monitoring");
  });
});