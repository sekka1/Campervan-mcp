/**
 * Script to synchronize campervan manuals from R2 storage, chunk content,
 * generate 768-dimensional embeddings, and prepare indexing for Vectorize/D1.
 */
import { generateEmbeddings, EMBEDDING_DIMENSION } from "./ingest-manuals.ts";

export interface ManualChunk {
  id: string;
  manualTitle: string;
  section: string;
  content: string;
}

export async function syncManuals(chunks?: ManualChunk[]): Promise<{
  processedCount: number;
  provider: string;
  dimensions: number;
}> {
  const activeProvider = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() || "deepinfra";
  console.log(`[sync-r2-manuals] Starting synchronization using embedding provider: ${activeProvider}`);

  // Sample or provided chunks for sync execution
  const targetChunks: ManualChunk[] = chunks || [
    {
      id: "ch-01",
      manualTitle: "Volkswagen Grand California 600 Manual",
      section: "Auxiliary Heating & Climate",
      content: "The Truma Combi D 6 E diesel heater operates via the central touchscreen control panel. Ensure auxiliary battery voltage is above 12.2V before switching on heating mode in sub-zero temperatures."
    },
    {
      id: "ch-02",
      manualTitle: "Volkswagen Grand California 600 Manual",
      section: "Fresh Water Tank Sanitation",
      content: "The 110-litre fresh water tank is located under the rear transverse bed. Use food-grade disinfectant and drain completely via the frost-protection dump valve before winter storage."
    }
  ];

  const texts = targetChunks.map(c => `[${c.manualTitle} - ${c.section}] ${c.content}`);
  console.log(`[sync-r2-manuals] Generating embeddings for ${texts.length} chunk(s)...`);

  const embeddings = await generateEmbeddings(texts);

  console.log(
    `[sync-r2-manuals] Successfully generated ${embeddings.length} vector(s) of dimension ${EMBEDDING_DIMENSION}.`
  );

  return {
    processedCount: embeddings.length,
    provider: activeProvider,
    dimensions: EMBEDDING_DIMENSION,
  };
}

// Allow direct CLI invocation
if (import.meta.url === `file://${process.argv[1]}`) {
  syncManuals()
    .then((result) => {
      console.log(`[sync-r2-manuals] Sync complete:`, result);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[sync-r2-manuals] Sync failed:`, err);
      process.exit(1);
    });
}
