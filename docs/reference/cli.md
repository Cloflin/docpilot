# CLI

```bash
npx docpilot <command>
```

Every command finds `.vitepress/config.mjs` relative to the directory you run it from and reads the `docPilot` named export. There is no second place to state which model embeds or where the docs live.

The loop is `index → calibrate → lint → eval → bench`, with `import` ahead of it whenever the corpus gains a page from somewhere else, and `tune` wherever it is retrieval itself that has to move. The first two are what the panel needs to work at all; the last three are what tells you whether it works well.

`tune` sends you back to the start. It writes a file and stops; `index` is the step that inlines a swept lever into the manifest a reader downloads, and until it runs a tuned lever is a file on disk and nothing more.

`feedback` sits outside the loop. It reads what your own endpoint collected and **proposes** probes for it; it never writes to the eval sets.

## `index`

```bash
npx docpilot index
npx docpilot index --dry
npx docpilot index --no-embed
```

Builds the retrieval index into `docs/public/rag/` (or wherever `indexDir` points). `--dry` chunks and reports without embedding — no network, no model — which is the loop for tuning chunking.

Idempotent: identical input produces byte-identical output.

**It asks the provider which embedding models it serves**, when the model was not
one you wrote down — you named a provider and stopped, or you named neither. The
configured name is tried first and the provider's own answers line up behind it:

```
  embedders 2 to try — custom offers 1, and BAAI/bge-m3 is configured
  warn  BAAI/bge-m3 is not answering (HTTP 404); trying the next embedder
  embedder  acme/gte-large-v2 · 1024d — chosen from 2 candidate(s)
```

One extra request at most, and none at all when you named the model or when a
free pool already stands behind the provider. A name **you** wrote is used as
given and a wrong one fails loudly rather than being replaced. See
[Asking the provider](/reference/config#asking-the-provider).

`--no-embed` writes a real index with **no vectors in it**: no embedding calls, no `vectors.<hash>.bin`, and retrieval by BM25 alone. It is the one-off form of [`embed: false`](/reference/config#embed-false) — the config key is what a deployment sets, because the browser has to be told as well.

The flag alone is not a deployable state, and this is the part to know before reaching for it: a vectorless index under a config that still names an embedder is a readiness FAILURE, not a warning. `npx docpilot doctor` reports it, and a site built in that state ships `{enabled: false}` — no panel at all. Use the flag to look at what the mode produces; set `embed: false` to run on it.

What that mode costs was measured on a 1191-chunk corpus: recall@8 fell from 0.97 to 0.41, retrieval F1 from 0.35 to 0.18, and 11 of 44 answerable questions were refused outright. The lexical channel also scores zero for a question asked in a language your corpus is not written in — there is no overlap to score. Measure your own corpus with `eval --gate-only --lexical` before you throw its vectors away — that needs a written `${evalDir}/golden.jsonl`, so `docpilot init` and the gold answers come first.

It also inlines the calibrated guard. If `${evalDir}/calibration.json` is missing, is for a different corpus, or was measured with a different embedding model, the build **warns and inlines a provisional guard** rather than failing — documentation must stay publishable when a threshold is stale.

And it inlines the tuned retrieval levers, which is the half of [`tune`](#tune) people miss: `tuning.json` reaches a reader only through this command. A missing one is **silent**, not warned — the shipped levers are measured values rather than placeholders, so a site that never runs `tune` is not misconfigured. A `tuning.json` that is present but stale is a warning, and the build falls back to those same shipped values.

## `import`

```bash
npx docpilot import https://example.com/product
npx docpilot import https://example.com/product --dry-run
npx docpilot import https://example.com/product --html page.html --out product
```

Turns an allowlisted external page into a page of the corpus, written to `importDir` with its provenance attached — see [Imported pages](/guide/imported-pages).

Six steps, in this order:

1. **The allowlist runs before the network.** A URL outside `sources.allow` is refused without being fetched, and the line that would widen the boundary is printed rather than applied.
2. **Fetch**, identifying itself as `docpilot-import` and asking for `--lang` (default `en`). A page behind a bot wall or built by JavaScript will not fetch: open it in a browser, save the DOM, and pass `--html <file>` — or `--html -` to pipe it in.
3. **Look for markdown the site already publishes**, and use it if there is any — see below. Steps 4 and 5 are what happens when there is none. `--no-alternate` skips the search.
4. **Extract**, in code: headings, prose, lists, data tables, code samples and tooltips are kept; navigation, footers, cookie banners, share rails and anything whose meaning is a button are dropped. Every drop is named on stdout, and so is the subtree that was read.
5. **Convert** to markdown, with `title`, `description`, `source` and `importedAt` frontmatter and the attribution block.
6. **Annotate**, with the model `chat` points at. This pass may add `<llm-only>` and `<llm-exclude>` and nothing else — the output is stripped of those tags and compared to the input character for character, and a model that reworded, reordered or dropped anything has its whole answer discarded. `--no-annotate` skips it.

### The page's own markdown wins

If the site publishes `page.md` beside `page`, that file is the import. It is not a better conversion of the page — it is what the page was built from, so there is nothing to reconstruct and nothing to lose to a theme.

It is found two ways, because sites do both:

- **declared** — `<link rel="alternate" type="text/markdown" href="…">`, or any `rel="alternate"` pointing at a `.md`;
- **derived** — from `<link rel="canonical">` when there is one, otherwise from the URL you asked for: `/a/b` → `/a/b.md`, then `/a/b/index.md`; a trailing slash tries `index.md` first. Canonical is what the guess is built from because that is the address without the tracking parameters and the trailing slash.

A derived URL is a guess and is treated as one. It goes through **the same allowlist** as the page — it is a URL the tool decided to request — and the response has to come back 200, non-empty and not HTML. A single-page app answers every unknown path with its own shell, so the status code alone proves nothing.

The frontmatter of the published file supplies `title` and `description` when it has them, including YAML block scalars (`description: >-`). Its `#` heading is dropped — the imported page has one already — and its relative links are made absolute against the source site, because they name routes that exist there and not here.

Whichever path ran, the report says so:

```
  read         https://vitepress.dev/guide/what-is-vitepress.md
               the page's OWN markdown — nothing was converted or dropped
```

```
  read         <main#app_main> — nothing outside it was read
               no .md at https://example.com/plugin/index.md (404)
```

| flag | |
|---|---|
| `--dry-run` | print the report and write nothing |
| `--html <file\|->` | read HTML from a file or stdin instead of fetching |
| `--out <slug>` | the file name under `importDir`; defaults to the URL's last segment |
| `--lang <tag>` | the `accept-language` to ask for; default `en` |
| `--no-alternate` | do not look for a published `.md`; convert the HTML |
| `--no-annotate` | skip the model pass |
| `--force` | replace a file that already exists |

The command does not index. An import changes the corpus hash, so what follows it is `index --dry`, `index`, `lint`, `eval --gate-only` and `calibrate` — the command prints that list when it writes.

## `calibrate`

```bash
npx docpilot calibrate
npx docpilot calibrate --sweep-only
npx docpilot calibrate --refresh
npx docpilot calibrate --limit=40
```

Measures the refusal thresholds against `${evalDir}/calibration.jsonl` and writes `${evalDir}/calibration.json`. A run that cannot satisfy its bounds **fails and leaves the previous file untouched** rather than shipping a regression.

| flag | |
|---|---|
| `--sweep-only` | sweep the cached probe scores, embed nothing |
| `--refresh` | ignore that cache and re-embed every probe |
| `--limit=N` | the first N probes of the set; default none |

`--sweep-only` re-runs the threshold search over `${evalDir}/calibration.raw.jsonl` — the per-probe scores the last run cached — which makes trying a different selection rule free. A probe that is not in that file stops the run with the file named rather than being scored as a miss; run once without the flag to populate it. `--refresh` ignores the cache and re-embeds.

`--limit=N` is the short loop while you are authoring probes, and it is a head-slice of the file rather than a sample of it. **A limited run still writes `calibration.json`**, so the thresholds it measures are the ones the next `index` inlines — which is what makes it an authoring aid and not a measurement. Re-run it whole before you rebuild.

The embedder is not a flag on this command either: it comes from `docPilot.embed` through the same resolver `index` uses, so a calibration cannot be measured in a vector space the index was not built in. `DOCPILOT_EMBED_URL`, `DOCPILOT_EMBED_PROVIDER` and `DOCPILOT_EMBED_KEY` still override it, for a sweep against a second endpoint.

There is no `--no-embed` here — that is [`index`](#index)'s flag, and this command reads its consequences off the manifest. On an index built without vectors it calibrates the lexical threshold only: `tauLexical` is swept and held to the same refusal floor, and `tau` — the hybrid threshold — is left null in `calibration.json` and reported as unmeasurable rather than filled in with a number no probe produced.

The null stops there. The next `npx docpilot index` inlines the measured `tauLexical` and puts the provisional 0.3 in the `tau` slot, stamped `source: "calibrated-reduced-lexical"` so the number is never read as measured — the retriever asserts a numeric `tau` at every init, and a null there is a panel that cannot open. Nothing on a vectorless index consults it: every verdict is `G = L` against `tauLexical`.

Run it again after a corpus change, an embedder change, or a prompt override.

## `lint`

```bash
npx docpilot lint
npx docpilot lint --file=<path>
```

Checks the golden set against the index it claims to measure. A `gold_chunks` entry naming a page that has since been renamed never matches, so the record reports a flat 0 that reads as a retrieval regression — this turns that into an error with the id named.

Run it before every `eval`, and after every `index`. **Run it after upgrading this package, too**: the second and later parts of a split section are now `#anchor~2`, `#anchor~3` where they used to be `#anchor-2`, `#anchor-3`, so every gold entry pinned at a continuation part matches nothing until it is repointed. `-N` now means only "the Nth heading with this title", which is what VitePress means by it. See [Building the index](/guide/indexing#what-moves-when-you-upgrade).

## `feedback`

```bash
npx docpilot feedback pull   --from ./export.jsonl
npx docpilot feedback report --from ./export.jsonl
npx docpilot feedback pull   --from https://example.com/feedback --since 2026-07-01
npx docpilot feedback report --from ./export.jsonl --out ./reports/votes.md
```

Turns the votes your readers cast into candidates for the eval sets.

| flag | |
|---|---|
| `--from <path\|url>` | required; a JSONL or JSON export of your own storage, or a GET endpoint |
| `--since <ISO>` | passed to a URL source as `?since=` |
| `--max-pages <n>` | stop after n pages of a paginated URL source; default `50` |
| `--out <path>` | override the output path |

Both spellings work — `--from ./export.jsonl` and `--from=./export.jsonl` — and `--help` prints the same table.

`--out` moves the one file each mode writes: `${evalDir}/candidates.jsonl` for `pull`, `${evalDir}/reports/feedback-latest.md` for `report`. It does not change what is written. A `pull` to a custom path still **merges** into whatever is already there, so pointing two runs at one file accumulates rather than replaces, and pointing one run at a fresh path starts a fresh review.

**This package ships no database driver, and will not.** The panel POSTs to an endpoint you run, into storage you chose; the way back out is yours too. `--from ./export.jsonl` reads anything one-JSON-object-per-line — a `psql -c … > export.jsonl`, a `mongoexport`, a Supabase CSV converted to JSONL, or what `window.__docPilot.exportFeedback()` prints in the console when you run no endpoint at all. A JSON array works as well; the shape is sniffed.

`--from https://…` is the convenience on top: if you already serve a receiver, add a GET beside it. It sends `Authorization: Bearer $DOCPILOT_FEEDBACK_TOKEN` when that variable is set, and follows a `{items, cursor}` pagination until the cursor runs out or `--max-pages` (default 50) — which it tells you about rather than reporting a total that looks complete. **The token comes from the environment only**, never from the config file, on the same rule provider keys already follow.

`pull` writes `${evalDir}/candidates.jsonl`: one row per distinct question, with how often it was asked, the down-rate, a reason histogram, the sentences readers wrote, the gate's numbers across every ask — and a **suggested** stratum with the reasoning for it.

**It writes nothing to `calibration.jsonl` or `golden.jsonl`, on purpose.** A `stratum` is a judgement about what a question was *for*, and a feedback record only carries signals about what the gate *did*. Where the signals cannot separate two strata the row carries `stratumOptions` and no answer, because a single guess is false precision — and false precision in a file that is meant to be reviewed gets rubber-stamped. Every row also carries a `target`, since a good many candidates belong in the golden set or in a documentation backlog rather than in the calibration set at all:

| `target` | what it is | what it still needs |
|---|---|---|
| `calibration` | a threshold probe | a `stratum` you agree with |
| `golden` | the gate passed and the answer was wrong, or the model declined | a `gold_answer`, 90–160 words |
| `docs` | a citation defect — `bad-links` on an answered turn | a fix to the page, not to a number |
| `none` | never reached the gate (a pasted credential, a greeting), or ran degraded | nothing; it is not a probe |

A re-run **merges**: your edits to `stratum`, `target` and `expect`, and any row you marked `promoted`, survive it — counts and gate statistics are refreshed. A row you reviewed for a question nobody asked this time is kept rather than dropped.

`report` writes `${evalDir}/reports/feedback-latest.md`: helpfulness, the reason histogram, refusal causes, the worst questions by down-rate at a minimum of three votes, and what readers wrote. It opens with what the sample cannot tell you — see below.

**Read the bias note before you promote anything.** Votes are not turns: a satisfied reader usually presses nothing, so this is a sample of people who felt strongly, filtered again by whichever verdicts `feedback.send` lets through. Under `feedback.send: 'down'` it is a purely negative sample, and calibrating tau against one moves the gate toward refusing every reader — the exact failure the stratified design in `calibrate` exists to prevent. That is why every candidate arrives as `needsReview: true`.

## `--level=` {#level}

`eval`, `bench emit` and `tune` all take one, and all three read it out of the same module, so a bench and an eval at the same tier start from the same records.

A golden record declares the pool it **enters** at:

```json
{"id": "q-01", "question": "How do I get started?", "level": "low", "expect": "answer", …}
```

Six tiers, smallest pool first:

`low` · `medium` · `high` · `xhigh` · `max` · `ultra`

**They are cumulative.** `--level=medium` runs low + medium. Every larger pool contains every smaller one, and that is the whole point: a regression in the smoke pool is a regression in the full set too, so the quick run and the full run can never disagree about which questions matter. `--limit=N` — still there, still a head-slice of whatever the author happened to write first — cannot give you that. Where both are passed, the level picks the population and `--limit` then takes the head *of that tier*.

Two defaults, and between them they land tiers on a golden file that already exists without moving a single number:

- **a record with no `level` reads as `high`.** `high` is defined as roughly the set that exists today, so a file written before tiers existed scores identically under `--level=high` and under no flag at all. Nobody has to backfill sixty records to keep their history.
- **a run with no `--level` is `ultra`** — everything, which is exactly what every run did before.

An unknown tier is refused rather than defaulted, by every command that takes the flag: a typo that fell through to `ultra` would print a pool nobody asked for and be read as the tier the author thought they ran. In the *file*, the rule is inverted — a record whose `level` is not one of the six falls into **every** pool, `ultra` included, because a typo may never delete a question from a run. Turning that into an error is `lint`'s job: it warns on an absent `level`, errors on an unrecognised one with the id named, and prints the pool size each tier yields.

**A bare flag is the same promise, and it is now kept.** These parsers read `--name=value` and nothing else, so `--level low` left `low` as a stray positional and the flag read as *absent* — which means `ultra`. That was silent and destructive rather than merely wrong: the run scored the whole set, stamped `meta.level: 'ultra'`, and — because `ultra` adds no segment — wrote itself over the full-set baseline report and then diffed itself against it, with the header line that names the pool suppressed for exactly that tier. Every value-taking flag on `eval`, `bench` and `tune` now refuses instead, naming itself and the form it wants:

```
  FAIL  --level takes a value: --level=low
```

The boolean flags — `--gate-only`, `--lexical`, `--resume`, `--dry` — are unaffected: for them the bare form *is* the form.

**A filtered run is only ever compared against its own level.** `eval` files a narrowed run apart as `report-<hash>-<model>-lvl-<level>-<prompt>.json`, and the report refuses to pair two runs across levels — `--level=low` scores a different *population*, not a smaller sample of the same one, so a delta between the two is arithmetic on unrelated numbers. `ultra` adds no segment at all, which is what keeps every unfiltered report on disk pairing with its successor. `bench emit` follows the same rule with a `.<level>` segment in its default task path, so a smoke emit cannot overwrite the full task file the last comparison was scored on.

### `latest.json` is the last unfiltered run {#latest-json}

Beside the report it writes under that name, `eval` copies every run to `${evalDir}/reports/latest.json` — the fixed path anything outside this tool reads. A narrowed run is filed next to it as `latest.<level>.json`, on the same asymmetry as everything above: `ultra` adds no segment, so a path that is already hard-coded keeps pointing at exactly what it always did.

It is the one artefact levels did not partition, and it is the one most likely to be read by something that is not looking. Unpartitioned, `npx docpilot eval` followed by `npx docpilot eval --level=low` left that path holding a ten-question smoke score where the project's number was the full-set one over sixty — `meta.level` inside the document either way, and nobody reading it.

## `eval`

```bash
npx docpilot eval
npx docpilot eval --gate-only
npx docpilot eval --gate-only --lexical
npx docpilot eval --models=qwen3:8b,phi4:14b
npx docpilot eval --level=medium --limit=5
npx docpilot eval --resume
DOCPILOT_BASE_URL=https://api.openai.com npx docpilot eval --provider=openai --models=gpt-4o-mini
```

Runs `${evalDir}/golden.jsonl` and writes a report to `${evalDir}/reports/`.

`--level=` scores one tier of the set — see [`--level=`](#level) above. The tier is stamped into the report's metadata on every run, filtered or not, and a report written before tiers existed reads as `ultra`, so the history survives.

`--gate-only` measures retrieval and refusal without calling a model — fast, free, and the right loop while tuning. `--lexical` additionally disables the dense channel, which is how you measure what the embedder is actually worth on your corpus.

On an index built without vectors the flag is implied — there is no dense channel to disable — and the report's metadata says the run was lexical-only, so a number from it is never mistaken for a hybrid one.

Reports are named by index hash, model and **prompt hash**. Two reports built from different instructions are not comparable, and the tool says so instead of diffing them. `docPilot.product`, `prompt.override` and `prompt.extend` all move that hash, because all three change what is sent.

### Flags {#eval-flags}

| flag | |
|---|---|
| `--level=<tier>` | which pool to score; default `ultra`, the whole set — see [`--level=`](#level) |
| `--limit=N` | the first N records of the selected tier; default none. A head-slice, not a sample — see [`--level=`](#level) for why the two are not interchangeable |
| `--models=a,b` | the matrix, one report per model; default `qwen3:8b`. `--model=` is the one-model alias it has always been |
| `--gate-only` | retrieval and the gate only, no model called |
| `--lexical` | additionally disable the dense channel |
| `--resume` | reuse a report already on disk for that model instead of re-running it |
| `--provider=<id>` | the wire adapter: `ollama`, `openai` or `anthropic`; default `DOCPILOT_PROVIDER`, else `ollama` |
| `--fallback=auto\|on\|off` | which transport the answering half runs on; default `auto` |
| `--max-iterations=N` | the agent loop's ceiling; default `2` |
| `--num-ctx=N` | the context window pinned per request; default `8192`, Ollama only |

`--provider=` names the same three **wire adapters** the panel runs on, so an eval measures the transport your readers will actually get. It is not the fourteen provider names the config takes: every OpenAI-compatible service — OpenRouter, Groq, DeepSeek — is `openai` here, with `DOCPILOT_BASE_URL` pointing at it and the key in the environment (`DOCPILOT_API_KEY`, or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`). Nothing is stored, and no report carries a credential. Spell it carefully: an unrecognised id falls back to the Ollama adapter rather than being refused, and the header line each model prints names the transport but not the adapter. The report records the string you typed as `meta.provider`, which is where a typo shows up — after the run.

The **embedder** is not this flag. It is resolved from `docPilot.embed` by the same resolver `index` uses, because the two halves are configured separately — Anthropic answers and cannot embed — and deriving one from the other embedded a hosted corpus's queries against a local Ollama, scoring them in a foreign vector space and reporting the result as this corpus's retrieval quality. `DOCPILOT_EMBED_PROVIDER`, `DOCPILOT_EMBED_URL` and `DOCPILOT_EMBED_KEY` override it; a reply of the wrong dimensionality stops the run.

`--fallback=` decides whether the run uses native tool calling or the no-tools transport. `auto` asks each model what it supports — the server's capability list where there is one, a behavioural probe where there is not — which is the only way a model advertised as a tool caller and shipped without tool support is measured on the transport it will actually run on. `on` and `off` force it, which is how you measure the same model both ways.

`--max-iterations=` defaults to what the product ships, so an eval with no flags measures the configuration a reader gets rather than a laboratory one. It is written into the report's metadata.

`--num-ctx=` is pinned because Ollama's server default is 4096 tokens and a primed turn is routinely larger. Unpinned, each model in a matrix truncates at a different point and the run measures three different prompts. `8192` is the default; 16384 is the largest value every model in the reference matrix can honour. On `openai` and `anthropic` the value is not sent at all and the report records `numCtx: null`.

`--resume` is what makes a matrix restartable. For each model it looks for the report **this** run would write — index hash, model, `-lexical`, `-novec`, tier and prompt hash all have to match — and loads that instead of calling the model again; a model with no such report still runs. Because the name carries all six, a resumed run can never pick up a report of a different measurement: `--level=low` will not read the full-set file, and a re-indexed corpus resumes nothing. It does nothing under `--gate-only`, which calls no model and has nothing to skip.

**Every value-taking flag here refuses a bare form.** `--level low`, `--limit 5` and `--num-ctx 4096` are all read as absent by a parser that matches `--name=` and nothing else, so the run would use the default and report it as fact — see [`--level=`](#level).

## `bench`

```bash
npx docpilot bench emit  --config=base
npx docpilot bench emit  --config=swept        # with the levers set in the environment
npx docpilot bench emit  --config=base --level=low
npx docpilot bench shard --tasks=base.tasks.jsonl --shards=10
npx docpilot bench score --tasks=a,b --answers=a,b
npx docpilot bench runs  --tasks=a,b --runs-a=a1,a2,a3 --runs-b=b1,b2,b3
npx docpilot bench judge-emit  --tasks=a,b --answers=a,b
npx docpilot bench judge-score --verdicts=v.jsonl --key=judge.key.jsonl
```

Compares two retrieval configurations on **answer quality**, with no API key. Retrieval, the gate and the primed observation run in-process from the production modules; the forced final call is handed to agents through a checked-in protocol.

What it measures is the difference between two configurations. What it does **not** measure — and must never be quoted as — is the agent loop, tool calls, iterations, latency or tokens per answer.

Artefacts go to `${evalDir}/bench/`, which `docpilot init` gitignores: the filenames are stable across runs, so a fresh run overwrites the previous one's answers.

`emit` takes `--level=` — see [`--level=`](#level). It is the only mode that does: the tier chooses the population, and `score` and the judge modes then work on whatever task and answer files you hand them. A narrowed emit writes `<config>.<level>.tasks.jsonl` rather than `<config>.tasks.jsonl`, which is what stops a ten-task smoke emit from silently replacing the sixty-task file the last comparison was scored on. Within the pool, `emit` measures only records whose `expect` is `answer`, so its count reads "answer tasks within the tier", never "the tier".

**Three runs, not one.** A single-run difference between two configurations is usually inside their own run-to-run spread. `runs` is the mode that measures that spread, so the difference can be read against it.

### The six modes {#bench-modes}

| mode | what it does |
|---|---|
| `emit` | build the task file for one config: retrieval, the gate, the primed observation and the message array, per record |
| `shard` | split a task file into per-answerer files, **withholding the gold** |
| `score` | the deterministic table: two or more configs, one answering run each |
| `runs` | the same two configs answered N times, so run-to-run spread is printed beside the delta |
| `judge-emit` | blind pairwise packets for an advisory judge, plus the side key |
| `judge-score` | unblind those verdicts and report them |

`shard` exists for the withholding. A shard line carries the id, the prompt and the citable id set and **nothing else** — `gold_answer`, `identifiers` and `gold_chunks` stay behind in the task file, because an answerer that can see the gold copies it and every metric downstream becomes a measurement of that copy. Shards are written as `<taskfile-basename>.shardNN.jsonl`.

`judge-emit` assigns sides by a hash of the record id, so neither config is systematically "left", and writes the key to a **separate** file the judge never reads. Each side is judged against its own excerpts, since the differing evidence is the thing under test. The judge is advisory and may never gate: a model inside the instrument measuring the model is not a measurement.

### Flags {#bench-flags}

| flag | mode | |
|---|---|---|
| `--config=<name>` | `emit` | required; names the configuration and the default output file |
| `--level=<tier>` | `emit` | which pool to emit; default `ultra` — see [`--level=`](#level) |
| `--out=<file>` | `emit`, `judge-emit` | where to write; default `${evalDir}/bench/<config>[.<level>].tasks.jsonl`, and `${evalDir}/bench/judge.jsonl` for the judge |
| `--history=<file>` | `emit` | answers from an earlier pass, so a follow-up record can carry the turn it follows |
| `--tasks=<file[,file]>` | `shard`, `score`, `runs`, `judge-emit` | one file for `shard`; two for `runs` and `judge-emit`; `score` takes as many as `--answers` |
| `--answers=<file,file>` | `score`, `judge-emit` | the answering runs, one per task file and in the same order |
| `--shards=<n>` | `shard` | how many files to split into; default `10`, capped at the task count |
| `--dir=<path>` | `shard` | where the shards go; default the task file's own directory |
| `--stage=<n>` | `shard` | emit only tasks of that stage; default all. `--stage=2` is the answering turn; stage 1 exists only to seed a follow-up |
| `--runs-a=<a,b,c>` | `runs` | config A's answer files, one per run |
| `--runs-b=<a,b,c>` | `runs` | config B's, and the same count |
| `--key=<file>` | `judge-emit`, `judge-score` | the side key; `judge-emit` defaults it to the `--out` path with `.jsonl` replaced by `.key.jsonl`, `judge-score` requires it |
| `--verdicts=<file>` | `judge-score` | required; the judge's verdicts, one JSON object per line |

`--history=` is not optional in practice for a set with follow-ups. Without it a follow-up record's prompt is missing the turn it follows, and the record measures a different question than the one it names.

**A bare flag is refused.** Every flag in that table is checked at start-up for the `--name value` form, and named with the shape it wants, because a parser matching `--name=` alone reads a bare one as absent: `--level` falls through to `ultra`, `--out` and `--history` fall through to a default path, and `--tasks`/`--answers` fall through to an empty list. On `emit` that combination writes sixty tasks over the file the last comparison was scored on.

## `tune`

```bash
npx docpilot tune
npx docpilot tune --level=medium          # narrowed: report only, no tuning.json
npx docpilot tune --lambda=0.5:1.0:0.05
npx docpilot tune --k=4:12
npx docpilot tune --dry
```

Sweeps the two retrieval levers — `MMR_LAMBDA` × `GATE_K` — against `${evalDir}/golden.jsonl` and writes the winning cell to `${evalDir}/tuning.json`, with a report of the whole grid beside it. **The whole set, or no `tuning.json` at all** — see [What it writes](#tune-writes).

It needs an index to sweep against and a golden set to sweep with, so it belongs after `index` and after `lint`. Stage A calls the **embed** endpoint — resolved from your config by the same resolver `index` uses, and asked for the model the manifest was built with; a reply of the wrong dimensionality stops the run rather than scoring this corpus in a vector space it was never built in. A run where no positive record at the chosen tier carries `gold_chunks` inside its own scope fails outright rather than reporting a grid of nulls: there is nothing for retrieval F1 to be measured against, and `lint` is what verifies those ids still resolve.

Both of those numbers used to be literals in `retriever.js`, arrived at by a hand-run loop — export a `DOCPILOT_*` variable, re-run `eval --gate-only`, read four figures off the summary, repeat — performed by eyeball, once, against **one** corpus, and then shipped to every consumer's bundle. This is that loop with the eyeball removed, and `tuning.json` is where the answer gets to live instead of in a code comment.

### What it sweeps, and what it leaves alone

| lever | what it is | swept? |
|---|---|---|
| `MMR_LAMBDA` | relevance against redundancy in the re-rank | **yes** — default axis `0.5:1.0:0.05` |
| `GATE_K` | the gate's own excerpt count: how many passages prime the turn | **yes** — default axis `4:12` |
| `CANDIDATES`, `FUSED` | pool construction | no — they move what *can* be selected, not what is shown, and the build will not inline them for that reason |
| the model's `search_docs` k | the tool argument | no — `search()` clamps it to 1..8, whatever the levers say |

`GATE_K` is the k that matters, because it is the k every retrieval metric in `eval` is measured at: the gate primes the turn with exactly that many excerpts, and retrieval F1 is scored on exactly that set.

**A tuned `GATE_K` above 8 is legal but partial**, and the default axis runs to 12 so you will meet one. It widens the excerpts that **prime** the turn, which is exactly what retrieval F1 is measured on, so the gain the grid reports is real. What it cannot widen is a `search_docs` call the model makes for itself: that k is clamped to 1..8, so the model can never reach a k of 10 on its own however the lever is set. Read a win above 8 as a win on the primed turn — worth having on a corpus whose answers routinely span several sections, worth less on one where the model searches its way to the answer over several tool calls. At 8 or below the two agree and the distinction does not arise. The report calls this out under the grid, and again on the chosen cell when the winner crosses it.

The k axis is capped at the resolved `FUSED` for a different reason: `FUSED` is the pool the re-rank picks from, so any k above it selects the whole pool and every larger k measures an identical cell.

### What it costs

**One embedding per record** — plus one more per follow-up, for the composed query — and then a pure in-process grid. No chat model is contacted, there is no LLM judge, and nothing is re-embedded between cells, so roughly a hundred cells cost one embedding pass rather than a hundred.

That is possible because **the gate is invariant under this grid.** `MMR_LAMBDA` and `GATE_K` reach only the re-rank and the excerpt slice — *which* passages are handed over once a turn has already been admitted. The gate's own verdict is computed from the best cosine over the whole scope and the top lexical hits, neither of which either lever touches. So pure retrieval metrics are sufficient here, and no cell can buy F1 by refusing the questions it is bad at. That is a property of today's code rather than a law, so every cell measures the over-refusal count anyway and the report prints it as a sanity row — the day it stops being constant, the table says so and tells you not to inline the result.

The winner is argmax mean retrieval F1, then recall@8, then MRR, then proximity to the levers already in force. That last tie-break is not cosmetic: a tie decided by float noise would churn a committed file, a rebuilt index and a redeployed bundle for a difference of zero.

### Flags

| flag | |
|---|---|
| `--level=<tier>` | which pool to sweep against; default the whole set — see [`--level=`](#level). **Narrows the run, so it writes no `tuning.json`** |
| `--lambda=lo:hi:step` | the λ axis; default `0.5:1.0:0.05`, bounded 0..1 |
| `--k=lo:hi` | the `GATE_K` axis; default `4:12`, whole numbers, capped at the resolved `FUSED` |
| `--dry` | write the report, leave `tuning.json` untouched |
| `--limit=N` | the first N records of the selected tier — a shape check, not a measurement. **Narrows the run the same way** |

A bare `lo` pins an axis to one value, which is how you sweep one lever and hold the other. A malformed range **throws** and never falls back to the default: a silent fallback would run the sweep over a grid nobody asked for and write its winner to a file that gets inlined into a bundle, with the typo still on screen. A range yielding more than 200 points is refused as well. `--limit` is checked the same way and for the same reason — it decides whether this run may write `tuning.json` at all, so `--limit=ten` is refused rather than read as "no limit".

Every flag is checked **before** the index is loaded and long before stage A embeds anything: a run that is going to be refused has to be refused while it is still free.

### An axis pinned in the environment refuses the run {#tune-env}

`docpilot tune` will not start while `DOCPILOT_MMR_LAMBDA` or `DOCPILOT_GATE_K` is set — including from `.env.local`, which is loaded into the environment before the check runs.

The reason is the precedence below working correctly. Env outranks the tuning object, and the tuning object is precisely what this command varies per cell: a pinned axis makes all ninety-nine cells measure the identical retrieval, all three metrics tie everywhere, and the winner falls out of a tie-break rather than a measurement — a value **nothing on the grid scored**, on its way into a committed file and from there into every reader's bundle. That is a shell variable shipping, against the rule that env never ships.

The variable is named and the run stops, rather than being unset for you: the environment is yours, and this process shares it with whatever launched it. The remedy is `unset`, or pinning the axis where a pin is honest — a bare `lo` on the grid:

```bash
unset DOCPILOT_GATE_K
npx docpilot tune --k=5          # the same pin, on the axis, in the report
```

The other six levers are reported rather than refused. A `DOCPILOT_FUSED=20` widens the pool the sweep selects from, which is a real thing to want to measure — but `tuning.json` records only λ and `GATE_K`, so the answer was measured under a pool the file does not mention, and the run says so.

### What it writes {#tune-writes}

`${evalDir}/tuning.report.md`, **always** — `--dry` exists to produce exactly that file, and a sweep you cannot read is a sweep you have to run again. It carries the chosen cell against the baseline, the full λ × k grid, the gate-invariance sanity row, and the ten records that moved most in each direction, which is where a headline of +0.02 mean F1 turns out to be one record going 0 → 1 and nine going nowhere.

A narrowed run files its report apart, and only a narrowed one gains a segment — a full run keeps the name it has always had, so no report on disk is orphaned:

| run | report |
|---|---|
| `npx docpilot tune` | `tuning.report.md` |
| `--level=medium` | `tuning-lvl-medium.report.md` |
| `--limit=20` | `tuning-n20.report.md` |
| `--level=low --limit=5` | `tuning-lvl-low-n5.report.md` |

`${evalDir}/tuning.json`, from a **full-pool run only**, and not under `--dry`. It carries the two measured levers and **nothing else** — the other six lever names are deliberately absent rather than written at their current values, because a key in that file is a claim that the number was measured on this corpus, and freezing six unmeasured constants into a consumer's manifest would make a later change to the shipped defaults invisible.

**So `--level` and `--limit` make the run report-only**, and that is a different decision from the suffix above rather than an inconsistency with it. The two artefacts are different kinds of thing. A report is reading material: a narrowed one is useful, it just must not overwrite the full-set one, and a suffix is exactly enough. `tuning.json` has one purpose — to be read back by `docpilot index` from one fixed path and inlined into every reader's bundle. So a `tuning-lvl-low.json` has only two possible fates, and both are worse than not writing it: nothing ever reads it, or something does and the smoke-pool answer ships anyway. Writing it to the fixed path is worse still, and is the defect this rule exists for: ten records replacing levers that took the whole golden file to earn, waved through by every check the build makes, because the version, the index hash and the embedding model all still match.

The run says which it did, on the way in and on the way out:

```
  narrowed pool — REPORT ONLY, docpilot/tuning.json will not be written
```

Re-run with no `--level` and no `--limit` to write it.

It is written even when the sweep picks the levers already in force. That is the point rather than an oversight: an unwritten winner survives only as a literal in the package, and the next release that moves that literal would move your corpus without anybody deciding to. Pinning it is the difference between "measured and unchanged" and "never measured".

### The step everyone forgets

**`tuning.json` does nothing until the next `npx docpilot index`.** `tune` writes the file and stops. It is the build that reads it back, validates it, and inlines the levers into the manifest, from where they reach every retrieval in the browser and in the eval. Until then, the file is a measurement nobody is running on.

The build drops it — loudly, and back to the shipped defaults — when it is a version this build does not read, when it names a different index hash, or when it was measured with a different embedding model. That last one has no other way of being caught: the index hash is taken over chunk text, so swapping the embedder leaves it identical, and a λ measured in one embedder's cosine space describes nothing about where another one puts its cosines.

On an index built without vectors there are no cosines at all, so what is really being swept is BM25 order plus `GATE_K`. The run still means something, the report says so on every page, and `embedModel` is written as `null` — which fails against every embedder while still matching the vectorless build it came from.

### What it may never touch

`tau`, `tauLexical`, `wDense` and `wLexical` are the guard's, set by [`calibrate`](#calibrate) and by nothing else. Levers are `tune`'s; thresholds are `calibrate`'s. Should one of those four find its way into `tuning.json` — by hand, by a merge, by a future writer being helpful — the build names it and drops it rather than letting it ride into the manifest the guard also rides in.

**The build's allowlist is narrower than that, and narrower than "a lever".** Only `MMR_LAMBDA` and `GATE_K` may travel through `tuning.json` into a bundle: the two `tune` measures, and no others. The remaining six — `RRF_K`, `W_LEXICAL_RRF`, `W_DENSE_RRF`, `CANDIDATES`, `FUSED`, `EXPAND_BELOW_TOKENS` — are dropped with a line saying they were never measured on this corpus, even though every one of them resolves fine at runtime.

That is the point rather than an oversight. `tuning.json` is a file you commit and may hand-edit, and the gate reads its lexical evidence off the top three of a candidate list `CANDIDATES` sizes — so a hand-written `CANDIDATES: 1` starves that evidence and turns an answerable question into a refusal, with no threshold named, no model called and nothing printed. A refusal verdict is `calibrate`'s to move; anything that can move one hits a wall here. Set the six for an exploratory run in the environment, where they belong and where they cannot ship.

One thing does outrank a tuned lever: a [`topK`](/reference/config#topk) you set yourself is `GATE_K` under its documented name, and an author's number beats a measured one. The full order is a `DOCPILOT_*` variable, then your config's `topK`, then `manifest.tuning`, then the package default — with one implementation of that rule, so the report can never name a lever the retrieval did not run on. A `DOCPILOT_*` that is not a number does not count as set: it leaves the lever where it was rather than pinning the corpus to garbage.

**That first layer is read when a lever is resolved, not when the module loads** — which is what makes `.env.local` work at all. Every CLI entry point loads that file into the environment *after* its imports, so a layer answering out of import-time constants would be reading a snapshot taken before the file existed: `DOCPILOT_GATE_K=9` in `.env.local` counted as set, resolved to the package literal, and discarded both its own value and `manifest.tuning` on the way past. All eight lever variables now take effect from `.env.local`, including the six that were silently dropped on that path. In the browser there is no environment at all — `globalThis.process` is undefined — so the rule collapses to `manifest.tuning` then the package default, and nothing set in a shell can ship.

## `doctor`

```bash
npx docpilot doctor
npx docpilot doctor --proxy
npx docpilot doctor --models
```

Prints what was resolved and either confirms the panel will render or lists what is missing, each with the command or variable that fixes it. **Exits non-zero when not ready** — the build never fails for these, so this is the opt-in place to gate CI.

It also prints [the provider chain](/guide/providers#name-nothing-the-provider-chain) in full, with the member that answered marked — unconditionally, whether the provider was named in your config or chosen by the environment:

```
[docpilot] chain     auto → openai
                     ✓ openai      OPENAI_API_KEY         ←
                     · gemini      GEMINI_API_KEY
                     · mistral     MISTRAL_API_KEY
                     …
                     ✓ ollama      no key needed
```

The build log stays quiet about this when a provider is named, because a line restating your config file is noise in a block people read at every start. `doctor` is the opposite: it is run precisely when the question is *why is it talking to that*, and which variables are set is not visible anywhere else. Only the **name** of a variable is ever printed, never its value.

It runs without a config file at all, on the shipped defaults and your environment. That is the zero-config install, and a command that exited there could not check it.

`--proxy` additionally prints the contract a production reverse proxy has to satisfy: the exact paths, the upstream for each, and the name of the header the key goes in. The key value is never printed. See [Production](/guide/production) for what to do with it.

`--models` also asks whether the **chat-only** claim in the provider table still holds. `anthropic`, `deepseek`, `groq`, `xai` and `cerebras` are recorded as serving no embeddings endpoint, which is a claim rather than a law — the same table said that of OpenRouter for months after it stopped being true, and the cost of it going stale is a second key and the text of your whole corpus posted to a third party at build time. So the endpoint is knocked on, with a candidate from the provider's own catalogue, and the answer is printed when it has changed:

```
[docpilot] embed?    groq answers /v1/embeddings after all — nomic-embed-text-v1.5
                     embed: {provider: 'groq'} drops the borrowed openrouter key
```

Silent otherwise, which is the expected case. It **reports and never acts**: the reverse proxy carrying `/ai/v1/embeddings` is written from your config at build time, so a build that moved itself would send every reader's query vector to the wrong upstream. Two candidates at most, so this cannot become a survey of somebody's catalogue. `anthropic` is skipped without a request — its API has no embeddings path to knock on.

`--models` asks the provider's live free catalogue whether the model list in force is still being served — the chat half and the embed half separately, and for each it is the free pool this package ships when the model is left unnamed, or your own `chat.models` where you wrote one. It prints the pool size against the catalogue size, then `RETIRED:` for every id upstream no longer lists and up to six that are new upstream. This is the one question a baked list cannot answer for itself, and free ids are retired weekly: a pool whose members have all been retired fails in the least legible way available, 404ing model by model until the reader is told the last one's name.

**It is a flag rather than part of the default run because it is the only thing in `doctor` that touches the network.** `doctor` is the command CI gates on, and a check that fails when a third party is slow is a check that gets removed — which takes the readiness gate with it.

It checks only a half that has a pool *and* a catalogue to check it against. On a provider that publishes neither, the line reads `no catalogue to check them against` rather than reporting every id as retired, and an unreachable catalogue is printed as unreachable rather than turned into a verdict. The exit code stays the readiness one either way — a retired id is news, not a broken configuration. See [Living on the free tier](/guide/free-tier).

## `init`

```bash
npx docpilot init
```

In a terminal, and only when nothing has already answered them, it asks two questions — where the button goes and what shape the panel is — and prints the config block for your answers. It never edits your config: the block is yours to paste.

| flag | effect |
|---|---|
| `--trigger=nav\|fab\|both\|none` | answers the first question. A comma list works too — `--trigger=nav,fab` |
| `--panel=auto\|drawer\|popup` | answers the second |
| `--yes`, `-y` | take the defaults, ask nothing |

The trigger question offers the four words; [`ui.trigger`](/reference/config#ui-trigger) also takes an array written out, which is something you put in your own config rather than answer at a prompt.

Any flag, a missing TTY, or a directory with no VitePress config skips the questions entirely — which is what makes `npx --yes`, CI and a Dockerfile work. Both values are validated by the same resolver the build and the browser run, so an unusable value is reported once, in the same words, wherever it was typed. See [`ui`](/reference/config#ui) for what the two settings mean.

Scaffolds the whole loop, and **never overwrites**:

| written | why |
|---|---|
| `.env.example` | the key names for every provider, copied from `src/templates/env.example` |
| `${evalDir}/golden.jsonl` | three starter records, one of which must be refused, each carrying a [`level`](#level) |
| `${evalDir}/calibration.jsonl` | six starter probes, half answerable |
| `${evalDir}/.gitignore` | the raw cache and the bench scratch |
| `.gitignore` | **appended, not created** — one entry for `docs/public/rag/`, the built index |
| `.claude/skills/docs-rag/` | the tuning and measurement loop, as a skill |
| `.claude/skills/docs-import/` | the imported-page contract, as a skill |

The two starter golden records that expect an answer enter at `low` and `medium`, and the negative — the one that must be refused — enters at `low`, so the smallest pool cannot be passed by answering everything. See [`--level=`](#level).

The skills are copied rather than left in the package because `.claude/` inside `node_modules` is not discovered — copying is the only way they reach anyone. See [Skills](/reference/skills).

`.gitignore` is the one exception to *never overwrites*, and it is an append rather than a write: your project almost certainly has one, and skipping it is how the ignore rule ended up documented and never implemented. The index is megabytes of quantised vectors rewritten whole by every `npx docpilot index`, so a repository that commits it grows by that much per rebuild. Delete the line if you would rather commit it — a deploy that ships the index makes no API requests of its own, which is what this repository does. Running `init` twice adds the entry once.

Every file is reported as written or kept, so running it twice is safe and running it in an existing project is honest.

### Upgrading: never overwriting cuts both ways {#init-upgrade}

The rule that makes `init` safe to re-run is the rule that makes it useless for an upgrade. It writes a file only when nothing is there, and that check never looks at what the existing file *says* — so a project that ran `init` once keeps its copy of the skills forever, across every package upgrade that rewrites them. Re-running `init` prints `kept … (already there)` for each one and moves on.

The copying is file by file, which makes the result worse than simply stale: a file the upgrade **added** to a skill does arrive, because nothing is there to keep, while every file it **changed** stays at the old version. A skill directory can end up half of one release and half of another, with nothing on screen to say so.

Nothing warns you about any of this, because from `init`'s side there is nothing wrong: your `golden.jsonl` and your `calibration.jsonl` are yours too, and quietly replacing either of those would be far worse than a stale skill.

So after upgrading the package, refresh the copied skills by hand:

```bash
rm -rf .claude/skills/docs-rag/ .claude/skills/docs-import/
npx docpilot init
```

Delete only the skill directories. Everything else `init` writes is yours to keep — the eval sets especially, which is the whole reason the helper refuses to overwrite in the first place. If you have edited a skill locally, diff it against the package's own copy under `node_modules/@cloflin/docpilot/skills/` rather than deleting it — that directory is what `init` copies from.
