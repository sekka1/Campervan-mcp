#!/usr/bin/env tsx
/**
 * scripts/patch-powertrain-metadata.ts
 *
 * Standalone migration/patch script to update existing D1 database records with
 * universal powertrain metadata (fuel: "bev" | "ice" | "all", powertrain: "bev" | "ice" | "all")
 * and sever mismatched schematic image associations (e.g. BEV diagrams attached to ICE chunks).
 *
 * Usage:
 *   npx tsx scripts/patch-powertrain-metadata.ts [--dry-run]
 */

import { CLOUDFLARE_API_BASE, executeD1Statements, type D1Statement } from "./ingest-manuals";

export const BEV_SCAN_REGEX =
  /\b(bev|e-transit|etransit|esprinter|promaster ev|promaster-ev|high voltage|megabrace|hv battery|traction battery|e185976b)\b/i;

export const ICE_SCAN_REGEX =
  /\b(ice|gas|gasoline|diesel|alternator|om654|ecoboost)\b/i;

export interface D1ChunkRecord {
  id: string;
  document_id: string;
  chunk_text: string;
  section_title: string | null;
  schematic_image_id: string | null;
  metadata_json: string | null;
  image_caption?: string | null;
  image_r2_key?: string | null;
}

export function computePatchedChunkMetadata(chunk: {
  chunk_text: string;
  section_title?: string | null;
  metadata_json?: string | null;
  image_caption?: string | null;
  image_r2_key?: string | null;
}): {
  fuel: "bev" | "ice" | "all";
  powertrain: "bev" | "ice" | "all";
  shouldSeverImage: boolean;
  newMetadataJson: string;
} {
  const combinedText = `${chunk.section_title || ""} ${chunk.chunk_text}`.toLowerCase();
  const imageDetails = `${chunk.image_caption || ""} ${chunk.image_r2_key || ""}`.toLowerCase();

  let fuel: "bev" | "ice" | "all" = "all";
  let powertrain: "bev" | "ice" | "all" = "all";

  if (BEV_SCAN_REGEX.test(combinedText)) {
    fuel = "bev";
    powertrain = "bev";
  } else if (ICE_SCAN_REGEX.test(combinedText)) {
    fuel = "ice";
    powertrain = "ice";
  } else {
    // Default to ICE for specific chassis, or "all" for generic
    fuel = "ice";
    powertrain = "ice";
  }

  let pouch: Record<string, unknown> = {};
  if (chunk.metadata_json) {
    try {
      const parsed = typeof chunk.metadata_json === "string" ? JSON.parse(chunk.metadata_json) : chunk.metadata_json;
      if (parsed && typeof parsed === "object") {
        pouch = { ...(parsed as Record<string, unknown>) };
      }
    } catch {}
  }

  pouch.fuel = fuel;
  pouch.powertrain = powertrain;

  const isImageBev = BEV_SCAN_REGEX.test(imageDetails);
  const shouldSeverImage = fuel === "ice" && isImageBev;

  return {
    fuel,
    powertrain,
    shouldSeverImage,
    newMetadataJson: JSON.stringify(pouch),
  };
}

export async function runPowertrainPatch(options: {
  accountId?: string;
  apiToken?: string;
  databaseId?: string;
  dryRun?: boolean;
}): Promise<{ patchedChunks: number; severedImages: number }> {
  const accountId = options.accountId || process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = options.apiToken || process.env["CLOUDFLARE_API_TOKEN"];
  const databaseId = options.databaseId || process.env["D1_DATABASE_ID"];
  const dryRun = Boolean(options.dryRun || process.argv.includes("--dry-run"));

  if (!accountId || !apiToken || !databaseId) {
    console.warn("D1 credentials not fully configured; skipping live D1 patch execution.");
    return { patchedChunks: 0, severedImages: 0 };
  }

  console.log(`Querying D1 database ${databaseId} for chunks needing powertrain classification...`);

  const fetchRes = await fetch(`${CLOUDFLARE_API_BASE}/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sql: `
        SELECT c.id, c.document_id, c.chunk_text, c.section_title, c.schematic_image_id, c.metadata_json,
               s.caption AS image_caption, s.r2_key AS image_r2_key
        FROM document_chunks c
        LEFT JOIN schematic_images s ON c.schematic_image_id = s.id
      `,
    }),
  });

  if (!fetchRes.ok) {
    throw new Error(`Failed to query document_chunks: ${await fetchRes.text()}`);
  }

  const queryJson = (await fetchRes.json()) as { result?: Array<{ results?: D1ChunkRecord[] }> };
  const rows = queryJson.result?.[0]?.results || [];
  console.log(`Found ${rows.length} chunk records in D1.`);

  const updateStatements: D1Statement[] = [];
  let severedImages = 0;
  let patchedChunks = 0;

  for (const row of rows) {
    const patch = computePatchedChunkMetadata(row);
    let sql: string;
    let params: (string | number | null)[];

    if (patch.shouldSeverImage) {
      severedImages++;
      sql = "UPDATE document_chunks SET metadata_json = ?, schematic_image_id = NULL WHERE id = ?";
      params = [patch.newMetadataJson, row.id];
    } else {
      sql = "UPDATE document_chunks SET metadata_json = ? WHERE id = ?";
      params = [patch.newMetadataJson, row.id];
    }

    patchedChunks++;
    updateStatements.push({ sql, params });
  }

  if (dryRun) {
    console.log(`[dry-run] Would patch ${patchedChunks} chunks (${severedImages} severed BEV images from ICE chunks).`);
    return { patchedChunks, severedImages };
  }

  if (updateStatements.length > 0) {
    await executeD1Statements(accountId, apiToken, databaseId, updateStatements);
    console.log(`Successfully patched ${patchedChunks} chunks in D1 (${severedImages} images severed).`);
  }

  return { patchedChunks, severedImages };
}

if (process.argv[1] && process.argv[1].endsWith("patch-powertrain-metadata.ts")) {
  runPowertrainPatch({ dryRun: process.argv.includes("--dry-run") })
    .then(({ patchedChunks, severedImages }) => {
      console.log(`Done. Patched ${patchedChunks} chunks, severed ${severedImages} BEV images.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
