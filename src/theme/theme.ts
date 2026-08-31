/**
 * The client half — a VitePress theme, and a way to add the panel to a theme
 * you already have.
 *
 * NO STYLESHEET IS IMPORTED HERE, deliberately. This file is the behaviour;
 * `index.js` is the behaviour plus `dist/docpilot.css`, and `no-styles.js` is the
 * behaviour on its own for a project that supplies the CSS itself. That is the
 * same arrangement VitePress uses for `vitepress/theme` and
 * `vitepress/theme-without-fonts`: one implementation, two entry points that
 * differ only in which side effect they carry.
 *
 * VitePress documents two ways to ship UI in a package: export a theme as the
 * default export, or export something the consumer composes into theirs. A
 * panel is the second kind of thing — nobody adopts a whole theme to get an
 * answer box — but the first is what a five-line getting-started needs. So both
 * ship, and `withDocPilot` is the one the README leads with.
 *
 * ```js
 * // .vitepress/theme/index.js — adding the panel to what you already have
 * import DefaultTheme from 'vitepress/theme'
 * import { withDocPilot } from '@cloflin/docpilot/theme'
 *
 * export default withDocPilot(DefaultTheme)
 * ```
 */

import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'

import { installVitePressHost } from './docpilot/host-vitepress.js'
import { setHighlighter } from './docpilot/highlight.js'
import { createShikiHighlighter } from './docpilot/highlighters/shiki.js'
import DocPilot from './components/DocPilot.vue'
import DocPilotTrigger from './components/DocPilotTrigger.vue'
import DocPilotCta from './components/DocPilotCta.vue'
import DocPilotIcons from './components/DocPilotIcons.vue'
import DocPilotQuote from './components/DocPilotQuote.vue'

export { DocPilot, DocPilotTrigger, DocPilotCta, DocPilotIcons, DocPilotQuote }

/**
 * The components ask `host.js` who the host is; this file is where VitePress
 * answers. Installed at import time, and again inside each of the two entry
 * points below.
 *
 * Once would be enough for the documented paths — importing either function
 * evaluates this module body. The repeat covers the one that is not: a project
 * that imports `DocPilot.vue` from `@cloflin/docpilot/theme/components/…`
 * directly, and reaches for `docPilotSlots()` afterwards. `installVitePressHost`
 * is a latch, so the extra calls cost a boolean test.
 *
 * IT IS NOT DECLARED AS A SIDE EFFECT in package.json, deliberately: the
 * `sideEffects` array is `['*.css','*.scss']`, and that exact value is what
 * lets a consumer's bundler drop the components they do not use. Widening it to
 * cover this call would trade a real guarantee for something a function call
 * already achieves.
 */
installVitePressHost()

/**
 * Shiki, because this is the VitePress entry point and VitePress highlights its
 * own pages with Shiki — an answer in the panel is then the same code in the
 * same colours as the page behind it.
 *
 * CHOSEN HERE RATHER THAN DEFAULTED IN THE REGISTRY. A default inside
 * `highlight.js` would put `import('@shikijs/…')` into every consumer's module
 * graph, and a bundler that cannot resolve those fails the BUILD — so a
 * Docusaurus site that chose Prism would still have to install Shiki in order to
 * compile. Choosing at the entry point is what makes the four `@shikijs`
 * packages genuinely optional peers.
 *
 * Nothing is loaded by this call. The grammars are fetched by
 * `ensureHighlighter()`, which the panel calls when it is first opened.
 */
setHighlighter(createShikiHighlighter())

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
 * box, which is where VitePress 2 puts its own DocPilot button. The stylesheet
 * reorders search ahead of it; there is no DOM order that gets both.
 *
 * `layout-bottom` carries FOUR components: the icon sprite, the panel, the
 * floating button — which belongs at the end of the document and not inside the
 * navbar — and the article's selection popover. All four are always mounted;
 * which of the two triggers actually renders is decided inside the component
 * from `docPilot.ui`, and whether the popover renders at all from
 * `docPilot.quote.fromDocs`, for the same reason `enabled` is — this function
 * runs at import time, when `themeConfig` cannot be read yet.
 *
 * The sprite is FIRST and is mounted exactly once — see ui-specs/001. It
 * teleports to `<body>`, so its position in this array is not where it lands;
 * what the array guarantees is that there is one of it.
 */
export function docPilotSlots(slots = {}) {
  installVitePressHost()
  return {
    ...slots,
    'layout-bottom': () => [
      h(DocPilotIcons),
      h(DocPilot),
      h(DocPilotTrigger, { variant: 'fab' }),
      h(DocPilotQuote),
    ],
    'nav-bar-content-before': () => h(DocPilotTrigger),
    'nav-screen-content-after': () => h(DocPilotTrigger, { variant: 'screen' }),
    'doc-footer-before': () => h(DocPilotCta),
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
 * `theme.docPilot.enabled` from `useData()` and render nothing, which is the same
 * outcome computed at the only point where the answer is actually known.
 *
 * THE PARENT IS LOOKED UP THROUGH `extends`, and that is not a nicety. A theme
 * built as `{ extends: SomeTheme, enhanceApp }` — the shape VitePress documents
 * for "reuse a theme and add to it", and the shape this package's own docs site
 * uses — has no `Layout` of its own. Falling back to VitePress's default layout
 * there renders the WRONG theme: the parent's brand chrome disappears and the
 * only visible symptom is a site that suddenly looks like stock VitePress.
 */
export function withDocPilot(theme: Record<string, any> = DefaultTheme) {
  installVitePressHost()
  const Parent = theme.Layout || theme.extends?.Layout || DefaultTheme.Layout
  return {
    ...theme,
    extends: theme.extends ?? (theme === DefaultTheme ? undefined : DefaultTheme),
    Layout: () => h(Parent, null, docPilotSlots()),
  }
}

/** The whole theme, for a project that has none of its own. */
export default withDocPilot(DefaultTheme)
