# AI Studio Agent Operating Rules

1. **Quota-Safe Turn Budgeting (Max 8–12 Tool Calls per Turn)**:
   - Always break work into logical, self-contained chunks per turn (target ≤ 8 tool calls per turn) to avoid hitting per-turn quota or rate limits.
   - Complete logical steps and return clear status checkpoints to the user.
2. **Test-First & Pre-Commit Verification (`sekka1/Campervan-mcp`)**:
   - Always run `pnpm typecheck`, `pnpm lint`, and `pnpm test` before committing or pushing changes.
