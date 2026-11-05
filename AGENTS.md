# AGENTS.md — System Architecture & Developer Agent Operating Rules

Welcome AI Agent. This repository contains a production-grade Model Context Protocol (MCP) server built with TypeScript, `@modelcontextprotocol/sdk`, and Cloudflare Workers (deployed via `cloudflare.config.ts`).

---

## 0. Start Here: Engineering Docs & Local Dev Loop

Do **not** re-derive how retrieval works or how to test it. Read these first:

- [`docs/engineering/retrieval-pipeline.md`](docs/engineering/retrieval-pipeline.md) — data model, ingestion-time ICE/BEV tagging, the 10-step query pipeline (`hybridSearch`), the ICE-default policy, PR #70–#74 history, the retrieval contract the LLM receives, known limitations, and a verification checklist.
- [`docs/engineering/local-dev-loop.md`](docs/engineering/local-dev-loop.md) — run your **local, unpushed** `src/` against the dev D1/Vectorize with `pnpm local:probe | local:trace | local:sql | local:server | local:ask`, plus a debugging playbook ("answer is bad / missing diagram").

Hard-won rules (details in those docs):
1. **Diagnose with data before changing code.** Check stored tags/pages (`pnpm local:sql`) and the stage at which a chunk is lost (`pnpm local:trace`). Re-ingesting does not change powertrain tags unless the classifier code changed.
2. **Generic-first (examples are not rules).** Never add logic, contract text or prompts that name a page, part, vehicle, model year or circuit you just saw (a unit test enforces this for the grounding rules). Classify the failure and fix the *class* with a mechanism, a contract principle or a deterministic check — see `retrieval-pipeline.md` §8. Concrete cases belong only in labeled test fixtures/promptfoo regressions. Sprinter, Ram/ProMaster, batteries, HVAC, air and water systems must all work through the same code.
3. **LLM freedom, grounded.** The retrieval contract (`buildBaseRetrievalContract()` in `src/tools/manuals.ts`, single source) lets the model explain and advise, but anything attributed to a manual must come from retrieved chunks, and all other advice must be labeled "General guidance (not from the indexed manuals)". Extend the builder, not inline copies.
4. **Verify the synthesized answer**, not just retrieval: `pnpm local:ask` (it runs `scripts/grounding-check.mjs`, which flags specs/sections/pages/part numbers/standards no tool returned), then spot-check quoted claims against D1 text. The checker proves presence, not attribution. Contract wording is a hypothesis: after changing it, **measure** compliance with `pnpm eval:grounding` (local server, several repeats, generic failure-class metrics) before and after — models vary run to run (`retrieval-pipeline.md` §8.2).
5. **No assumed context.** Never default a vehicle, year, model or manufacturer; ask via the `needs_clarification` response (§3 item 5). The only default is market = US. Tests and promptfoo questions must state the context they rely on.
6. `.campervan-d1.env` holds real credentials: never commit it, print it, or paste its contents.

---

## 0.1 When You Find a Specific Problem: Generalize It First

Bugs and bad answers will keep showing up one concrete case at a time (a missing diagram on one platform, an invented rule on another, a wrong recommendation for one circuit). **The concrete case is a symptom. Never fix it with a one-off.** Every platform (Transit, Sprinter, Ram/ProMaster) and system (electrical, batteries, HVAC, air, water, plumbing) must benefit from the fix. Follow this procedure every time:

1. **Reproduce and diagnose with real data** (`docs/engineering/local-dev-loop.md`): `pnpm local:sql` (what is stored), `pnpm local:trace` (which retrieval stage loses it), `pnpm local:probe` (what is returned), `pnpm local:ask` (what the model says + grounding check). Don't guess, and don't assume re-ingesting helps.
2. **Name the failure class, not the instance.** Strip out the page, part, vehicle, model year and circuit. Ask: "what general situation is this an example of?" (e.g. *a section split across variants*, *a model stating something no source says*, *recommending an item whose documented purpose differs from the user's use*, *calling an incomplete list complete*).
3. **Pick the layer that fixes the class** (table in `docs/engineering/retrieval-pipeline.md` §8): retrieval mechanism, ingestion classifier, contract principle in `buildBaseRetrievalContract()`, deterministic check (`scripts/grounding-check.mjs`), or formula code. Prefer mechanisms and deterministic checks over adding prompt text; prefer one principle with several cross-domain examples over a list of cases.
4. **Write the fix with no hardcoded specifics**: no vehicle, brand, model-year, page, part-number or circuit names in logic or contract text (`tests/unit/retrieval-contract.test.ts` enforces this for the contract). Examples may appear in comments and docs only if labeled as examples.
5. **Test the class, then the instance.** Unit tests use neutral synthetic fixtures (see `tests/unit/powertrain-continuation.test.ts`, `scripts/__tests__/grounding-check.test.ts`). The original real-world case goes in `promptfooconfig.yaml` as a clearly labeled regression, with generic-principle assertions alongside any data-specific ones.
6. **Verify end to end** with `pnpm local:ask` before opening a PR, and confirm the fix would also hold for a different platform or system (ask yourself, or test, a Sprinter/Ram/battery/HVAC/plumbing variant of the same situation).
7. **Document the class, not the case**: update `docs/engineering/retrieval-pipeline.md` (what the class is and which mechanism now covers it; add known limits). Keep platform-specific details to a short "example" line.

Worked example (PR #74/#75): one platform's grounding answer lacked the diagram, invented rules and recommended a fuel-circuit ground. The fixes were: section-continuity-aware neighbour promotion and variant-neutral section notes (retrieval mechanisms), purpose-matching and evidence-labeling contract principles, and a deterministic claim checker — none names that platform's pages or circuits.

If you cannot express a fix without naming a specific vehicle, part or page, stop and re-do step 2 — or ask the user.

---

## 0.2 Cost Guardrails: Models and Paid APIs

Paid model calls cost the owner real money (a premium judge model was once used by mistake for evaluation runs).
1. **Only use models that are already defined in this repo's config/code** (`promptfooconfig.yaml`, `scripts/metadata.ts`, `src/tools/manuals.ts`, `local/ask.ts`). Never introduce another model id, and never use Claude/GPT-class or other premium models via DeepInfra or any API for evaluation, grading, testing or debugging.
2. **Do not copy defaults blindly.** If an existing config references an expensive model (for example `anthropic/claude-sonnet-4-6`, $3/$15 per 1M tokens, which used to be the `llm-rubric` grader), do not reuse it in new configs or scripts: use the cheap default model (`deepseek-ai/DeepSeek-V4-Flash-0731`) and tell the user about the expensive setting. All promptfoo graders in this repo now use that cheap model.
3. **Keep paid runs small and deliberate.** Prefer unit tests and local probes (free) first; use few repeats; send graders only the text they need (e.g. strip the raw tool trace); never loop evaluations without a stated reason.
4. **Ask before using any model or paid service not listed above**, and report approximate usage when you ran evaluations.

---

## 1. Architectural Philosophy: The Strict Division of Concerns

This system operates on a fundamental division of responsibilities:

1. **Domain Knowledge & Specifications Belong Exclusively in RAG:**
   - **Never hardcode vehicle rules, component specs, part numbers, or model-year constraints in code or manual SQL tables.**
   - Vehicle specifications change across model years (e.g., 2015–2019 triple-60A studs vs. 2020+ 175A CCP2 on Ford Transits) and option codes. Hardcoding rules creates stale data that contradicts real manuals and causes hallucinations.
   - Raw OEM documents (Ford BEMMs, Mercedes Sprinter guides, Victron manuals, upfitter specs) stored in Cloudflare R2, D1 (`document_chunks`), and Vectorize are the single source of truth.
   - Frontier LLMs are trusted to reason over the retrieved chunks. Never build "validator" tools that second-guess or override the manuals with static checks.

2. **Physics & Math Belong in Deterministic Code:**
   - LLMs fail at precise electrical arithmetic and table lookups. Universal physics (Ohm's law, ABYC E-11 circular mil formulas, voltage drop percentages, fuse sizing curves) must be computed deterministically in pure TypeScript inside `src/utils/formulas.ts` with 0% hallucination.
   - Always return strict numerical answers with clear unit strings (e.g., `AWG`, `Volts`, `Amps`, `Nm`, `ft-lb`).

---

## 2. Core Rules & Prohibited Patterns for Agents

1. **Universal Metadata Taxonomy (4 Tags + Flexible JSON Pouch):**
   - All ingested documentation conforms to a universal metadata model:
     - 4 Universal Tags: `category` ("chassis" | "climate" | "power" | "plumbing" | "other"), `manufacturer` (string), `model` (string), and `market` ("us" | "eu" | "global").
     - 1 Flexible JSON Pouch: `metadata_json` (e.g. `{"year_start": 2020, "year_end": 2024, "chassis_code": "V363N", "voltage": 12, "fuel": "diesel"}`).
   - **Two-Tier Ingestion Classification**:
     - *Tier 1 (Fast Path)*: Deterministic filename regex `{category}_{manufacturer}_{model}_{market}_{extra}.pdf`.
     - *Tier 2 (AI Fallback)*: DeepInfra OpenAI-compatible chat completions API using model `deepseek-ai/DeepSeek-V4-Flash-0731` against introductory plain text (up to 10 pages, capped at 25,000 characters) when filenames are non-conforming.
   - **Anti-Pattern Prohibition**:
     - ❌ **NEVER** create component-specific or vehicle-specific tables (e.g., `chassis_specs`, `heater_specs`, `transit_rules`).
     - ❌ **NEVER** create vehicle-specific tools or hardcoded constants in TypeScript.
   - When new chassis, model years, or appliances are added, they are classified into the universal `documents` and `document_chunks` tables with zero schema bloat.

2. **Zero Vehicle-Specific Tables or Dictionaries (Anti-Hardcoding Rule):**
   - ❌ **DO NOT** create vehicle-specific tables in D1 (e.g., `chassis_rules`, `transit_specs`, `victron_components`).
   - ❌ **DO NOT** add vehicle-specific constant dictionaries (like `CHASSIS_RULES_DB`) to `src/utils/formulas.ts`.
   - ❌ **DO NOT** create vehicle-specific tools (e.g., `evaluate_chassis_rules`).
   - ✅ When a new vehicle or component is added to the system, it MUST be ingested as a raw document into R2/Vectorize/D1—never hand-coded into schemas or TypeScript.

2. **Fail Fast, Never Fall Back to Zero-Vectors:**
   - ❌ **NEVER** catch an embedding failure and silently return a dummy array or a vector of zeroes (`[0, 0, ..., 0]`). In Vectorize, zero-vectors cause cosine similarity scores to collapse to `-1.0` and return arbitrary, irrelevant chunks.
   - ✅ If Cloudflare Workers AI (`env.AI`) or Vectorize fails, log the root error and throw an explicit, descriptive error immediately.

3. **Lean Tool Surface:**
   Keep the public MCP tool registry minimal, composable, and focused:
   - `search_van_manuals`: Universal semantic retrieval across all ingested manuals (default `top_k: 8`). Returns verified text chunks, torque specs, part numbers, and R2 schematic URLs.
   - `calculate_dc_wire_and_fuse`: Universal ABYC E-11 compliant DC cable gauge (AWG), voltage drop, and overcurrent fuse calculator based purely on physics.
   - `inspect_manual_chunks`: Diagnostic tool for direct SQL keyword verification against D1 chunks.

4. **Database & Migration Integrity:**
   - D1 maintains only the generic document store: `documents`, `document_chunks`, `schematic_images`, and metering ledgers (`accounts`, `usage_records`).
   - D1 schema updates MUST be written as sequential, non-destructive SQL files in `d1/migrations/` (e.g., `0002_add_schematic_indices.sql`).
   - Never modify existing migration files after they have been merged. Always add a new numbered migration file.

5. **Type Safety & Schemas:**
   - All tool input parameters must be strictly validated using `Zod` schemas.
   - Run `pnpm tsc --noEmit` before proposing any PR to guarantee zero type errors.

6. **Quota & Turn Budgeting:**
   - Break work into small, incremental steps per turn (target ≤ 5 tool calls per turn) to stay well below API/turn quota limits.
   - Return checkpoints to the user between major steps (audit, implementation, verification/PR).

---

## 3. The Ingestion Contract

To add support for a new vehicle (e.g., Mercedes Sprinter, Ram ProMaster) or component (e.g., EcoFlow, Victron):
1. Place the official PDF in the ingestion pipeline.
2. The pipeline extracts text, crops high-resolution schematics to R2, chunks at ~500 tokens with 100-token overlap, and computes 768-dimensional embeddings via `@cf/baai/bge-base-en-v1.5`.
3. The server immediately supports the new hardware with **zero code changes, zero schema migrations, and zero manual data entry**.

---

## 4. Testing & Verification Standards

Before committing or submitting a PR, agents must ensure all quality gates pass:

1. **Unit Tests (`tests/unit/`):**
   - Every electrical or physical calculation function in `src/utils/formulas.ts` MUST have a unit test asserting exact compliance with ABYC E-11 standards.
   - Tool schemas must be tested to ensure default parameters (such as `top_k: 8`) are enforced.
2. **Integration Tests (`tests/integration/`):**
   - Verify that D1 search queries bind keywords cleanly without hardcoded parameter pollution.
   - Verify that embedding generation throws an error when the AI binding is unavailable.
3. **Post-Deployment Live Smoke Tests (`tests/live/`):**
   - Any live test must call `search_van_manuals` with explicit context (e.g. `model`, `model_year`) because the server asks instead of assuming it, and must assert `count === 8` by default for that call, that every result has a sane positive score (`0 < score <= 1`, strictly `score !== -1`), that the **best** result has `score > 0.60`, that the top results are topically about the query, and that `source` and `document_title` are populated (never `"unknown"`). Do **not** require every result to exceed 0.60: results are RRF-fused from vector and keyword rankings, so a chunk that ranks well on both can have a lower cosine score, and keyword-only candidates carry a fixed synthetic 0.75 (see `docs/engineering/retrieval-pipeline.md` §3). A per-result 0.60 floor only passed historically because synthetic scores masked missing semantic matches.
4. **Pre-Commit Verification:**
   - Run `pnpm lint` and `pnpm test`. Never commit code with known failing lint, typecheck, or test results.

---

## 5. Command Reference

- **Run Lint:** `pnpm lint`
- **Typecheck:** `pnpm tsc --noEmit`
- **Run Unit Tests:** `pnpm test:unit`
- **Run E2E / Integration Tests:** `pnpm test:e2e`
- **Run All Tests:** `pnpm test`
- **Run Post-Deploy Live Smoke Test:** `pnpm test:live`
- **Local Worker Dev:** `pnpm dev`
- **Apply Local D1 Migrations:** `npx cf d1 migrations apply 2aa73cfb-cf41-4ab3-b614-b0cf1eb7ec0c --dir d1/migrations --local --persist-to .wrangler/state`
- 


## 3. Retrieval & Search Architecture

1. **Strict `top_k` Contract with Forward Continuation Expansion:**
   - Technical manuals frequently introduce specification tables, wiring pinouts, or continuation rules in chunks following the section header (`#chunk_{N+1}`, `#chunk_{N+2}`).
   - `hydrateChunks` identifies top-ranked hits and stitches forward continuation chunks into the parent chunk context.
   - **Critical Invariant:** `hybridSearch` MUST strictly enforce `.slice(0, topK)` (default `8`) so that the array returned to the caller NEVER exceeds `top_k`.
2. **Stop-Word-Filtered Multi-Token RRF:**
   - Technical questions are tokenized by stripping standard English stop words (`where`, `what`, `are`, `the`, `for`, `and`, `with`, `regarding`, etc.) into distinct keywords of length >= 3.
   - D1 ranks chunks by multi-token match count across `chunk_text` and `section_title`.
   - Vector similarity ranks and keyword match ranks are fused via Reciprocal Rank Fusion (`RRF score = 1 / (60 + rank)`), ensuring multi-part questions retrieve chunks covering all parts of the user prompt.
3. **Progressive (Stepwise) Filter Relaxation:**
   - Filters relax in strict priority stages to prevent over-specific guesses (e.g. `category: "power"` on a chassis BEMM) from discarding relevant chunks or dropping all filters at once:
     - **Stage 1:** All provided filters (`category`, `subsystem`, `manufacturer`, `model`, `chassis`, `market`, `model_year`).
     - **Stage 2:** Drop `category` and `subsystem`, retaining `manufacturer`, `model`, `chassis`, `market`, and `model_year`.
     - **Stage 3:** Drop `chassis` and `model`, retaining `manufacturer`, `market`, and `model_year`.
     - **Stage 4:** Retain only `market` and `model_year`.
   - In model matching, exact model matches (`LOWER(model) = ?`, e.g. `"transit"`) are prioritized ahead of substring/prefix matches (`"transit_custom"`).
4. **Canonical Document Naming & R2 Object Renaming:**
   - Whenever manuals with cryptic vendor names (e.g., `2025-06.pdf`, `2027-eu-transit.pdf`) are ingested, `buildCanonicalManualName()` derives:
     - An unambiguous human-readable `documentTitle`: e.g. `"2025 Mercedes-Benz Sprinter (US, BM907)"`, `"2026 Ford Transit Custom (EU)"`, `"2027 Ford Transit (US)"`.
     - A clean canonical R2 key slug: e.g. `2025-mercedes-benz-sprinter-us-bm907.pdf`.
   - In `sync-r2-manuals.ts`, objects are renamed via `CopyObjectCommand` + `DeleteObjectCommand` *before* generating chunk IDs, schematics, and D1 rows, and the canonical key is recorded in `manuals_manifest.json`.
   - At query time in `src/utils/db.ts`, chunks are enriched dynamically with canonical titles, `model_year`, `market`, and `model`.
5. **No Assumed Context (ask, don't default):**
   - Never default a vehicle, manufacturer, model or **model year** (no "newest year"). **The one deliberate default is the market: US when none is specified** (applied at the tool layer and reported in `defaults_applied` so the LLM tells the user). When the best results come from several documents that differ in a facet the caller did not specify, `search_van_manuals` returns `needs_clarification: true` with `clarification` (missing facets, the choices found in the indexed documents, a `suggested_question`) and **no results**; the LLM asks the user, then calls again with filters (or `include_all_variants: true` to get every variant, each labelled with its own document title/year). This applies to every system (chassis, electrical, HVAC, plumbing, batteries, appliances). Implementation: `src/utils/disambiguation.ts` (`assessAmbiguity`) + `hybridSearchDetailed` in `src/utils/db.ts`; details in `docs/engineering/retrieval-pipeline.md` §9.
   - Do not add other defaults (`model_year`/`model`/`manufacturer`), "newest edition wins" ranking, or mock/fallback results naming a vehicle, or zero-vector embeddings (fail fast instead). Offline (`cf dev`, CI smoke) there is no Vectorize or embedding provider, so `search_van_manuals` must fail with a clear error there; `scripts/test-mcp-endpoints.sh` asserts exactly that, and real search is verified by the live post-deploy tests.
6. **Cross-Edition Near-Duplicate Deduplication:**
   - Only within a context the caller has already specified: near-identical chunks (>= 0.80 normalized token overlap) from overlapping editions are collapsed, keeping the newest `year_start`. It must never be used to silently choose between editions the caller has not distinguished (that case is a clarification).

## 4. Testing & Promptfoo Live Evaluation

1. **2-Turn MCP Evaluation Loop (`scripts/promptfoo-mcp-provider.mjs` & `promptfooconfig.yaml`):**
   - Promptfoo benchmark evaluations use a custom 2-turn MCP provider:
     - **Turn 1:** Sends the prompt to the candidate model (e.g., DeepSeek V4 Flash, Qwen 3.6 MoE) with declared MCP tool definitions and executes returned `tool_calls` live via JSON-RPC against the MCP server.
     - **Turn 2:** Appends the assistant `tool_calls` and `tool` role result messages to conversation history and calls the LLM again to synthesize a complete technical answer.
     - **Trace & Synthesis Output:** Outputs both the `MCP Tool Result (${toolName}): ...` execution trace and the synthesized final response, satisfying both tool invocation assertions and LLM rubric assertions.
