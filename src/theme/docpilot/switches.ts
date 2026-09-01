/**
 * The switches — ui-specs/009, and the home of rule 11.
 *
 * **Every reader-visible action this panel performs can be removed by the
 * project that mounts it.** That is the rule; this module is where the values
 * behind it are settled. What it is NOT is a `features` block: the config keys
 * stay grouped by SUBJECT — `quote.*`, `citations.*`, `composer.*` beside the
 * `scope.*`, `history.*`, `prompt.*` and `feedback.*` that shipped before them —
 * because this config already organises that way and a second organising
 * principle running alongside the first is two places to look for one answer.
 * How the resolvers are filed is a different question from how the settings are.
 *
 * `citations`, NOT `sources`. `docPilot.sources` is taken, by the allowlist of
 * origins an imported page may name in its `source:` frontmatter — the object
 * that decides which hosts may become a link in an answer. That is a security
 * boundary, and a cosmetic block landing on its name would be the worst kind of
 * collision: one that merges cleanly. `citations` is the better name anyway,
 * being what the panel calls them everywhere else.
 *
 * THE DEFAULTS ARE DECIDED BY BLAST RADIUS, not by preference. Three tiers:
 *
 *   · a defect            no switch at all — a bug has no user who wants to
 *                         keep it, so a key for one only ever gets set wrong
 *   · inside the panel    ON. The panel is this package's own surface, and a
 *                         reader who opened it asked for what is in it
 *   · outside the panel   OFF. Anything that reflows the host's layout or paints
 *                         on the host's article must not arrive with an upgrade
 *
 * Three settings are in the third tier by that test: `ui.layout: 'push'`,
 * `quote.fromDocs` and `ui.firstRunHint`. Three more are off for reasons of
 * their own, each recorded where it is resolved: `suggestions.followUps` on a
 * measurement outside this repository, `citations.passage` because a second
 * layer over a link is a layer a project turns on, and `budget.showRemaining`
 * because the count a browser can compute is not the count the account has.
 *
 * NO IMPORTS, and none may be added — the same terms `ui.js` states and for the
 * same three readers: `themeDocPilot` at build time in Node, `session.configure`
 * in the browser, and a component's `computed` before `configure()` has run.
 *
 * IDEMPOTENT, and the suite asserts it. The build resolves, emits the result
 * under the same keys, and the browser resolves that again; every member of a
 * resolved object is a legal input value, so the second pass changes nothing.
 *
 * NEVER THROWS. A typo in one of these runs during somebody else's docs build,
 * and a cosmetic setting has no business failing one. Report through the
 * injected reporter, use the default, carry on — the discipline `resolveUi`,
 * `resolveFeedback` and `resolveSuggestions` already keep.
 */

export const QUOTE_DEFAULTS = { fromAnswer: true, fromDocs: false }
export const CITATIONS_DEFAULTS = { passage: false, inCopy: true, pagesRead: false }
export const COMPOSER_DEFAULTS = { editLastOnArrowUp: true, deepLink: true, draft: true }
export const SUGGESTIONS_DEFAULTS = {
  questions: [],
  scoped: true,
  followUps: false,
  precomputed: true,
  answers: true,
  matchTau: 0.65,
}

/**
 * The built-in three, for a project that configured none.
 *
 * Lived in `DocPilot.vue` until the indexer needed the same list: it bakes what
 * the panel WILL SHOW, and a second copy of the list would bake three questions
 * the reader never sees. Same reason `normalise` moved into text.js.
 *
 * Deliberately engine-agnostic: this package ships to any VitePress site, so a
 * default that names a feature only one product has is a question the gate will
 * refuse on contact — which reads to the reader as a broken panel on their very
 * first click. `docPilot.suggestions` is where three to five good ones go, and
 * `docpilot index` now says on stdout which of these three your corpus refuses.
 */
export const DEFAULT_SUGGESTIONS = [
  'What is this documentation about?',
  'How do I get started?',
  'How do I authenticate requests?',
]

/**
 * The value that retires the paraphrase match — `BUDGET_NEVER`'s sibling, and
 * the same trick for the same reason.
 *
 * Lexical coverage L is a fraction of the query's rare terms that the opener's
 * text covers, so it cannot exceed 1. A threshold of 2 is a comparison that
 * cannot come true: the rule stays in the code and stops firing, exact matching
 * carries on, and the resolved shape stays a NUMBER so nothing downstream has to
 * branch on a type. `matchTau: false` in the config file resolves to this, which
 * also keeps the resolver idempotent — a resolved block fed back through comes
 * out unchanged. Rule 11a.
 */
export const MATCH_NEVER = 2

/** `'auto'` shows the field once the corpus is past the point where scanning works. */
export const SCOPE_FILTERS = ['auto', true, false]
export const SCOPE_DEFAULTS = {
  enabled: true,
  default: 'all',
  promptListLimit: 12,
  filter: 'auto',
  groupBySection: true,
}
export const HISTORY_DEFAULTS = {
  enabled: true,
  maxConversations: 20,
  exportThread: true,
  saveOnUnload: true,
}

/**
 * `baseURL: null` means "the same service as chat" — `embedTarget` fills it, and
 * every other null here is filled the same way. `model` is the one that is NOT a
 * fallback: `bge-m3` is a statement about a local Ollama, and it stands because a
 * panel that reaches the index's own `manifest.embedModel` first only needs a name
 * here when the manifest carries none.
 */
export const EMBED_DEFAULTS = {
  provider: null,
  baseURL: null,
  model: 'bge-m3',
  apiKey: null,
  lexicalOnly: false,
}

export const BUDGET_MODES = ['auto', 'agentic', 'one-shot']
export const BUDGET_PROBES = ['auto', 'always', 'never']
export const BUDGET_DEFAULTS = {
  mode: 'auto',
  oneShotBelow: 15,
  rotateAbove: 6,
  maxContinuations: 1,
  showRemaining: false,
  probe: 'auto',
  dailyLimit: null,
}

/**
 * The corpus size past which the picker's filter appears under `'auto'`.
 *
 * Twelve, which is `scope.promptListLimit`'s own number and not a coincidence:
 * that value is already this package's answer to "how many pages can be named in
 * one breath". A list longer than that is a list nobody scans.
 */
export const FILTER_AUTO_ABOVE = 12

/**
 * One boolean.
 *
 * Absent is not wrong — it is the default, and overwhelmingly the common case.
 * Anything that is neither absent nor a boolean is reported and dropped, because
 * `filter: 'yes'` is a setting the author believes is on.
 */
function flag(value, fallback, key, err) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  err(`[docpilot] ${key} accepts true or false — using ${fallback}`, value)
  return fallback
}

/** One enum. `allowed` may hold non-strings — `scope.filter` mixes `'auto'` with booleans. */
function pick(value, allowed, fallback, key, err) {
  if (value == null) return fallback
  if (allowed.includes(value)) return value
  err(
    `[docpilot] ${key} only accepts ${allowed.map((v) => JSON.stringify(v)).join(', ')} — ` +
      `using ${JSON.stringify(fallback)}`,
    value,
  )
  return fallback
}

/**
 * The value that retires a threshold: a rule still in the code that can no
 * longer fire. See `threshold` for why it is `-1` and not, say, `null`.
 */
export const BUDGET_NEVER = -1

/** The ceiling on `maxContinuations`, already past what a truncation costs. See `bounded`. */
export const MAX_CONTINUATIONS = 3

/**
 * One threshold, in answers left today — a whole number, or `-1` for never.
 *
 * The other resolvers pass their numbers straight through with `??`, and they
 * are right to: `promptListLimit` and `maxConversations` are list lengths, so a
 * wrong one shows the reader a list of the wrong length and the mistake is on
 * screen. The `budget` numbers are arithmetic against a daily REQUEST ceiling
 * and none of them is ever rendered. `oneShotBelow: '15'` compares a string to a
 * remaining count, and it surfaces weeks later as a panel that shortens its
 * answers on a budget that is not actually thin — indistinguishable, from the
 * outside, from the outage this whole block exists to prevent.
 *
 * `-1` IS A VALUE HERE, not a typo to report. A remaining count is never
 * negative, so `remaining <= -1` is a comparison that cannot come true: the rule
 * stays where it is and stops happening. That is the shape `budget: false` needs
 * — it used to neutralise `mode`, `showRemaining` and `probe` and leave the two
 * thresholds at 15 and 6, and `budgetPlan` reads those whatever the mode is, so
 * a project that had switched the block off in one word went on having its pool
 * stop rotating at six remaining. It is also the only value an author can write
 * to retire ONE rule while keeping the other. And a resolver that refused its
 * own output would break idempotence the first time a resolved `false` block
 * came back round, which is rule 11a's whole subject.
 */
function threshold(value, fallback, key, err) {
  if (value == null) return fallback
  if (Number.isInteger(value) && value >= BUDGET_NEVER) return value
  err(
    `[docpilot] ${key} accepts a whole number of 0 or more, or -1 for never — using ${fallback}`,
    value,
  )
  return fallback
}

/**
 * One fraction in [0, 1], or `false` for never.
 *
 * `threshold` above is the integer sibling and this is deliberately not it: a
 * coverage threshold is a fraction, and `Number.isInteger` would reject every
 * value an author would sensibly write. The two share the shape that matters —
 * a sentinel the comparison can never satisfy, so a retired rule stays in the
 * code rather than being branched around.
 *
 * A value outside [0, 1] is reported rather than clamped. `matchTau: 75` is an
 * author who meant a percentage, and clamping it to 1 would silently give them
 * "never match" while the config file says something that looks generous.
 */
function fraction(value, never, fallback, key, err) {
  if (value == null) return fallback
  if (value === false) return never
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value
  err(
    `[docpilot] ${key} accepts a number from 0 to 1, or false for never — using ${fallback}`,
    value,
  )
  return fallback
}

/**
 * How many follow-up requests a truncated reply may spend — 0 to 3, and the
 * ceiling is the whole point of having a separate helper for one key.
 *
 * `maxContinuations` is the one number in this block that SPENDS requests rather
 * than saving them, and it spends them per turn: `99` resolved verbatim, and on
 * a budget `budgetPlan` cannot defend that is ninety-nine requests behind a
 * single question against a fifty-a-day allowance — the failure this block
 * exists to prevent, arriving through the block itself. Three is already past
 * what the defect costs: a reply stopped at the provider's output ceiling needs
 * one more request, occasionally two. Above that it is not a longer answer, it
 * is a different failure being retried at a request each.
 */
function bounded(value, max, fallback, key, err) {
  if (value == null) return fallback
  if (Number.isInteger(value) && value >= 0 && value <= max) return value
  err(`[docpilot] ${key} accepts a whole number from 0 to ${max} — using ${fallback}`, value)
  return fallback
}

/**
 * The local-count ceiling: `null`, or a real allowance of at least one.
 *
 * `0` is what this exists to refuse, and refuse rather than clamp, because
 * everything downstream reads a falsy ceiling as ABSENCE: `createBudget` turns
 * `0` into `null`, and `session.js` seeds the free-tier fallback with `??`,
 * which `0` passes straight through. So an author writing `dailyLimit: 0` to
 * mean "allow none" gets no ceiling at all — the exact opposite of what they
 * wrote, with nothing said about it. Reported and replaced, like every other bad
 * leaf; `null`, which means "count nothing locally, wait for a header to say
 * what the ceiling is", stays the one legal non-number.
 */
function allowance(value, fallback, key, err) {
  if (value == null) return fallback
  if (Number.isInteger(value) && value >= 1) return value
  err(`[docpilot] ${key} accepts null or a whole number of 1 or more — using ${fallback}`, value)
  return fallback
}

/** Every boolean in one defaults object, resolved against one settings object. */
function flags(cfg, defaults, group, err) {
  const out = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    out[key] = flag(cfg[key], fallback, `${group}.${key}`, err)
  }
  return out
}

/**
 * Quoting a passage — ui-specs/007, and now its own switch.
 *
 * `fromAnswer` is 007's shipped behaviour given the key it never had: an action
 * that predates rule 11 is not exempt from it, it is simply late.
 *
 * `fromDocs` is off because it paints a control on the HOST's prose. The reader
 * who selects a command in order to copy it is the case that decides this: a
 * button appearing over that selection on every docs page, on an upgrade nobody
 * read the notes for, is the behaviour that gets a dependency removed.
 */
export function resolveQuote(docPilot, err = console.error) {
  return flags(docPilot?.quote || {}, QUOTE_DEFAULTS, 'quote', err)
}

/**
 * What a citation is worth — ui-specs/009.
 *
 * `inCopy` is ON, and it is a correction rather than an addition: a copied answer
 * used to arrive wherever it was pasted carrying `[1]` with nothing behind it,
 * which looks like provenance and is not.
 *
 * `passage` is OFF. The source row is already a link, and this key adds a SECOND
 * layer of information on top of one — a chevron on every row of every answer,
 * opening the raw retrieved chunk inline. That is worth having where a project
 * wants checking a source to be a normal step of reading, and it is a decision
 * about how dense this panel is rather than a defect the package should fix on
 * everybody's behalf. The reader who wants the source still has the link.
 *
 * `pagesRead` is OFF: it is a second list on a surface that already carries one.
 */
export function resolveCitations(docPilot, err = console.error) {
  return flags(docPilot?.citations || {}, CITATIONS_DEFAULTS, 'citations', err)
}

/**
 * The composer's two keyboard-and-address affordances — ui-specs/009.
 *
 * Both ON and both inside the panel. `editLastOnArrowUp` is a port of ChatGPT's
 * own behaviour and of the readline convention older than it; `deepLink` fills
 * the composer and deliberately does not submit, so following a link costs
 * nobody a turn.
 */
export function resolveComposer(docPilot, err = console.error) {
  return flags(docPilot?.composer || {}, COMPOSER_DEFAULTS, 'composer', err)
}

/**
 * The scope picker, plus the two settings that make it usable on a real corpus.
 *
 * `scope.default` keeps its rejected value in the schema deliberately and is NOT
 * validated here: session.js reports and corrects it at `configure()` time, and
 * moving that would change where an author sees the complaint. This resolver
 * settles the two new keys and passes the three old ones through unharmed.
 */
export function resolveScope(docPilot, err = console.error) {
  const cfg = docPilot?.scope || {}
  return {
    enabled: flag(cfg.enabled, SCOPE_DEFAULTS.enabled, 'scope.enabled', err),
    default: cfg.default ?? SCOPE_DEFAULTS.default,
    promptListLimit: cfg.promptListLimit ?? SCOPE_DEFAULTS.promptListLimit,
    filter: pick(cfg.filter, SCOPE_FILTERS, SCOPE_DEFAULTS.filter, 'scope.filter', err),
    groupBySection: flag(
      cfg.groupBySection,
      SCOPE_DEFAULTS.groupBySection,
      'scope.groupBySection',
      err,
    ),
  }
}

/**
 * The reader's own conversations, and the one new thing you can do with them.
 *
 * `maxConversations` passes through: it is a number with a byte ceiling under it
 * in history.js, and that ceiling is deliberately not a setting.
 */
export function resolveHistory(docPilot, err = console.error) {
  const cfg = docPilot?.history || {}
  return {
    enabled: flag(cfg.enabled, HISTORY_DEFAULTS.enabled, 'history.enabled', err),
    maxConversations: cfg.maxConversations ?? HISTORY_DEFAULTS.maxConversations,
    exportThread: flag(
      cfg.exportThread,
      HISTORY_DEFAULTS.exportThread,
      'history.exportThread',
      err,
    ),
    /**
     * Whether an unfinished turn is written down when the page goes away —
     * ui-specs/012. ON, and not really a reader-visible action: it is the
     * difference between coming back to what was already streamed and coming
     * back to nothing. It obeys `enabled` above, which is the switch that means
     * "record nothing".
     */
    saveOnUnload: flag(
      cfg.saveOnUnload,
      HISTORY_DEFAULTS.saveOnUnload,
      'history.saveOnUnload',
      err,
    ),
  }
}

/**
 * The embedder as the BROWSER receives it — the third union on this list.
 *
 * `embed: false` — a site with no embedder at all, retrieving lexically by
 * declaration — was being swallowed by the spread that used to stand in for this
 * resolver. `{...DEFAULTS.embed, ...(cfg.embed || {})}` reads `false` as absent,
 * so the panel came up believing it embedded with `bge-m3`; `'none'` is a string
 * and spread character by character, which left four numbered keys on the config
 * beside the same wrong model. Both then took the OUTAGE path on every turn: an
 * embedding POSTed to the CHAT endpoint (`embedTarget` falls back to `llm` for
 * every field), a 404, a console line naming a service the author deliberately
 * declined to configure, and refusals stamped `degraded` — telling readers the
 * semantic index is unavailable on a site that never had one.
 *
 * `themeDocPilot` gets this right on its own, so the failure was invisible on a
 * generated config and certain on a hand-written one — which is exactly the shape
 * `docs/install/web.md` documents first for a non-VitePress mount, and what
 * `mount.js` hands to `configure` verbatim. A union has to be resolved on both
 * ends or it is only a union on one of them.
 *
 * The resolved shape is always the finished object, `lexicalOnly` included, so no
 * read downstream has to ask which form it was given.
 */
export function resolveEmbed(docPilot, report = console.error) {
  const raw = docPilot?.embed
  if (raw === false || raw === 'none') {
    return {...EMBED_DEFAULTS, model: null, lexicalOnly: true}
  }

  // `'auto'` is the Node-side spelling for "follow the chat provider", and it is
  // resolved to a target long before the browser sees it. Arriving here it means
  // a hand-written themeConfig copied the settings key rather than the emitted
  // one, and the shipped defaults are the honest reading: same service as chat,
  // which is what `embedTarget`'s null fallbacks already do.
  const object = raw != null && raw !== 'auto' && !Array.isArray(raw) && typeof raw === 'object'
  if (raw != null && raw !== 'auto' && !object) {
    report(
      `[docpilot] embed accepts false, 'auto' or an object of settings — ` +
        `got ${typeof raw}, using the shipped embedder`,
    )
    return {...EMBED_DEFAULTS}
  }

  const cfg = object ? raw : {}
  // `themeDocPilot` emits the RESOLVED object, `lexicalOnly: true` and three
  // nulls, so the flag has to survive this arm — the generated config is the one
  // that must not need the settings spelling to be understood. What cannot
  // survive it is the flag beside an embedder: that config says both things at
  // once, and reading it either way silently is how a site ends up in a mode its
  // own file contradicts. The named half wins, because it is the half somebody
  // typed on purpose.
  const named = cfg.provider != null || cfg.model != null
  if (cfg.lexicalOnly === true && named) {
    report(
      `[docpilot] embed.lexicalOnly is set beside ${cfg.provider ? `provider "${cfg.provider}"` : `model "${cfg.model}"`} — ` +
        'a deployment either has an embedder or declares it has none. Using the embedder; ' +
        'write `embed: false` for lexical-only retrieval.',
    )
  }
  return {
    ...EMBED_DEFAULTS,
    ...cfg,
    lexicalOnly: cfg.lexicalOnly === true && !named,
  }
}

/**
 * How many REQUESTS a turn may spend, and what the panel says when they run out.
 *
 * OpenRouter's free tier caps at 50 REQUESTS a day — not tokens — while the free
 * models behind it publish 128k-512k context windows, so the scarce resource was
 * never the one this package was economising. A turn as it shipped costs three
 * or four requests: the `detectTools` probe on page load, up to `maxIterations`
 * loop calls, and the forced final call. That is roughly fourteen questions,
 * after which every answer is "The AI service didn't respond." — a sentence that
 * is true and useless, because the service did respond, and what it said was
 * that this site is out of free answers until a stated time tomorrow.
 *
 * `mode: 'auto'` is the whole of the design, and the reason a block this
 * invasive is safe to ship on. It changes nothing until the budget is one this
 * package can DEFEND, which is two questions rather than one: a daily allowance
 * has to exist to be rationed — the site declared `dailyLimit`, or the answering
 * half runs on a provider's own free pool — and the number describing it has to
 * BE daily, which a header count is trusted to be only when its reset is at
 * least ten minutes out. A funded key on a metered provider, a `chat.models`
 * list the author wrote themselves, and a gateway counting per MINUTE all fail
 * that test and leave the turn fully agentic, so nobody paying per token gets
 * their answers quietly shortened by a guess about scarcity. `budget.js` owns
 * the predicate; this file owns the numbers it reads.
 *
 * `showRemaining` is OFF, and it is the one member of the second tier that does
 * not follow that tier's rule. The line is inside this package's own panel, so
 * the tier says ON; what the tier cannot see is that the NUMBER is not the
 * reader's. On a public documentation site every reader draws on one key, so a
 * browser's own count is a lower bound on somebody else's spending — "35 of 50
 * left" is stated with an authority the arithmetic behind it does not have.
 * `docs/guide/free-tier.md` has said this since it was written. A project that
 * knows its key is not shared turns it on and gets the count, plus the note that
 * this deployment has no embedder where that is true — one muted line about what
 * the next question is limited to, offered rather than imposed.
 *
 * Either way it renders only where there is something to state: a known snapshot,
 * on a target that is actually metered by the same definition the ceiling is
 * seeded from, or a declared `embed: false`.
 *
 * `probe` is a setting because the `detectTools` call costs a request on every
 * page load, before the reader has asked anything, and on a 50-request day that
 * is the single most expensive habit here. `'auto'` skips it where the answer is
 * already known — a pooled provider's members are tool-capable by construction —
 * and `'always'` keeps the behaviour that shipped.
 *
 * WHY `probe`, `rotateAbove` and `maxContinuations` LIVE HERE rather than beside
 * `chat.models` and `chat.maxTokens`, which is where a strict reading of the
 * subject rule at the top of this file would file them: their subject IS this
 * one. Not one of them is a fact about the model — `probe` is a request made
 * before the reader has read a word, `rotateAbove` decides whether a second
 * model is worth a request, `maxContinuations` decides whether finishing this
 * answer is worth one. What they have in common is the only thing an author
 * looking for them will have in mind: they are the knobs a site turns when
 * REQUESTS are scarce. Scattering one cost-control feature across three groups
 * makes it three features nobody can find, and that is the worse failure of the
 * two — the author who has run out of free answers goes looking for one block,
 * and the whole of the answer had better be in it.
 *
 * A UNION, on the terms `suggestions` and `ui.fabLabel` already set: `budget:
 * false` is the block off in one word, for a project on a paid key that wants
 * back exactly what it had before this landed — agentic every turn, no line in
 * the panel, the probe unconditional, AND BOTH THRESHOLDS RETIRED. The
 * thresholds are the half this got wrong first time round: `mode: 'agentic'`
 * stops the turn being shortened, but `budgetPlan` reads `rotateAbove` whatever
 * the mode is, so a block that had been switched off still stopped the pool
 * rotating at six answers left — a rationing rule kept by the deployment that
 * deleted it, which is the same defect as rationing a paid key. `-1` is how they
 * are retired; see `threshold`. `maxContinuations` alone keeps its shipped
 * value, because repairing a reply the provider truncated mid-sentence is a
 * defect fix on any tier rather than a rationing measure. The RESOLVED shape is
 * always the finished object, so nothing downstream has to ask which form it was
 * given.
 */
export function resolveBudget(docPilot, report = console.error) {
  const raw = docPilot?.budget
  if (raw === false) {
    return {
      ...BUDGET_DEFAULTS,
      mode: 'agentic',
      oneShotBelow: BUDGET_NEVER,
      rotateAbove: BUDGET_NEVER,
      showRemaining: false,
      probe: 'always',
    }
  }

  const object = raw != null && !Array.isArray(raw) && typeof raw === 'object'
  if (raw != null && !object) {
    report(
      `[docpilot] budget accepts false or an object of settings — ` +
        `got ${typeof raw}, using the shipped budget`,
    )
    return { ...BUDGET_DEFAULTS }
  }

  const cfg = object ? raw : {}
  return {
    mode: pick(cfg.mode, BUDGET_MODES, BUDGET_DEFAULTS.mode, 'budget.mode', report),
    oneShotBelow: threshold(
      cfg.oneShotBelow,
      BUDGET_DEFAULTS.oneShotBelow,
      'budget.oneShotBelow',
      report,
    ),
    rotateAbove: threshold(
      cfg.rotateAbove,
      BUDGET_DEFAULTS.rotateAbove,
      'budget.rotateAbove',
      report,
    ),
    maxContinuations: bounded(
      cfg.maxContinuations,
      MAX_CONTINUATIONS,
      BUDGET_DEFAULTS.maxContinuations,
      'budget.maxContinuations',
      report,
    ),
    showRemaining: flag(
      cfg.showRemaining,
      BUDGET_DEFAULTS.showRemaining,
      'budget.showRemaining',
      report,
    ),
    probe: pick(cfg.probe, BUDGET_PROBES, BUDGET_DEFAULTS.probe, 'budget.probe', report),
    // Null is a VALUE here and not an omission — "count nothing locally, wait
    // for a header to say what the ceiling is". `allowance` returns the fallback
    // for both, and the fallback is null, so the two agree by construction.
    dailyLimit: allowance(cfg.dailyLimit, BUDGET_DEFAULTS.dailyLimit, 'budget.dailyLimit', report),
  }
}

/**
 * How many chips the empty state can hold — three by default, five at most.
 *
 * A CEILING, NOT A COUNT. The author writes three, four or five and the panel
 * shows what is written; `DEFAULT_SUGGESTIONS` stays three, so a project that
 * configured none pays exactly what it paid before — three embeddings and,
 * with `answers` on, three model calls per hash move.
 *
 * FIVE BECAUSE THE LAYOUT SAYS FIVE. `.docpilot__empty` is a `flex: 1` column
 * whose greeting takes the free space on `margin-block: auto` while the rows
 * stay anchored above the composer (core.scss:665-676). Five rows of 32px with
 * an 8px gap is the most the greeting can give up before it stops being
 * centred and starts being pushed.
 *
 * A `suggestions.limit` KEY WAS THE OTHER CANDIDATE AND IS WORSE. `questions`
 * already states the count — its length — so a limit beside it can only ever
 * disagree with its own input. The one behaviour it would add that the array
 * cannot is "configure five, show three", which is a config that lies about
 * itself. It would also cost a leaf in `DEFAULTS`, a line in the resolver, the
 * pre-configure copy in session.js, a declaration in types/config.d.ts and
 * four rule-11 checks, two of which EXECUTE the documented default — for a
 * number the author states by typing questions.
 *
 * EXPORTED, and that is the fix rather than the decoration. `DocPilot.vue` held
 * its own literal `3`, so the warning an author read and the list a reader saw
 * were free to disagree and nothing was watching. One constant, two readers.
 */
export const SUGGESTION_LIMIT = 5

/**
 * What an empty panel offers, and what a settled answer offers after it.
 *
 * A UNION, not a replacement. `suggestions` shipped as `string[]` and a bare
 * array must keep working, so an array means `{questions: [...]}` with the
 * behavioural defaults. `ui.fabLabel` already establishes the union precedent in
 * this config — `true | false | string` — and the rule both follow is the same:
 * the RESOLVED shape is always the finished object, so nothing downstream has to
 * ask which form it was given.
 *
 * `scoped` replaces a blank panel under a narrow scope. Today `suggestions`
 * returns `[]` the moment the scope is not `all`, for a reason that is correct —
 * the built-in three would fall outside it and the gate would refuse all of
 * them — and with a result that is not: the reader who narrowed the scope, who
 * expressed intent more precisely than usual, is the one shown nothing. What
 * goes there instead is the pages IN the scope, as rows. It generates no text.
 *
 * `followUps` is OFF, and this is the one default in the file decided by a
 * measurement outside this repository: ChatGPT ships follow-up suggestions and
 * its users write custom instructions to suppress them. Copy that ships on has
 * to be good for every corpus; copy that is opted into only has to be good
 * enough for the project that opted in.
 */
export function resolveSuggestions(docPilot, warn = console.warn) {
  const raw = docPilot?.suggestions
  const object = raw != null && !Array.isArray(raw) && typeof raw === 'object'
  if (raw != null && !Array.isArray(raw) && !object) {
    warn(
      `[docpilot] suggestions must be an array of strings or an object — ` +
        `got ${typeof raw}, using the built-in three`,
    )
    return { ...SUGGESTIONS_DEFAULTS }
  }

  const list = object ? raw.questions : raw
  return {
    questions: questionsOf(list, warn),
    scoped: flag(object ? raw.scoped : null, SUGGESTIONS_DEFAULTS.scoped, 'suggestions.scoped', warn),
    followUps: flag(
      object ? raw.followUps : null,
      SUGGESTIONS_DEFAULTS.followUps,
      'suggestions.followUps',
      warn,
    ),
    /**
     * Whether `docpilot index` resolves these questions ahead of time, and
     * whether the panel uses what it resolved — engine-specs/009, ui-specs/013.
     *
     * ONE key for both halves, and that is the point: a bake nobody reads is
     * build-time requests spent on a file that ships and does nothing, and a
     * reader with no bake to read is the behaviour that already exists. Off, the
     * feature is absent in both directions rather than half-present.
     */
    precomputed: flag(
      object ? raw.precomputed : null,
      SUGGESTIONS_DEFAULTS.precomputed,
      'suggestions.precomputed',
      warn,
    ),
    /**
     * Whether the bake includes the ANSWER as well as the evidence.
     *
     * The expensive half at build time — one model call per question, against
     * the same allowance the readers draw on — and the only half that can go
     * stale in a way the index hash does not catch, because it is prose about
     * chunks rather than the chunks. Off leaves the evidence bake intact: the
     * click still costs no embedding, the model still writes the answer, and it
     * still writes it in the reader's language.
     */
    answers: flag(
      object ? raw.answers : null,
      SUGGESTIONS_DEFAULTS.answers,
      'suggestions.answers',
      warn,
    ),
    /**
     * How close a typed question has to be to a baked one to count as it.
     *
     * `false` retires the paraphrase test and leaves exact matching, which is
     * the setting for a corpus where two openers are near-neighbours and the
     * build said so. The default is PROVISIONAL until measured against
     * `docpilot/calibration.jsonl` — see the `faq` mode in the docs-rag skill.
     */
    matchTau: fraction(
      object ? raw.matchTau : null,
      MATCH_NEVER,
      SUGGESTIONS_DEFAULTS.matchTau,
      'suggestions.matchTau',
      warn,
    ),
  }
}

/** The array half, unchanged from the day it shipped apart from where it lives. */
function questionsOf(raw, warn) {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    warn(
      `[docpilot] suggestions.questions must be an array of strings, got ${typeof raw} — ` +
        `using the built-in three`,
    )
    return []
  }

  const clean = []
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'string') {
      warn(`[docpilot] suggestions[${i}] is ${typeof entry}, not a string — dropped`)
      continue
    }
    const q = entry.trim().replace(/\s+/g, ' ')
    if (!q) {
      warn(`[docpilot] suggestions[${i}] is empty — dropped`)
      continue
    }
    if (clean.includes(q)) {
      warn(`[docpilot] suggestions[${i}] repeats an earlier one — dropped`)
      continue
    }
    clean.push(q)
  }

  // No silent cap. The component slices at the same constant now; saying so
  // here is the difference between a design decision and a bug the author
  // cannot see.
  if (clean.length > SUGGESTION_LIMIT) {
    warn(
      `[docpilot] ${clean.length} suggestions configured, ${SUGGESTION_LIMIT} shown — ` +
        `dropping: ${clean.slice(SUGGESTION_LIMIT).map((q) => `"${q}"`).join(', ')}`,
    )
  }
  return clean.slice(0, SUGGESTION_LIMIT)
}
