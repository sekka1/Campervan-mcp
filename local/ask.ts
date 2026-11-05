/**
 * End-to-end check: runs the same 2-turn tool loop as the promptfoo provider (candidate LLM -> local MCP
 * server -> LLM synthesis), prints the final answer, then runs the generic grounding checker on it
 * (specs / sections / pages / part numbers / standards that no tool returned).
 * Requires `local/server.ts` to be running.
 *
 * Usage: tsx --env-file=.campervan-d1.env local/ask.ts "<question>"
 *   ASK_MODEL, SERVER_URL override defaults; SAVE=<file> stores the raw provider output (trace + answer).
 */
import { writeFileSync } from "node:fs";
// @ts-expect-error - plain .mjs provider without typings
import Provider from "../scripts/promptfoo-mcp-provider.mjs";
import { findUngroundedClaims, parseProviderOutput } from "../scripts/grounding-check.mjs";

const question = process.argv[2] ?? "where are the grounding points for a 2024 Ford transit?";
const provider = new Provider({
  config: {
    model: process.env["ASK_MODEL"] ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    serverUrl: process.env["SERVER_URL"] ?? "http://127.0.0.1:8787",
    apiBaseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnvar: "DEEPINFRA_TOKEN",
  },
});
const result = await provider.callApi(question);
if (result.error || typeof result.output !== "string") {
  console.error(`local:ask failed: ${result.error ?? "provider returned no output"}`);
  process.exit(1);
}
const output: string = result.output;
if (process.env["SAVE"]) writeFileSync(process.env["SAVE"], output);

const { answer, evidence, pages } = parseProviderOutput(output);
console.log(answer);
const bad = findUngroundedClaims({ answer, evidence, pages, question });
console.log(
  bad.length === 0
    ? "\n--- grounding check: OK (all specs/sections/pages/parts/standards found in tool results)"
    : `\n--- grounding check: ${bad.length} UNGROUNDED CLAIM(S): ${bad.map((c) => `${c.type}: ${c.claim}`).join("; ")}`
);
