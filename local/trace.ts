/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Stage-by-stage retrieval trace: shows where each page/powertrain tag sits in the keyword ranking,
 * the vector ranking and the fused (RRF) ranking, BEFORE hydration, BEV filtering and top_k slicing.
 * Use it to find the stage at which an expected chunk drops out.
 *
 * Usage: tsx --env-file=.campervan-d1.env local/trace.ts "<query>" ['{"model":"<model>","model_year":<year>}']
 * (filters are optional and, like local/probe.ts, empty by default)
 */
import { tokenizeQuery, searchD1KeywordCandidates, searchManuals, reciprocalRankFusion } from "../src/utils/db.js";
import { makeLocalEnv } from "./env.js";

const query = process.argv[2] ?? "where are the grounding points for a 2024 Ford transit?";
// No filters by default, matching local/probe.ts, so a trace and a probe of the same query are comparable.
// Pass the same JSON filters to both when investigating a filtered search.
const filters = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const env = makeLocalEnv();

const tokens = tokenizeQuery(query);
const keyword = await searchD1KeywordCandidates(env.DB, tokens, filters);

// Same embedding model as production query-time and ingestion (768-dim bge-base-en-v1.5 via DeepInfra).
const resp: any = await (
  await fetch("https://api.deepinfra.com/v1/inference/BAAI/bge-base-en-v1.5", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DEEPINFRA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: [query] }),
  })
).json();
if (!resp.embeddings?.[0]) throw new Error(`Embedding failed: ${JSON.stringify(resp)}`);
const vector = await searchManuals(env.VECTOR_INDEX, resp.embeddings[0], { topK: 24 });
const fused = reciprocalRankFusion(vector.map((m) => m.id), keyword.map((k) => k.id));

const ids = Array.from(new Set([...keyword.map((k) => k.id), ...vector.map((v) => v.id), ...fused]));
const rows: any = await env.DB.prepare(
  `SELECT id, page_number p, json_extract(metadata_json,'$.powertrain') pt FROM document_chunks WHERE id IN (${ids.map(() => "?").join(",")})`
)
  .bind(...ids)
  .all();
const label = new Map<string, string>(rows.results.map((r: any) => [r.id, `p${r.p}/${r.pt}`]));

console.log("tokens :", tokens);
console.log("KEYWORD:", keyword.map((k) => `${label.get(k.id)}(${k.score})`).join(" "));
console.log("VECTOR :", vector.map((v) => `${label.get(v.id)}(${v.score.toFixed(2)})`).join(" "));
console.log("FUSED  :", fused.map((id) => label.get(id)).join(" "));
