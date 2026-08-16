# CLI

```bash
npx docpilot <command>
```

Every command finds `.vitepress/config.mjs` relative to the directory you run it from and reads the `docPilot` named export. There is no second place to state which model embeds or where the docs live.

The loop is `index → calibrate → lint → eval → bench`, with `import` ahead of it whenever the corpus gains a page from somewhere else. The first two are what the panel needs to work at all; the last three are what tells you whether it works well.

`feedback` sits outside the loop. It reads what your own endpoint collected and **proposes** probes for it; it never writes to the eval sets.

## `index`

```bash
npx docpilot index
npx docpilot index --dry
```

Builds the retrieval index into `docs/public/rag/` (or wherever `indexDir` points). `--dry` chunks and reports without embedding — no network, no model — which is the loop for tuning chunking.

Idempotent: identical input produces byte-identical output.

It also inlines the calibrated guard. If `${evalDir}/calibration.json` is missing, is for a different corpus, or was measured with a different embedding model, the build **warns and inlines a provisional guard** rather than failing — documentation must stay publishable when a threshold is stale.

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
```

Measures the refusal thresholds against `${evalDir}/calibration.jsonl` and writes `${evalDir}/calibration.json`. A run that cannot satisfy its bounds **fails and leaves the previous file untouched** rather than shipping a regression.

`--sweep-only` re-runs the threshold search over the cached probe scores and embeds nothing, which makes trying a different selection rule free. `--refresh` ignores that cache and re-embeds.

Run it again after a corpus change, an embedder change, or a prompt override.

## `lint`

```bash
npx docpilot lint
npx docpilot lint --file=<path>
```

Checks the golden set against the index it claims to measure. A `gold_chunks` entry naming a page that has since been renamed never matches, so the record reports a flat 0 that reads as a retrieval regression — this turns that into an error with the id named.

Run it before every `eval`, and after every `index`.

## `feedback`

```bash
npx docpilot feedback pull   --from ./export.jsonl
npx docpilot feedback report --from ./export.jsonl
npx docpilot feedback pull   --from https://example.com/feedback --since 2026-07-01
```

Turns the votes your readers cast into candidates for the eval sets.

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

## `eval`

```bash
npx docpilot eval
npx docpilot eval --gate-only
npx docpilot eval --gate-only --lexical
npx docpilot eval --models=qwen3:8b,phi4:14b
```

Runs `${evalDir}/golden.jsonl` and writes a report to `${evalDir}/reports/`.

`--gate-only` measures retrieval and refusal without calling a model — fast, free, and the right loop while tuning. `--lexical` additionally disables the dense channel, which is how you measure what the embedder is actually worth on your corpus.

Reports are named by index hash, model and **prompt hash**. Two reports built from different instructions are not comparable, and the tool says so instead of diffing them. `docPilot.product`, `prompt.override` and `prompt.extend` all move that hash, because all three change what is sent.

## `bench`

```bash
npx docpilot bench emit  --config=base
npx docpilot bench emit  --config=swept        # with the levers set in the environment
npx docpilot bench score --tasks=a,b --answers=a,b
npx docpilot bench judge-emit --tasks=a,b --answers=a,b
```

Compares two retrieval configurations on **answer quality**, with no API key. Retrieval, the gate and the primed observation run in-process from the production modules; the forced final call is handed to agents through a checked-in protocol.

What it measures is the difference between two configurations. What it does **not** measure — and must never be quoted as — is the agent loop, tool calls, iterations, latency or tokens per answer.

Artefacts go to `${evalDir}/bench/`, which `docpilot init` gitignores: the filenames are stable across runs, so a fresh run overwrites the previous one's answers.

**Three runs, not one.** A single-run difference between two configurations is usually inside their own run-to-run spread.

## `doctor`

```bash
npx docpilot doctor
npx docpilot doctor --proxy
```

Prints what was resolved and either confirms the panel will render or lists what is missing, each with the command or variable that fixes it. **Exits non-zero when not ready** — the build never fails for these, so this is the opt-in place to gate CI.

`--proxy` additionally prints the contract a production reverse proxy has to satisfy: the exact paths, the upstream for each, and the name of the header the key goes in. The key value is never printed. See [Production](/guide/production) for what to do with it.

## `init`

```bash
npx docpilot init
```

In a terminal, and only when nothing has already answered them, it asks two questions — where the button goes and what shape the panel is — and prints the config block for your answers. It never edits your config: the block is yours to paste.

| flag | effect |
|---|---|
| `--trigger=nav\|fab` | answers the first question |
| `--panel=auto\|drawer\|popup` | answers the second |
| `--yes`, `-y` | take the defaults, ask nothing |

Any flag, a missing TTY, or a directory with no VitePress config skips the questions entirely — which is what makes `npx --yes`, CI and a Dockerfile work. Both values are validated by the same resolver the build and the browser run, so an unusable value is reported once, in the same words, wherever it was typed. See [`ui`](/reference/config#ui) for what the two settings mean.

Scaffolds the whole loop, and **never overwrites**:

| written | why |
|---|---|
| `.env.example` | the key names for every provider, copied from `src/templates/env.example` |
| `${evalDir}/golden.jsonl` | three starter records, one of which must be refused |
| `${evalDir}/calibration.jsonl` | six starter probes, half answerable |
| `${evalDir}/.gitignore` | the raw cache and the bench scratch |
| `.claude/skills/docs-rag/` | the tuning and measurement loop, as a skill |
| `.claude/skills/docs-import/` | the imported-page contract, as a skill |

The skills are copied rather than left in the package because `.claude/` inside `node_modules` is not discovered — copying is the only way they reach anyone. See [Skills](/reference/skills).

Every file is reported as written or kept, so running it twice is safe and running it in an existing project is honest.
