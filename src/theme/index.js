/**
 * The client half — a VitePress theme, and a way to add the panel to a theme
 * you already have.
 *
 * VitePress documents two ways to ship UI in a package: export a theme as the
 * default export, or export something the consumer composes into theirs. A
 * panel is the second kind of thing — nobody adopts a whole theme to get an
 * answer box — but the first is what a five-line getting-started needs. So both
 * ship, and `withAskAi` is the one the README leads with.
 *
 * ```js
 * // .vitepress/theme/index.js — adding the panel to what you already have
 * import DefaultTheme from 'vitepress/theme'
 * import { withAskAi } from 'vitepress-plugin-ask-ai/theme'
 *
 * export default withAskAi(DefaultTheme)
 * ```
 */

import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'

import AskAi from './components/AskAi.vue'
import AskAiTrigger from './components/AskAiTrigger.vue'
import AskAiCta from './components/AskAiCta.vue'

import '../../dist/ask-ai.css'

export { AskAi, AskAiTrigger, AskAiCta }

/**
 * The four slots, and why each is the one it is.
 *
 * `layout-bottom`, not `layout-top`: layout-top is the Layout's FIRST child,
 * ahead of VPSkipLink, so a panel mounted there displaces the skip link in tab
 * order on every page of the site.
 *
 * `doc-footer-before`, not `doc-after`: it sits under the article and above the
 * prev/next pager, and it exists only inside VPDoc — so pages using
 * `layout: page` and the home page skip the call-to-action for free, with no
 * condition to write and no page-type check to keep in sync.
 *
 * `nav-bar-content-before` lands the trigger immediately right of the search
 * box, which is where VitePress 2 puts its own Ask AI button. The stylesheet
 * reorders search ahead of it; there is no DOM order that gets both.
 */
export function askAiSlots(slots = {}) {
  return {
    ...slots,
    'layout-bottom': () => h(AskAi),
    'nav-bar-content-before': () => h(AskAiTrigger),
    'nav-screen-content-after': () => h(AskAiTrigger, { variant: 'screen' }),
    'doc-footer-before': () => h(AskAiCta),
  }
}

/**
 * Add the panel to any theme, including one that already fills layout slots.
 *
 * A theme's own `Layout` is preserved and rendered as the parent, so slots it
 * fills survive: only the four names above are claimed. A theme that fills one
 * of those four loses it — there is no sane merge of two components into one
 * slot, and silently rendering both is worse than the collision.
 *
 * `enabled: false` is handled INSIDE the components rather than here. The theme
 * object is built once at import time and `themeConfig` is not readable at that
 * moment, so a check here would have to guess; the components read
 * `theme.askAI.enabled` from `useData()` and render nothing, which is the same
 * outcome computed at the only point where the answer is actually known.
 */
export function withAskAi(theme = DefaultTheme) {
  const Parent = theme.Layout || DefaultTheme.Layout
  return {
    ...theme,
    extends: theme.extends ?? (theme === DefaultTheme ? undefined : DefaultTheme),
    Layout: () => h(Parent, null, askAiSlots()),
  }
}

/** The whole theme, for a project that has none of its own. */
export default withAskAi(DefaultTheme)
