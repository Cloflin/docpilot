<script setup>
import { onMounted, ref } from 'vue'
import markIcon from './assets/docpilot-mono.svg'

/*
 * Deep-imported, the way `Home.vue` already imports three of the theme's
 * components: `@voidzero-dev/vitepress-theme` publishes no `exports` map, so
 * nothing restricts which subpaths a consumer may reach, and the component's
 * CSS (`vitepress-default/components/vp-code-group.css`) is already on every page
 * through the theme's `styles/index.css`. Nothing here is a fork.
 */
import CodeGroup from '@voidzero-dev/vitepress-theme/src/components/shared/CodeGroup.vue'

/*
 * One decision, three surfaces — the README, `docs/install/` and this component
 * print the same five pairs, and a variant invented on one of them is a command
 * a reader runs and reports as broken.
 *
 * `pnpm exec`, not `pnpm run docpilot`: `pnpm run` executes package.json
 * scripts, `pnpm exec` runs a bin. No line uses `dlx`/`npx` with the UNSCOPED
 * name either — `docpilot` without the scope is not this package, it is an
 * unowned name on the registry. Deno reaches npm only through the `npm:`
 * specifier, so both of its lines carry it.
 *
 * Both lines of every tab carry a literal `$ `, and the component's `prefix`
 * prop is deliberately unused: `prefix` is emitted once, before the first line
 * only (CodeGroup.vue:41), which on a two-command block reads as a rendering
 * fault rather than as a prompt. Writing the prompts into the code is safe
 * because VitePress strips them on copy — its global handler runs
 * `text.replace(/^ *(\$|>) /gm, '').trim()` for every language `isShell()`
 * accepts, and `bash`, this component's default, is one of the five
 * (`vitepress/dist/client/app/composables/copyCode.js:26`,
 * `shared.js:12`). The clipboard gets the two commands and nothing else.
 */
const installTabs = [
  { label: 'npm', code: '$ npm i @cloflin/docpilot\n$ npx docpilot init' },
  { label: 'Yarn', code: '$ yarn add @cloflin/docpilot\n$ yarn docpilot init' },
  { label: 'pnpm', code: '$ pnpm add @cloflin/docpilot\n$ pnpm exec docpilot init' },
  { label: 'Bun', code: '$ bun add @cloflin/docpilot\n$ bunx docpilot init' },
  {
    label: 'Deno',
    code: '$ deno add npm:@cloflin/docpilot\n$ deno run -A npm:@cloflin/docpilot init',
  },
]

const installEl = ref(null)

/*
 * The theme's `CodeGroup` renders `<button class="copy"></button>` with no text
 * and no name (CodeGroup.vue:39), so it reaches the accessibility tree as an
 * unnamed button — the only one on this site, because every copy button in
 * prose is emitted by VitePress's own `preWrapperPlugin`, which writes
 * `title="${tooltipText}"` and defaults that to `Copy code`. Naming them from
 * here rather than editing the vendored component keeps the component
 * upgradeable; forking it would fork every future fix with it.
 *
 * Only the active tab's block is in the tree at all (the rest are
 * `display: none`), so the five buttons can share the one label the rest of the
 * site uses. `Copied` needs no attribute: this theme's copied pill takes its
 * text from `--vp-code-copy-copied-text-content`, not from `data-copied`.
 */
onMounted(() => {
  const label = 'Copy code'
  for (const button of installEl.value?.querySelectorAll('button.copy') ?? []) {
    button.title = label
    button.setAttribute('aria-label', label)
  }
})
</script>

<template>
  <div class="wrapper wrapper--ticks grid md:grid-cols-2 w-full border-nickel divide-x">
    <div class="flex flex-col p-10 justify-between items-center md:items-start">
      <div class="flex flex-col gap-5 text-center md:text-left items-center md:items-start">
        <!--
          `no vector DB`, not `no server`. The panel needs exactly one
          server-side thing — a reverse-proxy route that attaches the model key
          — and `docs/guide/philosophy.md` is careful to write "no server beyond
          the one already serving your site" and then "One server-side piece
          remains, and only one". A four-word eyebrow cannot carry that
          qualification, so it claims the thing that IS unqualified instead.
        -->
        <span class="text-grey text-xs font-mono uppercase tracking-wide">
          AI assistant &middot; MIT licensed &middot; no vector DB &middot; any page
        </span>
        <h1 class="text-white text-pretty max-w-[40rem]">
          An AI assistant<br />on every page of your site
        </h1>
        <p class="text-white/70 text-lg max-w-[30rem] text-pretty">
          A real chat &mdash; scope it, quote a passage, follow up, keep the
          thread. It answers from an index you built rather than from the page it
          sits on, retrieval runs in the reader's browser, and it refuses before
          the model is called
        </p>
        <div class="flex items-center gap-5 mt-6">
          <a href="/guide/" class="button button--primary inline-block w-fit">
            <span>Get Started</span>
          </a>
          <a
            href="https://github.com/Cloflin/docpilot"
            target="_blank"
            rel="noopener noreferrer"
            class="button inline-flex items-center gap-2 w-fit"
          >
            <span>View on GitHub</span>
            <svg class="size-3" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M3.18228 2.81797L9.54624 2.81797L9.54624 9.18193"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
              <path
                d="M9.5459 2.81799L3.18194 9.18195"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
            </svg>
          </a>
        </div>

        <!--
          Inside the `gap-5` column so it inherits the same left edge as the
          heading and the buttons. Three deliberate departures from the way the
          theme's own marketing pages use this component:

          1. No `hidden md:block`. Hiding the install command below `md` hides
             the most useful thing on this page from the reader most likely to
             be skimming it, and `.tabs` is already `overflow-x: auto`, so five
             labels that do not fit scroll rather than wrap.
          2. `--vp-code-tab-divider: var(--color-nickel)`, not a hardcoded
             `#000`. Nickel is the hairline this page already draws with —
             `border-nickel` on the wrapper above, `divide-nickel` in
             `FeatureGrid.vue` — and a black rule would be the only one on the
             page.
          3. `--vp-code-block-bg: var(--color-slate)`, the same fill as the
             badge card below, so the two panels in this column read as one
             family instead of two greys.
        -->
        <div ref="installEl" class="install-tabs w-full">
          <CodeGroup
            :tabs="installTabs"
            style="
              --vp-code-tab-bg: var(--color-slate);
              --vp-code-block-bg: var(--color-slate);
              --vp-code-tab-divider: var(--color-nickel);
            "
          />
        </div>
      </div>
      <div class="px-3 py-1.5 bg-slate rounded w-fit flex gap-2 items-center mt-10">
        <a href="/concepts/guarantees">
          <figure class="project-icon gap-3">
            <img class="size-5" loading="lazy" :src="markIcon" alt="" />
            <figcaption class="text-sm">Read what it guarantees</figcaption>
            <svg class="size-3" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M3.18228 2.81797L9.54624 2.81797L9.54624 9.18193"
                stroke="#9277C7"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
              <path
                d="M9.5459 2.81799L3.18194 9.18195"
                stroke="#9277C7"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
            </svg>
          </figure>
        </a>
      </div>
    </div>

    <div class="flex flex-col min-h-[22rem] sm:min-h-[30rem]">
      <div
        class="relative px-6 sm:px-16 h-full flex flex-col justify-center overflow-clip py-8 sm:py-16 hero-background"
      >
        <!--
          A rendering of a CONVERSATION, not a screenshot: it stays honest when
          the panel's markup changes, and it costs no image bytes.

          Two turns rather than one, and the second one mid-flight. A single
          question-and-answer card is a search box with better typography, which
          is exactly the thing this panel is not — the follow-up, the scope chip
          in the header and the live status line under the second question are
          the three cheapest ways to show that on a page nobody will scroll
          twice. Every string here is a real one: the scope label, the six
          status lines and the source chips all come out of `i18n.js`.
        -->
        <div
          class="w-full max-w-[32rem] rounded-xl bg-primary/85 outline outline-white/15 p-5 flex flex-col gap-3.5 shadow-2xl"
        >
          <div class="flex items-center gap-2">
            <span class="size-2 rounded-full bg-dp-violet"></span>
            <span class="font-mono text-xs uppercase tracking-wide text-white/50">DocPilot</span>
            <span
              class="ml-auto font-mono text-[11px] text-white/60 bg-white/10 rounded px-2 py-0.5"
            >
              All docs
            </span>
          </div>

          <p class="text-white text-base">How do I rebuild the index in CI?</p>

          <div class="h-px bg-white/10"></div>

          <p class="text-white/75 text-sm leading-relaxed">
            Run the CLI as a build step before
            <span class="font-mono text-white">vitepress build</span>. It writes the
            index next to the site's static assets, so the browser fetches it like
            any other file.<sup class="text-dp-violet">1</sup>
          </p>

          <div class="flex flex-wrap gap-2">
            <span class="font-mono text-xs text-white/70 bg-white/10 rounded px-2 py-1">
              1 &middot; guide/indexing
            </span>
            <span class="font-mono text-xs text-white/70 bg-white/10 rounded px-2 py-1">
              2 &middot; reference/cli
            </span>
            <span class="font-mono text-xs text-white/40 rounded px-2 py-1">
              2 chunks retrieved
            </span>
          </div>

          <div class="h-px bg-white/10"></div>

          <p class="text-white text-base">And in a Docker build?</p>

          <p class="font-mono text-xs text-white/50 flex items-center gap-2">
            <span class="dp-pulse size-1.5 rounded-full bg-dp-violet"></span>
            Reading reference/cli
          </p>
        </div>
      </div>

      <a href="/concepts/a-turn" class="p-5 flex gap-5 items-center relative group">
        <div
          class="h-16 aspect-[244/144] rounded bg-slate flex flex-col items-center justify-center gap-0.5 group-hover:opacity-75 group-hover:scale-105 transition-[scale,opacity]"
        >
          <span class="font-mono text-[11px] leading-tight text-dp-violet">retrieve</span>
          <span class="font-mono text-[11px] leading-tight text-dp-violet">&darr; gate</span>
          <span class="font-mono text-[11px] leading-tight text-dp-violet">&darr; cite</span>
        </div>
        <div>
          <h5 class="text-white">How a turn works</h5>
          <p class="text-base">Every step, in the order it runs</p>
        </div>
      </a>
    </div>
  </div>
</template>

<style scoped>
/*
 * VitePress's prose rhythm puts 16px above the group (`vp-code-group.css:2`)
 * and 16px below the code block (`vp-doc.css:293`). This column is spaced by
 * `gap-5` instead, so both land on top of the gap and open a wider seam around
 * the tabs than anywhere else in the stack.
 */
.install-tabs :deep(.vp-code-group) {
  margin-top: 0;
}

.install-tabs :deep(div[class*='language-']) {
  margin-bottom: 0;
}

/*
 * Below 640px the theme pulls the group 24px past its container on both sides
 * and squares its corners — a full bleed that assumes VitePress's 24px prose
 * padding. This column pads by 40px (`p-10`), so the bleed stops 16px short of
 * the viewport edge and reads as the block being misaligned with the heading
 * above it rather than as a full bleed. Give it the theme's own >=640px
 * treatment at every width. `!important` is not preference: the rule being
 * corrected carries one (`vp-code-group.css:76`).
 */
@media (max-width: 639px) {
  .install-tabs :deep(.tabs) {
    margin-right: 0;
    margin-left: 0;
    border-radius: 8px 8px 0 0;
  }

  .install-tabs :deep(div[class*='language-']) {
    margin-right: 0;
    margin-left: 0;
    border-radius: 0 0 8px 8px !important;
  }
}

/*
 * The one moving thing on the page, and it stops for anyone who has asked it to.
 * A status line that never changes reads as a stalled panel; a status line that
 * animates is the only part of this card claiming to be live.
 */
@keyframes dp-pulse {
  50% {
    opacity: 0.25;
  }
}

.dp-pulse {
  animation: dp-pulse 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .dp-pulse {
    animation: none;
  }
}

.hero-background {
  background-color: #476be3;
  background-image:
    radial-gradient(60% 80% at 12% 18%, rgba(126, 155, 242, 0.6), transparent 70%),
    radial-gradient(70% 90% at 92% 92%, rgba(140, 59, 87, 0.65), transparent 70%),
    linear-gradient(135deg, #476be3 0%, #9277c7 55%, #c56161 100%);
  background-size: cover;
  background-position: center;
}
</style>
