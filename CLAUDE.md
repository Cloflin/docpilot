# DocPilot — repo instructions

## What this is

`@cloflin/docpilot` — a grounded Ask AI panel for any page of any site. Hybrid retrieval (BM25 over chunk text + cosine over int8-quantised vectors, merged by RRF) runs in the reader's browser against a static index built at deploy time. A relevance-floor gate is scored on every turn; whether it refuses before the model is called is `guard.mode` — `'off'` by default since 1.3 (engine-spec 019), because the threshold needs calibrating per corpus **and per language**, and `'calibrated'`/`'dense-only'` opt back in.

ESM-only, Node >= 20. TypeScript in `src/`, Vue components for the panel, VitePress for the docs site, published public to npm.

## Commands

- `npm run verify` — the gate: `check → build:js → typecheck → conformance → vitest`. Run this, not its parts, before committing.
- `npm test` — `vitest run` (happy-dom; the `--no-experimental-webstorage` flag is already in the script).
- `npm run check` — `scripts/check-docpilot.sh`, design-direction rules over `src/theme/**` SCSS and `DocPilot.vue`. Repo-internal, not shipped.
- `npm run typecheck` / `npm run typecheck:dist` — the second one type-checks built `dist/` against `tsconfig.conformance.json`.
- `npm run build` — css + js + web, three separate builders in `bin/`.
- `npm run docs:dev` / `npm run docs:build`; reindex with `npm run docs:index` (`node bin/docpilot.js index`).

## Layout

- `src/theme/docpilot/*` — panel runtime: gate, retriever, llm, providers, budget, session.
- `src/build/*` — indexer. `src/eval/*` — calibration, benches, reports. `src/feedback/*` — feedback pipeline.
- `src/adapters/*` — Vue, React, Docusaurus. `src/theme/components/*.vue` — the panel itself.
- `bin/` — CLI plus the three builders. `test/*.test.js` — tests are JS, sources are TS.
- `engine-specs/` and `ui-specs/` — numbered design specs; new work takes the next number.

## Conventions

Conventional Commits with a scope, as in the history: `feat(cli)`, `fix(docs)`, `config(docs)`, `chore(release)`. Prefer surgical edits over rewriting a file.

## Gotchas

- `docs/public/rag/` and `rag-local/` are committed on purpose (`.gitignore` explains why). Editing docs without reindexing fails `test/docs-links.test.js` on the corpus hash.
- The printed index figures in the docs are held by that same test. Fix them with `node scripts/refresh-figures.mjs` (run `--check` first). Order is index → refresh-figures → index.
- `dist/` is gitignored, but nearly every `exports` subpath resolves into it and several tests spawn `node` against a built artifact — build first on a fresh clone.
- CI runs Node 20 and 24 on every push; publishing happens only on a `v*` tag, via trusted publishing.

# Prompting guidance — model-gated

The model named in the environment block decides which section applies. Opus 5 → **Claude Opus 5**. Fable 5.1 → **Claude Fable 5.1**. Do not merge them: they contradict each other on narration cadence and on self-verification, because the two official guides say opposite things about those behaviours.

## Claude Opus 5

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

### Verbosity
Keep responses focused and brief; keep disclaimers and caveats short and spend the response on the main answer. When asked to explain something, give a high-level summary unless depth was requested. Note that effort controls how much the model *thinks*, not how long the visible reply is — lowering effort will not shorten the answer.

### Progress updates
Before the first tool call, say in one sentence what you're about to do. While working, give a brief update only when you find something important or change direction. When finished, lead with the outcome — the first sentence answers "what happened" — with supporting detail after it.

### Written deliverable length
Files written to disk (reports, Markdown docs, specs) run long by default. Match length to what the task needs: cover the substance, don't pad with filler sections, redundant summaries, or boilerplate.

### Scope and over-verification
Don't add separate verification steps and don't spawn a subagent to double-check — the model already verifies its own work, and stacked verification burns tokens with no gain in quality. Deliver what was asked at the scope intended; if the request seems mistaken or a better approach exists, say so in a sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it.

### Subagent spawning
Delegate only for large, genuinely independent, parallelizable tracks — a wide multi-file investigation. Don't delegate work that finishes in a handful of tool calls, and don't use subagents to verify your own work. If one subagent can do it, use one. Deterministic caps: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (Claude Code 2.1.217+).

### Self-correction
Don't instruct re-checks ("double-check", "re-verify") — they compound with behaviour the model already has. Correct an earlier statement only when the error would change the user's code, conclusions, or decisions; state it plainly and continue. For slips that change nothing, fix and move on without noting it.

### Effort levels
Default `high`. Use `low`/`medium` liberally as the primary lever on token cost and latency wherever quality holds; step up to `xhigh` for demanding coding and agentic work. Effort defaults carried over from a prior model deserve a fresh sweep on this repo's own evals.

### Code review prompting
Don't write "only report high-severity issues" or "be conservative" — Opus 5 follows that literally and reports less. Ask for everything and filter in a separate pass. Review accuracy holds at lower effort, so a fast pass at review time and a thorough pass later both work.

## Claude Fable 5.1

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1

Behavioral patterns distilled from the official Fable 5.1 prompting guide, adopted here as working rules for this repo.

### Progress updates
Before starting, say in a line what you're about to do; brief updates while working help follow along. Close with a short recap that stands on its own — what was found, what was done, what's next.

### Batch independent tool calls
First privately list what's needed next; then request every item that doesn't depend on another's result in one response, not one call per turn.

### Finish the whole task
Operating autonomously: don't ask "want me to…?" for work already requested — proceed. Stop only for destructive actions or genuine scope changes. Before ending a turn, check the last paragraph: if it's a plan, a promise ("I'll…", "let me know when…"), or a list of next steps instead of done work, do that work now instead of stopping.

### Delivering work — scope discipline
The request (or approved plan) sets the scope; don't quietly narrow, widen, or swap it. If a pre-existing bug, perf issue, or unrequested behavior surfaces while working, don't fix/extend it in the same change — report it as a follow-up instead, unless the requested behavior can't work without it. State assumptions made on ambiguous asks instead of building every reading.

### Tests and cleanup
Verify however is convenient; scratch scripts/checks don't need to be kept. Commit tests only where the task asks for them or the repo already tests this kind of change — don't turn scratch checks into permanent test files.

### Targeted edits over rewrites
Prefer surgical edits over rewriting a whole file when it won't change the end result — cheaper and faster, same outcome.

### Writing density / formatting
Avoid mannered prose (metaphor/flourish substituting for direct statement — say what's meant). In chat, use lists/bold only when asked or when content is genuinely multifaceted; default to plain prose otherwise.

### Search / verification triggering
Recognizing a name isn't the same as knowing its current state, especially in fast-moving areas (AI models, dev tools). When effort is low, this is where verification gets skipped most — deliberately search/verify such names rather than answering from memory, even with partial background.

### Effort levels
Default `high`. Step down to `medium`/`low` where evals show quality holds — `low` is often competitive on cost while scoring higher. Reserve `xhigh`/`max` for tasks measured to need it; long deliverables at those levels can double-draft (once in thinking, once in the reply) — ask for extra planning up front and a single-pass output instead of redrafting in full.
