/**
 * The three openers, answered here rather than at build time — engine-specs/017.
 *
 * `suggestions.questions` takes a string, and a string is a question a model
 * writes the answer to. These three are the other form: the answer is written
 * down, `docpilot index` ships it verbatim beside the index, and the reader's
 * first click costs no embedding request and no model call.
 *
 * WHY THESE THREE AND NOT A BAKE. They are the panel's empty state, which means
 * they are the most-asked questions on this site by construction — and all three
 * are questions whose answer is spread across four or five pages. A model given
 * eight excerpts writes a competent paragraph about the two it liked; what a
 * reader opening the panel for the first time needs is the whole path, in order,
 * with the commands in it. That is an editorial artefact, so an author writes it.
 *
 * `cite` IS NOT DECORATION. The build checks every id against the index it just
 * produced and drops the whole answer if one of them has moved, because prose
 * with nothing in the corpus behind it is the one thing the bake refuses to
 * ship. A renamed heading therefore costs this answer and prints why — it does
 * not silently ship an answer with no sources under it.
 *
 * PLAIN MARKDOWN ONLY. The panel renders fences, tables and links; it does not
 * render VitePress containers, so `::: warning` here would reach the reader as
 * three colons and a word. Where the docs use a container, these use bold.
 */
export const openers = [
  {
    q: 'How do I get started?',
    cite: ['install#', 'install#installing-it', 'guide/production#ask-what-the-contract-is'],
    answer: `**1) Install and initialise.**

\`\`\`bash
npm i @cloflin/docpilot
npx docpilot init
\`\`\`

Yarn, pnpm, Bun and Deno all work — \`yarn docpilot init\`, \`pnpm exec docpilot init\`, \`bunx docpilot init\`.

**2) Wire up the plugin and the theme.** Two files, no settings to write.

\`\`\`js
// docs/.vitepress/config.mjs
import { defineConfig, loadEnv } from 'vitepress'
import { defineDocPilot } from '@cloflin/docpilot'

const ai = defineDocPilot({}, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { docPilot: ai.themeConfig },
})
\`\`\`

\`\`\`js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme'

export default withDocPilot(DefaultTheme)
\`\`\`

**3) Put the key in \`.env.local\` — there and nowhere else.** One key configures both the answers and the embeddings: \`chat.provider\` defaults to \`'auto'\` and takes the first provider whose key it finds in the environment.

\`\`\`bash
OPENROUTER_API_KEY=sk-or-…
\`\`\`

The key is never written into the config. \`themeConfig\` compiles into the client bundle, so a key written there is published with the site; it lives in Node only — the Vite plugin's proxy attaches it in dev, your reverse proxy in production.

**4) Build the index and calibrate the gate.**

\`\`\`bash
npx docpilot index       # an index from your markdown → docs/public/rag/
npx docpilot calibrate   # refusal thresholds, measured on YOUR corpus
npx docpilot doctor      # what resolved, what answers, what embeds
\`\`\`

Without \`calibrate\` the thresholds stay provisional — they were measured on somebody else's corpus and they do not transfer.

**5) Run it.** \`npx vitepress dev docs\` — the dev server also proxies \`/ai/*\`. The panel opens from the button in the corner, from the navbar, or with ⌘I.

**6) Production is one reverse-proxy rule.** A built site does not proxy \`/ai/*\` and \`vitepress preview\` does not proxy at all, which is not a reason to move the key into the browser.

\`\`\`bash
npx docpilot doctor --proxy
\`\`\`

Run that on the build machine with its environment. The route has to match paths exactly (a prefix match on \`/ai\` turns the site into an open proxy on your key), add \`Authorization\` at the proxy, strip incoming \`Cookie\` and \`x-api-key\`, and set \`proxy_buffering off\`.`,
  },

  {
    q: 'How do I make the chat look like my site?',
    cite: [
      'guide/appearance#',
      'guide/appearance#five-entry-points',
      'reference/config#ui',
      'reference/highlighting#',
    ],
    answer: `Three levels, cheapest first. Almost everything is settled by the first one.

**1. The \`ui\` settings — shape, place, scheme.**

\`\`\`js
export const docPilot = {
  ui: {
    trigger: 'fab',          // 'fab' | 'nav' | 'screen' | 'both' | 'none' | an array
    panel: 'auto',           // 'drawer' | 'popup'
    layout: 'overlay',       // 'push' — the page moves aside instead of being covered
    theme: 'auto',           // 'light' | 'dark' — pin the scheme regardless of the site
    fabLabel: 'Ask AI',      // a string is verbatim; true — from i18n; false — icon only
    credit: true,            // false — drop the “DocPilot” link
  },
}
\`\`\`

\`trigger\` is a list, not an either/or: \`'nav'\` is \`['nav', 'screen']\` and \`'both'\` is all three. \`'none'\` removes the buttons and leaves ⌘I working. \`panel: 'auto'\` follows the trigger — a popup with a \`fab\`, a drawer without one. An invalid value never breaks the build; it is printed and falls back.

**2. The \`--dp-*\` CSS tokens — colour and geometry.** Everything the panel paints goes through one. Override them *after* the panel's styles:

\`\`\`css
:root {
  --dp-width: 520px;      /* clamp(360px, 30vw, 460px) by default */
  --dp-r-field: 12px;     /* the composer: 28px by default */
  --dp-focus: var(--brand);
}
\`\`\`

Three surface levels decide which token you want: \`--dp-surface\` (the panel, the composer, the button), \`--dp-surface-2\` (an object's own paint — a question bubble, a hovered row, inline code), \`--dp-wash\` (the cursor on a control, laid over whatever it sits on).

**Order beats specificity.** Core declares every token with a real value and the adapter re-declares the colours on \`:root\` at the same specificity, winning by being loaded second — so your \`:root\` has to come after the adapter.

**3. Your own styles.** Take the theme without its CSS and load your token table last:

\`\`\`js
import { withDocPilot } from '@cloflin/docpilot/theme-without-styles'
import '@cloflin/docpilot/style/core.css'
import './my-docpilot-tokens.css'
\`\`\`

**The font.** \`--dp-font\` is \`inherit\`, so with no settings the panel is set in the page's own face. \`ui: { font: '--brand-font' }\` writes onto \`<html>\` inline — the one layer that beats the adapter, which is why it lands on VitePress and Docusaurus alike. \`--dp-font-mono\` is a real stack, because the page has no monospace face to lend.

**What not to do:** radii are static on purpose; \`--dp-alert\` is deliberately outside your palette; nothing nested may ask for \`--dp-font\`, because \`inherit\` resolves per element; \`prefers-reduced-motion\` and \`forced-colors\` are already handled.`,
  },

  {
    q: 'What are the CLI and the skill for?',
    cite: ['reference/cli#', 'reference/cli#exit-codes', 'reference/cli#update', 'reference/skills#'],
    answer: `**The CLI is the only place where anything is computed.** The panel in the reader's browser builds nothing and measures nothing — it reads static files you built. \`npx docpilot\` builds the index, measures the refusal thresholds, checks answer quality, and says whether any of it is fit to deploy. **The skill is the written-down half of the same loop**: what to measure, what has already been measured, and what an edit is not allowed to break.

Every command reads the named export \`docPilot\` from \`.vitepress/config.mjs\`. There is no second place saying what embeds and where the docs are — a copy of that decision drifts, and the failure is silent.

**The loop.**

\`\`\`
[import] [vocabulary] → index → calibrate → lint → eval → bench
                          ↑                                  ↓
                          └────────── tune ──────────────────┘
\`\`\`

\`index\` and \`calibrate\` are what the panel does not work at all without. \`lint\`, \`eval\` and \`bench\` are what tells you whether it works *well* — the half that gets skipped, and how a gate ships on provisional thresholds forever. \`tune\` writes a file and stops: \`tuning.json\` reaches the reader only through the next \`index\`. \`feedback\` stands outside the loop and only proposes candidates — a golden answer is written by a person.

| command | what it does | spends requests |
|---|---|---|
| \`init\` | scaffolds the loop: env sample, starter eval sets, the skills, a \`/docpilot-*\` command per command | no |
| \`index\` | chunks, embeds, writes \`docs/public/rag/\`, inlines calibration and tuning | yes, except \`--dry\` |
| \`calibrate\` | measures the refusal thresholds against \`calibration.jsonl\` | yes |
| \`lint\` | checks the golden set against the index it claims to measure | no |
| \`eval\` | runs \`golden.jsonl\`, writes a report | yes, except \`--gate-only\` |
| \`bench\` | A/B two retrieval configs by answer quality | no key needed |
| \`tune\` | sweeps the levers, writes \`tuning.json\` | one embedding pass |
| \`doctor\` | prints what resolved, exits non-zero if the panel will not run | no, except \`--models\` |
| \`update\` | refreshes the copied skills and slash commands after an upgrade | no |

**\`doctor\` is what CI gates on.** The build never fails because of DocPilot — the panel switches itself off and prints a block — so the place where the same facts become a non-zero exit is a separate command. Only the *name* of the key variable is ever printed.

**Four exit codes:** \`0\` done, \`1\` attempted and failed, \`2\` a bad command line (nothing ran, retrying will not help), \`130\` cancelled at a prompt. Diagnostics go to stderr and the product to stdout, which is why \`doctor --json | jq\` works with the report still on screen.

**A flag with a value needs \`=\`.** \`--level low\` is read as *absent*, the run takes the default and reports it as fact. Write \`--level=low\`. \`import\` and \`feedback\` are the two exceptions.

**Sequences that are easy to get wrong:**

\`\`\`bash
npx docpilot index                                              # a docs edit
npx docpilot index && npx docpilot calibrate && npx docpilot index   # embedder changed
npx docpilot tune && npx docpilot index                         # the lever ships on the next index
\`\`\`

**The skills.** \`init\` copies \`docs-rag\` and \`docs-import\` into your agent tool — Claude Code, Codex, Cursor, Copilot or a vendor-neutral \`.agents/\` — and generates a \`/docpilot-<command>\` for every command. \`docs-rag\` carries nine modes and two sections that matter more than the modes: **Binding rules** (thresholds are not levers; an LLM judge may not gate; anything that drops a metric by more than two points is reverted) and **Things already measured**, so the next person does not spend a day rediscovering a negative result.

\`init\` writes a file only where there is nothing, which is right for your eval sets and wrong for the skills — so \`npx docpilot update\` is what refreshes them after an upgrade. \`--check\` is its CI form.

You do not need Claude Code for any of this: these are markdown files under an open standard, and the rules in them hold for whoever reads them.`,
  },
]
