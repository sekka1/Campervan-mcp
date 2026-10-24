import { describe, expect, it, vi } from "vitest";
import {
  classifyWithDeepInfra,
  DEFAULT_UNIVERSAL_METADATA,
  extractCoverPageText,
  extractDocumentMetadata,
  METADATA_AI_MAX_PAGES,
  METADATA_AI_MAX_CHARS,
  parseExtraTokens,
  parseFilenameMetadata,
} from "../../scripts/metadata";

describe("Tier 1: Deterministic Filename Parser", () => {
  it("parses vehicle chassis with year range and market", () => {
    const meta = parseFilenameMetadata("chassis_ford_transit_us_2020-2024.pdf");
    expect(meta).not.toBeNull();
    expect(meta).toEqual({
      category: "chassis",
      manufacturer: "ford",
      model: "transit",
      market: "us",
      metadata: {
        year_start: 2020,
        year_end: 2024,
      },
      metadata_json: JSON.stringify({ year_start: 2020, year_end: 2024 }),
    });
  });

  it("parses climate appliance with fuel and voltage", () => {
    const meta = parseFilenameMetadata("climate_espar_airtronic-s2_global_diesel-12v.pdf");
    expect(meta).not.toBeNull();
    expect(meta).toEqual({
      category: "climate",
      manufacturer: "espar",
      model: "airtronic-s2",
      market: "global",
      metadata: {
        voltage: 12,
        fuel: "diesel",
      },
      metadata_json: JSON.stringify({ voltage: 12, fuel: "diesel" }),
    });
  });

  it("parses power component with single year and chassis code", () => {
    const meta = parseFilenameMetadata("power_victron_multiplus-ii_eu_2023_v363.pdf");
    expect(meta).not.toBeNull();
    expect(meta?.category).toBe("power");
    expect(meta?.manufacturer).toBe("victron");
    expect(meta?.model).toBe("multiplus-ii");
    expect(meta?.market).toBe("eu");
    expect(meta?.metadata.year_start).toBe(2023);
    expect(meta?.metadata.year_end).toBe(2023);
    expect(meta?.metadata.chassis_code).toBe("V363");
  });

  it("returns null for non-conforming filenames", () => {
    expect(parseFilenameMetadata("MY24_Transit_BEMM_V363N_20APR24_J2_V2_R2.pdf")).toBeNull();
    expect(parseFilenameMetadata("velit-heater-manual.pdf")).toBeNull();
    expect(parseFilenameMetadata("sample.pdf")).toBeNull();
  });
});

describe("parseExtraTokens", () => {
  it("extracts propane and 24v", () => {
    const tokens = parseExtraTokens("propane_24v_2021-2025");
    expect(tokens.fuel).toBe("propane");
    expect(tokens.voltage).toBe(24);
    expect(tokens.year_start).toBe(2021);
    expect(tokens.year_end).toBe(2025);
  });
});

describe("Tier 2: DeepInfra AI Cover-Page Pass", () => {
  it("calls DeepInfra OpenAI chat completions endpoint and parses JSON", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              category: "chassis",
              manufacturer: "ford",
              model: "transit",
              market: "us",
              metadata: {
                year_start: 2024,
                year_end: 2024,
                chassis_code: "V363N",
                voltage: 12,
                fuel: "gasoline",
              },
            }),
          },
        },
      ],
    };

    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(mockResponse), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;

    const meta = await classifyWithDeepInfra(
      "FORD TRANSIT 2024 BODY AND EQUIPMENT MOUNTING MANUAL V363N NORTH AMERICA",
      "test-token",
      mockFetch
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = (mockFetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toContain("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });

    expect(meta.category).toBe("chassis");
    expect(meta.manufacturer).toBe("ford");
    expect(meta.model).toBe("transit");
    expect(meta.market).toBe("us");
    expect(meta.metadata.year_start).toBe(2024);
    expect(meta.metadata.chassis_code).toBe("V363N");
  });

  it("includes filename in DeepInfra prompt when filename is provided", async () => {
    const mockResponse = {
      choices: [{ message: { content: JSON.stringify({ category: "chassis", manufacturer: "ford", model: "transit", market: "us" }) } }],
    };
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })
    ) as unknown as typeof fetch;

    await classifyWithDeepInfra("Page text", "token", mockFetch, "MY24_Transit_BEMM.pdf");
    const [_, init] = (mockFetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.messages[1].content).toContain("Filename: MY24_Transit_BEMM.pdf");
  });

  it("falls back to default metadata when DEEPINFRA_TOKEN is not set", async () => {
    const meta = await classifyWithDeepInfra("Some text without token", undefined);
    expect(meta).toEqual(DEFAULT_UNIVERSAL_METADATA);
  });

  it("falls back to default metadata when cover page text is empty", async () => {
    const meta = await classifyWithDeepInfra("", "test-token");
    expect(meta).toEqual(DEFAULT_UNIVERSAL_METADATA);
  });

  it("handles DeepInfra API HTTP errors gracefully without throwing", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("Rate limit exceeded", { status: 429 })
    ) as unknown as typeof fetch;

    const meta = await classifyWithDeepInfra("Cover page text", "test-token", mockFetch);
    expect(meta).toEqual(DEFAULT_UNIVERSAL_METADATA);
  });
});

describe("Combined Two-Tier Extraction", () => {
  it("uses Tier 1 directly when filename conforms, without calling AI", async () => {
    const mockFetch = vi.fn();
    const meta = await extractDocumentMetadata(
      "climate_espar_airtronic-s2_global_diesel-12v.pdf",
      "Page text here",
      "token",
      mockFetch as unknown as typeof fetch
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(meta.category).toBe("climate");
    expect(meta.manufacturer).toBe("espar");
  });

  it("falls back to Tier 2 AI when filename does not conform", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              category: "climate",
              manufacturer: "velit",
              model: "2026",
              market: "us",
              metadata: { voltage: 12 },
            }),
          },
        },
      ],
    };
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })
    ) as unknown as typeof fetch;

    const meta = await extractDocumentMetadata(
      "velit-heater.pdf",
      "Velit Gasoline/Diesel Air Heater 12V 2026 Edition",
      "token",
      mockFetch
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(meta.category).toBe("climate");
    expect(meta.manufacturer).toBe("velit");
  });
});
describe("extractCoverPageText helper", () => {
  it("extracts up to METADATA_AI_MAX_PAGES (default 10) and caps at METADATA_AI_MAX_CHARS (default 25000)", () => {
    expect(METADATA_AI_MAX_PAGES).toBe(10);
    expect(METADATA_AI_MAX_CHARS).toBe(25000);
    const pages = Array.from({ length: 15 }, (_, i) => `Page ${i + 1} content repeating `.repeat(100));
    const extracted = extractCoverPageText(pages);
    expect(extracted).toContain("Page 1 content");
    expect(extracted).toContain("Page 10 content");
    expect(extracted).not.toContain("Page 11 content");
    expect(extracted.length).toBeLessThanOrEqual(METADATA_AI_MAX_CHARS);

    // Test character cap
    const hugePage = "A".repeat(30000);
    expect(extractCoverPageText([hugePage]).length).toBe(METADATA_AI_MAX_CHARS);
  });
});
