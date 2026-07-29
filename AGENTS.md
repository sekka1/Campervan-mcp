# AGENTS.md — System Architecture & Developer Agent Operating Rules

Welcome AI Agent. This repository contains a production-grade Model Context Protocol (MCP) server built with TypeScript, `fastmcp/edge`, and Cloudflare Workers.

## Core Rules for Agents

1. **Deterministic Calculations over Generation**:
   - Math for wire sizing, electrical drop, fuse protection, and weight capacity MUST be implemented in pure TypeScript helper functions inside `src/utils/formulas.ts`.
   - Never let an LLM guess mathematical values. Always return strict numerical answers with clear unit strings (e.g., `AWG`, `Volts`, `lbs`).

2. **Database Integrity**:
   - D1 schema updates MUST be written as sequential, non-destructive SQL files in `d1/migrations/` (e.g., `0002_add_heater_specs.sql`).
   - Never modify existing migration files after they have been merged. Always add a new numbered migration file.

3. **Type Safety & Schemas**:
   - All tool input parameters must be strictly validated using `Zod` schemas.
   - Run `pnpm tsc --noEmit` before proposing any PR to guarantee zero type errors.

4. **Testing Thresholds**:
   - Every new electrical or weight calculation function added to `src/utils/formulas.ts` MUST have a corresponding unit test in `tests/unit/`.
   - PRs with failing unit or E2E tests will not be merged.

5. **Pre-Commit Verification**:
   - Before committing any code change, run `pnpm lint` and `pnpm test` (or the more targeted `pnpm tsc --noEmit`, `pnpm test:unit`, `pnpm test:e2e`).
   - If lint or tests fail, fix the underlying issues first, then re-run lint and tests to confirm they pass before committing.
   - Never commit code with known failing lint or test results.

## Command Reference
- **Run Lint:** `pnpm lint`
- **Run Unit Tests:** `pnpm test:unit`
- **Run E2E Tests:** `pnpm test:e2e`
- **Run All Tests:** `pnpm test`
- **Local Worker Dev:** `pnpm dev`
- **Apply Local D1 Migrations:** `npx wrangler d1 migrations apply DB --local`
