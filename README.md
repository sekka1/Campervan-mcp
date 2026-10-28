# Campervan MCP Workspace & Manuals Pipeline

This repository hosts the ingestion and embedding pipelines for campervan manuals, synchronizing documentation with Vectorize and D1 storage backends.

---

## Embedding Configuration

The embedding pipeline supports a configurable provider switch between **DeepInfra** and **Cloudflare Workers AI**. Both backends generate identical **768-dimensional vectors** using the `BAAI/bge-base-en-v1.5` architecture (`@cf/baai/bge-base-en-v1.5` on Cloudflare), preventing index drift across backends.

### Provider Comparison

| Provider | Model Identifier | Vector Dimensions | Environment Variables Required |
| :--- | :--- | :--- | :--- |
| **DeepInfra** *(Default)* | `BAAI/bge-base-en-v1.5` | `768` | `DEEPINFRA_TOKEN` |
| **Cloudflare Workers AI** | `@cf/baai/bge-base-en-v1.5` | `768` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |

### Provider Selection

Set the `EMBEDDING_PROVIDER` environment variable to either `"deepinfra"` or `"cloudflare"`. If omitted or empty, the pipeline automatically defaults to `"deepinfra"`.

```bash
# Explicitly set to DeepInfra
export EMBEDDING_PROVIDER="deepinfra"

# Or toggle to Cloudflare Workers AI
export EMBEDDING_PROVIDER="cloudflare"
```

---

## Running Manual Syncs Locally

You can run the manuals sync pipeline directly using `npx tsx`:

### 1. Default Provider (DeepInfra)
```bash
DEEPINFRA_TOKEN="your_deepinfra_token" npx tsx scripts/sync-r2-manuals.ts
```

### 2. Fallback Provider (Cloudflare Workers AI)
```bash
EMBEDDING_PROVIDER="cloudflare" \
CLOUDFLARE_ACCOUNT_ID="your_account_id" \
CLOUDFLARE_API_TOKEN="your_api_token" \
npx tsx scripts/sync-r2-manuals.ts
```

---

## Testing & Quality Assurance

In accordance with our repository verification rules, execute the full test suite and type checker:

```bash
# Run Vitest unit tests (covers mock fetch, payload formats, dimension checks, token validation)
pnpm test

# Run static type verification
pnpm typecheck

# Run linter
pnpm lint
```

---

## GitHub Actions Automated Ingestion

The `.github/workflows/sync-r2.yml` workflow triggers scheduled or manual synchronizations. It reads:
- `vars.EMBEDDING_PROVIDER` (defaults to `deepinfra`)
- `secrets.DEEPINFRA_TOKEN`
- `secrets.CLOUDFLARE_ACCOUNT_ID`
- `secrets.CLOUDFLARE_API_TOKEN`

To manually trigger a sync:
```bash
gh workflow run "sync-r2" --ref main
```
