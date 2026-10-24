/**
 * scripts/metadata.ts
 *
 * Universal document metadata architecture and two-tier automated classification:
 * - Tier 1 (Fast Path): Deterministic filename regex ({category}_{manufacturer}_{model}_{market}_{extra}.pdf)
 * - Tier 2 (AI Fallback): DeepInfra API (deepseek-ai/DeepSeek-V4-Flash-0731) on Pages 1-2 text
 */

import { basename } from "node:path";

export type DocumentCategory = "chassis" | "climate" | "power" | "plumbing" | "other";
export type DocumentMarket = "us" | "eu" | "global";

export const VALID_CATEGORIES: ReadonlySet<DocumentCategory> = new Set([
  "chassis",
  "climate",
  "power",
  "plumbing",
  "other",
]);

export const VALID_MARKETS: ReadonlySet<DocumentMarket> = new Set(["us", "eu", "global"]);

export interface PouchMetadata {
  year_start?: number | null;
  year_end?: number | null;
  chassis_code?: string | null;
  voltage?: number | null;
  fuel?: string | null;
  [key: string]: unknown;
}

export interface UniversalMetadata {
  category: DocumentCategory;
  manufacturer: string;
  model: string;
  market: DocumentMarket;
  metadata: PouchMetadata;
  metadata_json: string;
}

export const DEFAULT_UNIVERSAL_METADATA: UniversalMetadata = {
  category: "other",
  manufacturer: "unknown",
  model: "unknown",
  market: "global",
  metadata: {},
  metadata_json: "{}",
};

/**
 * Parses extra tokens from filename suffix into structured metadata pouch.
 * e.g., "2020-2024", "diesel-12v", "v363n_2024"
 */
export function parseExtraTokens(extra: string): PouchMetadata {
  const pouch: PouchMetadata = {};
  const lower = extra.toLowerCase();

  // Year range: e.g. "2020-2024" or "2020_2024"
  const rangeMatch = lower.match(/(?:^|[^0-9])(19\d\d|20\d\d)[-_](19\d\d|20\d\d)(?:$|[^0-9])/);
  if (rangeMatch) {
    pouch.year_start = parseInt(rangeMatch[1]!, 10);
    pouch.year_end = parseInt(rangeMatch[2]!, 10);
  } else {
    // Single year: e.g. "2024"
    const singleYearMatch = lower.match(/(?:^|[^0-9])(19\d\d|20\d\d)(?:$|[^0-9])/);
    if (singleYearMatch) {
      const year = parseInt(singleYearMatch[1]!, 10);
      pouch.year_start = year;
      pouch.year_end = year;
    }
  }

  // Voltage: e.g. "12v", "24v", "48v"
  const voltMatch = lower.match(/(?:^|[^a-z0-9])(12|24|48)v(?:$|[^a-z0-9])/);
  if (voltMatch) {
    pouch.voltage = parseInt(voltMatch[1]!, 10);
  }

  // Fuel type: e.g. "diesel", "gas", "gasoline", "propane"
  const fuelMatch = lower.match(/(?:^|[^a-z0-9])(diesel|gasoline|gas|propane)(?:$|[^a-z0-9])/);
  if (fuelMatch) {
    pouch.fuel = fuelMatch[1] === "gas" ? "gasoline" : fuelMatch[1];
  }

  // Chassis code: e.g. "v363n", "v363", "vs30", "ncv3"
  const chassisMatch = lower.match(/(?:^|[^a-z0-9])(v363n|v363|vs30|ncv3|w906|w907)(?:$|[^a-z0-9])/);
  if (chassisMatch) {
    pouch.chassis_code = chassisMatch[1].toUpperCase();
  }

  return pouch;
}

/**
 * Tier 1: Deterministic Filename Parser.
 * Matches: {category}_{manufacturer}_{model}_{market}_{extra}.pdf
 * Case-insensitive, normalizes to lowercase tags.
 */
export function parseFilenameMetadata(filePathOrName: string): UniversalMetadata | null {
  const name = basename(filePathOrName).replace(/\.[^.]+$/, "");
  const parts = name.split("_");

  if (parts.length < 4) {
    return null;
  }

  const rawCat = parts[0]!.toLowerCase();
  if (!VALID_CATEGORIES.has(rawCat as DocumentCategory)) {
    return null;
  }
  const category = rawCat as DocumentCategory;

  const manufacturer = parts[1]!.toLowerCase();
  const model = parts[2]!.toLowerCase();

  const rawMarket = parts[3]!.toLowerCase();
  if (!VALID_MARKETS.has(rawMarket as DocumentMarket)) {
    return null;
  }
  const market = rawMarket as DocumentMarket;

  const extraParts = parts.slice(4).join("_");
  const metadata = extraParts ? parseExtraTokens(extraParts) : {};

  return {
    category,
    manufacturer,
    model,
    market,
    metadata,
    metadata_json: JSON.stringify(metadata),
  };
}

/**
 * Configuration constants for Tier 2 AI Cover-Page Pass:
 * Easily configurable page count and character cap.
 */
export const METADATA_AI_MAX_PAGES = 10;
export const METADATA_AI_MAX_CHARS = 25000;

export const DEEPINFRA_API_URL = "https://api.deepinfra.com/v1/openai/chat/completions";
export const DEEPINFRA_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";

export const CLASSIFICATION_PROMPT = `You are a technical document classifier. Analyze the introductory text (up to ${METADATA_AI_MAX_PAGES} pages) of this equipment manual and extract metadata into valid JSON with this exact schema:
{
  "category": "chassis" | "climate" | "power" | "plumbing" | "other",
  "manufacturer": string (lowercase, e.g. "ford", "mercedes", "espar", "victron"),
  "model": string (lowercase, e.g. "transit", "sprinter", "airtronic_s2", "multiplus_ii"),
  "market": "us" | "eu" | "global",
  "metadata": {
    "year_start": number | null,
    "year_end": number | null,
    "chassis_code": string | null,
    "voltage": number | null,
    "fuel": string | null
  }
}`;

/**
 * Extracts introductory text from pages up to METADATA_AI_MAX_PAGES and caps at METADATA_AI_MAX_CHARS.
 */
export function extractCoverPageText(
  text: string | string[],
  maxPages: number = METADATA_AI_MAX_PAGES,
  maxChars: number = METADATA_AI_MAX_CHARS
): string {
  const combined = Array.isArray(text)
    ? text.slice(0, maxPages).join("\n")
    : (typeof text === "string" ? text : "");
  return combined.slice(0, maxChars);
}

/**
 * Tier 2: AI Cover-Page Pass via DeepInfra.
 * Analyzes the plain text of up to METADATA_AI_MAX_PAGES (capped at METADATA_AI_MAX_CHARS) of the PDF.
 */
export async function classifyWithDeepInfra(
  coverPageText: string,
  deepinfraToken?: string,
  customFetch: typeof fetch = globalThis.fetch,
  filename?: string
): Promise<UniversalMetadata> {
  const token = deepinfraToken ?? process.env["DEEPINFRA_TOKEN"];
  if (!token) {
    console.warn("DEEPINFRA_TOKEN not set; falling back to default metadata.");
    return { ...DEFAULT_UNIVERSAL_METADATA };
  }

  if (!coverPageText || coverPageText.trim().length === 0) {
    console.warn("No cover page text available for AI classification; falling back to default metadata.");
    return { ...DEFAULT_UNIVERSAL_METADATA };
  }

  try {
    const truncatedText = coverPageText.slice(0, METADATA_AI_MAX_CHARS);
    const response = await customFetch(DEEPINFRA_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEEPINFRA_MODEL,
        messages: [
          { role: "system", content: CLASSIFICATION_PROMPT },
          {
            role: "user",
            content: `${filename ? `Filename: ${filename}\n\n` : ""}Document Text (First ${METADATA_AI_MAX_PAGES} Pages):\n${truncatedText}\n\nRespond with valid JSON only.`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.warn(`DeepInfra API returned HTTP ${response.status}: ${await response.text()}`);
      return { ...DEFAULT_UNIVERSAL_METADATA };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("DeepInfra response contained no content.");
      return { ...DEFAULT_UNIVERSAL_METADATA };
    }

    const parsed = JSON.parse(content) as {
      category?: string;
      manufacturer?: string;
      model?: string;
      market?: string;
      metadata?: PouchMetadata;
    };

    const rawCat = (parsed.category || "").toLowerCase() as DocumentCategory;
    const category: DocumentCategory = VALID_CATEGORIES.has(rawCat) ? rawCat : "other";

    const manufacturer = (parsed.manufacturer || "unknown").toLowerCase().trim();
    const model = (parsed.model || "unknown").toLowerCase().trim();

    const rawMarket = (parsed.market || "").toLowerCase() as DocumentMarket;
    const market: DocumentMarket = VALID_MARKETS.has(rawMarket) ? rawMarket : "global";

    const metadata: PouchMetadata =
      typeof parsed.metadata === "object" && parsed.metadata !== null ? parsed.metadata : {};

    return {
      category,
      manufacturer,
      model,
      market,
      metadata,
      metadata_json: JSON.stringify(metadata),
    };
  } catch (err) {
    console.warn("Error during DeepInfra metadata classification:", err);
    return { ...DEFAULT_UNIVERSAL_METADATA };
  }
}

/**
 * Combined Two-Tier Metadata Extraction:
 * 1. Tries deterministic filename parsing.
 * 2. If non-conforming, falls back to DeepInfra AI cover page classification.
 */
export async function extractDocumentMetadata(
  filePathOrName: string,
  coverPageText: string,
  deepinfraToken?: string,
  customFetch: typeof fetch = globalThis.fetch
): Promise<UniversalMetadata> {
  const fromFilename = parseFilenameMetadata(filePathOrName);
  if (fromFilename) {
    return fromFilename;
  }
  const filename = basename(filePathOrName);
  return classifyWithDeepInfra(coverPageText, deepinfraToken, customFetch, filename);
}
