import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computePatchedChunkMetadata,
  runPowertrainPatch,
  BEV_SCAN_REGEX,
  ICE_SCAN_REGEX,
} from "../patch-powertrain-metadata";

describe("scripts/patch-powertrain-metadata", () => {
  describe("Regex Classification", () => {
    it("identifies BEV markers across multiple vehicle chassis", () => {
      expect(BEV_SCAN_REGEX.test("Ford E-Transit 2024 high voltage disconnect")).toBe(true);
      expect(BEV_SCAN_REGEX.test("Mercedes eSprinter Megabrace mounting")).toBe(true);
      expect(BEV_SCAN_REGEX.test("Ram ProMaster EV traction battery zone")).toBe(true);
      expect(BEV_SCAN_REGEX.test("Figure E185976b BEV Ground Points")).toBe(true);
      expect(BEV_SCAN_REGEX.test("Standard 3.5L EcoBoost engine ground")).toBe(false);
    });

    it("identifies ICE markers across chassis", () => {
      expect(ICE_SCAN_REGEX.test("3.5L EcoBoost gasoline engine")).toBe(true);
      expect(ICE_SCAN_REGEX.test("Mercedes OM654 diesel engine auxiliary alternator")).toBe(true);
      expect(ICE_SCAN_REGEX.test("Standard ICE chassis ground points")).toBe(true);
    });
  });

  describe("computePatchedChunkMetadata", () => {
    it("classifies BEV chunk and preserves non-severed image", () => {
      const result = computePatchedChunkMetadata({
        chunk_text: "High voltage traction battery ground point Megabrace",
        section_title: "Electrical - BEV",
        image_caption: "Figure E185976b E-Transit Grounding Points",
      });

      expect(result.fuel).toBe("bev");
      expect(result.powertrain).toBe("bev");
      expect(result.shouldSeverImage).toBe(false);
      const parsed = JSON.parse(result.newMetadataJson);
      expect(parsed.fuel).toBe("bev");
      expect(parsed.powertrain).toBe("bev");
    });

    it("severs BEV image when chunk is classified as ICE", () => {
      const result = computePatchedChunkMetadata({
        chunk_text: "Standard 3.5L EcoBoost gasoline chassis ground studs 49 to 88",
        section_title: "Chassis Grounding - Combustion",
        image_caption: "Figure E185976b E-Transit BEV Grounding Points",
      });

      expect(result.fuel).toBe("ice");
      expect(result.powertrain).toBe("ice");
      expect(result.shouldSeverImage).toBe(true);
    });

    it("retains ICE image when chunk is classified as ICE", () => {
      const result = computePatchedChunkMetadata({
        chunk_text: "Standard 3.5L EcoBoost gasoline chassis ground studs 49 to 88",
        section_title: "Chassis Grounding - Combustion",
        image_caption: "Figure E185976 Transit Grounding Points",
      });

      expect(result.fuel).toBe("ice");
      expect(result.powertrain).toBe("ice");
      expect(result.shouldSeverImage).toBe(false);
    });

    it("defaults ambiguous chassis chunk to ICE", () => {
      const result = computePatchedChunkMetadata({
        chunk_text: "Seat pedestal ground stud torque spec 25 Nm",
        section_title: "Ground Points",
      });

      expect(result.fuel).toBe("ice");
      expect(result.powertrain).toBe("ice");
    });
  });

  describe("runPowertrainPatch", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns zero counts when D1 env vars are missing", async () => {
      const result = await runPowertrainPatch({
        accountId: "",
        apiToken: "",
        databaseId: "",
      });
      expect(result).toEqual({ patchedChunks: 0, severedImages: 0 });
    });

    it("fetches rows and handles dry-run without executing updates", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            {
              results: [
                {
                  id: "chunk-1",
                  document_id: "doc-1",
                  chunk_text: "Ford E-Transit 2024 high voltage battery",
                  section_title: "BEV",
                  schematic_image_id: "img-bev-1",
                  image_caption: "E185976b BEV",
                },
                {
                  id: "chunk-2",
                  document_id: "doc-1",
                  chunk_text: "Ford Transit 3.5L EcoBoost ground studs 49 to 88",
                  section_title: "Grounding",
                  schematic_image_id: "img-bev-1",
                  image_caption: "E185976b BEV diagram",
                },
              ],
            },
          ],
        }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const result = await runPowertrainPatch({
        accountId: "test-acc",
        apiToken: "test-tok",
        databaseId: "test-db",
        dryRun: true,
      });

      expect(result.patchedChunks).toBe(2);
      expect(result.severedImages).toBe(1); // chunk-2 is ICE but has BEV diagram
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only the query, no update
    });
  });
});
