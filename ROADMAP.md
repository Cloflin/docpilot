# Roadmap: DocPilot

## Overview

DocPilot 3.0 widens where grounded answers come from and how fresh they stay, and shrinks what a site ships. The roadmap starts by freezing the 2.1.1 baselines and moving the existing sources onto one shared document pipeline with unchanged output bytes. Then it improves HTML extraction, builds the connectors (Intercom, Zendesk, Freshdesk, Generic REST, own-origin pages), puts the server index behind a storage adapter with an atomic hot swap, and adds the sync engine that makes an edit at the source reach answers without a restart (Core Value). Confluence and Notion follow once sync and reconcile exist. Next, one turn pipeline serves browser, server and eval, and server retrieval gains filters, a candidate pool, a reranker and contextual chunks, each backed by eval evidence. The client track then moves chat state onto a Vue-free core, splits the bundle into registered features with a custom-bundle CLI, and decides through a go/no-go whether the whole UI moves to Web Components. The last phase ships the migration path and proves the motivating case on stock DocPilot: a production site that today needs a patched DocPilot and hand-written import scripts.

## Structure Notes

- **Ten phases, above the standard 5-8.** 106 requirements in 11 categories split into two tracks (server: Phases 2-6, client: Phases 7-9). Research suggested 12 phases. Two merges were made where dependencies stay honest: wiki connectors joined the sync phase (they are the first schedule-first consumers of reconcile), and the turn-driver unification joined server retrieval (the driver is that phase's first deliverable and must be green before any retrieval stage lands). Further merges would cross real boundaries: Phase 1 keeps output byte-identical while Phase 2 deliberately shifts corpus hashes; Phases 4 and 5 would hold 25 requirements; Phases 7 and 8 differ in risk and research needs; Phase 9 is conditional.
- **Requirements placed ahead of their category.** REL-01 (Node >= 22.13, CI on 22 and 24) is in Phase 4 because the `node:sqlite` adapter cannot run in CI before it. SYNC-08 (atomic hot swap) is in Phase 4 because the index holder is built with the store. STORE-08 (ceilings per runtime) is in Phase 1 because the shared pipeline owns the ceilings. SEC-01 to SEC-03 start in Phase 3 because credentials first exist there; later phases keep the secret scan green and extend the visibility fixtures to the wiki connectors.
- **Embedding-moving changes are batched.** All extractor changes land as one extractor-version bump in Phase 2. Eval evidence for that bump, the breadcrumb prefix, the contextual prefix and the reranker is collected together in Phase 6 (EVAL-04), once the Intercom golden set exists, and always before 3.0 ships.
- **The 2.x deprecation release (REL-02) is cut before 3.0 final.** The list of removed exports and options is final only after Phase 9, so Phase 10 owns it.
- **Research flags.** Phases 3, 4, 5, 6, 8 and 9 need `/gsd-plan-phase --research-phase <N>` before planning.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Baselines and shared document pipeline** - Freeze 2.1.1 baselines and run existing sources through one `SourceDoc` pipeline, byte-identical
- [ ] **Phase 2: HTML extraction** - Deterministic, structure-preserving HTML to Markdown that never fails the index on one bad page
- [ ] **Phase 3: Source connectors and snapshot pull** - Intercom, Zendesk, Freshdesk, Generic REST and sitemap sources pulled into a snapshot that `index` reads offline
- [ ] **Phase 4: Server storage and hot swap** - Server index behind a `StorageAdapter` (files, memory, SQLite, Postgres) with an atomic swap in the running server
- [ ] **Phase 5: Sync engine, freshness and wiki connectors** - Edits at the source reach answers via CLI, schedule or webhook; Confluence and Notion join schedule-first
- [ ] **Phase 6: Unified turn pipeline and server retrieval** - One turn driver for browser, server and eval; filters, breadcrumbs, reranker, contextual prefix, eval-gated
- [ ] **Phase 7: Vue-free chat core** - Per-instance chat state on a framework-agnostic core; the Vue panel runs on it unchanged to the reader
- [ ] **Phase 8: Feature registry and modular bundle** - Per-feature exports, lazy chunks, launcher, custom-bundle CLI and a published size table
- [ ] **Phase 9: Web Component UI (conditional go/no-go)** - Evidence-based decision on a Lit `<docpilot-panel>` replacing the Vue UI
- [ ] **Phase 10: Release and acceptance** - Deprecation release, migration tooling, rc on `next`, the reference site on stock 3.0, eval no worse than 2.1.1

## Phase Details

### Phase 1: Baselines and shared document pipeline
**Goal**: The 2.1.1 behaviour is frozen as measurable baselines, and Markdown, HTML-directory and OpenAPI sources run through one shared `SourceDoc` pipeline with unchanged output bytes.
**Depends on**: Nothing (first phase)
**Requirements**: EVAL-01, EVAL-02, BNDL-01, CORE-02, SRC-01, SRC-02, STORE-08
**Success Criteria** (what must be TRUE):
  1. The maintainer can re-run the golden eval on `rag` and `rag-local`, plus `eval --runtime=server`, and compare `rankedIds` against frozen 2.1.1 baselines kept in the repo, so a changed ranking shows up as a diff. The lexical recalibration owed since the stemmer change is done first, on the offline `rag-local` + Ollama path.
  2. A bundle composition report breaks the 1.19 MB `dist/docpilot.web.js` down by contributor (Vue, Shiki, markdown-it, MiniSearch, panel code, optional features), so later phases choose what leaves from measurement.
  3. Characterisation tests of the 2.1.1 session (submit sequence, state writes, citations, openers, history, quote, budget) pass on today's code and stay as the safety net for Phases 6 and 7.
  4. Markdown, HTML-directory and OpenAPI sources emit documents in the one `SourceDoc` shape (id, canonical URL, title, body, `updatedAt`, locale, visibility, breadcrumb, tags, content hash), and `docs/public/rag/` and `docs/public/rag-local/` rebuild byte-identical.
  5. A server-runtime corpus above the 64 KB manifest and 5 MB file ceilings builds without patching, while the browser build still refuses it.
**Plans:** 9/12 plans executed in 6 waves

Plans:
**Wave 1**
- [x] 01-01-PLAN.md — Characterisation harness (browser + server SSE) and the core turn: submit traces, citations, quote, history (CORE-02)
- [x] 01-02-PLAN.md — `rankRecords` extraction, the baseline engine, `--baseline` wiring, golden repoint checkpoint (EVAL-01)
- [x] 01-03-PLAN.md — Bundle composition report and the frozen 2.1.1 composition (BNDL-01)
- [x] 01-04-PLAN.md — Four-source builder characterisation (the byte oracle) and the OpenAPI `dereference` test seam (SRC-02)
- [x] 01-12-PLAN.md — SourceDoc contract and per-runtime limits, `shell.ts`, engine-spec 041 (wave 1, split from 01-04) (SRC-01, STORE-08)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-05-PLAN.md — Characterisation: openers, gate refusal, credential/social short-circuits, budget (CORE-02)
- [x] 01-06-PLAN.md — Characterisation: follow-up, restore, scope change, cancel, provider error, 429 rotation (CORE-02)
- [x] 01-07-PLAN.md — The one docs edit: register the baseline flags, browser-scoped ceiling wording, rebuild both indexes (Ollama + metered checkpoints) (EVAL-01, STORE-08)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-08-PLAN.md — Recalibrate rag-local (full) and rag (transfer), freeze both rankings, offline gate in verify (EVAL-02, EVAL-01)

**Wave 4** *(blocked on Wave 3 completion)*
- [ ] 01-09-PLAN.md — Answer-quality and server-runtime baselines on local Ollama (EVAL-01)

**Wave 5** *(blocked on Wave 4 completion)*
- [ ] 01-10-PLAN.md — All four sources through SourceDoc and `documentsToChunks`, real-corpus oracle (SRC-01, SRC-02)

**Wave 6** *(blocked on Wave 5 completion)*
- [ ] 01-11-PLAN.md — Per-runtime ceilings, shell-size line, byte-identical rebuild of both indexes, phase gate (STORE-08, SRC-02)

**Cross-cutting constraints:**
- Every scenario goes through createHarness; this file never imports session.js (D-14)

### Phase 2: HTML extraction
**Goal**: HTML pages become clean, deterministic Markdown that keeps code, links, tables and structure, and one bad page never fails `docpilot index`.
**Depends on**: Phase 1
**Requirements**: HTML-01, HTML-02, HTML-03, HTML-04, HTML-05, HTML-06, HTML-07, HTML-08, HTML-09, HTML-10, HTML-11, HTML-12, HTML-13
**Success Criteria** (what must be TRUE):
  1. Site owner can set `content` and `exclude` selectors per source and get only the article body. Without selectors, the rule list removes navigation, footers, cookie banners, breadcrumbs, feedback widgets, share bars and TOC sidebars, and keeps tab panels and accordions with their labels.
  2. A page with `<br>` inside a code block produces a multi-line fenced block with the language as fence info, with highlighter spans, line-number tables and copy buttons gone. A page with an OpenAPI description embedded in an article indexes, and its relative link resolves against the canonical URL or degrades to text with a warning.
  3. Heading hierarchy and ids, nested lists, GFM tables (colspan / rowspan fallback), `details`, definition lists and blockquotes survive extraction. Entities are decoded, whitespace and Unicode are normalised, and script, style, template and svg noise is gone.
  4. Page title, canonical URL, `lang` and `dateModified` are extracted, a `robots noindex` page is skipped, and `docpilot import` and `docpilot doctor` print a per-source report of characters kept and dropped, empty pages and link failures.
  5. After `npm i @cloflin/docpilot` on a clean machine, `docpilot import` works with nothing else installed, and the parser is absent from the browser bundle. The same HTML gives byte-identical Markdown, and the extractor version is part of the corpus hash. A Readability-class fallback is adopted only if it beats the rule list on a labelled page set, and a `fetcher` hook accepts pre-rendered HTML.
**Plans**: TBD

### Phase 3: Source connectors and snapshot pull
**Goal**: Site owner can pull public content from Intercom, Zendesk, Freshdesk, any JSON API and their own origin into a snapshot directory that `docpilot index` turns into an index, with no hand-written import script and no credential leaving the build machine.
**Depends on**: Phase 2 (HTML-bodied connectors reuse the extractor), Phase 1
**Requirements**: SRC-03, SRC-04, SRC-05, SRC-06, SRC-07, SRC-08, SRC-09, SRC-10, SRC-11, SRC-12, SRC-13, CONN-01, CONN-02, CONN-03, CONN-06, CONN-07, CONN-08, SEC-01, SEC-02, SEC-03
**Success Criteria** (what must be TRUE):
  1. Site owner can run `docpilot pull` for an Intercom Help Center (published articles only, per-locale state, collection breadcrumbs, pinned `Intercom-Version`), a Zendesk Help Center (incremental endpoint, translations) and a Freshdesk knowledge base (category and folder walk) and get a snapshot directory of Markdown plus front-matter. Each (article, locale) pair is one document. `docpilot index` then reads only files and makes no network call.
  2. When an API call fails, `docpilot pull` keeps the last good snapshot of that source and reports the failure. Pulls retry on 429 and 5xx honouring `Retry-After`, resume pagination, and lose no document to an `updated_at` tie or clock skew. `docpilot connectors test <name>` reports auth result, first page, field coverage and locale / state counts and writes nothing.
  3. Site owner can write their own connector against the exported `Connector` interface, or configure Generic REST declaratively (auth, pagination, array path, field map, incremental parameter, delete detection, `transform`). Generic REST refuses private, loopback and link-local targets unless allowlisted. Site owner can map citation URLs with `urlTemplate`, include or exclude collections and labels before import, and see source tags in chunk metadata.
  4. Site owner can point a sitemap / URL source at their own origin and get its pages with no import script: sitemap discovery, robots, 1 request/s by default, a cookie jar for geo-redirects, a configurable user agent. A WAF soft-block or stub page is reported and not indexed.
  5. Draft, internal and restricted documents never reach an index (per-connector fixtures prove it), and the static build refuses any non-public document. Connector, store and sync config and credentials never appear in the client config, built bundle, manifest or logs; credentials come only from environment-variable references; `npm run verify` scans the built output for them; `docpilot doctor` checks connector auth and scopes.
**Plans**: TBD
**Research**: run `/gsd-plan-phase --research-phase 3` first. Per-connector spikes on live trial accounts: Zendesk deletions in the incremental export, Freshdesk article `updated_at`, Intercom webhook topics for the account's API version, signature details.

### Phase 4: Server storage and hot swap
**Goal**: The server index lives behind a `StorageAdapter` that works on files, memory, SQLite and Postgres, and a running server swaps to updated content atomically without a restart.
**Depends on**: Phase 1 (independent of Phases 2 and 3; can run in parallel with them)
**Requirements**: STORE-01, STORE-02, STORE-03, STORE-04, STORE-05, STORE-06, STORE-07, STORE-09, STORE-10, SYNC-08, REL-01
**Success Criteria** (what must be TRUE):
  1. An existing `rag/` directory loads unchanged through the files adapter and answers as it did in 2.1.1 (the Phase 1 baselines show no regression).
  2. Site owner can keep the server index in SQLite through `node:sqlite` with no extra install, or in Postgres with pgvector by passing their own `pg` client (the package imports no database driver). One exported adapter conformance suite passes against the files, memory, SQLite and Postgres adapters.
  3. Replacing one document is atomic, so a reader never sees a half-updated article, and the sync cursor commits together with the documents. The store records embedding model, dimensions and quantisation, and the server refuses to start or sync on a mismatch.
  4. When a document changes in the store from outside the server process, the running server serves the new content without a restart, and an in-flight turn finishes on the index it started with.
  5. `docpilot store migrate <from> <to>` moves an index between adapters without re-embedding. A lease keeps a second instance from holding the same source lock. `engines.node` is `>= 22.13` and CI runs Node 22 and 24.
**Plans**: TBD
**Research**: run `/gsd-plan-phase --research-phase 4` first. Measure MiniSearch rebuild time at 10k and 50k chunks before promising swap latency; test the SQLite vector path with `defensive` on.

### Phase 5: Sync engine, freshness and wiki connectors
**Goal**: An edit at the source reaches the running server's answers without a rebuild or restart, by CLI, schedule or webhook, with reconcile as the correctness backstop; Confluence and Notion join as schedule-first connectors.
**Depends on**: Phase 3, Phase 4
**Requirements**: SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-06, SYNC-07, SYNC-09, SYNC-10, SYNC-11, SYNC-12, SYNC-13, CONN-04, CONN-05
**Success Criteria** (what must be TRUE):
  1. `docpilot sync [source]` is incremental by default, supports `--full` and `--dry-run`, and exits with codes fit for cron and CI. `--dry-run` lists documents to add, change and delete and the estimated embedding requests before anything is spent. Only documents whose normalised content hash changed are re-chunked, unchanged chunks reuse cached embeddings, and a per-run embedding cap defers the rest to the next run.
  2. `docpilot serve` runs scheduled syncs (interval or cron string) and never starts a second run of a source that is still syncing. After a source edit and one scheduled run, the running server answers from the new text. The webhook route has its own auth and rate limit: a forged, replayed or stale event is rejected without touching the index, a valid one is acknowledged fast, debounced per document, and the document is re-fetched by id.
  3. A periodic full reconcile removes deleted and unpublished documents. A sync that would delete more than `maxDeleteRatio` (default 20%) of a source stops and reports instead. A document that fails to process is quarantined and retried on the next run, and never aborts the sync or corrupts the index.
  4. Site owner can see sync state: last success, added / changed / deleted / failed counts and lag per source in `/metrics` and `docpilot doctor`, optional freshness lag in answer metadata, and an SSE stream of sync status events. The docs give a CI recipe that refreshes the static index on a schedule or webhook (`pull` then `index`).
  5. Site owner can ingest Confluence Cloud (allowlisted spaces, storage-format macros for code, panels, expand and include converted by explicit rules) and Notion pages shared with the integration (`urlTemplate` for citation URLs). Both refresh on schedule, and neither lets a draft or restricted page reach the index.
**Plans**: TBD
**Research**: run `/gsd-plan-phase --research-phase 5` first. Vendor webhook and delete semantics (shared with Phase 3 spikes), multi-replica behaviour, Confluence storage vs `view` HTML and macro coverage, Notion block-only edits vs `last_edited_time`.

### Phase 6: Unified turn pipeline and server retrieval
**Goal**: One turn pipeline drives browser, server and eval, and the server retrieves with filters, breadcrumbs, a larger candidate pool, an optional reranker, contextual chunks and neighbour expansion, each shipped only with eval evidence.
**Depends on**: Phase 3 (facets and breadcrumbs), Phase 4 (async retrieval and the index holder), Phase 1 (characterisation tests)
**Requirements**: CORE-01, EVAL-03, EVAL-04, EVAL-05, SEC-04, RETR-01, RETR-02, RETR-03, RETR-04, RETR-05, RETR-06, RETR-07
**Success Criteria** (what must be TRUE):
  1. The same fixture through the browser, server and eval drivers gives identical `gate`, `rankedIds` and `outcome`. With every new retrieval stage off, results match the Phase 1 2.1.1 baselines.
  2. The eval report header records host, model and the retrieval stages that ran. A golden set for real Intercom help-center content runs on the offline `rag-local` + Ollama path, and eval fixtures with prompt-injection text in ingested documents show the answer stays grounded.
  3. Site owner can scope retrieval by locale, source, collection, visibility and tags through a typed allowlist, and "nothing left after the filter" is its own outcome. Each chunk carries a deterministic breadcrumb / title prefix before BM25 and embedding, and the server retrieves a larger configurable candidate pool than the browser.
  4. Site owner can turn on a reranker through an HTTP `/rerank` adapter. On timeout or error the turn falls back to the un-reranked order, and the relevance gate still scores the pre-rerank channels, so a calibrated threshold stays valid.
  5. Site owner can turn on an LLM-written contextual prefix per chunk at ingest, cached by content hash, and top hits expand to their neighbouring chunk or section on the server. The extractor version, breadcrumb prefix, contextual prefix and reranker each ship only with eval evidence on `rag-local`, including Russian probes.
**Plans**: TBD
**Research**: run `/gsd-plan-phase --research-phase 6` first. Line-by-line inventory of `session.submit` state writes before the sink is designed; reranker choice and hosting (Ollama has no `/rerank`), candidate depth, multilingual check, contextual-prefix cost on a 2k-chunk corpus.

### Phase 7: Vue-free chat core
**Goal**: Chat state and turn lifecycle run on a framework-agnostic core with per-instance state, and the existing Vue panel, adapters and `mount` run on it with no change a reader can see.
**Depends on**: Phase 6 (the unified turn driver), Phase 1 (characterisation tests)
**Requirements**: CORE-03, CORE-04, CORE-05, CORE-06, CORE-07, CORE-08, CORE-09, CORE-10
**Success Criteria** (what must be TRUE):
  1. Code under `src/core` imports no `vue`, DOM or UI framework, and `scripts/check-docpilot.sh` fails the build if it does. Its reactivity is `@vue/reactivity` inlined into the build, so a consumer of the core never installs Vue.
  2. Two panels on one page, two SSR requests and two tests never share chat state (`createChat()` per instance). A send while a reply streams does not double submit, and regenerate is refused while streaming. The core exposes a status machine (submitted, streaming, ready, error) over a transport interface, so browser-direct and server SSE turns share one code path.
  3. Site owner can bind the core from any framework through `subscribe` / `getSnapshot`, and can build their own UI with a headless stores package (React `useSyncExternalStore`, Vue, Svelte).
  4. The Vue panel runs on the core through a bridge, and citations, openers, history, quote, tools, budget and accessibility behave as in 2.1.1 (the Phase 1 characterisation tests pass). The Vue, React and Docusaurus adapters and `mount` are thin wrappers over the same core.
**Plans**: TBD

### Phase 8: Feature registry and modular bundle
**Goal**: A site ships only the features it turns on, the minimal bundle is substantially smaller than today's 1.19 MB, and every size is measured and published.
**Depends on**: Phase 7 (Vue-free core), Phase 1 (bundle audit)
**Requirements**: BNDL-02, BNDL-03, BNDL-04, BNDL-05, BNDL-06, BNDL-07, BNDL-08, BNDL-09, BNDL-10, BNDL-11, BNDL-12
**Success Criteria** (what must be TRUE):
  1. Site owner can compose features with `createDocPilot({ features: [...] })`, and a feature not listed is not in the bundle. Each optional feature (scope, tools, openers, feedback, highlighters, quote, history and the rest) is a side-effect-free subpath export with an accurate `sideEffects` entry, shown by a consumer-bundler tree-shake test.
  2. A feature turned on in config lazy-loads its own chunk through a literal specifier that webpack and Docusaurus resolve. A vanilla launcher of a few KB loads the panel on first open or hover, and Shiki, Prism, highlight.js and `markdown-it` load lazily.
  3. `docpilot bundle --features <list>` builds a custom `<script>` bundle from prebuilt chunks and a generated loader, and the same list gives the same output. `docpilot bundle --single-file` builds one file through an optional esbuild install.
  4. `npm run verify` fails when the minimal bundle or any feature exceeds its size budget, and the minimal bundle is substantially smaller than 1.19 MB. The docs show a per-feature size table generated from one JSON source. `publint` and `@arethetypeswrong/cli` pass.
  5. `docpilot doctor` warns when the config uses a feature the bundle lacks, and when the bundle carries a feature the config never uses.
**Plans**: TBD
**Research**: run `/gsd-plan-phase --research-phase 8` first. `import()` from a classic script under strict CSP and under Docusaurus / webpack; `sideEffects` audit of module-level state.

### Phase 9: Web Component UI (conditional go/no-go)
**Goal**: A decision backed by the bundle audit and an accessibility spike settles whether a Lit `<docpilot-panel>` replaces the Vue UI; on "go" it ships behind thin wrappers, on "no-go" the Vue UI stays and the reason is recorded.
**Depends on**: Phase 8
**Requirements**: CORE-11
**Success Criteria** (what must be TRUE):
  1. A go/no-go record exists with numbers: Vue's share of the minimal bundle after Phase 8, and spike results for focus trap, aria references, selection / quote and host themes (VitePress, Docusaurus) under Shadow DOM.
  2. On "no-go", the Vue UI ships unchanged, the phase closes with the recorded reason, and no Web Component code is merged.
  3. On "go", `<docpilot-panel>` works in an open shadow DOM with CSS variables and parts, and thin Vue, React and Docusaurus wrappers pass real-framework smoke tests with accessibility parity against the Vue UI.
  4. On "go", the Vue UI is removed in the same release line, so only one UI implementation ships.
**Plans**: TBD
**UI hint**: yes
**Research**: run `/gsd-plan-phase --research-phase 9` first. Lit and Shadow DOM accessibility spike (focus trap, aria references, selection / quote, host themes).

### Phase 10: Release and acceptance
**Goal**: 3.0 ships with a safe upgrade path, and the motivating reference site runs on stock DocPilot with an edit visible in an answer and no eval regression.
**Depends on**: Phase 9 (and all earlier phases)
**Requirements**: REL-02, REL-03, REL-04, REL-05, REL-06, REL-07, REL-08, REL-09, REL-10
**Success Criteria** (what must be TRUE):
  1. A 2.x release warns on every export and option that 3.0 removes, and `docpilot doctor --migrate` finds old options and imports in a project and shows the replacement for each.
  2. 3.0 refuses an old-format index with a message that names the rebuild command, and strict config validation names the replacement for every removed option.
  3. A migration guide and both changelogs cover every breaking change, and `3.0.0-rc` publishes on the `next` dist-tag without moving `latest`.
  4. The reference site that motivated 3.0 runs on stock 3.0, with its DocPilot patch script and hand-written import scripts deleted.
  5. Acceptance: an edit to an Intercom article appears in an answer without a server restart, and eval recall, refusal and groundedness on `rag/` and `rag-local/` are no worse than the 2.1.1 baseline, with the new sources measured.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Phase 4 depends only on Phase 1 and may overlap Phases 2 and 3. Phase 5 needs both Phase 3 and Phase 4. The client track (Phases 7-9) starts after Phase 6 delivers the unified turn driver.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Baselines and shared document pipeline | 9/12 | In Progress | - |
| 2. HTML extraction | 0/TBD | Not started | - |
| 3. Source connectors and snapshot pull | 0/TBD | Not started | - |
| 4. Server storage and hot swap | 0/TBD | Not started | - |
| 5. Sync engine, freshness and wiki connectors | 0/TBD | Not started | - |
| 6. Unified turn pipeline and server retrieval | 0/TBD | Not started | - |
| 7. Vue-free chat core | 0/TBD | Not started | - |
| 8. Feature registry and modular bundle | 0/TBD | Not started | - |
| 9. Web Component UI (conditional go/no-go) | 0/TBD | Not started | - |
| 10. Release and acceptance | 0/TBD | Not started | - |

### Phase 11: MCP server, MCP client and permissions

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 10
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 11 to break down)

### Phase 12: Package split and rename to @cloflin/ai

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 11
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 12 to break down)
