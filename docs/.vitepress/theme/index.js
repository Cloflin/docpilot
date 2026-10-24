import { h } from 'vue'
import CloflinTheme from '@cloflin/vitepress-theme'
// By package name, like any other consumer. The host-neutral core stylesheet,
// not the VitePress one: that maps the panel's tokens onto the default theme's
// `--vp-*` variables, which this theme does not have. `styles.css` maps them
// onto this theme's `--cf-*` instead.
import { withDocPilot } from '@cloflin/docpilot/theme-without-styles'
import '@cloflin/docpilot/style/core.css'
import './styles.css'
import SiteFooter from './SiteFooter.vue'

// Every component in `demos/`, `intro/` and `home/`, registered by file name, so a page
// can use `<ScopeDemo />` in its markdown without a script block.
const components = import.meta.glob(['./demos/*.vue', './intro/*.vue', './home/*.vue'], { eager: true })

/**
 * The docs theme: @cloflin/vitepress-theme, with the panel added through
 * `withDocPilot` the way any consumer adds it. The wrapper renders the theme's
 * Layout with `layout-bottom` (panel, floating button, quote popover) and
 * `nav-bar-content-before` (navbar trigger) filled — both slots exist in this
 * theme under the default theme's names.
 *
 * The demo components are registered globally; see `components` below.
 */
/**
 * The theme's Layout with the site footer appended to `layout-bottom`. It is a
 * merge rather than a slot of its own because `withDocPilot` claims that slot
 * for the panel: the wrapper renders this Layout as its parent and passes the
 * panel in, and both end up in the slot.
 */
const Layout = (_props, { slots }) =>
  h(CloflinTheme.Layout, null, {
    ...slots,
    'layout-bottom': () => [slots['layout-bottom']?.(), h(SiteFooter)],
  })

export default withDocPilot({
  extends: CloflinTheme,
  Layout,
  enhanceApp({ app }) {
    for (const [file, mod] of Object.entries(components)) {
      app.component(file.split('/').pop().replace('.vue', ''), mod.default)
    }
  },
})
