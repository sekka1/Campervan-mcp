# Retrieval Pipeline: How `search_van_manuals` Works (and Why)

> **Read this before changing anything in `src/utils/db.ts`, `src/tools/manuals.ts`, or the
> powertrain/schematic logic in `scripts/ingest-manuals.ts`.**
> To reproduce/debug retrieval against real data without deploying, see
> [`local-dev-loop.md`](./local-dev-loop.md).

Everything here is **vehicle- and component-agnostic by design** (AGENTS.md §1–2). Specific manuals
(e.g. the 2024 Ford Transit grounding section) appear only as **worked examples** of a *class* of problem,
always labeled as such. Sprinter, Ram/ProMaster, Victron, HVAC, air, water, plumbing, etc. go through the same
code and the same contract. If you are about to write a rule that names a page, part, vehicle or circuit,
stop and read §8 (Generic-first).

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
   First runs **`findBoilerplateTokensByDocument`**: a token found in more than 60 % of a *document's* chunks (page banners,
   the make/model/year printed on every page, section footers) is suppressed **in that document only** (an
   `c.document_id NOT IN (…)` guard in the keyword SQL), because there it matches everything equally and only drags in
   unrelated chunks; the same word still matches normally in other manuals. Semantic search and the metadata filters
   already handle "which vehicle". Measured per document in the caller's filter scope (no hardcoded vocabulary);
   documents under 20 chunks are ignored; if every token would be suppressed in a document, none are. One extra
   grouped `COUNT` query per search; no suppression if it fails.
4. **RRF fusion** `reciprocalRankFusion` (`1/(60+rank)`). Keyword-only hits get a **synthetic score of 0.75**
   (that is why many results show exactly `0.750`; it is not a cosine score, and is **not comparable** to real
   similarities — never sort by raw `score` across sources). Consequently the live smoke test asserts the *best*
   score > 0.60 (plus sane positive scores and topical results), not a 0.60 floor on every result; a per-result
   floor only ever passed because synthetic 0.75 scores were filling the top 8 and hiding missing semantic matches.
5. **Hydrate** `hydrateChunks`: loads chunk + document + schematic rows with **progressive filter relaxation**
   (all filters → drop category/subsystem → drop model/chassis → market+year only), then stitches forward
   continuation text (`chunk_N+1`, `+2`) onto top hits and cue-bearing chunks — but **only across compatible
   powertrains** (`arePowertrainsCompatible`).
6. **`promoteNonBevNeighbors`** (PR #74, non-BEV queries only) — see §5.
7. **Clarification gate, then dedup** (only for the MCP tool, `clarify: true`; see §9). If the best results come from
   several documents that differ in a facet the caller did not specify, return `needs_clarification` and no results
   *before* anything is collapsed. Otherwise `deduplicateCrossEditionChunks` drops near-identical chunks across
   overlapping editions **within the context the caller specified** (keeps newest); never collapses BEV with ICE (PR #72);
   skipped when `include_all_variants` is set.
8. **Sort**: exact model match → ICE-before-BEV (unless the query has BEV
   indicators) → **fused (RRF) rank** (position in `matches`, which is why promoted chunks are *inserted* next to
   their parent, not appended). Raw `score` is deliberately not used: before this was fixed, keyword-only hits (synthetic
   0.75) outranked genuine semantic matches (~0.70–0.76 cosine) and silently discarded the fusion order, which pushed
   relevant sections out of the top 8.
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

### 5.1 Variant-neutral section notes (`extractNeutralSectionContext`)

Same class of problem, second half: the dropped opener also carried CAUTION/WARNING/NOTE text that applies to *every*
variant. Rather than keep the BEV page (and its BEV callouts) or lose the cautions, the first promoted chunk gets a
prefix `[Section notes from page <N>, the opener of this section (variant-specific sentences omitted); the content below starts on page <M> and may continue onto later pages]: …` built by:
keep CAUTION/WARNING/NOTE/IMPORTANT blocks; drop any sentence matching the other variant's markers
(`BEV_CONTENT_REGEX`) **and the rest of that block** (later sentences usually depend on it); drop non-prose
(figure labels, table cells). It works on any manual that has variant-tagged openers (diesel vs electric, 12 V vs 48 V
if markers are added, etc.) and never injects variant-specific callouts, so `diagram_text_integrity` still holds.
*Example outcome:* a "use only the indicated points / tighten to torque" caution survives for the ICE answer while the
"on the electric version create your own point" note does not.

**Known limitations / future work (deliberately not done):**
- (Resolved) A dropped opener's variant-neutral CAUTION/WARNING/NOTE prose is now preserved — see §5.1.
- (Resolved) Keyword noise from tokens that appear on every page — see `findBoilerplateTokensByDocument` (step 3) — and the
  fused order being overridden by raw scores — see step 8. Symptom that led to both: a short query returned
  unrelated chapters (suspension/brake pages) instead of the section describing the approved method for add-on loads.
  Diagnosis recipe: `pnpm local:trace` (is the right chunk in FUSED?) vs `pnpm local:probe` (is it in the output?).
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
| `answer_checklist` | **6 short imperative items, read first** (cautions first; approved method before options; show each item's purpose and never treat a list as an approval list; name gaps in numbered sequences; cite only what is retrieved; own advice last, methods only, never pick items from the documented list). Short on purpose: weaker models skim long rule paragraphs |
| `strict_grounding_rule` | specs/dimensions/torque only if in chunks (pinned verbatim by tests; don't reword) |
| `missing_manual_rule` | absent third-party component → no "typical" specs; consult its manual |
| `powertrain_rule`, `powertrain_notice` | ICE default; notice when only BEV chunks matched |
| `diagram_text_integrity` | callouts in text must match the embedded diagram; never embed BEV diagram for ICE |
| `options_enumeration_rule` | broad questions → full inventory tables, no cherry-picking |
| `schematic_rule` | always embed `schematic_url` as markdown image |
| `evidence_rule` | **documented vs general-guidance labeling**; no invented section/page/part numbers; no external-standard numbers from memory (use `calculate_dc_wire_and_fuse`); describe unretrieved content only as "not retrieved"; no unsupported absolutes; **inclusion in a table/list is not approval** |
| `recommendation_rule` | carry through the manual's "use/type/rating" columns; only rank when a documented attribute supports it; never recommend items documented for another system (fuel, brake, airbag, HV…) for auxiliary loads; **own advice may describe methods but must not pick/rank/endorse items from a documented list** (if no approved method is retrieved: say so and describe creating a dedicated one) |
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

## 8. Generic-first: how to handle the next corner case

Every platform and system (chassis, batteries, HVAC, air, water, plumbing) will surface odd cases. **Do not add a
rule that names the page, part, vehicle or circuit you just saw.** Classify the failure instead, and fix the class:

| Failure class (examples) | Fix at this layer | Existing generic mechanism |
|---|---|---|
| Relevant content never reaches the model (section split across pages/variants, diagram-only page, numeric-only table) | **Retrieval mechanism** | `hydrateChunks` continuation, `promoteNonBevNeighbors` (section-continuity aware), `extractNeutralSectionContext` |
| Content wrongly tagged / filtered | **Ingestion classifier** (pure function of text) + data check | `classifyPowertrainText`, `stripPageBoilerplate`; verify with `local:sql` first |
| Model states things the manuals don't say | **Contract principle** + deterministic check | `evidence_rule`, `scripts/grounding-check.mjs` |
| Model recommends something unsafe/irrelevant to the user's goal | **Contract principle** (purpose-matching), never an item list | `recommendation_rule` |
| Model overstates completeness or skips warnings | **Contract principle** | `completeness_and_warnings_rule` |
| Math / unit / table lookup errors | **Deterministic code** | `src/utils/formulas.ts` + tests |

Rules of thumb:
1. **Examples ≠ rules.** Put the concrete case in a *test fixture or promptfoo case* (labeled as a regression/example),
   and the *principle* in the mechanism or contract. Tests for generic code should use neutral synthetic text
   (see `tests/unit/powertrain-continuation.test.ts`, `scripts/__tests__/grounding-check.test.ts`).
2. **Prefer mechanisms over lists.** "Don't recommend fuel-tank grounds" is a one-off; "don't recommend an item whose
   documented purpose differs from the user's intended use, and show the purpose column" covers fuel, brakes, airbags,
   potable vs. waste water, gas vs. vent paths, sensor circuits, … on every platform.
3. **Prefer deterministic checks over more prompt text.** If a class of error can be detected mechanically (invented
   numbers, citations, part numbers, standards), detect it in code and assert on it in promptfoo.
4. **Keep the generic contract test green:** `tests/unit/retrieval-contract.test.ts` rejects vehicle/brand names and
   model years in the grounding rules.
5. Record *what the class was and which mechanism now covers it* in this document (not the one-off specifics).

### 8.1 Deterministic grounding checker (`scripts/grounding-check.mjs`)

Given a provider output (tool-result trace + synthesized answer) it extracts checkable claims — numeric specs with
units, `Section x.y.z`, page references (range endpoints), part/figure numbers, named standards (ABYC, NEC, ISO, SAE…)
— and reports those that appear in **no tool result** (and not in the user's question). The `retrieval_contract` text is
excluded from evidence on purpose (it names standards as examples). Numbers computed by `calculate_dc_wire_and_fuse`
count as evidence because that tool result is in the trace.
- Use it: `pnpm local:ask` prints `grounding check: …` after every answer; promptfoo uses
  `type: javascript` / `file://scripts/grounding-check.mjs:groundingAssertion` (currently on the grounding tests).
- **Limit (by design):** it proves *presence*, not *attribution*. A real number attached to the wrong rule (e.g. a relay
  rating quoted as a grounding limit) passes. The contract rules and the llm-rubric cover that; spot-check quotes
  with `local:sql`.
- Part numbers are matched ignoring stray spaces around hyphens, because PDF extraction produces text like `KK2V- 14301-K`.
- It flags inferred page ranges (e.g. citing "pp. 154–155" when only 154 was retrieved) — usually a true positive.

### 8.2 Measuring contract compliance (do this before and after changing contract wording)

Contract wording is a hypothesis; **models differ and vary run to run**, so measure instead of eyeballing one answer.
`promptfoo.local-grounding.yaml` runs the real 2-turn loop against the **local** server with generic failure-class
metrics (`grounding_check`, `no_approval_inference`, `no_item_picking`, `gaps_called_out`, `approved_method_first`).
Start `pnpm local:server`, export the `.campervan-d1.env` values, run `pnpm eval:grounding` (4 repeats; use `--repeat 8`
for tighter numbers), compare pass counts before/after, and read the per-run failure reasons.

**Cost: use only the cheap repo-defined model for candidate AND judge** (`deepseek-ai/DeepSeek-V4-Flash-0731`; see
AGENTS.md §0.2). The config strips the raw tool trace before the `llm-rubric` judge sees the output. A premium judge
(`anthropic/claude-sonnet-4-6`, $3/$15 per 1M tokens) was once used here, including as the main benchmark's grader;
it has been replaced everywhere. Never reintroduce it.

Lessons recorded from the first measurements (cheap candidate model, grounding question; counts are runs passed, and the
judge matters: the first pass used a stricter premium judge, the re-check used the cheap judge):
- A short imperative `answer_checklist` lifted *gaps called out* from 2/4 to 8/8 (both judges) where the long rule
  paragraphs alone were skipped half the time.
- "Don't do X" alone did not stop a weaker model picking items from a list in its own advice (2/4); adding **a
  replacement behaviour** (point to the approved method, or say none is documented) raised it to 6-8/8 depending on
  the judge. It is still the least reliable metric, so expect residual misses from cheaper models.
- `grounding_check` hits that remain are genuine (pages/sections cited but not retrieved, occasional invented
  numeric spacings); the checker's own false positives (e.g. `KK2V- 14301-K` extraction spacing) were fixed generically.
- Checker false positives are worth chasing, but fix the checker (generic normalization), not the model.
- Weaker/cheaper models comply less; if a metric will not move with wording, use a stronger model for those clients
  rather than adding more prompt text.

## 9. No assumed context: asking instead of defaulting (`needs_clarification`)

**Principle.** The same question has different answers for different manufacturers, models, model years and markets
(vehicle platforms, heaters, battery systems, plumbing kits...). The server must never silently choose one. Removed
implicit defaults: the `market: "us"` schema default and US ranking preference, "newest edition wins" for
unspecified years, and the mock fallback that named a default vehicle (`?? "transit"`; Vectorize errors now throw).
*Still deliberate:* the ICE-by-default **powertrain** policy (§4), which the owner asked for explicitly.

**Mechanism** (generic; facet values come from the indexed documents, nothing hardcoded):
1. `hybridSearchDetailed(..., { clarify: true })` ranks as usual, then calls `assessAmbiguity` on the top-`top_k`
   results (BEV chunks dropped first for non-BEV queries), **before** edition de-duplication.
2. Results are grouped by document. A document is a real competing variant if it has at least 2 of the top results or
   one in the top 3 ranks (`MIN_CHUNKS_FOR_VARIANT`, `TOP_RANKS_FOR_VARIANT`); a stray low-ranked chunk is ignored.
3. For each facet the caller did **not** specify (`manufacturer`, `model` (a `chassis` filter counts), `model_year`,
   `market`), if the variants show 2+ distinct values the facet is "missing". A specific `source` disables the gate.
4. If any facet is missing the tool returns the normal response shape with `count: 0`, `results: []`,
   `needs_clarification: true` and `clarification` = `{ reason, missing_context, choices, options[], suggested_question,
   instruction }`. The contract's `context_rule` / checklist item 1 tell the LLM to ask the user (or, if the user already
   said it earlier in the conversation, to re-call with the filter), then call again with the answer as filters.
5. `include_all_variants: true` is the escape hatch ("all of them"/"not sure"): no clarification and **no edition
   collapsing**; each result carries its own `document_title` and `model_year` so the answer can be labelled.

**Verification.** Unit tests use neutral fixtures (`tests/unit/disambiguation.test.ts`: detector, search gate, and the
registered tool handler end to end). Real-data check needs 2+ editions ingested: `pnpm local:probe "<question>"` prints
`NEEDS CLARIFICATION` with the choices. With a single indexed document nothing is ever asked.

**Known limits / follow-ups.**
- Variants are detected only from the top results; a variant that exists but is not retrieved is not offered.
- Facets come from document metadata (`manufacturer`, `model`, `market`, `year_start/year_end`); documents missing that
  metadata cannot be disambiguated.
- Powertrain (ICE/BEV) is not a clarification facet (policy §4).
- `hybridSearchDetailed` still normalises the `chassis` filter with a small hardcoded alias list
  (`transit`/`sprinter`/`promaster`) when building the Vectorize filter; this predates the generic-first rule and should be
  replaced by values read from the indexed documents.

