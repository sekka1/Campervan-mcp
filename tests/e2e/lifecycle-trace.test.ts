import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { hashApiKey } from "../../src/utils/metering";

describe("E2E Lifecycle Trace: Lean RAG-First Agent Workflow", () => {
  it("executes the full lifecycle: RAG search -> wire calculation -> metering deduction", async () => {
    const rawApiKey = "camper_live_test_key_abc123";
    const apiKeyHash = await hashApiKey(rawApiKey);
    const initialBalance = 100_000; // 100,000 microcents ($0.10)

    let currentBalance = initialBalance;

    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...params: unknown[]) => ({
          first: vi.fn(async () => {
            if (sql.includes("FROM accounts WHERE api_key_hash = ?")) {
              if (params[0] === apiKeyHash) {
                return { id: "acc_lifecycle_1", balance_microcents: currentBalance, is_active: 1 };
              }
              return null;
            }
            return null;
          }),
          all: vi.fn(async () => {
            if (sql.includes("FROM document_chunks c")) {
              return {
                results: [
                  {
                    id: "doc_transit_chunk_173",
                    document_id: "doc_transit_bemm",
                    document_title: "Ford Transit BEMM 2024",
                    category: "oem_bemm",
                    manufacturer: "Ford",
                    applicable_chassis: "transit",
                    page_number: 145,
                    section_title: "4.24.4 Customer Connection Points",
                    subsystem: "12v_dc",
                    chunk_text:
                      "CCP2 (Customer Connection Point 2) provides 175A continuous under the driver seat pedestal with M8 stud.",
                    schematic_r2_key: "schematics/doc_transit_bemm/p148-0.png",
                    schematic_caption: "CCP2 Connection Layout",
                  },
                ],
              };
            }
            return { results: [] };
          }),
        })),
      })),
      batch: vi.fn().mockImplementation(async (statements: unknown[]) => {
        return (statements as unknown[]).map(() => ({ meta: { changes: 1 } }));
      }),
    } as unknown as D1Database;

    const mockVectorize = {
      query: vi.fn().mockResolvedValue({
        matches: [
          {
            id: "doc_transit_chunk_173",
            score: 0.92,
            metadata: {
              source: "ford_transit_bemm",
              page: 145,
              section: "Customer Connection Points",
              text: "CCP2 175A connection layout",
            },
          },
        ],
      }),
    } as unknown as VectorizeIndex;

    const mockAi = {
      run: vi.fn().mockResolvedValue({
        data: [new Array(768).fill(0.01)],
      }),
    } as unknown as Ai;

    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const env = {
      DB: db,
      VECTOR_INDEX: mockVectorize,
      AI: mockAi,
      CDN_BASE_URL: "https://assets.campervan.dev",
      AUTH_ENABLED: "true",
      METERING_ALLOW_ALL: "false",
    };

    // -------------------------------------------------------------------------
    // Step 1: Agent calls `search_van_manuals` (Universal Semantic Retrieval)
    // -------------------------------------------------------------------------
    const step1Req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawApiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_van_manuals",
          arguments: {
            query: "How do I wire to 2024 Ford Transit CCP2 without tripping fuses?",
            chassis: "transit",
            subsystem: "12v_dc",
          },
        },
      }),
    });

    const step1Res = await worker.fetch(step1Req, env, ctx);
    expect(step1Res.status).toBe(200);
    const step1Data = await step1Res.json();
    const step1Content = JSON.parse(step1Data.result.content[0].text);
    expect(step1Content.results[0].manufacturer).toBe("Ford");
    expect(step1Content.results[0].text).toContain("CCP2 (Customer Connection Point 2)");
    expect(step1Content.results[0].schematic_url).toBe(
      "https://assets.campervan.dev/schematics/doc_transit_bemm/p148-0.png"
    );
    expect(step1Content.results[0].schematic_markdown).toBe(
      "[CCP2 Connection Layout](https://assets.campervan.dev/schematics/doc_transit_bemm/p148-0.png)"
    );

    // -------------------------------------------------------------------------
    // Step 2: Agent calls `calculate_dc_wire_and_fuse` (Universal Electrical Math)
    // -------------------------------------------------------------------------
    const step2Req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${rawApiKey}`,
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

    const step2Res = await worker.fetch(step2Req, env, ctx);
    expect(step2Res.status).toBe(200);
    const step2Data = await step2Res.json();
    const step2Content = JSON.parse(step2Data.result.content[0].text);
    expect(step2Content.recommended_awg).toBe("2");
    expect(step2Content.exact_voltage_drop_percent).toBeLessThanOrEqual(3);
    expect(step2Content.recommended_fuse_amps).toBe(80);
    expect(step2Content.fuse_type).toBe("MIDI / AMI Fuse");

    // -------------------------------------------------------------------------
    // Step 3: Verify Metering Deductions
    // -------------------------------------------------------------------------
    // Two atomic batches were executed across the two tool calls
    expect(db.batch).toHaveBeenCalledTimes(2);
  });
});
