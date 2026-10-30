import { describe, it, expect } from "vitest";
import { searchVanManuals, SearchVanManualsResponse } from "../../src/tools/manuals.ts";
import { MCP_TOOLS, handleMcpRequest } from "../../src/index.ts";

describe("Dynamic Retrieval Grounding Contract & Manuals MCP Tools", () => {
  describe("1. Empty Retrieval / Missing Manuals Behavior", () => {
    it("returns matches_found: false and explicit advice when no chunks match", async () => {
      const response: SearchVanManualsResponse = await searchVanManuals(
        "Unknown obscure Chinese diesel heater model XYZ999 torque specs"
      );

      expect(response).toBeDefined();
      expect(response.results).toHaveLength(0);
      expect(response.retrieval_metadata).toBeDefined();
      expect(response.retrieval_metadata.matches_found).toBe(false);
      expect(response.retrieval_metadata.count).toBe(0);

      // Verify explicit advice forbidding guessing and requiring vehicle-side OEM constraints only
      expect(response.retrieval_metadata.advice).toContain(
        "Consult the manufacturer's manual for torque and cut-out specifications"
      );
      expect(response.retrieval_metadata.advice).toContain(
        "no official torque value is provided in vehicle documentation"
      );
      expect(response.retrieval_metadata.advice).toContain(
        "provide ONLY vehicle-side OEM constraints"
      );

      // Verify retrieval contract rules
      const { retrieval_contract } = response.retrieval_metadata;
      expect(retrieval_contract.strict_grounding_rule).toBe(
        "Only provide specifications, dimensions, or torque values if explicitly contained in the retrieved manual chunks below."
      );
      expect(retrieval_contract.missing_manual_rule).toContain(
        "CRITICAL NEGATIVE CONSTRAINT"
      );
      expect(retrieval_contract.missing_manual_rule).toContain(
        "Provide ONLY vehicle-side OEM chassis constraints (e.g., roof bow clearance, sealant requirements)."
      );
      expect(retrieval_contract.missing_manual_rule).toContain(
        "DO NOT attempt to provide 'widely published', 'typical', or general specifications"
      );
      expect(retrieval_contract.missing_manual_rule).toContain(
        "Consult the manufacturer's manual for torque and cut-out specifications, as no official torque value is provided in vehicle documentation."
      );
    });
  });

  describe("2. Mocked Vector / D1 Hydration Behavior", () => {
    it("returns matches_found: true with hydrated chunks and strict grounding rule", async () => {
      const mockEnv = {
        AI: {
          run: async () => ({ data: [Array.from({ length: 768 }, () => 0.05)] })
        },
        VECTORIZE: {
          query: async () => ({
            matches: [{ id: "ford_bemm_p148_c1", score: 0.92 }]
          })
        },
        DB: {
          prepare: () => ({
            bind: () => ({
              all: async () => ({
                results: [
                  {
                    id: "ford_bemm_p148_c1",
                    document_id: "ford_transit_bemm_2024",
                    title: "Ford Transit Body and Equipment Mounting Manual",
                    manufacturer: "Ford Motor Company",
                    page_number: 148,
                    subsystem: "12v_dc",
                    chunk_text:
                      "CCP2 is protected by a 175A midi fuse located in the pre-fuse box under the driver seat. Fasten lugs with M8 flanged nut torqued to 12-15 Nm.",
                    r2_key: "schematics/transit/ccp2_diagram.png",
                    caption: "CCP2 Driver Seat Pedestal Terminal"
                  }
                ]
              })
            })
          })
        },
        CDN_BASE_URL: "https://assets.campervan-mcp.com"
      };

      const response = await searchVanManuals(
        "Ford Transit CCP2 connection torque",
        mockEnv,
        { chassis: "ford_transit" }
      );

      expect(response.retrieval_metadata.matches_found).toBe(true);
      expect(response.retrieval_metadata.count).toBe(1);
      expect(response.results).toHaveLength(1);

      const chunk = response.results[0];
      expect(chunk.title).toContain("Ford Transit");
      expect(chunk.chunk_text).toContain("12-15 Nm");
      expect(chunk.schematic_image_url).toBe(
        "https://assets.campervan-mcp.com/schematics/transit/ccp2_diagram.png"
      );

      // Verify contract remains attached
      expect(response.retrieval_metadata.retrieval_contract.strict_grounding_rule).toContain(
        "Only provide specifications, dimensions, or torque values if explicitly contained"
      );
    });
  });

  describe("3. Directive MCP Tool Descriptions Registration", () => {
    it("registers calculate_dc_wire_and_fuse with directive safety prompt for LLMs", () => {
      const calcTool = MCP_TOOLS.find((t) => t.name === "calculate_dc_wire_and_fuse");
      expect(calcTool).toBeDefined();

      const desc = calcTool!.description;
      expect(desc).toContain("AWG is an inverse scale: 1/0 and 2/0 are larger than 2 AWG; 4 AWG is smaller.");
      expect(desc).toContain("Overcurrent protection (fuse) must ALWAYS be placed within 7 inches of the battery (power source), NEVER at the inverter or load.");
      expect(desc).toContain("Always include the returned 'safety_invariants' in user-facing answers.");
    });

    it("registers search_van_manuals with directive grounding prompt for LLMs", () => {
      const manualTool = MCP_TOOLS.find((t) => t.name === "search_van_manuals");
      expect(manualTool).toBeDefined();

      const desc = manualTool!.description;
      expect(desc).toContain("Adhere strictly to the returned 'retrieval_contract'.");
      expect(desc).toContain("CRITICAL NEGATIVE CONSTRAINT");
      expect(desc).toContain("Provide ONLY vehicle-side OEM chassis constraints");
      expect(desc).toContain("Consult the manufacturer's manual for torque and cut-out specifications");
    });
  });

  describe("4. MCP Protocol JSON-RPC Handler Execution", () => {
    it("handles tools/list method returning registered tools", async () => {
      const req = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
      const res = await handleMcpRequest(req);

      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(1);
      expect(res.result?.tools).toHaveLength(2);
      const tools = (res.result?.tools as Array<{ name: string }>) || [];
      expect(tools.map((t) => t.name)).toContain("calculate_dc_wire_and_fuse");
      expect(tools.map((t) => t.name)).toContain("search_van_manuals");
    });

    it("handles tools/call for calculate_dc_wire_and_fuse and includes safety_invariants in payload", async () => {
      const req = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "calculate_dc_wire_and_fuse",
          arguments: {
            system_voltage: 12,
            amperage: 80,
            one_way_distance_feet: 10,
            allowable_drop_percent: 3
          }
        }
      };

      const res = await handleMcpRequest(req);
      expect(res.jsonrpc).toBe("2.0");
      expect(res.result.content[0].text).toContain("safety_invariants");

      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.safety_invariants.fuse_placement).toContain("within 7 inches");
      expect(parsed.safety_invariants.prohibited_practices[0]).toContain("inverter terminal");
      expect(parsed.safety_invariants.prohibited_practices[1]).toContain("AWG is an inverse gauge");
      expect(parsed.safety_invariants.prohibited_practices[2]).toContain("15–20 ft-lbs");
    });

    it("handles tools/call for search_van_manuals with dynamic retrieval contract", async () => {
      const req = {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "search_van_manuals",
          arguments: {
            query: "Dometic RTX 2000 12V air conditioner wire gauge"
          }
        }
      };

      const res = await handleMcpRequest(req);
      expect(res.jsonrpc).toBe("2.0");
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.retrieval_metadata.retrieval_contract).toBeDefined();
      expect(parsed.retrieval_metadata.retrieval_contract.strict_grounding_rule).toBeDefined();
    });

    it("coerces hallucinated subsystem aliases like 'climate' without throwing -32602 schema error", async () => {
      const req = {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "search_van_manuals",
          arguments: {
            query: "Roof ventilation fan wiring diagram",
            subsystem: "climate" // Qwen/model semantic drift term
          }
        }
      };

      const res = await handleMcpRequest(req);
      expect(res.jsonrpc).toBe("2.0");
      expect(res.error).toBeUndefined();
      expect(res.result).toBeDefined();
      expect(res.result.content).toBeDefined();
      expect(res.result.content[0].text).toContain("retrieval_metadata");
    });
  });

  describe("4. SubsystemSchema & Alias Preprocessing", () => {
    it("normalizes casing, whitespace, and maps semantic drift synonyms", async () => {
      const { SubsystemSchema, SUBSYSTEM_ALIASES } = await import("../../src/tools/manuals.ts");

      expect(SUBSYSTEM_ALIASES.climate).toBe("heating_cooling");

      // Direct enum values
      expect(SubsystemSchema.parse("heating_cooling")).toBe("heating_cooling");
      expect(SubsystemSchema.parse("12v_dc")).toBe("12v_dc");

      // Casing and whitespace
      expect(SubsystemSchema.parse("  CLIMATE  ")).toBe("heating_cooling");
      expect(SubsystemSchema.parse("HVAC")).toBe("heating_cooling");
      expect(SubsystemSchema.parse("fan")).toBe("heating_cooling");
      expect(SubsystemSchema.parse("ventilation")).toBe("heating_cooling");
      expect(SubsystemSchema.parse("electrical")).toBe("12v_dc");
      expect(SubsystemSchema.parse("dc")).toBe("12v_dc");
      expect(SubsystemSchema.parse("ac")).toBe("120v_ac");
      expect(SubsystemSchema.parse("water")).toBe("plumbing");
      expect(SubsystemSchema.parse("roof")).toBe("structural");
      expect(SubsystemSchema.parse("can_bus")).toBe("chassis_interface");

      // Undefined passes through as optional
      expect(SubsystemSchema.parse(undefined)).toBeUndefined();
    });
  });
});

