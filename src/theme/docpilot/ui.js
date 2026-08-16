/**
 * Where the button lives, what shape the panel takes, and what the floating
 * button is made of.
 *
 *   ui: {
 *     trigger:  'nav' | 'fab',
 *     panel:    'auto' | 'drawer' | 'popup',
 *     fabLabel: true | false | string,   // ui-specs/005
 *     fabIcon:  true | false,
 *   }
 *
 * `panel: 'auto'` is the default and means "whatever the trigger implies": a
 * floating button opens a floating popup, a navbar button opens the full-height
 * drawer that ships today. The shape of the option is VitePress's own — see
 * `resolveMode()` in theme-default's docsearch support — an enum with an `auto`
 * member plus a resolver that returns the FINISHED structure. Nothing
 * downstream re-derives `'auto'` for itself, so no two readers of the setting
 * can disagree about what it meant.
 *
 * The explicit combinations — `nav` + `popup`, `fab` + `drawer` — are carried
 * out in silence. That is what `'auto'` is for: once the implied pairing has a
 * name of its own, an explicit value is an intention rather than a mistake to
 * be corrected.
 *
 * A value outside the enum is reported and dropped, never thrown: this resolves
 * during a docs build, and a typo in a cosmetic setting must not be able to
 * fail one. Same treatment `scope.default` already gets in session.js.
 *
 * NO IMPORTS, and none may be added. This is read from Node (`themeDocPilot`, at
 * build time), from the client store (`session.configure`) and from two
 * components' `computed` — `src/config.js` already imports the theme's
 * `i18n.js` on exactly those terms: pure data, pure functions, no Vue.
 *
 * IDEMPOTENT, and the suite asserts it. The build resolves, emits the result
 * under the same `ui` key, and the browser resolves that again; both members of
 * a resolved pair are legal input values, so the second pass changes nothing.
 */

/** The accepted values, in the order `npx docpilot init` offers them. */
export const UI_TRIGGERS = ['nav', 'fab']
export const UI_PANELS = ['auto', 'drawer', 'popup']

export const UI_DEFAULTS = { trigger: 'nav', panel: 'auto', fabLabel: true, fabIcon: true }

function pick(value, allowed, fallback, key, err) {
  // Absent is not wrong — it is the default, and the overwhelmingly common case.
  if (value == null) return fallback
  if (allowed.includes(value)) return value
  err(
    `[docpilot] ui.${key} only accepts ${allowed.map((v) => `"${v}"`).join(', ')} — ` +
      `using "${fallback}"`,
    value,
  )
  return fallback
}

/**
 * `docPilot` here is whatever object carries a `ui` key — raw settings, resolved
 * settings, or the client half — so one call site's shape is every call site's
 * shape. `err` is injectable for the same reason `resolveSuggestions` takes
 * `warn`: the CLI validates `--trigger`/`--panel` through this function and
 * wants to phrase its own complaint.
 */
/**
 * `fabLabel` is a UNION — `true`, `false`, or the words themselves — so it does
 * not go through `pick`, which validates an enum.
 *
 *   true      the shipped string, looked up per locale through i18n
 *   'Ask AI'  those exact words, untranslated: an author who typed them has
 *             already chosen the language
 *   false     no label at all
 *
 * An empty or blank string is `false`: a label made of spaces is a label the
 * author deleted without saying so, and rendering it would leave a pill with a
 * gap in it.
 */
function label(value, err) {
  if (value == null || value === true) return true
  if (value === false) return false
  if (typeof value === 'string') return value.trim() || false
  err(
    '[docpilot] ui.fabLabel accepts true, false or a string — using true',
    value,
  )
  return true
}

export function resolveUi(docPilot, err = console.error) {
  const ui = docPilot?.ui || {}
  const trigger = pick(ui.trigger, UI_TRIGGERS, UI_DEFAULTS.trigger, 'trigger', err)
  const panel = pick(ui.panel, UI_PANELS, UI_DEFAULTS.panel, 'panel', err)
  const fabLabel = label(ui.fabLabel, err)
  // Only `false` switches it off. Anything else — absent, true, a typo — leaves
  // the glyph on, because this is the half that can stand alone.
  let fabIcon = ui.fabIcon !== false
  // The one combination that has no rendering: a button with no icon and no
  // text is a control nobody can see, and the failure mode of a cosmetic
  // setting must never be "the panel cannot be opened".
  if (!fabIcon && fabLabel === false) {
    err('[docpilot] ui.fabIcon and ui.fabLabel cannot both be off — keeping the icon', ui)
    fabIcon = true
  }
  return {
    trigger,
    // Never 'auto' past this line. Every consumer reads a real shape.
    panel: panel === 'auto' ? (trigger === 'fab' ? 'popup' : 'drawer') : panel,
    // Stated rather than left to each component to compute from `trigger`: the
    // navbar trigger and the FAB are two mounted instances of one component,
    // and "which one renders" is the answer both of them need.
    showNavTrigger: trigger === 'nav',
    showFab: trigger === 'fab',
    // These two describe the FLOATING placement only — see ui-specs/005. The
    // navbar trigger has always been icon-only beside the host's search box and
    // the nav-screen row has always been text; neither reads them.
    fabLabel,
    fabIcon,
  }
}
