# AGENTS.md — System Architecture & Developer Agent Operating Rules

Welcome AI Agent. This repository contains a production-grade Model Context Protocol (MCP) server built with TypeScript, `@modelcontextprotocol/sdk`, and Cloudflare Workers (deployed via `cloudflare.config.ts`).

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

1. **Zero Vehicle-Specific Tables or Dictionaries (Anti-Hardcoding Rule):**
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
   - Any live test must assert that `search_van_manuals` returns positive cosine similarity scores (`score > 0.60`, strictly `score !== -1`), returns `count === 8` by default, and populates `source` and `document_title` (never `"unknown"`).
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
