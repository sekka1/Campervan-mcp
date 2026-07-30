# Campervan-mcp

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for campervan/DIY-van-build technical and electrical planning, built with TypeScript and deployed on [Cloudflare Workers](https://workers.cloudflare.com/).

It gives AI assistants (Claude, etc.) tool access to deterministic electrical calculations, payload/weight capacity checks, a component specs database (Cloudflare D1), and semantic search over van build manuals and documentation (Cloudflare Vectorize).

## Features

- **Deterministic calculations** — All electrical, wire sizing, and weight math is implemented in pure TypeScript (`src/utils/formulas.ts`), never left to LLM guesswork.
- **Component spec lookup** — Query a D1-backed relational database of electrical/mechanical component specs (busbars, inverters, heaters, etc.).
- **Semantic manual search** — Search vectorized PDF/HTML documentation (wiring diagrams, body builder guides, error codes) via Cloudflare Vectorize.
- **Stateless HTTP transport** — Uses the MCP Streamable HTTP transport, well suited to Cloudflare Workers' request/response model.

## Tools

| Tool | Description |
| --- | --- |
| `calculate_wire_gauge` | Calculates recommended AWG wire size, conductor resistance, voltage drop percentage, and fuse sizing for a DC circuit based on electrical load, wire run distance, and system voltage. |
| `validate_solar_array` | Validates a solar panel string configuration (series/parallel) against MPPT charge controller specifications, checking cold-weather open-circuit voltage (Voc) safety and current limits. |
| `calculate_van_payload` | Calculates total component weight against vehicle GVWR for Sprinter, Transit, and Promaster vans. Returns remaining payload capacity and estimated axle load distribution. |
| `list_van_models` | Lists all supported van models with their GVWR, curb weight, maximum payload, and axle ratings. |
| `lookup_component_specs` | Queries the D1 database for component specifications including terminal stud sizes, max continuous amp ratings, dimensions, and idle power draw. |
| `get_component_by_model` | Retrieves exact specifications for a component by its model number from the D1 database. |
| `search_van_manuals` | Searches the vector database of campervan documentation using semantic similarity (wiring diagrams, error codes, body builder guides, equipment manuals). |

## Architecture

```
src/
├── index.ts            # Worker entrypoint — wires up McpServer + HTTP transport
├── tools/
│   ├── electrical.ts    # Wire gauge & solar array validation tools
│   ├── payload.ts       # Van payload/weight capacity tools
│   ├── specs.ts         # D1-backed component spec lookup tools
│   └── manuals.ts       # Vectorize-backed semantic manual search tool
└── utils/
    ├── formulas.ts      # Pure TypeScript electrical/weight calculation helpers
    └── db.ts            # D1 database helpers

d1/
├── migrations/          # Sequential, non-destructive D1 schema migrations
└── seeds/               # Seed data for component_specs table

scripts/
└── ingest-docs.ts       # Ingests PDF/HTML docs into Vectorize for RAG search

tests/
├── unit/                # Unit tests for formulas and tools
└── e2e/                 # End-to-end tests against the MCP HTTP endpoints
```

The server binds to two Cloudflare resources (see `wrangler.toml`):

- **D1** (`DB`) — relational database of component specs.
- **Vectorize** (`VECTOR_INDEX`) — vector index of chunked manual/documentation text, with an optional Workers AI (`AI`) binding for embeddings.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers, D1, and Vectorize enabled (for deployment)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)

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
npx wrangler d1 migrations apply DB --local
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

`scripts/smoke-test-server.sh` spins up the worker locally with `wrangler dev`,
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
   copy the printed `database_id` into `wrangler.toml`, commit, and push to
   `main`.
2. **[`Deploy to Production`](./.github/workflows/deploy-production.yml)**
   (runs automatically on every push to `main`) — applies any new D1
   migrations in `d1/migrations/` and deploys the Worker.

To deploy manually instead, update `wrangler.toml` with your own D1
`database_id`, then run:

```bash
pnpm deploy
```

## Ingesting Documentation

### Automated PDF Manual Ingestion (GitOps)

PDF manuals placed in `docs/manuals/*.pdf` are automatically parsed, chunked, embedded, and
synced to the `van_manuals_index` Vectorize index by the `.github/workflows/ingest-manuals.yml`
workflow whenever they are added, modified, or deleted on `main`. PDF parsing and chunking happen
in the GitHub Actions runner (not the Cloudflare Worker) to avoid edge CPU limits.

```bash
npx wrangler vectorize create van_manuals_index --dimensions=768 --metric=cosine

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
  "text": "Raw extracted text chunk..."
}
```

`doc_type`/`category` are inferred from the file's folder prefix:

| Path prefix                  | `doc_type`        | `category`  |
| ----------------------------- | ----------------- | ----------- |
| `travel/`, `guides/`           | `road_trip_guide`  | `travel`    |
| `specs/`, `hardware/`          | `product_spec`     | `hardware`  |
| `manuals/` or anything else    | `manual`           | `technical` |

Filtering on `category`/`doc_type` requires Vectorize metadata indexes, which the
`setup-infrastructure.yml` workflow creates automatically:

```bash
npx wrangler vectorize create-metadata-index van_manuals_index --property-name=category --type=string
npx wrangler vectorize create-metadata-index van_manuals_index --property-name=doc_type --type=string
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
