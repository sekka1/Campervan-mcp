/* eslint-disable @typescript-eslint/no-explicit-any */
/** Usage: tsx local/probe.ts "<query>" [json filters, e.g. '{"model":"transit","model_year":2024}'] */
import worker from "../src/index.js";
import { makeLocalEnv } from "./env.js";

const query = process.argv[2] ?? "where are the grounding points for a 2024 Ford transit?";
const filters = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const env = makeLocalEnv();
const req = new Request("http://localhost/", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "search_van_manuals", arguments: { query, ...filters } },
  }),
});
const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} } as never);
const json: any = await res.json();
const data = JSON.parse(json.result.content[0].text);
if (process.env["RAW"]) console.log(JSON.stringify(data, null, 2));
console.log(`\nquery: ${query}\ncount: ${data.count ?? data.results?.length}`);
for (const [i, r] of (data.results ?? []).entries()) {
  console.log(
    `#${i} score=${r.score?.toFixed?.(3)} p${r.page} fuel=${r.fuel_type ?? r.powertrain ?? "?"} ` +
      `doc="${r.document_title}" schem=${r.schematic_url ?? r.schematic_r2_key ?? "-"}\n   ` +
      String(r.text ?? r.chunk_text ?? "").replace(/\s+/g, " ").slice(0, 160)
  );
}
console.log("\ntop-level keys:", Object.keys(data));
