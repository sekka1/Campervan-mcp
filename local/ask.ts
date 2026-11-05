/**
 * End-to-end check: runs the same 2-turn tool loop as the promptfoo provider (candidate LLM -> local MCP
 * server -> LLM synthesis) and prints the final answer. Requires `local/server.ts` to be running.
 *
 * Usage: tsx --env-file=.campervan-d1.env local/ask.ts "<question>"
 */
// @ts-expect-error - plain .mjs provider without typings
import Provider from "../scripts/promptfoo-mcp-provider.mjs";

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
// Drop the raw "MCP Tool Result (...)" trace lines; keep the synthesized answer.
console.log(String(result.output).split("\n").filter((l: string) => !l.startsWith("MCP Tool Result")).join("\n"));
