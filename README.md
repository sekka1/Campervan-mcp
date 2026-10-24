# Campervan-mcp

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for campervan/DIY-van-build technical and electrical planning, built with TypeScript and deployed on [Cloudflare Workers](https://workers.cloudflare.com/).

It gives AI assistants (Claude, etc.) tool access to deterministic electrical calculations, payload/weight capacity checks, a component specs database (Cloudflare D1), and semantic search over van build manuals and documentation (Cloudflare Vectorize).

## Connecting to the Live Server

You can connect directly to the live production MCP server from Claude Desktop, Cursor, or any MCP-compatible client using the configuration below:

```json
{
  "mcpServers": {
    "campervan": {
      "url": "https://campervan-mcp-server.garlandk.workers.dev/",
      "transport": "streamable-http"
    }
  }
}
```

### Quick Test via cURL

Verify connectivity and inspect available tools:

```bash
curl -X POST https://campervan-mcp-server.garlandk.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}'
```

## Features

- **Deterministic calculations** — All electrical, wire sizing, and weight math is implemented in pure TypeScript (`src/utils/formulas.ts`), never left to LLM guesswork.
- **Component spec lookup** — Query a D1-backed relational database of electrical/mechanical component specs (busbars, inverters, heaters, etc.).
- **Semantic manual search** — Search vectorized PDF/HTML documentation (wiring diagrams, body builder guides, error codes) via Cloudflare Vectorize.
- **Stateless HTTP transport** — Uses the MCP Streamable HTTP transport, well suited to Cloudflare Workers' request/response model.

## Tools

| Tool | Description | Cost (Microcents) |
| --- | --- | --- |
| `search_van_manuals` | Searches vetted OEM vehicle manuals (Ford Transit, Mercedes Sprinter, Ram ProMaster), electrical components (Victron, Renogy, REDARC), and upfitter standards. Returns authoritative text chunks, torque specs, part numbers, and verbatim schematic diagram links. | 2,000 ($0.002) |
| `calculate_dc_wire_and_fuse` | Deterministic ABYC E-11 DC cable gauge (AWG 16 to 4/0), 105°C engine compartment derating, exact voltage drop %, and fuse form factor sizing (ATC, MIDI, MEGA, MRBF, Class T). | 500 ($0.0005) |
| `inspect_manual_chunks` | Diagnostic endpoint for inspecting raw ingested manual chunks in Cloudflare D1 using SQL text pattern matching. | 2,000 ($0.002) |

## Architecture

```
src/
├── index.ts            # Worker entrypoint — wires up McpServer + Streamable HTTP transport
├── tools/
│   ├── electrical.ts    # calculate_dc_wire_and_fuse (Universal Electrical Math)
│   └── manuals.ts       # search_van_manuals (Universal Semantic Retrieval) & inspect_manual_chunks
└── utils/
    ├── formulas.ts      # Pure TypeScript electrical math (ABYC E-11 tables, voltage drop, fuses)
    ├── db.ts            # D1 database & Vectorize hybrid search helpers
    └── metering.ts      # API key authentication & fractional microcent metering

d1/
├── migrations/          # Sequential, non-destructive D1 schema migrations
└── seeds/               # Seed data for component_specs table

scripts/
└── ingest-docs.ts       # Ingests PDF/HTML docs into Vectorize for RAG search

tests/
├── unit/                # Unit tests for formulas and tools
└── e2e/                 # End-to-end tests against the MCP HTTP endpoints
```

The server binds to two Cloudflare resources (see `cloudflare.config.ts`):

- **D1** (`DB`) — relational database of component specs.
- **Vectorize** (`VECTOR_INDEX`) — vector index of chunked manual/documentation text, with an optional Workers AI (`AI`) binding for embeddings.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers, D1, and Vectorize enabled (for deployment)
- [`cf` CLI](https://blog.cloudflare.com/cloudflare-cf-cli-launch) (installed as a dev dependency; it exposes the entire Cloudflare API and delegates builds to Wrangler, which is also a dev dependency). Configuration lives in `cloudflare.config.ts` (replaces `wrangler.toml`).

## Getting Started

Install dependencies:

```bash
pnpm install
```

Run the worker locally:

```bash
pnpm dev
```

Apply D1 migrations locally:

```bash
npx cf d1 migrations apply 2aa73cfb-cf41-4ab3-b614-b0cf1eb7ec0c --dir d1/migrations --local --persist-to .wrangler/state
```

Type-check the project:

```bash
pnpm tsc --noEmit
```

## Testing

```bash
pnpm test          # run all tests (unit + e2e)
pnpm test:unit      # unit tests only
pnpm test:e2e       # end-to-end tests only
pnpm test:coverage  # unit tests with coverage
```

### Server Smoke Test

`scripts/smoke-test-server.sh` spins up the worker locally with `cf dev`,
applies local D1 migrations, and exercises the live MCP JSON-RPC endpoints
(`initialize`, `tools/list`, and several `tools/call` requests) to verify the
server actually runs end-to-end. Run it locally:

```bash
./scripts/smoke-test-server.sh
```

This same script runs in the [`MCP Server Smoke Test`](./.github/workflows/server-smoke-test.yml)
GitHub Actions workflow, which can be triggered manually (`workflow_dispatch`)
or automatically on pull requests.

## Linting

```bash
pnpm lint
```

Uses ESLint 9 flat config (`eslint.config.mjs`) with `typescript-eslint` recommended rules.

## Deployment

Deployment uses two GitHub Actions pipelines with `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` configured as repository secrets:

1. **[`Setup Cloudflare Infrastructure`](./.github/workflows/setup-infrastructure.yml)**
   (`workflow_dispatch`, manual) — a one-time bootstrap pipeline that creates
   the D1 database, the Vectorize index, and the `category`/`doc_type`
   metadata indexes on that Vectorize index (required for metadata filtering)
   if they don't already exist. Run it once from the **Actions** tab, then
   copy the printed `id` into `cloudflare.config.ts` (and the D1 migration commands in the workflows), commit, and push to
   `main`.
2. **[`Deploy to Production`](./.github/workflows/deploy-production.yml)**
   (runs automatically on every push to `main`) — applies any new D1
   migrations in `d1/migrations/` and deploys the Worker.

To deploy manually instead, update `cloudflare.config.ts` with your own D1
`id`, then run:

```bash
pnpm deploy
```


## API Key Authentication & Metering

The server includes pre-funded API key authentication and fractional microcent metering backed by Cloudflare D1 (`accounts` and `usage_records` tables).

### Feature Flags (`cloudflare.config.ts`)

- **`AUTH_ENABLED`** (default `"false"` during testing): Set to `"true"` to require a valid `Authorization: Bearer cv_live_...` API key on all requests.
- **`METERING_ALLOW_ALL`** (default `"true"` during testing): Set to `"false"` to enforce preflight balance verification and atomic per-tool microcent deductions.

### Account & Key Management CLI (`scripts/manage-keys.ts`)

Use the operational CLI to provision accounts, generate cryptographically secure API keys, and manage balances:

```bash
# Create a new account with default $10.00 (10,000,000 microcents) balance locally:
npx tsx scripts/manage-keys.ts create --local

# Create an account on remote Cloudflare D1 with custom balance:
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npx tsx scripts/manage-keys.ts create --id my_client --balance 5000000

# Fund an existing account with additional microcents:
npx tsx scripts/manage-keys.ts fund --id my_client --amount 2500000 --local

# Inspect account balance and status:
npx tsx scripts/manage-keys.ts inspect --id my_client --local
```

## Ingesting Documentation

### Universal Document Metadata & Naming Convention

All manuals in the ingestion pipeline are indexed using a universal classification model:
- **Four Universal Tags**: `category` (`chassis`, `climate`, `power`, `plumbing`, `other`), `manufacturer` (e.g. `ford`, `mercedes`, `espar`, `victron`), `model` (e.g. `transit`, `sprinter`, `airtronic_s2`, `multiplus_ii`), and `market` (`us`, `eu`, `global`).
- **Flexible Metadata Pouch (`metadata_json`)**: Stores model year ranges (`year_start`, `year_end`), chassis codes (`V363N`, `VS30`), voltage, and fuel types.

#### Document Naming Convention (Tier 1 Fast Path)
Files named according to `{category}_{manufacturer}_{model}_{market}_{extra}.pdf` are deterministically parsed without AI calls:
- `chassis_ford_transit_us_2020-2024.pdf` → Category: `chassis`, Manufacturer: `ford`, Model: `transit`, Market: `us`, `year_start: 2020`, `year_end: 2024`
- `climate_espar_airtronic-s2_global_diesel-12v.pdf` → Category: `climate`, Manufacturer: `espar`, Model: `airtronic-s2`, Market: `global`, `fuel: diesel`, `voltage: 12`

#### AI Cover-Page Pass (Tier 2 Fallback)
For non-conforming filenames (e.g., `MY24_Transit_BEMM_V363N_20APR24_J2_V2_R2.pdf`), the pipeline extracts plain text from Pages 1 and 2 and classifies the document using DeepInfra (`deepseek-ai/DeepSeek-V4-Flash-0731`).
> **Secret Requirement**: Set `DEEPINFRA_TOKEN` in repository secrets to enable automatic DeepInfra cover-page classification during GitHub Actions ingestion.

### Automated PDF Manual Ingestion (GitOps)

PDF manuals placed in `docs/manuals/*.pdf` are automatically parsed, chunked, embedded, and
synced to the `van_manuals_index` Vectorize index by the `.github/workflows/ingest-manuals.yml`
workflow whenever they are added, modified, or deleted on `main`. PDF parsing and chunking happen
in the GitHub Actions runner (not the Cloudflare Worker) to avoid edge CPU limits.

```bash
npx cf vectorize create --name=van_manuals_index --index-config-dimensions=768 --index-config-metric=cosine

# Ingest / update manuals
npx tsx scripts/ingest-manuals.ts --added-modified "docs/manuals/velit-heater-manual.pdf"

# Remove manuals that were deleted
npx tsx scripts/ingest-manuals.ts --deleted "docs/manuals/old-manual.pdf"
```

Each chunk is embedded via the Cloudflare Workers AI REST API (`@cf/baai/bge-base-en-v1.5`,
768 dimensions) and upserted into Vectorize with a deterministic vector ID
(`{sanitized_filename}#chunk_{index}`), so re-ingesting an updated manual overwrites its
previous chunks. Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment
variables.

#### Metadata Schema

Every vector upserted by `ingest-manuals.ts` or `sync-r2-manuals.ts` carries the following
metadata, so results can be filtered by document type/category in addition to full-text search:

```json
{
  "filename": "travel/vancouver_island.pdf",
  "manual_title": "Vancouver Island",
  "title": "Vancouver Island",
  "doc_type": "road_trip_guide",
  "category": "travel",
  "chunk_index": 0,
  "total_chunks": 12,
  "text": "Raw extracted text chunk...",
  "chassis": "universal",
  "subsystem": "12v_dc"
}
```

Chunks are ~500 words with 100 words of overlap. `chassis` (`transit`, `sprinter`, `promaster`,
or `universal`) is inferred from the file path and `subsystem` (one of the D1 `subsystem` values,
default `chassis_interface`) from the chunk text.

When `D1_DATABASE_ID` is set (plus a `CLOUDFLARE_API_TOKEN` with D1 edit permission), both
ingestion scripts also write the `documents` and `document_chunks` rows via the D1 REST API,
using the Vectorize vector ID as `document_chunks.id`. Without it, only Vectorize is updated.

With D1 enabled, ingestion also extracts schematic-sized images (≥100×100 px, up to 3 per page)
from each PDF, uploads them as PNGs to R2 under `schematics/<document_id>/p<page>-<n>.png`
(bucket `R2_BUCKET_NAME`, default `campervan-mcp`), writes `schematic_images` rows, links
`document_chunks.schematic_image_id` to the first image on the chunk's page, and fills
`section_title` from the first heading-like line on the page. Set the `CDN_BASE_URL` Worker
variable to a public URL serving the bucket and `search_van_manuals` results will include a
`schematic_url` next to `schematic_r2_key`.

`doc_type`/`category` are inferred from the file's folder prefix:

| Path prefix                  | `doc_type`        | `category`  |
| ----------------------------- | ----------------- | ----------- |
| `travel/`, `guides/`           | `road_trip_guide`  | `travel`    |
| `specs/`, `hardware/`          | `product_spec`     | `hardware`  |
| `manuals/` or anything else    | `manual`           | `technical` |

Filtering on `category`/`doc_type` requires Vectorize metadata indexes, which the
`setup-infrastructure.yml` workflow creates automatically:

```bash
npx cf vectorize metadata-index create van_manuals_index --property-name=category --index-type=string
npx cf vectorize metadata-index create van_manuals_index --property-name=doc_type --index-type=string
npx cf vectorize metadata-index create van_manuals_index --property-name=chassis --index-type=string
npx cf vectorize metadata-index create van_manuals_index --property-name=subsystem --index-type=string
```

### Manual R2 Bucket Sync (Large Manuals)

Large PDF manuals (too big to comfortably commit to the git repo) can instead be uploaded to
the `campervan-mcp` Cloudflare R2 bucket, including nested subfolders (e.g.
`heaters/velit-2026.pdf` or `electrical/victron/multiplus.pdf`). Run the
**Manual Sync R2 Manuals to Vectorize** workflow (`.github/workflows/sync-r2.yml`) from the
GitHub Actions UI (`workflow_dispatch`) to recursively list the bucket, diff it against a
manifest persisted in R2, and stream/chunk/embed/upsert only the added or modified PDFs while
deleting vectors for any PDFs removed from the bucket.

```bash
# Sync R2 bucket manuals (uses R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY for the R2
# S3-compatible access, and CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN for the
# Workers AI / Vectorize REST APIs)
npx tsx scripts/sync-r2-manuals.ts

# Preview the diff without embedding/upserting anything
npx tsx scripts/sync-r2-manuals.ts --dry-run

# Force re-indexing of every PDF in the bucket, ignoring the manifest cache
npx tsx scripts/sync-r2-manuals.ts --force-reindex
```

Vector IDs are derived from the full R2 object key (subfolder path included), e.g.
`electrical_victron_multiplus_pdf#chunk_0`, so nested manuals with the same filename in
different folders don't collide.

### Legacy Ad-Hoc Ingestion Script

Older HTML/PDF sources can still be ingested individually using the legacy script:

```bash
npx tsx scripts/ingest-docs.ts --source ./docs/transit-body-builder.pdf --name ford_transit_body_builder
```

Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for repository conventions and rules that apply to automated/AI contributors (deterministic calculations, migration policy, schema validation with Zod, and testing thresholds), which are also good practices for human contributors.
