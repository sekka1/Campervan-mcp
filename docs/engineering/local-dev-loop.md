# Local Dev Loop: Test Unpushed Code Against the Dev Data

Goal: iterate on retrieval / prompt-contract changes in seconds, without push → deploy → ask the live MCP.
The code under test is your local `src/`; the **data is the real dev environment** (D1 + Vectorize), reached
over the Cloudflare REST API. There is no local emulator for Vectorize, so this is the only faithful way.

> ⚠️ The harness uses real dev credentials, runs with auth/metering disabled, and its D1 shim executes
> whatever SQL the code sends — **including writes**. Dev only. The server binds to `127.0.0.1` (override with `HOST`).
> The production Worker (`src/index.ts` `export default { fetch }`) is untouched by this harness.

## One-time setup

1. Node ≥ 22 and pnpm (`engines` requires it). On a box without Node, a user-level install works:
   `curl -fsSL https://nodejs.org/dist/latest-v22.x/<node-v22.x-linux-arm64.tar.xz> | tar -xJ --strip-components=1 -C ~/.local/node`
   then `export PATH=$HOME/.local/node/bin:$PATH` and `npm i -g pnpm`; run `pnpm install`.
2. Create `.campervan-d1.env` (listed in `.gitignore`; never commit or paste its contents):
   ```
   CLOUDFLARE_ACCOUNT_ID=...
   CLOUDFLARE_API_TOKEN=...      # needs D1 read(/edit) + Vectorize read
   D1_DATABASE_ID=2aa73cfb-cf41-4ab3-b614-b0cf1eb7ec0c
   DEEPINFRA_TOKEN=...           # query embeddings + the answering LLM
   # optional: VECTORIZE_INDEX_NAME=van_manuals_index  CDN_BASE_URL=...  PORT=8787  HOST=127.0.0.1
   ```
   R2 keys are only needed for ingestion scripts, not for this loop.

## Commands (all load `.campervan-d1.env` automatically)

| Command | What it does |
|---|---|
| `pnpm local:probe "<query>" '{"model":"transit","model_year":2024}'` | Calls the real `search_van_manuals` handler; prints rank, score, page, powertrain tag, doc title, schematic URL. `RAW=1` prints full JSON incl. the retrieval contract. |
| `pnpm local:trace "<query>" [filters-json]` | Same optional filters as `local:probe` (none by default, so the two are comparable). Shows keyword / vector / fused rankings (page/tag) **before** hydration, BEV filtering and slicing. Use to find the stage that drops a chunk. |
| `pnpm local:sql "SELECT …" ['[param,…]']` | Runs SQL against dev D1 (inspect tags, chunk text, schematics). |
| `pnpm local:server` | Serves the local Worker on `http://127.0.0.1:8787` (same JSON-RPC endpoint as production). |
| `pnpm local:ask "<question>"` | With the server running: the promptfoo 2-turn loop (LLM → local MCP → LLM synthesis); prints the final answer, then a **grounding check** listing specs/sections/pages/part numbers/standards that no tool returned. `ASK_MODEL`, `SERVER_URL`, `SAVE=<file>` override/extend. |
| `BASE_URL=http://127.0.0.1:8787 pnpm test:live` | Runs the post-deploy smoke tests against local code. |
| promptfoo | set `serverUrl: "http://127.0.0.1:8787"` in the provider config to evaluate local code. |

## How it works (`local/`)

- `local/env.ts` builds an `Env`: `DB` (prepare/bind/all/first/run/batch → D1 REST `/query`),
  `VECTOR_INDEX` (`query` → Vectorize REST `/query`), `DEEPINFRA_TOKEN`, `AUTH_ENABLED=false`, `METERING_ALLOW_ALL=true`.
  The shims **throw** on API errors so outages are never hidden by the mock fallbacks in `searchManuals`.
- `server.ts` / `probe.ts` call `worker.fetch(...)` from `src/index.ts` directly, so everything (Zod validation, tool
  registry, contract) is exercised exactly as in production.
- Real config lives in `cloudflare.config.ts` (bindings `DB`, `VECTOR_INDEX`, `AI`, `DEEPINFRA_TOKEN`).
  `wrangler.toml` is **stale** (different binding/index names) — don't use it as a reference and don't expect
  `wrangler dev` to work without a custom config; Vectorize has no local mode anyway.

## Debugging playbook: "the answer is bad / missing diagrams"

Work down; stop at the first stage that explains it.
1. **Is the data right?** `pnpm local:sql` — find the chunks by phrase and check `page_number`, `metadata_json`
   powertrain tag, `schematic_image_id`, `section_title`. (Example: Transit pages 149–156.)
2. **Is it retrieved?** `pnpm local:trace "<question>"` — present in KEYWORD / VECTOR / FUSED?
3. **Is it dropped afterwards?** `pnpm local:probe` — compare with FUSED. Candidates: non-BEV post-filter,
   dedup, `top_k` slice, filter relaxation (try with/without `model`, `model_year`, `market` filters).
4. **Is the LLM misusing good chunks?** `pnpm local:ask` — read the grounding-check line, compare the answer to chunk text; tighten the
   *generic* contract (`buildBaseRetrievalContract`) or a mechanism, never vehicle facts (see `retrieval-pipeline.md` §8).
5. Only after a code change is verified here: tests → PR. Re-ingest only if ingestion code/PDFs changed.

## Worked example (PR #74, grounding points)

`local:trace` showed the section opener p150 as the #1 fused hit; `local:probe` showed it absent from the output;
SQL showed p150 `bev`, p151 `ice` (diagram), p152 `bev`, p153 `all` (table) → the BEV post-filter dropped the
opener and nothing carried its ICE continuation. Fix: `promoteNonBevNeighbors` (see `retrieval-pipeline.md` §5).
Follow-ups from `local:ask` were fixed as *classes*, not cases: invented rules/numbers → `evidence_rule` + grounding checker; an
item documented for another system recommended for add-on loads → purpose-matching `recommendation_rule`; a dropped opener's
universal cautions → `extractNeutralSectionContext`. (This section is an example of the process, not a list of rules.)
