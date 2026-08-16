import VoidZeroTheme, {
  themeContextKey,
} from '@voidzero-dev/vitepress-theme/src/index'
// By package name, like any other consumer — the `exports` map and the shipped
// stylesheet are both exercised by this site's own build.
import { withDocPilot } from '@cloflin/docpilot/theme'
import './styles.css'

import wordmarkLight from './assets/docpilot-light.svg'
import wordmarkDark from './assets/docpilot-dark.svg'
import footerBg from './assets/footer-background.svg'
import monoIcon from './assets/docpilot-mono.svg'

/**
 * The docs theme, laid out the way the Rolldown docs are: the shared VoidZero
 * VitePress theme, plus a thin per-project layer that supplies this project's
 * own brand assets and colours.
 *
 * The theme injects its assets through `themeContextKey` rather than reading
 * them from config, so a project that extends it has to provide all five keys —
 * `Header.vue` and `Footer.vue` both `inject(...)!` without a fallback, and a
 * missing key is a render-time crash, not a missing logo.
 *
 * THE TWO LOGO KEYS ARE CROSSED, and deliberately. The theme names them after
 * the ink rather than the appearance — `Header.vue` renders `logoDark` under
 * `block dark:hidden`, so the key called dark is the one shown in LIGHT mode.
 * The files here are named the other way round, after the appearance they are
 * drawn for, which is the VitePress convention and the one `docs/public` already
 * follows. Renaming either side to agree would only move the crossover; this is
 * the single place it lives.
 *
 * `extends` chains `enhanceApp`: VitePress runs the base theme's first, then
 * this one's, so the base is deliberately not called by hand here.
 *
 * `withDocPilot` wraps that whole arrangement. This theme has no `Layout` of its
 * own — the VoidZero one arrives through `extends` — so the wrapper reads the
 * parent from there and renders it with four slots filled: the panel and the
 * floating button at the end of the layout, the trigger beside the navbar
 * search, and the call-to-action under each article. On a page using the
 * marketing layout only `layout-bottom` exists, so the panel is present there
 * and its navbar trigger is not; that is the host theme's shape, not a setting.
 *
 * With no index built, `themeConfig.docPilot` is `{enabled: false}` and all four
 * render nothing at all.
 */
export default withDocPilot({
  extends: VoidZeroTheme,

  enhanceApp({ app }) {
    app.provide(themeContextKey, {
      logoDark: wordmarkLight,
      logoLight: wordmarkDark,
      logoAlt: 'DocPilot',
      footerBg,
      monoIcon,
    })
  },
})
