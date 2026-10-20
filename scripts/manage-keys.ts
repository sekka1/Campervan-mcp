#!/usr/bin/env node
/**
 * scripts/manage-keys.ts
 *
 * Operational CLI for Campervan MCP account provisioning, API key generation,
 * balance funding, and usage inspection backed by Cloudflare D1.
 *
 * Usage:
 *   npx tsx scripts/manage-keys.ts create [--id <account_id>] [--balance <microcents>] [--local]
 *   npx tsx scripts/manage-keys.ts fund --id <account_id> --amount <microcents> [--local]
 *   npx tsx scripts/manage-keys.ts inspect --id <account_id> [--local]
 *   npx tsx scripts/manage-keys.ts list [--local]
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const DEFAULT_DATABASE_ID = "2aa73cfb-cf41-4ab3-b614-b0cf1eb7ec0c";
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

export function generateRawApiKey(): string {
  return "cv_live_" + crypto.randomBytes(24).toString("hex");
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export interface D1Statement {
  sql: string;
  params: unknown[];
}

export function buildCreateAccountStatement(
  accountId: string,
  apiKeyHash: string,
  balanceMicrocents = 10000000
): D1Statement {
  return {
    sql: "INSERT INTO accounts (id, api_key_hash, balance_microcents, is_active) VALUES (?, ?, ?, 1)",
    params: [accountId, apiKeyHash, balanceMicrocents],
  };
}

export function buildFundAccountStatement(
  accountId: string,
  amountMicrocents: number
): D1Statement {
  return {
    sql: "UPDATE accounts SET balance_microcents = balance_microcents + ? WHERE id = ?",
    params: [amountMicrocents, accountId],
  };
}

export async function executeD1Remote(
  accountId: string,
  apiToken: string,
  databaseId: string,
  statement: D1Statement
): Promise<unknown> {
  const url = `${CLOUDFLARE_API_BASE}/${accountId}/d1/database/${databaseId}/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sql: statement.sql,
      params: statement.params,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare D1 REST API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { success: boolean; errors?: unknown[]; result?: unknown };
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  }
  return data.result;
}

export function executeD1Local(
  databaseId: string,
  statement: D1Statement
): string {
  let formattedSql = statement.sql;
  for (const param of statement.params) {
    const val = typeof param === "number" ? String(param) : `'${String(param).replace(/'/g, "''")}'`;
    formattedSql = formattedSql.replace("?", val);
  }

  return execFileSync(
    "npx",
    ["cf", "d1", "execute", databaseId, "--local", "--command", formattedSql],
    { encoding: "utf8" }
  );
}

export interface CliOptions {
  command: "create" | "fund" | "inspect" | "list";
  id?: string;
  balance?: number;
  amount?: number;
  local?: boolean;
  databaseId?: string;
}

export function parseCliArgs(args: string[]): CliOptions {
  const command = args[0] as CliOptions["command"];
  if (!["create", "fund", "inspect", "list"].includes(command)) {
    throw new Error("Invalid command. Expected create, fund, inspect, or list.");
  }

  const options: CliOptions = { command, local: false };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--local") {
      options.local = true;
    } else if (arg === "--id" && args[i + 1]) {
      options.id = args[++i];
    } else if (arg === "--balance" && args[i + 1]) {
      options.balance = parseInt(args[++i], 10);
    } else if (arg === "--amount" && args[i + 1]) {
      options.amount = parseInt(args[++i], 10);
    } else if (arg === "--database-id" && args[i + 1]) {
      options.databaseId = args[++i];
    }
  }

  return options;
}

export async function runManageKeys(options: CliOptions): Promise<{ rawKey?: string; message: string }> {
  const dbId = options.databaseId || process.env.D1_DATABASE_ID || DEFAULT_DATABASE_ID;

  if (options.command === "create") {
    const accountId = options.id || "acc_" + crypto.randomBytes(6).toString("hex");
    const rawKey = generateRawApiKey();
    const hash = hashApiKey(rawKey);
    const balance = options.balance ?? 10000000;
    const stmt = buildCreateAccountStatement(accountId, hash, balance);

    if (options.local) {
      executeD1Local(dbId, stmt);
    } else {
      const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
      const cfToken = process.env.CLOUDFLARE_API_TOKEN;
      if (!cfAccount || !cfToken) {
        throw new Error("Remote D1 requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or pass --local)");
      }
      await executeD1Remote(cfAccount, cfToken, dbId, stmt);
    }

    return {
      rawKey,
      message: `Account created successfully!\nAccount ID: ${accountId}\nInitial Balance: ${balance} microcents ($${(balance / 1000000).toFixed(6)} USD)\nAPI Key: ${rawKey}\n(Save this key now — it cannot be recovered)`,
    };
  }

  if (options.command === "fund") {
    if (!options.id) throw new Error("--id is required for fund command");
    if (typeof options.amount !== "number" || isNaN(options.amount)) {
      throw new Error("--amount <microcents> is required for fund command");
    }

    const stmt = buildFundAccountStatement(options.id, options.amount);
    if (options.local) {
      executeD1Local(dbId, stmt);
    } else {
      const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
      const cfToken = process.env.CLOUDFLARE_API_TOKEN;
      if (!cfAccount || !cfToken) {
        throw new Error("Remote D1 requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or pass --local)");
      }
      await executeD1Remote(cfAccount, cfToken, dbId, stmt);
    }

    return {
      message: `Funded account ${options.id} with ${options.amount} microcents ($${(options.amount / 1000000).toFixed(6)} USD).`,
    };
  }

  if (options.command === "inspect" || options.command === "list") {
    const sql =
      options.command === "inspect"
        ? `SELECT id, balance_microcents, is_active, created_at FROM accounts WHERE id = '${options.id}'`
        : "SELECT id, balance_microcents, is_active, created_at FROM accounts ORDER BY created_at DESC LIMIT 20";

    const stmt: D1Statement = { sql, params: [] };
    if (options.local) {
      const output = executeD1Local(dbId, stmt);
      return { message: output };
    } else {
      const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
      const cfToken = process.env.CLOUDFLARE_API_TOKEN;
      if (!cfAccount || !cfToken) {
        throw new Error("Remote D1 requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or pass --local)");
      }
      const res = await executeD1Remote(cfAccount, cfToken, dbId, stmt);
      return { message: JSON.stringify(res, null, 2) };
    }
  }

  throw new Error("Unsupported command");
}

if (require.main === module) {
  const options = parseCliArgs(process.argv.slice(2));
  runManageKeys(options)
    .then((res) => {
      console.log(res.message);
    })
    .catch((err) => {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    });
}
