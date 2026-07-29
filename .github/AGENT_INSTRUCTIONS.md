# Granular Code Construction Guidelines for AI Agents

## Tool Construction Standard

When adding a new tool to `src/tools/`, follow this exact pattern:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { calculateVoltageDrop } from "../utils/formulas.js";

export function registerElectricalTools(mcp: McpServer): void {
  mcp.tool(
    "calculate_wire_gauge",
    "Calculates recommended AWG wire size, fuse size, and voltage drop % based on electrical load and distance.",
    {
      current_amps: z.number().positive().describe("Total circuit current in Amperes"),
      length_feet: z.number().positive().describe("One-way wire distance in feet"),
      voltage: z.enum(["12", "24", "48"]).default("12").describe("System DC voltage"),
      allowable_drop_pct: z.number().min(1).max(10).default(3).describe("Max allowed voltage drop % (3% for critical, 10% non-critical)")
    },
    async (args) => {
      const result = calculateVoltageDrop(
        args.current_amps,
        args.length_feet,
        Number(args.voltage),
        args.allowable_drop_pct
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
```

## Pull Request Checklist for Agents

Before outputting code or opening a PR, perform these checks:

1. Did you write unit tests in `tests/unit/` covering edge cases (e.g., zero amps, negative numbers, missing values)?
2. Is the TypeScript code compatible with Cloudflare Workers (no Node.js filesystem (`fs`) imports unless using `node:` compatibility mode)?
3. Are all tool parameter schemas fully documented with `.describe()` strings so LLM clients understand input requirements?
4. Have you run `pnpm tsc --noEmit` to verify zero TypeScript errors?
5. Have you run `pnpm test:unit` and confirmed all tests pass?

## Directory Reference

| Path | Purpose |
|------|---------|
| `src/tools/` | MCP tool registration functions |
| `src/utils/formulas.ts` | Pure math functions (no side effects) |
| `src/utils/db.ts` | D1 and Vectorize helper wrappers |
| `d1/migrations/` | Sequential SQL schema migrations |
| `d1/seeds/` | Seed data for local development |
| `tests/unit/` | Vitest unit tests for formulas |
| `tests/e2e/` | Miniflare/Worker E2E test suite |
| `scripts/` | One-off utility scripts |

## Naming Conventions

- Tool names: `snake_case` (e.g., `calculate_wire_gauge`)
- TypeScript functions: `camelCase` (e.g., `calculateVoltageDrop`)
- Zod schemas: `PascalCase` suffixed with `Schema` (e.g., `WireGaugeInputSchema`)
- SQL tables: `snake_case` plural (e.g., `component_specs`)
- SQL columns: `snake_case` (e.g., `max_continuous_amps`)
