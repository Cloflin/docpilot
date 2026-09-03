## How do I get started?

1) Install the package and initialise it:

::: code-group

```bash [npm]
npm i @cloflin/docpilot
npx docpilot init
```

```bash [Yarn]
yarn add @cloflin/docpilot
yarn docpilot init
```

```bash [pnpm]
pnpm add @cloflin/docpilot
pnpm exec docpilot init
```

```bash [Bun]
bun add @cloflin/docpilot
bunx docpilot init
```

```bash [Deno]
deno add npm:@cloflin/docpilot
deno run -A npm:@cloflin/docpilot init
```

:::

2) Wire up the plugin and the theme — two files, no settings to write:

```js
// docs/.vitepress/config.mjs
import { defineConfig, loadEnv } from 'vitepress'
import { defineDocPilot } from '@cloflin/docpilot'

const ai = defineDocPilot({}, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { docPilot: ai.themeConfig },
})
```

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme'

export default withDocPilot(DefaultTheme)
```

3) Put the key in `.env.local` — **there and nowhere else**. One key configures both the answers and the embeddings: `chat.provider` defaults to `'auto'` and takes the first provider whose key it finds in the environment.

```bash
# .env.local  (already in .gitignore — it never reaches git)
OPENROUTER_API_KEY=sk-or-…     # the shortest path: free tier, no card
# or any of your own: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY …
```

::: danger The key is never written into the config
`themeConfig` compiles into the client bundle — a key written there (or into `docPilot.chat`) is published along with the site. The key lives in Node only: in dev the Vite plugin's proxy attaches it, in production your reverse proxy does.
:::

4) Build the index and calibrate the refusal threshold:

```bash
npx docpilot index       # an index from your markdown → docs/public/rag/
npx docpilot calibrate   # refusal thresholds, measured on YOUR corpus
npx docpilot doctor      # the check: what resolved, what answers, what embeds
```

Without `calibrate` the thresholds stay provisional — they were measured on somebody else's corpus and they do not transfer between projects.

5) Run it and see:

```bash
npx vitepress dev docs   # the VitePress dev server: it also proxies /ai/*
```

The panel opens from the button in the corner, from the navbar, or with <kbd>⌘I</kbd>. A question that is not about your docs is turned away **before** the model is called — at zero cost.

6) Production is one reverse-proxy rule. `vitepress dev` proxies `/ai/*` itself, a built site does not, and `vitepress preview` does not proxy at all (which is not a reason to move the key into the browser).

```bash
npx docpilot doctor --proxy   # prints the contract: the exact paths, the upstream and the NAME of the key variable
```

Run that on the build machine with its environment, not on your laptop. What the route has to do: match paths exactly (`location = /ai/v1/...`; a prefix match on `/ai` turns the site into an open proxy on your key), have the proxy add `Authorization`, strip incoming `Cookie` and `x-api-key`, and set `proxy_buffering off` (the answer arrives as server-sent events). A ready-made nginx example is in [Production](/guide/production).

**Security, briefly:** the key lives only in `.env.local` and in the build environment, the model's answer is proxied, the links in an answer are checked against the index, and a token the reader pastes (`sk-…`, a JWT, `Bearer …`) is caught in the browser before it is sent. This is not a security boundary: everything runs in the reader's browser and the corpus is public — the control here is about key hygiene and search boundaries, not isolation.



---

## How do I make the chat look like my site?

Three levels, cheapest first. Start at the top — almost everything is settled by the first one.

### 1. The `ui` settings — shape, place, scheme

The `ui` object in the config. The full list of values is [`ui`](/reference/config#ui); what each value draws is [Appearance](/guide/appearance).

```js
export const docPilot = {
  ui: {
    trigger: 'fab',            // 'fab' | 'nav' | 'screen' | 'both' | 'none' | an array
    panel: 'auto',             // 'drawer' — full height at the right edge | 'popup' — above the button
    layout: 'overlay',         // 'push' — the page moves aside instead of being covered
    theme: 'auto',             // 'light' | 'dark' — pin the scheme regardless of the site
    fabLabel: 'Ask AI',        // a string is taken verbatim; true — from i18n; false — icon only
    fabIcon: true,             // false — words only
    credit: true,              // false — drop the “DocPilot” link from the footer line
  },
}
```

Worth knowing:

- **`trigger` is a list, not an either/or.** `'nav'` = `['nav', 'screen']` (a button in the navbar plus a row in the mobile menu), `'both'` = all three. `'none'` removes the buttons, but <kbd>⌘I</kbd> keeps working — [`ui.trigger`](/reference/config#ui-trigger).
- **`panel: 'auto'` follows the trigger:** with a `fab` it is a popup, without one a drawer. By default that means a popup — [`ui.panel`](/reference/config#ui-panel).
- **`theme: 'light' | 'dark'` — a pinned panel wears DocPilot's palette, not your site's.** On VitePress `--dp-surface` is mapped onto `--vp-c-bg`, and that holds one value at a time — [`ui.theme`](/reference/config#ui-theme).
- **An invalid value does not break the build**: it is printed to stdout and falls back to the default.

### 2. The `--dp-*` CSS tokens — colour and geometry

Everything the panel paints goes through one of the tokens. Override them **after** the panel's styles:

```css
:root {
  --dp-width: 520px;          /* clamp(360px, 30vw, 460px) by default */
  --dp-popup-block: 560px;
  --dp-r-field: 12px;         /* the composer: 28px by default */
  --dp-focus: var(--brand);
}
```

- Colours: `--dp-surface`, `--dp-surface-2`, `--dp-wash`, `--dp-line`, `--dp-lip`, `--dp-text`, `--dp-text-dim`, `--dp-on-text`, `--dp-focus`, `--dp-accent-soft`, `--dp-alert`, `--dp-chip`, `--dp-code-bg`, `--dp-shadow`, `--dp-scrim`.
- Geometry and timing: `--dp-width`, `--dp-gutter`, `--dp-r-sm/md/lg/bubble/field/pill`, `--dp-dur`, `--dp-dur-fast`, `--dp-ease`, `--dp-z`, `--dp-fab-size`, `--dp-popup-inset`, `--dp-popup-block`, `--dp-top`.

The full table with the core values, and what the VitePress and Docusaurus adapters turn them into, is [Appearance → The tokens](/guide/appearance#the-tokens).

**Three surface levels** — the rule that picks the token: `--dp-surface` (the panel itself, the composer, the floating button), `--dp-surface-2` (an object's own paint: the question bubble, a suggestion row, inline code, a hovered row), `--dp-wash` (the cursor on a **control**, laid over whatever it sits on). The delete button inside a hovered history row reads as a darker chip inside a lighter row — without a single rule written for that case.

::: warning Order beats specificity
Core declares every token with a real value, the adapter re-declares the colours on `:root` at the same specificity and wins **by being loaded second**. Your `:root` has to come after the adapter, or it loses.
:::

### 3. Your own styles, all the way down

Five entry points — [Appearance → Five entry points](/guide/appearance#five-entry-points). If you want your own token table, take the theme without its CSS:

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme-without-styles'
import '@cloflin/docpilot/style/core.css'
import './my-docpilot-tokens.css'   // your :root — loaded last

export default withDocPilot(DefaultTheme)
```

An adapter of your own for a host we do not ship is a `:root` block that re-declares the same set of names in terms of your tokens, loaded after core. It **must not introduce `--dp-*` names of its own**: a token that exists only in the adapter is a token without which core does not render.

### 4. The font

`--dp-font` is `inherit`: the panel mounts into `<body>` and, with no settings at all, is set in the page's own face. There are two ways to name your own, for different situations — [`ui.font`, `ui.fontMono`](/reference/config#ui-font-ui-fontmono):

```js
ui: { font: '--brand-font', fontMono: 'JetBrains Mono, monospace' }
```

`ui.font` is written onto `<html>` as an inline property — **the one layer that beats the adapter** — which is why it lands on both VitePress and Docusaurus. The CSS route (`:root { --dp-font: var(--my-font) }`) is what you need when the value depends on a media query, on `[data-theme]`, or on a container.

`--dp-font-mono` is a real stack rather than `inherit`: the page has no monospace face for the panel to borrow.

### 5. Syntax highlighting

The highlighter is pluggable — Shiki, Prism, highlight.js, or your own; the whole API is in [Syntax highlighting](/reference/highlighting). On colour: Shiki writes both themes onto every token and applies neither, so the style picks the theme (core by `prefers-color-scheme`, the adapters by `html.dark` / `html[data-theme='dark']`). Prism and highlight.js are painted by **your** site's theme; the panel overrides exactly one thing — the background, because a code card is a single `--dp-code-bg` surface.

### What not to do

- **Radii are not animated** — they are static on purpose: a changing shape competes with the colour change that has already said the same thing.
- **`--dp-alert` is not mapped onto the host palette** — it is the one colour outside your theme, a 10px dot on the trigger when an answer arrives while the panel is closed ([`ui.background`](/reference/config#ui-background)).
- **Nothing nested may ask for `--dp-font`**: `inherit` resolves relative to the element, so `var(--dp-font)` inside a monospace block returns the monospace face.
- `prefers-reduced-motion` and `forced-colors` are handled — do not duplicate them with rules of your own: [What degrades, and how](/guide/appearance#what-degrades-and-how).

---

## What are the CLI and the skill for?

Briefly: **the CLI is the only place where anything is computed.** The panel in the reader's browser builds nothing and measures nothing — it reads static files that you built. `npx docpilot` builds the index, measures the refusal thresholds, checks answer quality, and tells you whether any of it is fit to deploy. **The skill is the written-down half of the same loop**: what to measure, what has already been measured, and what an edit is not allowed to break. One of them is the executor, the other is the instruction for whoever drives it — an agent, or you.

### One source of truth

Every command looks for `.vitepress/config.mjs` relative to the directory it was run in and reads the **named export `docPilot`**. There is no second place that says what embeds and where the docs are — and that is not tidiness for its own sake: a copy of that decision drifts, and the failure is silent (a query scored in a foreign vector space degrades into word matching, and the calibrated gate starts refusing questions the docs do answer).

```bash
npx docpilot <command>          # npm
pnpm exec docpilot <command>    # pnpm
yarn docpilot <command>         # Yarn
bunx docpilot <command>         # Bun

npx @cloflin/docpilot init      # one-off, without installing — only under the full package name
```

A bare `docpilot` on npm is **a different package**, not this one. Only the scoped name runs one-off.

### The loop

```
[import] [vocabulary] → index → calibrate → lint → eval → bench
                          ↑                                  ↓
                          └────────── tune ──────────────────┘
```

- **`index` and `calibrate`** — what the panel does not work at all without.
- **`lint`, `eval`, `bench`** — what tells you whether it works **well**. This is the half that gets skipped, and that is exactly how a gate ships to production on provisional thresholds forever without anyone finding out.
- **`import`** goes in front of the loop when the corpus takes in a page from elsewhere; **`vocabulary`** when readers' words do not match the docs' words.
- **`tune`** sends you back to the start: it writes a file and stops. `tuning.json` reaches the reader **only through `index`** — until then the lever you tuned is on disk and nowhere else.
- **`feedback`** stands outside the loop: it reads what your endpoint collected and **proposes** candidates. It never writes into the eval sets — a golden answer is written by a person.

### The commands

| command | what it does | when | spends requests |
|---|---|---|---|
| `init` | scaffolds the cycle: `.env.example`, starter golden/calibration sets, the two skills plus a `/docpilot-*` slash command per command, a line in `.gitignore` | once | no |
| `index` | chunks markdown (plus OpenAPI and `--html-dir`), embeds, writes `docs/public/rag/`, inlines the calibration and the tuning | after every docs edit | yes, except `--dry` / `--no-embed` |
| `calibrate` | measures the refusal thresholds against `calibration.jsonl`, writes `calibration.json` | after `index`, after changing embedder | yes |
| `lint` | checks the golden set against the index it claims to measure | before every `eval`, after every `index`, after upgrading the package | no |
| `eval` | runs `golden.jsonl`, writes a report | when you change the model, the prompt, the search | yes, except `--gate-only` |
| `bench` | A/B two search configurations by answer quality | when you are comparing two options | no key needed |
| `tune` | sweeps `MMR_LAMBDA` × `GATE_K`, writes `tuning.json` plus a grid report | when the thing to move is the search itself | one embedding pass for the whole grid |
| `import` | pulls a page from an allowlist into the corpus with provenance | when the answer does not live in your docs | yes (the fetch plus an annotation pass) |
| `vocabulary` | proposes the words readers use for your terms | before the index, before the first `index` | yes (it asks the chat model) |
| `feedback` | turns reader votes into eval candidates | as votes accumulate | no |
| `doctor` | prints what resolved and **exits non-zero** if the panel will not run | in CI, and every time it is “why is it talking to that provider” | no, except `--models` |
| `update` | refreshes the copied skills and the `/docpilot-*` commands from the installed package | after `npm install @cloflin/docpilot@latest` | no |

`npx docpilot --help` and `npx docpilot <command> --help` are free and require nothing: no config, no key, no network, no built index. Help used to **run** the command — on `index`, `eval`, `calibrate` and `vocabulary` that made `--help` a payment order.

### `doctor` — what CI gates on

The build **never** fails because of DocPilot: the panel switches itself off and prints a block. A dependency that can take down someone else's build on the day it is installed is a dependency that gets removed. So the place where the same facts turn into a non-zero exit is a separate command:

```bash
npx docpilot doctor                       # readiness plus the whole provider chain, ✓ on whoever answered
npx docpilot doctor --json | jq .ready    # the same for a script; the diagnosis stays on stderr
npx docpilot doctor --proxy               # the reverse-proxy contract: exact paths, upstream, the variable NAME
npx docpilot doctor --embed               # every embedder this project could build with
npx docpilot doctor --models              # whether the model pool is still alive: RETIRED: and what is new
```

Only the **name** of the key variable is printed, never the value. `--models` is the one thing that goes to the network, which is why it is a flag rather than part of a normal run: a check that fails because a third party is slow is a check that gets removed, and the readiness gate goes with it.

### What the CLI knows and you do not

Small things that pay for themselves immediately:

- **Vectors you have already paid for are not bought twice.** A chunk's embedding is cached under a key made of the model, the provider, the host, the prefix and the chunk text — so editing one page costs one request rather than one per 32 chunks of the corpus. The cache lives in `${evalDir}/embed-cache/`, is gitignored by `init`, and is safe by construction: a different model, provider or host is a different namespace.
- **`index --dry`** chunks and reports without embedding — no network, no model. That is the loop for tuning your chunking.
- **`eval --gate-only`** measures retrieval and refusals without calling the model: fast, free, and the right loop while you are turning search knobs. `--lexical` on top switches off the dense channel — that is how you measure what your embedder is actually worth on your corpus.
- **A rebuild refuses to silently inline someone else's calibration**: a `calibration.json` measured with a different embedding model is not substituted in — the build warns and installs a provisional gate, because documentation has to stay publishable with a stale threshold.
- **Four exit codes**: `0` — ready, `1` — tried and failed (provider, config, missing index, `CALIBRATION FAILED`), `2` — a bad command line (**nothing ran**; retrying will not help), `130` — Ctrl-C at a prompt, nothing written.
- **Diagnostics on stderr, the product on stdout** — which is why `doctor --json | jq` works while the report is still visible in the terminal.

::: warning A flag with a value needs `=`
`--level low`, `--limit 5`, `--num-ctx 4096` are read by the parser as **absent**: it matches `--name=` and nothing else. The run will take the default and report it as fact. Write `--level=low`.

`import` and `feedback` are the two exceptions — they have always read `--flag value` and still do, because their pages have always shown that form.
:::

### Three sequences that are easy to get wrong

```bash
# 1. A docs edit
npx docpilot index

# 2. The embedder changed, or the corpus took in a page through import
npx docpilot index && npx docpilot calibrate && npx docpilot index

# 3. The vocabulary changed (its hash lives separately from the corpus hash)
npx docpilot index && npx docpilot calibrate --refresh && npx docpilot index

# 4. You ran tune — the lever reaches the reader only on the next index
npx docpilot tune && npx docpilot index
```

The corpus hash covers the **text** of the chunks. Change the embedder and every cosine moves while the hash does not; that is why the model name is written down next to the thresholds, and why the panel checks the manifest's model against the one the browser embeds with.

### The skills: `docs-rag` and `docs-import`

`npx docpilot init` copies two skills into your agent tool, and generates a `/docpilot-<command>` slash command for every command on the table above. Copies rather than leaving them in the package, because no tool discovers a `.claude/`, `.codex/`, `.cursor/` or `.github/` directory inside `node_modules`: a skill in a dependency reaches nobody.

Agent Skills is an open standard — a directory per skill, a `SKILL.md` inside it — so `--target` names the tool and `--scope` names which of its two directories:

| `--target=` | skills, `--scope=project` | skills, `--scope=user` | slash commands |
|---|---|---|---|
| `claude` | `.claude/skills/` | `~/.claude/skills/` | `.claude/commands/` |
| `codex` | `.codex/skills/` | `~/.codex/skills/` | the same directory: in Codex a slash command **is** a skill |
| `cursor` | `.cursor/skills/` | `~/.cursor/skills/` | `.cursor/commands/` |
| `copilot` | `.github/skills/` | `~/.copilot/skills/` | `.github/prompts/` — none for `user` |
| `agents` | `.agents/skills/` | `~/.agents/skills/` | none — there is no vendor-neutral command format |

`init` asks which one in a terminal and defaults to `.claude/skills/`. `--skills-dir=` is the escape hatch for a tool this table has never heard of.

**`docs-rag`** — the measuring and tuning loop, nine modes:

| mode | what it does |
|---|---|
| `index` | show every embedder the project could build with, ask which one, and refuse to overwrite an index built with another |
| `eval` | run the golden set, read the report, give a verdict, **change nothing** |
| `generate` | write golden records: a stratified sample, then a mandatory editing pass |
| `bench` | A/B two search configurations by answer quality, with no API key |
| `tune` | propose edits, each with its file, its change, and the metric it is supposed to move |
| `faq` | pick 3–5 questions for the empty state — from reader votes, or from the corpus when there are no votes |
| `feedback` | triage what readers actually voted on |
| `corpus` | fix the **documentation**, when no search constant will help |
| `llms` | make the docs readable by agents that are not this panel |

Two sections in it matter more than the modes:

- **Binding rules** — thresholds are not levers, an LLM judge may not gate, a prompt edit ships alone, and anything that drops a metric by more than two percentage points is reverted.
- **Things already measured** — the list of experiments already run, each with its price: MMR diversification, heading ancestors in a chunk's context line, excerpt size 1200 → 2400, “three runs, not one”, and why `citationPrecision` is only read together with `citationRecall`. Every entry exists so that the next person does not spend a day rediscovering a negative result.

Two protocols ride along with it — `answerer-protocol.md` and `judge-protocol.md` — handed verbatim to the agents that `bench` spins up. They are checked in on purpose: a protocol that lives in a chat message is not reproducible, and a bench whose instructions drifted between runs measured nothing.

**`docs-import`** — the contract for an imported page: the allowlist as a security boundary, the extraction rule (**convert the markup, never index a retelling** — a tool that “summarises” a page returns sentences nobody wrote in the source, which the assistant then cites), the page contract, the annotation pass, and the order of the gates, ending in recalibration because the corpus hash has moved.

::: warning `init` does not refresh a skill — `update` does
`init` writes a file only where there is nothing, and that check never looks at what the existing file *says*. So a project that ran it once keeps its copy of the skills across every package upgrade that rewrites them; re-running `init` prints `kept … (already there)` and moves on. That rule is right for `golden.jsonl` and `calibration.jsonl` — those are your work — and wrong for the skills, which are documentation this package ships.

```bash
npm install @cloflin/docpilot@latest

npx docpilot update --dry     # what would change, and in which files
npx docpilot update           # do it
npx docpilot update --check   # the CI form: no writes, exit 1 when anything is stale
```

With no flags it **finds** the installs rather than being told about them — every directory in the table above, in both scopes — so `update` in one project refreshes a skill you installed into `~/.claude/skills/` from another. Nothing is created by discovery; only an explicit `--target=` installs somewhere new.

A `.docpilot.json` beside each skill records the release that wrote it and a sha256 per file, which turns “you edited this” from a guess into a fact: an untouched file is `updated` in silence, an edited one is `REPLACED` with your bytes kept as `<file>.bak` and named in the report.
:::

### Do I need Claude Code?

No. These are markdown files under an open standard, and Claude Code, Codex, Cursor and Copilot all read the same shape — `--target` picks which. The rules in them hold for anyone who reads them: the “things already measured” list is worth reading before touching a search constant, whoever is touching it — a person or an agent. In full: [CLI](/reference/cli) and [Skills](/reference/skills).

---
