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

## Linting

```bash
pnpm lint
```

Uses ESLint 9 flat config (`eslint.config.mjs`) with `typescript-eslint` recommended rules.

## Deployment

Update `wrangler.toml` with your own D1 `database_id`, then deploy:

```bash
pnpm deploy
```

## Ingesting Documentation

Vectorize search results are populated from PDF/HTML manuals using the ingestion script:

```bash
npx wrangler vectorize create van_manuals_index --dimensions=384 --metric=cosine
npx tsx scripts/ingest-docs.ts --source ./docs/transit-body-builder.pdf --name ford_transit_body_builder
```

Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for repository conventions and rules that apply to automated/AI contributors (deterministic calculations, migration policy, schema validation with Zod, and testing thresholds), which are also good practices for human contributors.
