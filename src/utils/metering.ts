/**
 * API Key Authentication & Fractional Microcent Metering Service.
 *
 * Implements SHA-256 Bearer token hashing, D1 account lookup, pre-execution
 * balance verification, and race-safe balance deduction + usage ledger recording.
 */

export interface AccountRecord {
  id: string;
  balance_microcents: number;
  is_active: number;
}

/** Default cost in microcents ($0.002000) for RAG / database search tools */
export const SEARCH_TOOL_COST_MICROCENTS = 2000;

/** Default cost in microcents ($0.000500) for deterministic calculation tools */
export const DETERMINISTIC_TOOL_COST_MICROCENTS = 500;

/** Per-tool cost schedule in microcents (1,000,000 microcents = $1.00 USD) */
export const TOOL_COSTS_MICROCENTS: Record<string, number> = {
  // Hybrid RAG & D1 lookup tools ($0.002000)
  search_van_manuals: SEARCH_TOOL_COST_MICROCENTS,
  lookup_vehicle_electrical_specs: SEARCH_TOOL_COST_MICROCENTS,
  lookup_component_specs: SEARCH_TOOL_COST_MICROCENTS,
  get_component_by_model: SEARCH_TOOL_COST_MICROCENTS,

  // Deterministic math & OEM engineering rule tools ($0.000500)
  calculate_wire_gauge: DETERMINISTIC_TOOL_COST_MICROCENTS,
  calculate_dc_wire_and_fuse: DETERMINISTIC_TOOL_COST_MICROCENTS,
  validate_solar_array: DETERMINISTIC_TOOL_COST_MICROCENTS,
  calculate_van_payload: DETERMINISTIC_TOOL_COST_MICROCENTS,
  list_van_models: DETERMINISTIC_TOOL_COST_MICROCENTS,
  chassis_rules: DETERMINISTIC_TOOL_COST_MICROCENTS,
};

/**
 * Returns whether Bearer API-key authentication is enabled (`AUTH_ENABLED === "true"`).
 * Defaults to `false` (disabled) unless explicitly set to `"true"`.
 */
export function isAuthEnabled(authEnabled?: string): boolean {
  return authEnabled === "true";
}

/**
 * Determines whether the metering bypass flag (`METERING_ALLOW_ALL`) is active.
 * Defaults to `true` (allow all without balance check/deduction) unless explicitly set to `"false"`.
 */
export function isMeteringAllowAll(meteringAllowAll?: string): boolean {
  return meteringAllowAll !== "false";
}

/**
 * Returns the microcent cost for a given MCP tool name, or null if the tool is not recognized.
 */
export function getToolCostMicrocents(toolName: string): number | null {
  return Object.prototype.hasOwnProperty.call(TOOL_COSTS_MICROCENTS, toolName)
    ? TOOL_COSTS_MICROCENTS[toolName]!
    : null;
}

/**
 * Extracts a Bearer token from an HTTP Authorization header.
 * Returns null if the header is missing, not a Bearer scheme, or has an empty/multi-part token.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  return match?.[1] ?? null;
}

/**
 * Computes the lowercase hex-encoded SHA-256 digest of a raw API key.
 */
export async function hashApiKey(rawApiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawApiKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface MeteredToolCall {
  id: string | number | null;
  name: string;
  costMicrocents: number;
}

/**
 * Extracts all known `tools/call` invocations from a parsed JSON-RPC request body
 * (supports both single JSON-RPC objects and JSON-RPC batch arrays).
 */
export function extractMeteredToolCalls(payload: unknown): MeteredToolCall[] {
  const items = Array.isArray(payload) ? payload : [payload];
  const calls: MeteredToolCall[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const envelope = item as {
      id?: string | number | null;
      method?: unknown;
      params?: { name?: unknown };
    };
    if (envelope.method === "tools/call" && typeof envelope.params?.name === "string") {
      const cost = getToolCostMicrocents(envelope.params.name);
      if (cost !== null) {
        calls.push({
          id: envelope.id ?? null,
          name: envelope.params.name,
          costMicrocents: cost,
        });
      }
    }
  }

  return calls;
}

export type AuthCheckOutcome =
  | { ok: true; account: AccountRecord; apiKeyHash: string }
  | { ok: false; status: 401 | 402; error: string };

/**
 * Validates a raw API key against the D1 `accounts` table and (when `enforceBalance` is true)
 * verifies the account has sufficient microcent balance for the required cost.
 *
 * @param db                   - Cloudflare D1 database binding
 * @param rawApiKey            - Plaintext Bearer API key from the request
 * @param requiredMicrocents   - Minimum balance required when metering is enforced (defaults to 1)
 * @param enforceBalance       - When false (e.g., METERING_ALLOW_ALL="true"), skips the balance check
 */
export async function authenticateAndCheckBalance(
  db: D1Database,
  rawApiKey: string,
  requiredMicrocents = 1,
  enforceBalance = true
): Promise<AuthCheckOutcome> {
  const apiKeyHash = await hashApiKey(rawApiKey);
  const account = await db
    .prepare(
      "SELECT id, balance_microcents, is_active FROM accounts WHERE api_key_hash = ? AND is_active = 1"
    )
    .bind(apiKeyHash)
    .first<AccountRecord>();

  if (!account) {
    return {
      ok: false,
      status: 401,
      error: "Invalid or inactive API key",
    };
  }

  if (enforceBalance) {
    const minimumBalance = Math.max(1, requiredMicrocents);
    if (account.balance_microcents < minimumBalance) {
      return {
        ok: false,
        status: 402,
        error: "Insufficient account balance",
      };
    }
  }

  return { ok: true, account, apiKeyHash };
}

/**
 * Deducts the tool execution cost from `accounts.balance_microcents`
 * (guarded by `balance_microcents >= ?` so balance can never go negative)
 * and inserts an audit row into `usage_records`.
 *
 * Returns true if the balance deduction succeeded, or false if a concurrent request
 * exhausted the balance before the conditional UPDATE ran.
 */
export async function recordToolUsage(
  db: D1Database,
  accountId: string,
  toolName: string,
  costMicrocents: number,
  executionTimeMs: number
): Promise<boolean> {
  const safeDuration = Math.max(0, Math.round(executionTimeMs));
  const results = await db.batch([
    db
      .prepare(
        "UPDATE accounts SET balance_microcents = balance_microcents - ? WHERE id = ? AND is_active = 1 AND balance_microcents >= ?"
      )
      .bind(costMicrocents, accountId, costMicrocents),
    db
      .prepare(
        "INSERT INTO usage_records (account_id, tool_name, cost_microcents, execution_time_ms) SELECT ?, ?, ?, ? WHERE (SELECT changes()) > 0"
      )
      .bind(accountId, toolName, costMicrocents, safeDuration),
  ]);

  const updateMeta = (results[0] as { meta?: { changes?: number } } | undefined)?.meta;
  if (updateMeta && typeof updateMeta.changes === "number" && updateMeta.changes === 0) {
    return false;
  }
  return true;
}
