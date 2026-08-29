# 011 — The panel can be pinned to a scheme

## Problem

Which scheme the panel wears has never been a setting. It is decided by the
cascade, and by two unrelated mechanisms depending on what is loaded:

| what is loaded | the signal | where |
|---|---|---|
| `core.scss` alone — `/web`, `/mount`, the `<script>` tag | `@media (prefers-color-scheme: dark)` | `core.scss` |
| `+ vitepress.scss` | `--vp-c-*`, which VitePress switches on `html.dark` | `vitepress.scss` |
| `+ docusaurus.scss` | `--ifm-*`, switched on `html[data-theme='dark']` | `docusaurus.scss` |

Both are right for the case they were written for, and neither can be told it is
wrong. Two sites it is wrong for:

**A page pinned against its reader.** The embed path has one signal — the OS —
and the whole point of an embed is that it lands on a page the package knows
nothing about. A marketing site that is dark by construction, with no toggle and
no `prefers-color-scheme` anywhere in its own CSS, gets a white panel on a
light-OS machine. Nothing in that page is asking for a light panel; the panel is
answering a question the page never asked.

**A product that has decided.** A docs site whose assistant is meant to read as
one thing everywhere — the same surface in a screenshot, in a demo, in a support
reply — cannot say so. The nearest thing available today is to override nine
`--dp-*` tokens in a stylesheet the author has to load *after* the adapter, which
means knowing that the adapter wins by load order rather than by specificity.
That is a fact about this package's internals, and needing it to change a colour
scheme is the defect.

**The workaround is worse than it looks.** An author who does write those nine
overrides writes them at `:root`, which is exactly the specificity the adapter
uses — so it works or does not work depending on bundler output order, and it
breaks silently on a VitePress upgrade that moves a stylesheet.

---

## Research

### The reference

Every host this panel sits inside already treats "which scheme" as a setting with
three states, and all three spell them nearly the same way.

**VitePress** — `appearance: true | false | 'dark' | 'force-dark' | 'force-auto'`.
`true` is the toggle plus OS default; `'force-dark'` removes the toggle and pins.
The important part is the shape: a site is allowed to say *dark, and stop asking*.

**Docusaurus** — `colorMode: { defaultMode, disableSwitch, respectPrefersColorScheme }`.
Three keys where VitePress has one, and the same three states fall out of them.

**MkDocs Material** — `palette` is a list, and each entry names a `media`. A site
that wants one scheme writes one entry with no media query.

**The chat widgets this panel is shaped after** — Intercom, Crisp, Zendesk — all
expose a scheme or colour setting on the embed snippet, because the embed case is
the one where the host page cannot be interrogated at all. None of them tries to
read the page's own colours.

The convergence is on the *words*, not just the idea: `auto` / `light` / `dark`
is what a reader has already met, and `system` is the second-most-common spelling
of the first. Both cost nothing to accept.

### `color-scheme` is not the same setting, and is needed too

`prefers-color-scheme` is a query about the user. `color-scheme` is a declaration
to the user agent about what an element is painted for, and it drives things no
custom property reaches: the text caret, the scrollbar, a `<textarea>`'s
resize handle, and any native control's chrome. The panel declares it nowhere
today, which is correct while the panel follows the page — the page's own
declaration is right for both. Under a pin it stops being right.

It must be scoped. `color-scheme` on `<html>` repaints the **host page's**
scrollbars, and a setting about the assistant panel that changes the site's
scrollbars is a bug report waiting to be filed. The three roots this package owns
— `.docpilot`, `.docpilot-nav-trigger`, `.docpilot-cta` — are the same list
`font-family: var(--dp-font)` is already held to, and for the same reason.

### The pin has to beat an adapter, and specificity is the only way

The stated mechanism of the stylesheet split is that an adapter wins **by loading
second**: `:root` in `core.scss` and `:root` in `vitepress.scss` are equal, and
order decides. That makes `:root` unusable for a pin — the core loads first, so a
pin written there loses on exactly the two hosts that have a toggle to overrule.

`html.docpilot-dark` is `(0,1,1)` against `:root`'s `(0,1,0)` and wins wherever it
is loaded from. The class form rather than an attribute is not a preference:
`html.docpilot-push` already exists for `ui.layout`, `scripts/check-docpilot.sh`
already admits `html.docpilot-*` as a state qualifier in an adapter's selector
allowlist, and `[data-theme` is a string the core is forbidden from containing.

Shiki does not follow. Its colours are per-token inline custom properties, so
which of the two a span reads is decided by a **rule**, not a token — which is
why each adapter already states both halves. `html.dark .docpilot__answer .shiki`
and `html.docpilot-dark .docpilot__answer .shiki` are the same specificity, so
there the pin can only win on order, and each adapter has to carry the pinned
pair after its own.

### What a pin must NOT take

The adapters re-declare fifteen tokens. Only nine differ between the core's own
light and dark sets, and those nine are what a scheme *is*. Of the rest:

- `--dp-accent-soft`, `--dp-shadow`, `--dp-scrim` — one value serves both schemes
  here, so on a host they carry the site's brand tint, its elevation and its
  backdrop. A scheme pin has no opinion about any of the three, and taking them
  would replace a site's accent with ours over a question about light and dark.
- `--dp-font`, `--dp-font-mono`, `--dp-top` — not colours.
- `--dp-wash`, `--dp-lip` — mixed from `--dp-text`, which the pin moves. They
  follow for free, which is the whole reason they are derived.
- `--dp-alert` — deliberately outside both sets already.

### The cost of restating nine values

The pinned blocks are a copy of two blocks twelve lines above them, and a copy
nobody checks goes stale on the first palette change with nothing in the diff to
say so. A Sass mixin would remove the copy and break two checks that read the
stylesheet as text — rule 10's token-name diff and the suite's "the adapter
re-declares every dark-scheme token" extraction. The copy is cheaper than either
change, **provided it is asserted**: `test/styles.test.js` now compares the pinned
blocks against `:root` and the media block by name *and* by value.

---

## Decision

`ui.theme: 'auto' | 'light' | 'dark'`, default `'auto'`, `'system'` accepted as a
spelling of `'auto'` and folded into it before the enum check.

| value | what decides the scheme |
|---|---|
| `'auto'` | the host's own toggle where there is an adapter; `prefers-color-scheme` where there is none — today's behaviour, unchanged |
| `'light'` | nothing |
| `'dark'` | nothing |

**`'auto'` survives resolution**, and it is the only key in `resolveUi` that does.
`panel: 'auto'` names a *shape* and the build settles it from the trigger list,
which is why nothing downstream may re-derive it. This names a *signal*, and the
signal is the reader's browser: there is nothing to settle at build time, and a
resolver that settled it anyway would pin every reader to whichever scheme the
machine that ran the build happened to prefer. Idempotency still holds, because
`'auto'` is itself a legal input.

**The writer is a class on `<html>`**, written by `session.configure` beside
`applyFont`, and removed rather than skipped: `setConfig` runs on a live page.

**A pinned panel wears the core's palette, not the host's.** `--dp-surface` maps
to `--vp-c-bg`, and `--vp-c-bg` only holds a dark value while VitePress is *in*
dark mode — so on a light site there is no host value for a dark pin to read.
This is the same trade `ui.font` makes and it is stated in the published
reference rather than left to be discovered.

**No new token, and no new rule.** Rule 3 stays as written — the accent is still
declared once per file — precisely because the pin does not take it.

---

## What this does not cover

**A toggle in the panel.** A reader who wants the panel to follow them already has
one: their site's own theme switch, under `'auto'`. A second switch inside the
panel would be a second source of truth for the same question, and the first one
is the site's.

**Remembering a reader's choice.** Nothing is stored, because nothing is chosen —
this is a build-time setting with one value for the whole site.

**A third palette.** `'light'` and `'dark'` are the two sets `core.scss` already
holds. A site that wants its own colours has had the tokens all along, and the
pin does not compete with them: an override loaded after the core still wins at
equal specificity, and one written on `html.docpilot-dark` wins outright.

**Pinning the host.** The class goes on `<html>` because that is where `:root`
tokens live, but nothing outside this package's three roots is repainted —
`color-scheme` included. The page's scheme is the page's business.
