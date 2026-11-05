# Retrieval Pipeline: How `search_van_manuals` Works (and Why)

> **Read this before changing anything in `src/utils/db.ts`, `src/tools/manuals.ts`, or the
> powertrain/schematic logic in `scripts/ingest-manuals.ts`.**
> To reproduce/debug retrieval against real data without deploying, see
> [`local-dev-loop.md`](./local-dev-loop.md).

Everything here is **vehicle- and component-agnostic by design** (AGENTS.md §1–2). The Ford Transit
2024 grounding example is used throughout only as a worked case study, because it exercised every
part of the pipeline. Sprinter, ProMaster/Ram, Victron, HVAC, plumbing, etc. go through the same code.

---

## 1. Data model (what is actually in D1 / Vectorize / R2)

| Store | Content | Notes |
|---|---|---|
| D1 `documents` | one row per PDF | `title`, `category`, `manufacturer`, `model`, `market`, `metadata_json` |
| D1 `document_chunks` | ~500-token chunks | id = `<doc_slug>#chunk_<N>` (N is sequential **in page order**, so `chunk_N+1` is usually the next piece of text) |
| D1 `schematic_images` | one row per extracted page image | `r2_key` e.g. `schematics/<doc>/p151-0.png` |
| Vectorize `van_manuals_index` | 768-dim `@cf/baai/bge-base-en-v1.5` embeddings | metadata carries `source`, `page`, `section`, `text` |
| R2 | raw PDFs + schematic PNGs | public CDN base = `CDN_BASE_URL` |

Per-chunk `metadata_json` is the flexible pouch: `{"year_start":2024,"powertrain":"ice"|"bev"|"all","fuel":...}`.

**Gotchas about stored data (all verified against dev D1):**
- `section_title` is **noisy**: it can be a real heading (`4.25 Grounding`), a page footer
  (`4 Electrical151`), a table row (`1 Front Floor/Turret/Fender…`) or `null`. Never rely on it alone to
  decide section membership; use numbered headings found in `chunk_text` (see §5).
- A page's diagram is a chunk of its own when the figure is just labels/numbers (e.g. Transit p151 text is
  `E185976 rev1 63 6462 66 …`). Such chunks are semantically "empty" and almost never rank on their own.
- Manuals repeat page boilerplate on **every** page: the `Abc = BEV Only  Abc = ICE Only` legend and the
  `FORD TRANSIT & E-TRANSIT` banner. This text is stripped before classification (`stripPageBoilerplate`) and,
  as a side effect, also inflates naive keyword matches for words like `ford`, `transit`, `2024`.
- A chunk that merely *mentions* BEV (e.g. "On E-Transit BEV, for low voltage applications…") is tagged `bev`
  even if it is the intro of a section that also covers ICE. This is correct per the marker rules and is the
  root cause of the problem fixed in PR #74 (§5).

## 2. Ingestion-time powertrain tagging (`scripts/ingest-manuals.ts`)

`classifyPowertrainText(text)` → `"bev" | "ice" | "all" | undefined`:
- strip boilerplate → test `BEV_MARKER_REGEX` and `COMBUSTION_MARKER_REGEX`.
- BEV markers only → `bev`; ICE markers only → `ice`; both → `all` (shared/neutral); neither → `undefined`
  (caller defaults to `ice` for non-universal chassis, `all` for universal).
- Images: an image is BEV only if its page is BEV-only (or its caption/key says BEV).
  Chunk→image binding: BEV chunk gets a BEV image; ICE chunk only a non-BEV image; others the first on the page.

**Re-ingesting does not change tags unless this code changes.** Tags are a pure function of chunk text.
(PR #73 fixed this function; existing data had already been correctly re-tagged. `scripts/patch-powertrain-metadata.ts`
exists for patching rows without re-embedding.) If retrieval is wrong, do **not** assume "re-ingest" is the fix:
check what the tags actually are first (`local:sql`, see local-dev-loop.md).

## 3. Query-time pipeline (`hybridSearch` in `src/utils/db.ts`)

Order of operations (every step is a place a chunk can be lost; use `pnpm local:trace` to see stages 1–3):

1. **Embed** the query (`DEEPINFRA_TOKEN`/BGE; or Workers AI `env.AI`). Embedding failure must throw (AGENTS.md: no zero-vectors).
2. **Vector search** `searchManuals` → Vectorize `topK = candidatePoolSize = max(topK*3, 24)` (pool is wider than
   `top_k` precisely so post-filters don't starve the result, PR #72).
3. **Keyword search** `searchD1KeywordCandidates`: stop-word-filtered tokens (≥3 chars), scores chunks by
   token hits in `chunk_text` (+2) and `section_title` (+3). Respects category/manufacturer/model/market/year filters.
4. **RRF fusion** `reciprocalRankFusion` (`1/(60+rank)`). Keyword-only hits get a **synthetic score of 0.75**
   (that is why many results show exactly `0.750`; it is not a cosine score).
5. **Hydrate** `hydrateChunks`: loads chunk + document + schematic rows with **progressive filter relaxation**
   (all filters → drop category/subsystem → drop model/chassis → market+year only), then stitches forward
   continuation text (`chunk_N+1`, `+2`) onto top hits and cue-bearing chunks — but **only across compatible
   powertrains** (`arePowertrainsCompatible`).
6. **`promoteNonBevNeighbors`** (PR #74, non-BEV queries only) — see §5.
7. **Dedup** `deduplicateCrossEditionChunks`: drops near-identical chunks across model years (keeps newest);
   never collapses BEV with ICE (PR #72).
8. **Sort**: exact model match → US/global market preference → ICE-before-BEV (unless the query has BEV
   indicators) → score (only when `model` is set or the market preference is `us`/unspecified; with e.g. `market: "eu"` and no `model`, ties keep their order,
   which is why promoted chunks are *inserted* next to their parent, not appended).
9. **Non-BEV post-filter**: for a non-BEV query, **all `bev` chunks are removed if any non-BEV chunk exists**.
   If *only* BEV chunks matched, they are returned with a `powertrain_notice` in the contract.
10. **`.slice(0, topK)`** — hard invariant, results never exceed `top_k` (default 8).

`executeVectorSearch` in `src/tools/manuals.ts` is a separate, simpler path used by the exported
`searchVanManuals` helper; the MCP tool handler uses `hybridSearch`.

## 4. ICE-by-default powertrain policy

Unless the query contains BEV indicators (`queryContainsBevIndicators`: bev, e-transit, electric, ev…), the system
assumes ICE: ICE/neutral chunks rank first, BEV chunks are dropped, BEV diagrams must not be embedded for ICE
answers (`diagram_text_integrity` in the contract), and the model must never ask "do you have an EV?".
History: #70 (ICE-first bias, schematic markdown) → #71 (powertrain bleed-through prevention, diagram/text
integrity) → #72 (wider candidate pool; no cross-powertrain dedup) → #73 (legend/banner no longer tags ICE chunks as BEV).

## 5. PR #74: promoting the ICE continuation of a BEV-tagged section opener

**Symptom:** "where are the grounding points for a 2024 Ford Transit?" returned no diagram and generic text.
**Investigation (reproduce with `pnpm local:trace`):** the section opener (Transit p150 "4.25.1 Ground Points",
tagged `bev` because it names the BEV figure E185976b) was the **#1 vector and fused hit**, but step 9 dropped it, and
step 5 refused to stitch its ICE continuation (p151 ICE diagram, p153 ICE table) onto a BEV parent. Nothing
replaced them, and p151's numeric-only text never ranked on its own.

**Fix:** `promoteNonBevNeighbors(db, matches, hydrated)` (called after hydration, non-BEV queries only):
- Parents = top 3 matches whose fuel type is `bev`.
- Looks at the same document's chunks on the next `pageWindow = 3` pages; promotes up to `maxPerParent = 3`
  non-BEV ones, **inserted immediately after the parent** with `score = parent.score − 0.001·n`.
- **Section continuity:** walking forward, stops at the first neighbour whose text contains a numbered
  heading (`\d+(\.\d+){1,3} Capitalised`) whose top-two-level root differs from the parent's section root
  (parent root = first number in its `section_title`, else first heading in its text — *not* the last, because
  opener text ends with cross-references like "Refer to: 5.1.2 Welding"). If the parent's section is unknown,
  any numbered heading ends promotion. Sub-headings in the same root (`4.25.2`) continue the section.
- A neighbour already in the candidate list is moved up next to the parent rather than duplicated.
- Promoted chunks get the label `"<parent heading> (continued on p<N>)"` unless they carry their own real heading.
- Runs before the sort, so `top_k` and BEV filtering still apply afterwards.

**Known limitations / future work (deliberately not done):**
- The BEV opener's own prose (e.g. Transit p150 "Only use the ground points indicated…") is still dropped for
  ICE queries. Option: attach a stripped `section_intro` to the first promoted chunk, clearly marked BEV-tagged.
- Keyword stage is noisy: tokens like `ford`/`transit`/`2024` match every page header. Consider stripping tokens
  that equal the document's own title/filter terms.
- `searchManuals` (`src/utils/db.ts`) catches Vectorize errors and returns **mock results**, and
  `src/tools/manuals.ts` has zero-vector fallbacks. Both violate the fail-fast rule in AGENTS.md; the local
  harness avoids them by throwing in its shim, but production can still mask outages.
- Missing numbers inside tables (e.g. Transit ground points 55, 56, 73, 81, 82) match the stored text exactly;
  whether the PDF omits them or extraction lost them has not been verified.

## 6. The retrieval contract (what the LLM is told)

`buildBaseRetrievalContract()` in `src/tools/manuals.ts` is the **single source** for the rules returned in
`retrieval_metadata.retrieval_contract` (the tool description tells consumers to "adhere strictly" to it).
Rules must stay generic — a unit test (`tests/unit/retrieval-contract.test.ts`) fails if vehicle/brand names or
model years appear in the grounding rules. Fields:

| Field | Purpose |
|---|---|
| `strict_grounding_rule` | specs/dimensions/torque only if in chunks (pinned verbatim by tests; don't reword) |
| `missing_manual_rule` | absent third-party component → no "typical" specs; consult its manual |
| `powertrain_rule`, `powertrain_notice` | ICE default; notice when only BEV chunks matched |
| `diagram_text_integrity` | callouts in text must match the embedded diagram; never embed BEV diagram for ICE |
| `options_enumeration_rule` | broad questions → full inventory tables, no cherry-picking |
| `schematic_rule` | always embed `schematic_url` as markdown image |
| `evidence_rule` | **documented vs general-guidance labeling**; no invented section/page/part numbers; no external-standard numbers from memory (use `calculate_dc_wire_and_fuse`) |
| `recommendation_rule` | carry through the manual's "use/type/rating" columns; only rank when a documented attribute supports it; never recommend items documented for another system (fuel, brake, airbag, HV…) for auxiliary loads |
| `completeness_and_warnings_rule` | say "as retrieved" and flag gaps; reproduce relevant CAUTION/WARNING/NOTE text first |

Design intent: the LLM keeps freedom to explain, organize and add practical advice, but anything attributed to a
manual must be traceable to a chunk, and anything else must be labeled **General guidance (not from the indexed manuals)**.
Added after an answer cited a non-existent "Section 4.5.2 >40A rule", ABYC "10 AWG minimum" from memory, and
recommended fuel-tank-sender ground points for house loads.

**Adding a rule?** Keep it generic, add it to the builder (not inline in two places), extend
`tests/unit/retrieval-contract.test.ts`, and add/adjust a promptfoo rubric.

## 7. Verification checklist for retrieval changes

1. `pnpm tsc --noEmit && pnpm lint && pnpm test:unit`
2. `pnpm local:probe "<question>"` — are the expected pages, tags and `schematic_url`s present, ≤ `top_k`?
3. `pnpm local:trace "<question>"` — if not, which stage loses them (keyword / vector / fused / filter / slice)?
4. `pnpm local:server` + `pnpm local:ask "<question>"` — read the **synthesized answer**: labeled general guidance,
   no invented numbers/sections, ICE default, diagram embedded, cautions present.
5. Spot-check quoted claims against D1 text (`pnpm local:sql "SELECT … LIKE '%phrase%'"`).
6. Add/adjust a promptfoo case in `promptfooconfig.yaml` (point `serverUrl` at the local server to run it before deploy).

Known env-only test failures: ~14 schematic/PDF-rendering e2e tests (`ingest-pipeline`, `r2-pipeline`,
`schematics-pipeline`, `scripts/__tests__/schematics`) fail on aarch64/Android dev boxes with and without changes
(canvas/PDF rendering + 5 s timeouts). Rely on CI for those.
