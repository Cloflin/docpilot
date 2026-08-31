/**
 * Where the button lives, what shape the panel takes, what the floating button
 * is made of, and how the panel treats the page it opens over.
 *
 *   ui: {
 *     trigger:      'nav' | 'fab' | 'screen' | 'both' | 'none' | [...],
 *     panel:        'auto' | 'drawer' | 'popup',
 *     fabLabel:     true | false | string,      // ui-specs/005
 *     fabIcon:      true | false,
 *     layout:       'overlay' | 'push',         // ui-specs/009
 *     prefetch:     'hover' | 'idle' | false,   // ui-specs/009
 *     firstRunHint: true | false,               // ui-specs/009
 *     waitingEscalation: true | false,          // ui-specs/012
 *     credit:       true | false,               // the `DocPilot` link in the footnote
 *     theme:        'auto' | 'light' | 'dark',  // ui-specs/011
 *     font:         string | null,              // a family list, or `--your-var`
 *     fontMono:     string | null,
 *   }
 *
 * `trigger` IS A LIST, and a bare word is shorthand for one. A site is allowed
 * every placement at once — the navbar button beside search, the row in the
 * mobile nav menu, and the floating button — because they are not alternatives
 * on the same screen: the first two only exist inside someone else's navbar and
 * the third only exists outside it. Making them exclusive was a limit of the
 * enum, never a design decision, and the enum is what changed.
 *
 * `panel: 'auto'` is the default and means "whatever the trigger implies": a
 * list with the floating button in it opens a floating popup, a list without one
 * opens the full-height drawer. The SHIPPED pair is therefore the floating
 * button and the popup, because `trigger` defaults to `'fab'`. The shape of the
 * option is VitePress's own — see `resolveMode()` in theme-default's docsearch
 * support — an enum with an `auto` member plus a resolver that returns the
 * FINISHED structure. Nothing downstream re-derives `'auto'` for itself, so no
 * two readers of the setting can disagree about what it meant.
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
 * under the same `ui` key, and the browser resolves that again; every member of
 * a resolved result is a legal input value, so the second pass changes nothing.
 * That is also why the resolved `trigger` is ALWAYS an array and never the word
 * the author typed: `'nav'` means two placements, so a resolver that handed back
 * `'nav'` would be handing back something it had not finished resolving.
 */

/**
 * The three placements, in the order they appear in the document.
 *
 *   'nav'     the button in the host's navigation bar, beside its search box
 *   'screen'  a text row inside the host's mobile navigation menu
 *   'fab'     the floating button, bottom corner, on every page and every width
 *
 * THE ORDER IS THE CANONICAL ORDER, and `resolveUi` sorts into it. A resolved
 * list has to compare equal to another resolved list of the same placements, or
 * the suite's idempotency assertion and every `toEqual` in it would depend on
 * the order somebody happened to type.
 */
export const UI_TRIGGERS = ['nav', 'screen', 'fab']

/**
 * The words that stand for a LIST — the shape `trigger` had before it was one.
 *
 * `'nav'` is the load-bearing entry. It has always meant *both* the navbar
 * button and the row in the mobile nav menu, because a navbar that collapses
 * into a hamburger takes the button with it and a placement with no mobile half
 * is a placement that disappears on a phone. Sites configured `trigger: 'nav'`
 * on that promise, so the word keeps it: only an explicit `['nav']` gets the
 * desktop button on its own.
 *
 * `'fab'` deliberately does NOT pull in the screen row: the floating button is
 * on screen at every width already, and a second entry point in the mobile menu
 * is exactly what choosing one placement said not to have. `['fab','screen']`
 * is how a site asks for both.
 *
 * `'fab'` is also the SHIPPED DEFAULT — see `UI_DEFAULTS` below — which is a
 * change of default and not of meaning: the word still stands for the one
 * placement, and `'nav'` still stands for two.
 *
 * `'both'` and `'none'` were in `types/config.d.ts` from the start and were
 * accepted by nothing — the resolver dropped them with a warning and fell back
 * to `'nav'`. The types were the honest half of that disagreement, so they are
 * the half that stays.
 */
const UI_TRIGGER_WORDS = {
  nav: ['nav', 'screen'],
  screen: ['screen'],
  fab: ['fab'],
  both: ['nav', 'screen', 'fab'],
  all: ['nav', 'screen', 'fab'],
  none: [],
}

/** What `npx docpilot init` offers, and what a bad value is reported against. */
export const UI_TRIGGER_WORD_LIST = Object.keys(UI_TRIGGER_WORDS)

export const UI_PANELS = ['auto', 'drawer', 'popup']

/**
 * `'overlay'` is today's behaviour and stays the default — ui-specs/009.
 *
 * The desktop drawer is `position: fixed` at the trailing edge, so it covers the
 * host's aside and, on a narrow desktop, part of the prose column. The
 * component's own header calls the panel non-modal so *docs stay readable beside
 * the answer*, which `'push'` is what makes true: the host's content gets an
 * inline-end padding while the panel is open. It reflows somebody else's layout,
 * so it is a mode a project chooses rather than a fix that arrives.
 */
export const UI_LAYOUTS = ['overlay', 'push']

/**
 * When the retrieval index is fetched — ui-specs/009.
 *
 *   'hover'  on the trigger's first pointerenter or focus. Close to intent and
 *            almost never wrong, which is why it is the default.
 *   'idle'   once the page has settled, for a site that would rather pay up front
 *   false    on open, which is where it happened before this setting existed
 *
 * Only the NETWORK half is prefetched. `ensureIndex` also restores the scope and
 * the conversation, and the scope restore can announce — into a polite region,
 * with the panel closed. session.js keeps those two apart for that reason.
 */
export const UI_PREFETCH = ['hover', 'idle', false]

/**
 * WHAT A TURN DOES WHEN THE PANEL GOES AWAY UNDER IT — ui-specs/010.
 *
 *   'notify'   the turn runs on; the trigger carries a dot when it settles
 *   'open'     the turn runs on; the panel comes back with the answer in place
 *   false      the turn is abandoned on close, which is where it was before
 *              this setting existed
 *
 * `'notify'` ships because the panel's own stated position is that the docs
 * stay readable beside the answer: a reader who put the panel away was reading
 * something, and a panel that reopens itself over that is the one behaviour
 * this package has always refused. The dot is the smallest thing that can say
 * "it is done" without taking the page back.
 *
 * `false` is the switch rule, not a hedge: this is a reader-visible behaviour
 * arriving on an `npm update`, and it has to be removable.
 */
export const UI_BACKGROUND = ['notify', 'open', false]

/**
 * WHICH COLOUR SCHEME THE PANEL WEARS — ui-specs/011.
 *
 *   'auto'   whatever the page already says: the host's own light/dark toggle
 *            where there is an adapter, `prefers-color-scheme` where there is
 *            not. Today's behaviour, and the default.
 *   'light'  the core's light palette, whatever the page and the OS say
 *   'dark'   the core's dark palette, on the same terms
 *
 * `'system'` is accepted as a spelling of `'auto'` and normalised to it before
 * the enum is checked, because the two words name the same thing everywhere
 * else a reader has met this setting and neither is worth an error message.
 *
 * THE ONE KEY WHERE `'auto'` SURVIVES RESOLUTION. `panel: 'auto'` names a SHAPE,
 * and the build can settle it from the trigger list — see the note on `panel`
 * below for why nothing downstream may re-derive it. `theme: 'auto'` names a
 * SIGNAL, and the signal is the reader's browser: there is nothing to settle at
 * build time, and a resolver that picked one would be pinning every reader to
 * whichever scheme the machine that ran the build happened to prefer.
 *
 * A PIN WEARS THE CORE'S OWN PALETTE, not the host's. `--dp-surface` maps to
 * `--vp-c-bg` on VitePress, and `--vp-c-bg` only holds a dark value while
 * VitePress is *in* dark mode — so a panel pinned dark on a light site has no
 * host value to read and uses the core's. Same trade `ui.font` makes.
 */
export const UI_THEMES = ['auto', 'light', 'dark']

/**
 * WHAT MAY REACH `style.setProperty`, stated as what may not.
 *
 * The resolved value is written onto `<html>` as a custom property and is read
 * by exactly one declaration, `font-family`. A denylist rather than an allowlist
 * because the legitimate input is every family name in every script — `思源黑体`
 * is a font, `--police-de-caractères` is a variable someone will write — and an
 * allowlist of Latin letters would reject the authors this setting is for.
 *
 * What is refused is the punctuation that could end this declaration or open
 * another: `;` `{` `}` `<` `>` `@` `\`, the `*` that starts a comment, a control
 * character, and `url(` — which `font-family` cannot use and which is the one
 * function in a value that fetches.
 */
const FONT_UNSAFE = /[;{}<>@*\\\u0000-\u001f]|url\s*\(/i

/** A custom property NAME, which is the shorthand `var()` is grown around. */
const CSS_VAR_NAME = /^--[A-Za-z0-9_-]+$/

export const UI_DEFAULTS = {
  /**
   * `'fab'` — the floating button, and the one placement that does not need
   * somebody else's navbar.
   *
   * `'nav'` was the default for as long as the panel was a VitePress theme
   * extension, where a navbar slot is a given. It is not a given anywhere else:
   * a custom theme, a React page, a Docusaurus site with its own header — every
   * host that has no slot for the button rendered NOTHING by default, and the
   * only visible symptom was a panel nobody could open. `mountDocPilot` had
   * already reached the same conclusion on its own and mounts `'fab'` by
   * default; this is the settings half agreeing with it.
   *
   * A site that wants the button back in its navigation bar says
   * `ui: { trigger: 'nav' }`, and `panel: 'auto'` returns the drawer with it.
   */
  trigger: 'fab',
  /**
   * `'auto'`, which with the default trigger resolves to `'popup'`.
   *
   * The pairing stays derived rather than stated: a site that moves the button
   * into its navbar gets the drawer back from the same key it never touched.
   */
  panel: 'auto',
  fabLabel: true,
  fabIcon: true,
  layout: 'overlay',
  prefetch: 'hover',
  firstRunHint: false,
  /**
   * `true` — a wait long enough to be worth naming gets named. ui-specs/012.
   *
   * The status line is otherwise a pure function of the phase, and a phase does
   * not move while a provider accepts the connection and then says nothing —
   * which the step timeout permits for two minutes. Two steps, at eight seconds
   * and at twenty-five; `status.js` holds the numbers and the argument for them.
   *
   * ON by 009's blast-radius test: it is inside the panel, on this package's own
   * surface, and it replaces silence rather than replacing a sentence.
   */
  waitingEscalation: true,
  /**
   * `'notify'` — the turn outlives the panel, and says so with a dot.
   *
   * A default that changes behaviour on update, which this package normally
   * refuses. It is taken here because the behaviour it replaces was a FALSEHOOD
   * rather than a preference: closing the panel mid-retrieval aborted the turn,
   * and an abort with nothing painted yet renders as `I couldn't find this in
   * the docs.` — a statement about the corpus, made about a turn the corpus was
   * never asked to answer. There is no value of this setting under which that
   * sentence was right, so no reader loses anything they had.
   */
  background: 'notify',
  /**
   * `true` — the panel says what it is, once, at the bottom of the footnote.
   *
   * One word, `DocPilot`, linked to the project, after the disclaimer it shares
   * a line with. On by default because a panel a reader cannot name is a panel
   * they cannot ask about; a switch rather than a fixture because a docs site is
   * somebody else's product and the last word in it is theirs.
   */
  credit: true,
  /**
   * `'auto'` — the panel follows the page, which is what it has always done.
   *
   * The default changes nothing: with no pin, the core's dark values still come
   * from `prefers-color-scheme` and an adapter's still come from the host's own
   * toggle. `'light'` and `'dark'` are for the site those two signals cannot
   * answer for — an embed on a page pinned against its reader's OS, or a
   * product that wants the assistant to read as one scheme everywhere.
   */
  theme: 'auto',
  /**
   * `null` — and the default lives in the STYLESHEET, not here.
   *
   * `--dp-font` is `inherit`, so a panel nobody configured already wears the
   * face of the page it opens on: this pair is for the site whose font the
   * panel cannot inherit — a `<body>` that names none, a host that sets one on
   * its article container alone, a design system that keeps it in a variable
   * the panel has no reason to know the name of. Null means *nobody said*, and
   * nothing is written to the document.
   */
  font: null,
  fontMono: null,
}

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

/**
 * `ui.font` / `ui.fontMono` — the site's own face, named rather than inherited.
 *
 * TWO SPELLINGS, because a site holds the value in one of two forms and neither
 * is the more correct one:
 *
 *   'Inter, system-ui, sans-serif'   the family list itself
 *   '--brand-font'                   the custom property it already lives in
 *   'var(--brand-font, Inter)'       the same, written out, fallback and all
 *
 * A bare `--name` is WRAPPED, not rejected. `var(--brand-font)` is what it has
 * to become before it can be written, and asking an author to type the wrapper
 * is asking them to type the one part of it with no decision in it. Anything
 * else is passed through as written, because a family list is not a grammar
 * this file has any business re-deriving.
 *
 * Dropped with a message, never thrown, on the same terms as every other value
 * here: this resolves during a docs build, and a typo in a cosmetic setting must
 * not be able to fail one. The panel then wears the page's face, which is the
 * default and a perfectly good answer.
 *
 * IDEMPOTENT like the rest — `var(--x)` in gives `var(--x)` out, and `null`
 * survives a second pass — so the build may resolve it and the browser resolve
 * that again.
 */
function family(value, key, err) {
  // Absent is not wrong — it is the default, and the overwhelmingly common case.
  // `false` is the same sentence written by an author who thinks in switches.
  if (value == null || value === false) return null
  if (typeof value !== 'string') {
    err(
      `[docpilot] ui.${key} accepts a font family list, a custom property name, or null — ` +
        'using the page\'s own font',
      value,
    )
    return null
  }
  const raw = value.trim()
  // A value made of spaces is a value the author deleted without saying so —
  // the same reading `fabLabel` gives it.
  if (!raw) return null
  const out = CSS_VAR_NAME.test(raw) ? `var(${raw})` : raw
  if (FONT_UNSAFE.test(out)) {
    err(
      `[docpilot] ui.${key} may not contain ; { } < > @ * \\ or url() — ` +
        'using the page\'s own font',
      value,
    )
    return null
  }
  return out
}

/** In `UI_TRIGGERS` order, deduped — see why the order is fixed up there. */
const canonical = (list) => UI_TRIGGERS.filter((t) => list.includes(t))

/** A value, named in a message, without a way for the naming to throw. */
function show(value) {
  try {
    const out = JSON.stringify(value)
    // `undefined`, a function and a symbol all stringify to `undefined`.
    return out === undefined ? String(value) : out
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * `ui.trigger` — one word, or a list of placements.
 *
 * The two inputs are read differently ON PURPOSE. A WORD goes through
 * `UI_TRIGGER_WORDS`, which is where `'nav'` keeps meaning "the navbar button
 * and its mobile row". A LIST is taken literally, member by member, because an
 * author who wrote the members out is describing the finished set and an
 * expansion applied on top of that would add a placement they did not ask for.
 * `'nav'` and `['nav']` therefore differ, and that asymmetry is the whole of
 * the back-compatibility: it is the only shape a site could already have.
 *
 * AN EMPTY RESULT IS LEGAL, but only when it was asked for. `'none'` and `[]`
 * both resolve to no visible trigger, which is a real configuration — the hotkey
 * still binds, and a host that renders its own button wants exactly this. A list
 * that ARRIVED non-empty and ended up empty is a typo instead, and falls back to
 * the default: a cosmetic setting must never be able to leave a page with no way
 * to open the panel.
 */
function triggers(value, err) {
  // Absent is not wrong — it is the default, and the overwhelmingly common case.
  if (value == null) return [...UI_TRIGGER_WORDS[UI_DEFAULTS.trigger]]

  if (typeof value === 'string') {
    /**
     * `Object.hasOwn`, NOT a truthiness test on the lookup.
     *
     * A plain object literal inherits from `Object.prototype`, so
     * `UI_TRIGGER_WORDS['toString']` is a FUNCTION and perfectly truthy — and
     * `[...aFunction]` throws `TypeError: not iterable`. `trigger: 'toString'`,
     * `'constructor'` or `'__proto__'` would therefore have taken down a docs
     * build from inside the one resolver whose whole contract is that a typo in
     * a cosmetic setting can never fail one.
     */
    const named = Object.hasOwn(UI_TRIGGER_WORDS, value) ? UI_TRIGGER_WORDS[value] : null
    // A copy, never the table's own array: the resolved object is handed to the
    // client and to two components, and one `.push()` anywhere would rewrite
    // what every later build of this process resolves.
    if (named) return [...named]
    err(
      `[docpilot] ui.trigger accepts ${UI_TRIGGER_WORD_LIST.map((v) => `"${v}"`).join(', ')} ` +
        `or an array of ${UI_TRIGGERS.map((v) => `"${v}"`).join(', ')} — ` +
        `using "${UI_DEFAULTS.trigger}"`,
      value,
    )
    return [...UI_TRIGGER_WORDS[UI_DEFAULTS.trigger]]
  }

  if (Array.isArray(value)) {
    const kept = value.filter((v) => UI_TRIGGERS.includes(v))
    const dropped = value.filter((v) => !UI_TRIGGERS.includes(v))
    // Named one by one rather than counted — "no silent caps": a list that lost
    // a member is a list whose author is about to go looking for a button.
    //
    // `show`, not `JSON.stringify`, and for the same reason the word lookup uses
    // `Object.hasOwn`: this resolver may not throw, and `JSON.stringify` throws
    // on a circular reference and on a BigInt. The message is a courtesy; it
    // must not be able to cost a build more than the value it is describing.
    if (dropped.length) {
      err(
        `[docpilot] ui.trigger array accepts ${UI_TRIGGERS.map((v) => `"${v}"`).join(', ')} — ` +
          `dropped ${dropped.map(show).join(', ')}`,
        value,
      )
    }
    // Emptied by the filter, not by the author. See the note above.
    if (!kept.length && value.length) return [...UI_TRIGGER_WORDS[UI_DEFAULTS.trigger]]
    return canonical(kept)
  }

  err(
    `[docpilot] ui.trigger accepts a string or an array — using "${UI_DEFAULTS.trigger}"`,
    value,
  )
  return [...UI_TRIGGER_WORDS[UI_DEFAULTS.trigger]]
}

export function resolveUi(docPilot, err = console.error) {
  const ui = docPilot?.ui || {}
  const trigger = triggers(ui.trigger, err)
  const panel = pick(ui.panel, UI_PANELS, UI_DEFAULTS.panel, 'panel', err)
  const layout = pick(ui.layout, UI_LAYOUTS, UI_DEFAULTS.layout, 'layout', err)
  const prefetch = pick(ui.prefetch, UI_PREFETCH, UI_DEFAULTS.prefetch, 'prefetch', err)
  const fabLabel = label(ui.fabLabel, err)
  // Only `false` switches it off. Anything else — absent, true, a typo — leaves
  // the glyph on, because this is the half that can stand alone.
  let fabIcon = ui.fabIcon !== false
  // The one combination that has no rendering: a button with no icon and no
  // text is a control nobody can see, and the failure mode of a cosmetic
  // setting must never be "the panel cannot be opened". Corrected whether or not
  // the floating button is in the list, so that adding it later cannot resurrect
  // a pair that was already invalid.
  if (!fabIcon && fabLabel === false) {
    err('[docpilot] ui.fabIcon and ui.fabLabel cannot both be off — keeping the icon', ui)
    fabIcon = true
  }
  return {
    // ALWAYS an array. See the idempotency note at the top of the file for why
    // the word the author typed is not what comes back out.
    trigger,
    /**
     * Never 'auto' past this line. Every consumer reads a real shape.
     *
     * The floating button decides it, and it decides it even when the navbar
     * button is in the list too: the popup is anchored to the corner the FAB
     * sits in, and the drawer is not anchored to anything. So `['nav','fab']`
     * opens the popup, both buttons open the same panel, and the one placement
     * with a geometric opinion is the one that gets to hold it. A site that
     * wants the drawer with a FAB says `panel: 'drawer'` — which was always
     * legal and is still carried out in silence.
     */
    panel: panel === 'auto' ? (trigger.includes('fab') ? 'popup' : 'drawer') : panel,
    // Stated rather than left to each component to compute from `trigger`: the
    // three placements are three mounted instances of one component, and "does
    // this one render" is the answer all three need. Booleans rather than the
    // list itself, because a component that reads `.includes()` is a component
    // that can be handed a string by a hand-written themeConfig.
    showNavTrigger: trigger.includes('nav'),
    showScreen: trigger.includes('screen'),
    showFab: trigger.includes('fab'),
    // These two describe the FLOATING placement only — see ui-specs/005. The
    // navbar trigger has always been icon-only beside the host's search box and
    // the nav-screen row has always been text; neither reads them.
    fabLabel,
    fabIcon,
    // ── ui-specs/009 ────────────────────────────────────────────────────────
    layout,
    prefetch,
    // Through `pick` like the rest, rather than `=== true`: a typo here would
    // otherwise resolve silently to the default and the author would be looking
    // for a hint that never renders and never complained.
    firstRunHint: pick(ui.firstRunHint, [true, false], UI_DEFAULTS.firstRunHint, 'firstRunHint', err),
    waitingEscalation: pick(
      ui.waitingEscalation,
      [true, false],
      UI_DEFAULTS.waitingEscalation,
      'waitingEscalation',
      err,
    ),
    // ── ui-specs/010 ────────────────────────────────────────────────────────
    background: pick(ui.background, UI_BACKGROUND, UI_DEFAULTS.background, 'background', err),
    // Through `pick` for the same reason as the line above it: `credit: 'no'` is
    // an author switching the link off, and resolving that silently to `true`
    // leaves them looking at a badge they told the config to remove.
    credit: pick(ui.credit, [true, false], UI_DEFAULTS.credit, 'credit', err),
    /**
     * Like `font` below, this one reaches the STYLESHEET rather than a
     * component: `session.configure` writes `docpilot-light` / `docpilot-dark`
     * onto `<html>` and the core's pinned blocks do the rest.
     *
     * `'system'` is folded into `'auto'` BEFORE the enum check, so the message
     * `pick` would otherwise print never fires for a word that is not a mistake,
     * and so the resolved value stays inside `UI_THEMES` — which is what keeps
     * the second pass in the browser a no-op.
     */
    theme: pick(
      ui.theme === 'system' ? 'auto' : ui.theme,
      UI_THEMES,
      UI_DEFAULTS.theme,
      'theme',
      err,
    ),
    /**
     * The two that do not reach a component at all — `session.configure` writes
     * them onto `<html>` as `--dp-font` and `--dp-font-mono`. Resolved here
     * anyway, and not in the browser, so that a bad value is reported where a
     * build can print it rather than in a console nobody has open.
     */
    font: family(ui.font, 'font', err),
    fontMono: family(ui.fontMono, 'fontMono', err),
  }
}
