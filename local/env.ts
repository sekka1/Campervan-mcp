/**
 * Local dev harness: builds a Worker `Env` whose D1 and Vectorize bindings are
 * shims over the Cloudflare REST API (the dev D1 / Vectorize), so the *local*
 * src/ code can be exercised without deploying.
 *
 * Required (from .campervan-d1.env): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
 * D1_DATABASE_ID, DEEPINFRA_TOKEN. Optional: VECTORIZE_INDEX_NAME, CDN_BASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const API = "https://api.cloudflare.com/client/v4/accounts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (load it via --env-file=.campervan-d1.env)`);
  return v;
}

async function cf(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/${need("CLOUDFLARE_ACCOUNT_ID")}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${need("CLOUDFLARE_API_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`Cloudflare ${path} failed (${res.status}): ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}

class RestStatement {
  params: unknown[] = [];
  constructor(readonly sql: string) {}
  bind(...p: unknown[]) {
    this.params = p;
    return this;
  }
  private async exec() {
    const dbId = need("D1_DATABASE_ID");
    const r = await cf(`d1/database/${dbId}/query`, { sql: this.sql, params: this.params });
    return r[0];
  }
  async all() {
    return this.exec();
  }
  async run() {
    return this.exec();
  }
  async first(col?: string) {
    const r = await this.exec();
    const row = r.results?.[0] ?? null;
    return col && row ? row[col] : row;
  }
}

const db = {
  prepare: (sql: string) => new RestStatement(sql),
  async batch(stmts: RestStatement[]) {
    const dbId = need("D1_DATABASE_ID");
    return cf(`d1/database/${dbId}/query`, { batch: stmts.map((s) => ({ sql: s.sql, params: s.params })) });
  },
};

const vectorIndex = {
  async query(vector: number[], opts: Record<string, unknown> = {}) {
    // Fail loudly: do not let callers silently fall back to mock results.
    const idx = process.env["VECTORIZE_INDEX_NAME"] ?? "van_manuals_index";
    const r = await cf(`vectorize/v2/indexes/${idx}/query`, { vector, ...opts });
    return { matches: r.matches ?? [], count: r.count ?? (r.matches ?? []).length };
  },
};

export function makeLocalEnv(): any {
  need("DEEPINFRA_TOKEN");
  return {
    DB: db,
    VECTOR_INDEX: vectorIndex,
    DEEPINFRA_TOKEN: process.env["DEEPINFRA_TOKEN"],
    EMBEDDING_PROVIDER: "deepinfra",
    CDN_BASE_URL: process.env["CDN_BASE_URL"] ?? "https://pub-655d7d799988450194dfe2dc6d5b1741.r2.dev",
    AUTH_ENABLED: "false",
    METERING_ALLOW_ALL: "true",
    ENVIRONMENT: "local",
  };
}
