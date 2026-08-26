/**
 * Drawer state and the turn lifecycle.
 *
 * One module-level store, shared by the trigger, the CTA and the drawer, so the
 * panel survives route changes with its thread intact.
 */

import { reactive, computed } from 'vue'
import { loadIndex } from './store.js'
import { createRetrieval } from './retriever.js'
import { embedQuery } from './embed.js'
import { runTurn } from './harness.js'
import { detectTools } from './llm.js'
import { renderAnswer } from './markdown.js'
import { ensureHighlighter, onReady } from './highlight.js'
import * as scopeApi from './scope.js'
import * as instruction from './prompt-store.js'
import * as feedback from './feedback.js'
import { history } from './history.js'
import { promptHash, detectLanguage, localeOf, clampQuote } from './prompt.js'
import { redactSecrets } from './credentials.js'
import { detectSocial } from './social.js'
import { resolveI18n, t, normaliseLocale } from './i18n.js'
import { hostConfig } from './host.js'
import { resolveUi } from './ui.js'
// ui-specs/009 — rule 11's resolvers. Re-run here for the same reason `ui` is:
// `configure` also receives the `{enabled: false}` payload, which never met
// `themeDocPilot` and therefore carries none of these blocks at all.
import {
  resolveQuote,
  resolveCitations,
  resolveComposer,
  resolveScope,
  resolveHistory,
  resolveSuggestions,
  resolveBudget,
  resolveEmbed,
  EMBED_DEFAULTS,
} from './switches.js'
import { createBudget, budgetPlan, FREE_TIER_DAILY } from './budget.js'

/**
 * The archive, and the seam the suite replaces it through.
 *
 * Held in a binding rather than imported into every call site so that a test can
 * hand the store a pair of Map-backed fakes — the same shape as
 * `__setHighlighterForTests`, and for the same reason: node has no localStorage.
 */
let store = history

/** Test seam. Pass nothing to put the browser's own instance back. */
export function __setHistoryForTests(instance) {
  store = instance || history
}

/**
 * The host named in an imported page's source row. Written here rather than
 * imported from `src/build/lib/sources.js`: that module is the BUILD's gate and
 * the theme must not depend on the build tree. The origin reaching this point
 * has already passed the allowlist at index time, so this is presentation only
 * and a malformed value degrades to no suffix rather than throwing mid-render.
 */
const originHost = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const DEFAULTS = {
  enabled: true,
  // `apiKey` exists for a self-hosted endpoint on a private network. It must
  // stay null in any public build: themeConfig is compiled into the client
  // bundle, so a key written here is a key published. In production the panel
  // calls a same-origin path and the proxy attaches the credential.
  llm: {
    provider: 'ollama',
    baseURL: 'http://localhost:11434',
    model: 'qwen3:8b',
    apiKey: null,
    temperature: 0.2,
    maxTokens: 2048,
    // Ollama's server default context is 4096 tokens, and a primed turn plus one
    // tool call already exceeds it — past that llama.cpp shifts the window and
    // drops the system block off the front, which surfaces as an unexplained
    // refusal. Sent only on the ollama transport; hosted providers size their
    // own context and ignore it.
    numCtx: 8192,
    // The three facts `themeDocPilot` carries across from the provider table,
    // named here for the configs that never met it: a hand-written themeConfig
    // and the `{enabled: false}` payload. `extraBody` is a body fragment the
    // adapter merges without reading; `rateLimited` says the service publishes
    // limits; `freePool` says this deployment answers off the provider's own
    // free catalogue, which is the only thing that makes a daily REQUEST ceiling
    // real and the only one of the three the budget is allowed to ration on.
    // Absent, all three resolve to the same "nothing brand-specific, nothing
    // metered" that every provider but OpenRouter emits.
    extraBody: null,
    rateLimited: false,
    freePool: false,
  },
  // Configured separately from `llm` on purpose: Anthropic has no embeddings
  // endpoint, so the two halves must be able to point at different services.
  // `baseURL: null` means "same as llm.baseURL".
  //
  // `lexicalOnly` is the third form of the settings union — a deployment with no
  // embedder at all — and it is spelled out here rather than left to arrive from
  // the build so that the reads below are a boolean question on every config,
  // including a hand-written themeConfig and the `{enabled: false}` payload that
  // never met `themeDocPilot`.
  //
  // The RESOLVED shape, equal to `resolveEmbed({})`, on the terms `budget` states
  // below: `configure` resolves the union rather than spreading it.
  embed: { ...EMBED_DEFAULTS },
  /**
   * null means "whatever this corpus measured", which is the only honest default.
   *
   * This key was documented from the first release and read by nothing — the
   * gate's k has always been the `GATE_K` literal in retriever.js — so the two
   * numbers here and in config.js (5 and 12) were never in force and never
   * agreed with each other either. `tuning` below is what reads it now: a number
   * is the author overriding the measured GATE_K by hand, null lets
   * `docpilot tune`'s value through, and null with no tuning in the manifest is
   * the module literal, which is what every build shipped up to here.
   */
  topK: null,
  // See config.mjs: the host primes the turn with the gate's own excerpts, and
  // every observation is re-sent on every step, so iterations 3 and 4 mostly
  // paid to repeat evidence the model already had.
  maxIterations: 2,
  // The day's requests, and what to do as they run out — the RESOLVED shape,
  // equal to `resolveBudget({})`, on the terms `ui` states below. It sits here
  // rather than beside the other 009 blocks because its first effect is on the
  // line above it: one-shot mode is `maxIterations` driven to 0 for the turn.
  budget: {
    mode: 'auto',
    oneShotBelow: 15,
    rotateAbove: 6,
    maxContinuations: 1,
    showRemaining: false,
    probe: 'auto',
    dailyLimit: null,
  },
  // The RESOLVED shapes, never the settings ones — the rule `ui` below already
  // states. Each is equal to its resolver called with `{}`, and the suite says
  // so, which is what makes these safe to run on before `configure` lands.
  suggestions: { questions: [], scoped: true, followUps: false },
  quote: { fromAnswer: true, fromDocs: false },
  citations: { passage: false, inCopy: true, pagesRead: false },
  composer: { editLastOnArrowUp: true, deepLink: true },
  // The product this documentation is about. Null renders as "this
  // documentation" everywhere it appears — in the instruction, in the composer
  // placeholder, in the assistant's own introduction.
  product: null,
  feedbackEndpoint: null,
  // WHICH votes leave the device, and whether the reader may write a sentence.
  // The RESOLVED shape — equal to `resolveFeedback({})` by construction, like
  // `ui` below.
  feedback: { send: 'both', comment: true, confirm: true },
  // The configured DELTA only — the shipped tree lives in i18n.js and is looked
  // up behind it, so a project that overrides nothing ships no extra bytes.
  i18n: { translations: {}, locales: {} },
  guard: { mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3 },
  scope: { enabled: true, default: 'all', promptListLimit: 12, filter: 'auto', groupBySection: true },
  // The reader's own conversations, on their device. Off means "do not record
  // AND clear what is there" — see `configure` below.
  history: { enabled: true, maxConversations: 20, exportThread: true },
  // `override` / `extend` are the BUILD-TIME instruction text from
  // the consumer's `docPilot` settings — a different thing from `allowAppend`, which is the
  // reader's own per-session addendum and never reaches the system message.
  prompt: { show: true, allowAppend: false, appendMaxChars: 500, override: null, extend: '' },
  // The RESOLVED shape, never the settings one: `panel: 'auto'` must not be
  // reachable from here. Equal to `resolveUi({})` by construction, and the
  // suite says so — this is what the panel runs on before `configure` lands.
  ui: {
    trigger: 'nav',
    panel: 'drawer',
    showNavTrigger: true,
    showFab: false,
    fabLabel: true,
    fabIcon: true,
    layout: 'overlay',
    prefetch: 'hover',
    firstRunHint: false,
  },
  // All null, and they stay null here: "nobody said" is a distinct answer from
  // any value, and it is what lets the host binding supply one. `hostConfig()`
  // resolves the three layers; nothing reads these directly.
  host: { base: null, ragBase: null, article: null, search: null, content: null },
}

export const state = reactive({
  open: false,
  ready: false,
  degraded: false,
  degradedReason: '',
  index: null,
  config: DEFAULTS,
  scope: { ...scopeApi.ALL },
  turns: [],
  // Which stored conversation `turns` IS, null until it has earned a row, plus
  // the switcher's own list — rows only, no turns.
  conversationId: null,
  // The docs were rebuilt since this conversation was written. It still renders;
  // some of its citation rows may now point at pages that no longer exist.
  conversationStale: false,
  history: [],
  status: null, // { phase, label }
  busy: false,
  dockPanel: null, // 'picker' | 'prompt' | 'history' | null
  instruction: '',
  announce: '',
  // ui-specs/009 — a question and a scope handed in from outside the panel: a
  // `?dp-ask=` link, or a passage quoted in the host's own article. Both are
  // drained by whichever surface owns the field they land in, and both are
  // deliberately NOT submitted on arrival.
  pendingQuestion: '',
  pendingQuote: '',
  pendingScope: null,
  currentPath: '/',
  // The page's locale, pushed in by the component. Drives every panel string;
  // the reply copies key off the language the reader typed instead.
  lang: 'en',
  retrieval: 'hybrid',
  // Why the dense channel is missing, when it is. Read by the refusal copy so a
  // degraded search is never reported as an absent answer.
  retrievalError: '',
  fallback: false,
  // What the provider last said about the day's requests, or null while nothing
  // has been learned — `{limit, remaining, defensibleRemaining, resetAt, source,
  // spentLocal}` from budget.js. `remaining` is the number the panel prints and
  // `defensibleRemaining` the one a plan is built on; they differ only where a
  // header count carried no window anybody stated, which budget.js demotes to
  // the display rather than discarding. Null is the honest answer for every
  // provider that publishes no rate-limit headers, and the panel shows nothing
  // rather than a guess.
  budget: null,
  // What the NEXT turn will do about it: 'agentic' or 'one-shot'. Kept beside
  // the snapshot rather than derived in the component because the plan is a
  // decision, taken in one place, and a second reading of `budgetPlan` in the
  // template would be a second place for the thresholds to be applied.
  budgetMode: 'agentic',
  debug: false,
})

let controller = null
let sessionId = null
let budget = null

function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The day's requests, counted once for the page.
 *
 * OpenRouter's free tier caps at 50 REQUESTS a day rather than at tokens, and
 * that count belongs to the DAY, not to the tab: a reader who asks four
 * questions, follows a link and asks four more has spent eight. It is therefore
 * backed by localStorage, which budget.js resolves per call rather than at
 * import — this module is loaded during VitePress's SSR pass, where naming
 * `localStorage` at all is a ReferenceError, and that is why no storage is
 * passed here.
 *
 * Created for every provider, not only the metered ones. An endpoint that sends
 * no rate-limit headers never teaches it anything, its snapshot stays unknown,
 * and every plan built from an unknown budget is the agentic turn that shipped —
 * so nobody paying per token has their answers shortened by a guess.
 */
function ensureBudget() {
  if (budget) return budget
  budget = createBudget({
    // A ceiling the project wrote down wins. Failing that, a deployment on the
    // provider's own FREE POOL gets the published free-tier number, so the
    // requests spent before any response carries a header are still counted
    // against something. Every other deployment counts against nothing and stays
    // unknown — including a funded key on the same metered provider, which was
    // the reading that dropped a paying site to one request per turn after 35
    // questions. `freePool`, never `rateLimited`: the second says the service
    // publishes limits, which is a different sentence.
    dailyLimit:
      state.config.budget.dailyLimit ?? (state.config.llm.freePool ? FREE_TIER_DAILY : null),
  })
  refreshBudget()
  return budget
}

/**
 * What a plan is decided on: the author's `budget` block, plus the one fact
 * about the TARGET that the block cannot carry.
 *
 * `freePool` is not a setting and must never become one — `resolveBudget` would
 * drop it on the browser's second pass, and an author who could write it could
 * declare a free tier they are not on. So it is merged on the way IN to
 * `budgetPlan`, which refuses to ration a remaining count it cannot defend and
 * takes this as half of what defends one.
 *
 * TWO PLACES MAKE A PLAN, and this is only one of them: the other is
 * `runTurn`, which merges the same two things for the turn it is about to run.
 * It cannot call this — the harness is handed a config, never the store, and an
 * import back into here would be a cycle — so the pair is kept honest by saying
 * so in both files rather than by sharing a line.
 */
function planSettings() {
  return { ...state.config.budget, freePool: state.config.llm.freePool === true }
}

/** The snapshot the panel renders, and the plan the next turn will run under. */
function refreshBudget() {
  if (!budget) return
  const snapshot = budget.snapshot()
  // A budget nobody has taught anything is not a budget: "? of ? answers left"
  // is worse than no line at all, so the panel is given one only once a count
  // exists — learned from a header, or from a ceiling the project stated.
  state.budget = Number.isFinite(snapshot?.remaining) ? snapshot : null
  state.budgetMode = budgetPlan(snapshot, planSettings()).mode
}

export function configure(themeConfig, path, lang) {
  const cfg = themeConfig?.docPilot || {}
  state.config = {
    ...DEFAULTS,
    ...cfg,
    llm: { ...DEFAULTS.llm, ...(cfg.llm || {}) },
    // Resolved, not spread — `embed` is a union on the same terms as `budget`
    // below, and a spread reads `embed: false` as an absent key. See
    // `resolveEmbed` for what that cost.
    embed: resolveEmbed(cfg),
    guard: { ...DEFAULTS.guard, ...(cfg.guard || {}) },
    // Resolved, not spread — ui-specs/009. Same terms as `ui` and `feedback`
    // below: idempotent, so this is a no-op on a normal build, and the thing
    // that earns its place on a hand-written themeConfig or the disabled payload.
    scope: resolveScope(cfg),
    history: resolveHistory(cfg),
    quote: resolveQuote(cfg),
    citations: resolveCitations(cfg),
    composer: resolveComposer(cfg),
    // A UNION at the settings end and always the finished object here, so the
    // component never has to ask which form it was handed.
    suggestions: resolveSuggestions(cfg),
    // The other union — `budget: false` is the whole block off in one word —
    // and resolved here for the same reason `ui` is: this call also receives the
    // `{enabled: false}` payload, which never met `themeDocPilot` and carries no
    // budget block at all.
    budget: resolveBudget(cfg),
    prompt: { ...DEFAULTS.prompt, ...(cfg.prompt || {}) },
    // Resolved, not spread. `themeDocPilot` already emits a finished structure, so
    // this call is a no-op on a normal build; it earns its place on the
    // `{enabled: false}` payload, which carries no `ui`, and on a themeConfig
    // written by hand. A spread would let a half-filled object through.
    ui: resolveUi(cfg),
    // Merged like `llm` and `guard` rather than resolved: the three-layer
    // resolution that gives these values meaning needs the host BINDING, which
    // only exists in the browser, so `hostConfig()` does it at each read.
    host: { ...DEFAULTS.host, ...(cfg.host || {}) },
    // Same terms as `ui`: idempotent, so re-resolving what the build already
    // resolved changes nothing, and a hand-written themeConfig with a typo in
    // `send` gets the default rather than an endpoint that never fires.
    feedback: feedback.resolveFeedback(cfg),
  }
  // scope.default keeps a rejected value in the schema deliberately: a build-time
  // default of `page` would silently narrow every reader's first question.
  if (state.config.scope.default !== 'all') {
    // eslint-disable-next-line no-console
    console.error('[docpilot] scope.default only accepts "all"; ignoring', state.config.scope.default)
    state.config.scope.default = 'all'
  }
  // RAG-SPEC 4.9: hiding the disclosure also drops any instruction already in
  // sessionStorage — text the reader can no longer see must not keep riding
  // along with the question.
  if (!state.config.prompt.show) {
    state.config.prompt.allowAppend = false
    instruction.clear()
    state.instruction = ''
  }
  if (!state.config.prompt.appendMaxChars) state.config.prompt.allowAppend = false
  // The same rule as prompt.show directly above, applied to a store that
  // OUTLIVES the tab: a feature the reader can no longer see must not keep their
  // questions on their machine, so switching it off is also an erasure.
  if (!state.config.history.enabled) store.clear()
  else store.setLimits({ conversations: state.config.history.maxConversations })
  if (path) state.currentPath = path
  if (lang) state.lang = lang
  sessionId = sessionId || newId('s')
  // After the config is settled, because both the ceiling and the plan come out
  // of it — and before the first question, because a budget carried over from
  // this morning is a line the panel can show while the composer is still empty.
  ensureBudget()
  if (typeof window !== 'undefined') {
    state.debug = new URLSearchParams(location.search).has('dpdebug')
    feedback.installConsoleHelper()
  }
}

/**
 * Where the query embedding is fetched from.
 *
 * Defaults fall through to the chat target, so a single-service setup — which
 * is every OpenAI-compatible one — configures nothing here. A split setup
 * (Claude answers, something else retrieves) overrides only what differs.
 */
function embedTarget(cfg) {
  return {
    provider: cfg.embed.provider || cfg.llm.provider,
    baseURL: cfg.embed.baseURL || cfg.llm.baseURL,
    // THE INDEX NAMES THE MODEL when the config did not. A provider whose free
    // tier is a pool leaves `embed.model` null on purpose — which member was
    // reachable is a fact about the build, not about the settings — and the
    // manifest is where the build wrote it down. Reading it here is what makes
    // the query vector land in the same space as the chunks.
    model: cfg.embed.model || state.index?.manifest.embedModel || null,
    apiKey: cfg.embed.apiKey ?? cfg.llm.apiKey,
  }
}

/**
 * A query vector, and what it costs the day.
 *
 * OpenRouter serves both halves of a hybrid turn off ONE key, so on the free
 * tier an embedding is a request out of the same fifty as the answer — two of
 * them on a follow-up, which is most of what the loop itself was cut down to
 * spend. Nothing counted them, so the panel stated a number the service
 * disagreed with and every plan was made against a budget already thinner than
 * the ledger believed.
 *
 * Charged ONLY when both halves point at the same service. `embed.provider` and
 * `embed.baseURL` exist precisely so they need not — Anthropic has no
 * embeddings endpoint, and a local Ollama beside a hosted chat model is the
 * ordinary shape — and that deployment draws on a different allowance
 * altogether. Charging it would shorten answers to pay for requests the metered
 * account never received, which is the same class of mistake as rationing a
 * funded key.
 *
 * Only a call that came back is charged, and this deliberately undercounts
 * rather than over. A throw here is as often a connection that never reached the
 * service — an embedder that is down, or a reader who pressed stop — as it is a
 * refusal the service counted, and the retries inside embed.js are invisible
 * from out here. A local count is a floor in any case: the service's own header,
 * which the chat half reads on every response, always wins over it.
 */
async function embed(text, cfg, signal) {
  const target = embedTarget(cfg)
  const vec = await embedQuery(text, { ...target, signal })
  if (target.provider === cfg.llm.provider && target.baseURL === cfg.llm.baseURL)
    ensureBudget().spend(1)
  return vec
}

/**
 * The index records which model built it; until now nothing compared that to
 * the model the browser embeds with.
 *
 * The retriever's only check is vector WIDTH, so two different models of the
 * same width — 1536 is a popular number — would score a query against a foreign
 * vector space: cosines become noise, and the gate quietly refuses good
 * questions with no error anywhere. Names differing is a configuration mistake,
 * so say so once, loudly, and drop to the lexical mode the spec already defines
 * rather than pretending the numbers mean something.
 */
function embedderMatchesIndex() {
  // Nothing to disagree. A vectorless index names no model and a declared
  // lexical-only config names none either, so the comparison below would come
  // back true anyway — but only by two nulls happening to meet, and a
  // hand-written themeConfig that leaves `embed.model` at its default puts a
  // name back on one side. Whether the mode was CHOSEN must not turn on that.
  if (state.config.embed.lexicalOnly) return true
  const built = state.index?.manifest.embedModel
  // The CONFIGURED model, not the resolved one: when the config names nothing,
  // `embedTarget` takes the manifest's name and the two agree by construction.
  // Comparing the resolved value would be comparing the manifest with itself.
  const live = state.config.embed.model
  if (!built || !live || built === live) return true
  // eslint-disable-next-line no-console
  console.error(
    `[docpilot] index was built with "${built}" but this build embeds with "${live}" — ` +
      'retrieval is running lexical-only. Rebuild the index (npx docpilot index) or fix embed.model.',
  )
  return false
}

/**
 * The routes a link in the answer may point at.
 *
 * An EXTERNAL page is deliberately absent: its `path` is an id for a page that
 * exists only in the corpus, so a model link to it would render as an anchor to
 * a 404. `renderAnswer` de-links what is not here, which is exactly the right
 * outcome — the reader still reads the sentence, and the only live link to that
 * material is its source row, which points at the origin.
 */
export const knownPaths = computed(
  () =>
    new Set((state.index?.manifest.pages || []).filter((p) => !p.external).map((p) => p.path)),
)

export const guard = computed(() => {
  const m = state.index?.manifest.guard || {}
  const c = state.config.guard
  return {
    ...m,
    tau: c.tau ?? m.tau,
    tauLexical: c.tauLexical ?? m.tauLexical,
    source: c.tau != null || c.tauLexical != null ? 'config' : m.source,
  }
})

/**
 * The retrieval levers this instance runs on — the guard's shape, one layer down.
 *
 * `guard` above resolves thresholds; this resolves the ranking constants, on the
 * same rule and for the same reason: what the corpus MEASURED beats what our
 * corpus measured, and what the author WROTE beats both. The manifest half
 * arrives from `docpilot tune` through `tuningFor`; the author half is `topK`,
 * which is `GATE_K` under its documented name — the number of excerpts the gate
 * hands the model, and the k every retrieval metric in the eval is measured at.
 *
 * null here is not "no opinion by accident": `resolveLevers(null)` in the
 * retriever resolves every name to its module literal, so an untuned site keeps
 * the values that shipped. The env layer is deliberately absent — a DOCPILOT_*
 * variable is a sweep running on somebody's shell, and it is read in the
 * retriever, never here, because nothing set in a shell may ship. In the browser
 * there is no `process` to read, so that layer cannot exist at all.
 */
export const tuning = computed(() => {
  const m = state.index?.manifest.tuning || null
  const k = state.config.topK
  if (typeof k !== 'number' || !Number.isFinite(k)) return m
  return {
    ...m,
    // 1..12 is the swept band. Below 1 the gate returns nothing and the model
    // answers from the question alone; above 12 the excerpts stop fitting the
    // context a small model has for them, and `FUSED` is 12 anyway, so a larger
    // k asks the fusion for candidates it never produced. Rounded because
    // `slice(0, 2.5)` is a k of 2 that the debug line would report as 2.5.
    GATE_K: Math.min(12, Math.max(1, Math.round(k))),
    source: 'config',
  }
})

/**
 * The scope as the READER sees it, which is not the scope the MODEL sees.
 *
 * `state.scope.label` is generated by scope.js and travels into the harness's
 * observations, so it is part of the model's input and stays in one language.
 * This is the display name for the same thing, and the only one that is
 * translated. A page or section keeps its own title — that title is corpus text
 * and translating it would name a page that does not exist.
 */
export const scopeLabel = computed(() => {
  const sc = state.scope
  if (!sc || sc.kind === 'all' || !sc.paths.length) return T('scope.all')
  if (sc.kind === 'page' || sc.kind === 'section') return sc.label
  return T('scope.nPages', { n: sc.paths.length })
})

export const offersSection = computed(
  () => !!state.index && scopeApi.offersSection(state.currentPath, state.index.manifest),
)

export const currentPathIndexed = computed(() => knownPaths.value.has(state.currentPath))

function say(message) {
  state.announce = message
}

/**
 * The panel's own strings, from inside a module with no component instance.
 *
 * `useHost()` is unreachable here, so the page locale is pushed in by the
 * component (`configure`, then `setLang` on every route change) and kept in the
 * store. The chrome selector is that locale; the two REPLY copies below use the
 * language the reader typed instead — see i18n.js for why the two are not one.
 */
const tree = () => resolveI18n(state.config.i18n)
const T = (path, vars) => t(tree(), normaliseLocale(state.lang, tree()), path, vars)

/** A `reply.*` string: keyed by the typed language, with the page's as backup. */
const replyT = (locale, path, vars) =>
  t(tree(), locale, path, vars, normaliseLocale(state.lang, tree()))

/** Called on every route change: VitePress can switch locale without a reload. */
export function setLang(lang) {
  state.lang = lang || 'en'
}

/**
 * Is speculative bandwidth acceptable right now? — ui-specs/009.
 *
 * The index of a large corpus is real traffic, and a prefetch spends it on every
 * reader including the ones who never open the panel. `saveData` is the reader
 * saying so outright; a 2G effective type is the network saying it for them.
 * Absent `connection` is treated as fine, because the browsers without it are
 * the desktop ones.
 */
function mayPrefetch() {
  if (typeof navigator === 'undefined') return false
  const c = navigator.connection
  if (!c) return true
  if (c.saveData) return false
  return !/(^|-)2g$/.test(String(c.effectiveType || ''))
}

/**
 * The NETWORK half of `ensureIndex`, and only that half — ui-specs/009.
 *
 * THIS IS THE WHOLE POINT OF THE SPLIT. `ensureIndex` also restores the scope
 * and the conversation, and the scope restore can `say()` — into a polite live
 * region, with the panel closed and the reader reading something else. So a
 * prefetch downloads and stops; everything with a consequence stays on `open()`,
 * where somebody is looking.
 *
 * The failure is swallowed. A prefetch is speculative and must not be able to
 * put the panel into `degraded` before the reader has asked for anything;
 * `loadIndex` releases its memo on failure, so `open()` simply tries again.
 */
export function prefetchIndex() {
  if (state.index || state.degraded || !mayPrefetch()) return
  loadIndex(hostConfig(state.config).ragBase).catch(() => {})
}

export async function ensureIndex() {
  if (state.index || state.degraded) return
  try {
    const index = await loadIndex(hostConfig(state.config).ragBase)
    // Two calls can both pass the guard above before either resolves — an open
    // racing a prefetch, now that there are two callers. The restore below is
    // not idempotent (it announces), so the loser stops here.
    if (state.index) return
    state.index = index
    const restored = scopeApi.restore(state.index.manifest)
    state.scope = restored.scope
    if (restored.reset) say(T('announce.scopeReset'))
    // A deep link's scope outranks the restored one: the reader followed a link
    // that said which pages, and the scope in storage belongs to an earlier
    // visit. Applied here because it is the first moment there is a manifest to
    // validate it against. — ui-specs/009
    if (state.pendingScope === 'page' && knownPaths.value.has(state.currentPath)) {
      setScope([state.currentPath])
    }
    state.pendingScope = null
    state.instruction = state.config.prompt.show ? instruction.get() : ''
    restoreConversation()
    state.ready = true
  } catch (e) {
    state.degraded = true
    state.degradedReason = String(e.message || e)
  }
}

/** The query parameters, namespaced — a docs site may well own `ask` already. */
const DEEP_LINK_ASK = 'dp-ask'
const DEEP_LINK_SCOPE = 'dp-scope'

/**
 * `?dp-ask=…` — ui-specs/009.
 *
 * A support reply, a release note or an error page can hand a reader a specific
 * question. The panel opens with the text in the composer and **does not submit
 * it**: the reader stays in charge of spending a turn, a crawler following the
 * link spends nothing, and a question somebody else wrote is one the reader
 * should get to read before it is asked on their behalf.
 *
 * The parameter is removed with `replaceState` so a reload does not refill a
 * composer the reader emptied on purpose — and so the link does not survive
 * into whatever they copy out of the address bar next.
 *
 * @returns {boolean} whether anything was found, for the suite
 */
export function applyDeepLink(search, replace = null) {
  if (!state.config.composer.deepLink) return false
  const params = new URLSearchParams(search || '')
  const ask = params.get(DEEP_LINK_ASK)
  if (!ask?.trim()) return false
  // The composer's own ceiling. A link is somebody else's input, and the field
  // it lands in caps at a thousand characters.
  state.pendingQuestion = ask.trim().slice(0, 1000)
  if (params.get(DEEP_LINK_SCOPE) === 'page') state.pendingScope = 'page'
  params.delete(DEEP_LINK_ASK)
  params.delete(DEEP_LINK_SCOPE)
  replace?.(params)
  open()
  return true
}

export function open() {
  state.open = true
  ensureIndex()
  // Fetched here, not at the first code fence: the answer highlights live, so
  // the grammars have to be resident before the first code token arrives. It is
  // a lazy chunk, so no docs page pays for it, and it swallows its own failure.
  ensureHighlighter()
}

export function close() {
  state.open = false
  state.dockPanel = null
  stop()
}

export function toggle() {
  state.open ? close() : open()
}

export function stop() {
  controller?.abort()
  controller = null
}

/**
 * A new conversation. The one on screen is not deleted — it is let go of.
 *
 * The tab's pointer is cleared rather than the archive written: a conversation
 * with no turns has earned no row, and writing an empty one would put a
 * nameless entry at the top of the reader's list.
 */
export function newChat() {
  stop()
  state.turns = []
  state.conversationId = null
  state.conversationStale = false
  store.start()
  state.scope = { ...scopeApi.ALL }
  instruction.clear()
  state.instruction = ''
  state.dockPanel = null
  refreshHistory()
  if (state.index) scopeApi.save(state.scope, state.index.manifest.hash)
}

/** Switch the panel to a stored conversation. */
export function openConversation(id) {
  stop()
  const found = store.open(id)
  if (!found) {
    // Deleted in another tab between the list being drawn and this click.
    refreshHistory()
    return
  }
  const title = state.history.find((c) => c.id === id)?.title || ''
  adopt(found)
  state.dockPanel = null
  refreshHistory()
  say(T('announce.conversationOpened', { title }))
}

/**
 * Delete one conversation. Deleting the one on screen empties the panel: a
 * thread still sitting there would be written straight back by the next turn.
 */
export function removeConversation(id) {
  store.remove(id)
  if (id === state.conversationId) {
    stop()
    state.turns = []
    state.conversationId = null
    state.conversationStale = false
  }
  refreshHistory()
  say(T('announce.conversationDeleted'))
}

/** The reader's own undo for the whole feature — see the privacy note in the docs. */
export function clearHistory() {
  stop()
  store.clear()
  state.turns = []
  state.conversationId = null
  state.conversationStale = false
  refreshHistory()
  say(T('announce.historyCleared'))
}

export function setScope(paths) {
  state.scope = scopeApi.makeScope(paths, state.index.manifest)
  scopeApi.save(state.scope, state.index.manifest.hash)
  say(T('announce.scope', { scope: scopeLabel.value }))
}

export function setInstruction(value) {
  state.instruction = instruction.set(value)
  say(T(state.instruction ? 'announce.instructionSaved' : 'announce.instructionRemoved'))
}

/**
 * The thread, written down.
 *
 * Called once per settled turn and once per vote — never mid-stream, because a
 * per-token write would serialise the whole conversation on every frame. The
 * store does the read-modify-write, so two tabs writing the same archive keep
 * each other's rows; see history.js for the one race that survives that.
 */
function saveCurrent() {
  if (!state.config.history.enabled) return
  const id = store.save({
    id: state.conversationId,
    hash: state.index?.manifest.hash,
    turns: state.turns,
  })
  if (id) {
    state.conversationId = id
    // Written against the current index, so whatever made it stale is now
    // behind it: the warning goes away the moment the reader adds a turn.
    state.conversationStale = false
  }
  refreshHistory()
}

/** Re-read the list. Cheap, and it is what stands in for a `storage` listener. */
export function refreshHistory() {
  state.history = state.config.history.enabled ? store.list() : []
}

/**
 * A stored turn, back into a live one.
 *
 * `renderAnswer` is a pure function of (text, knownPaths, cited) and this runs
 * after the index has loaded, so the HTML is recomputed rather than stored —
 * which also means an answer linking to a page that has since been deleted comes
 * back with that link removed rather than pointing into a 404.
 *
 * `cited` is rebuilt from POSITIONS: entry i is the row citation i+1 resolved
 * to, and two citations into one section share a row.
 */
function rehydrate(row) {
  const { citedIdx, answerHtml, ...rest } = row
  const sources = rest.sources || []
  const cited = Array.isArray(citedIdx) ? citedIdx.map((i) => sources[i] || null) : null
  const turn = reactive({
    ...makeTurn(rest.question, rest.scope || { ...scopeApi.ALL }),
    ...rest,
    sources,
    reasons: rest.reasons || [],
    verdict: rest.verdict || null,
    // v-model wants a string, never undefined.
    comment: rest.comment || '',
    feedbackRevision: rest.feedbackRevision || 0,
    // Lets the owner tell "nothing was retrieved" apart from "what was retrieved
    // was not kept" — this turn's `gate.chunks` did not survive the archive.
    restored: true,
    // Not stored: reasoning is the model's scratchpad and the largest field on a
    // turn. A restored turn simply has no reasoning disclosure.
    thought: '',
    thoughtOpen: false,
    thoughtSeconds: 0,
    streaming: false,
    reasonOpen: false,
  })
  if (cited) turn.cited = cited
  // A turn imported from the pre-history payload has sources and no `cited`;
  // re-rendering that one would strip its markers, so it keeps its own HTML —
  // the same exemption the onReady() hook below already makes.
  turn.answerHtml =
    answerHtml || (turn.answerText ? renderAnswer(turn.answerText, knownPaths.value, cited || []).html : '')
  return turn
}

/** Point the panel at a stored conversation and render it. */
function adopt(found) {
  state.conversationId = found.id
  // The hash gates the WARNING now, not the data. Discarding the archive on
  // every docs rebuild would wipe it on a cadence the reader cannot see.
  state.conversationStale = !!found.hash && found.hash !== state.index?.manifest.hash
  state.turns = found.turns.map(rehydrate)
}

function restoreConversation() {
  if (!state.config.history.enabled) return
  // The pre-history per-tab thread, imported once and then removed. Runs before
  // the pointer is read, because it is what sets the pointer on the first load.
  store.migrate()
  refreshHistory()
  const id = store.current()
  if (!id) return
  const found = store.open(id)
  if (found) adopt(found)
}

/**
 * One row of the source list.
 *
 * The leading slot is the SECTION heading, not the page title. Three citations
 * into one long page — `#aws-s3`, `#azure-blob`, `#local-disk` —
 * render as three identical rows otherwise, and the reader has no way to tell
 * which link goes where. The page title moves into the ancestor tail, in front
 * of the sidebar section, so the row reads inward: heading · page · section.
 * A page-level chunk has no heading of its own and keeps the old two-part row.
 */
function sourceRow(c) {
  const page = state.index.manifest.pages.find((p) => p.path === c.path)
  const pageTitle = page?.title || c.breadcrumb || c.title
  const heading = c.title && c.title !== pageTitle ? c.title : null
  // An imported page's row opens the ORIGINAL, in a new tab.
  //
  // `href` stays the internal route for a page that HAS one — it is what dedupes
  // two citations into one row, what `renderAnswer` was handed, and where the
  // reader lands if the origin ever goes away. An external page has no route at
  // all, so its id would be a 404 and the origin is the only address it owns.
  //
  // The host is appended to the tail rather than drawn as a badge because that
  // is the one place a destination can be named without a new border, colour or
  // type size, all three of which the design-rule gate counts.
  const origin = page?.origin || null
  const route = `${c.path}${c.anchor ? `#${c.anchor}` : ''}`
  return {
    n: 0,
    id: c.id,
    href: page?.external ? origin : route,
    origin,
    title: heading || pageTitle,
    tail: [heading ? pageTitle : null, page?.tail, origin ? originHost(origin) : null]
      .filter(Boolean)
      .join(' · '),
  }
}

/**
 * The passage behind a citation — ui-specs/009.
 *
 * The README's position is that citation is provenance and not entailment, which
 * makes checking a source a normal step of reading. Until this, the only way to
 * take that step was a navigation that below 960px closes the panel and takes
 * the thread with it — while the text was in the browser the whole time.
 *
 * TWO SOURCES, in this order, and the order is the point:
 *
 *   1. `turn.gate.chunks` — the chunk THIS TURN put in front of the model. It is
 *      the honest answer to "what was this citation drawn from", because it is
 *      the object the model actually saw.
 *   2. the index, by id — for a restored conversation, where `history.js` has
 *      deliberately dropped the gate's chunks rather than spend kilobytes a turn
 *      on them.
 *
 * Empty string when neither has it, which is the third real case: the docs were
 * rebuilt and that chunk no longer exists. The component renders no disclosure
 * at all there, because a control that opens onto nothing is worse than none —
 * and the turn already carries `conversationStale` for the neighbouring warning.
 *
 * Reading `state.index` here rather than through the retriever is the same call
 * `sourceRow` above already makes. The retriever's `fetch` is a MODEL-facing
 * seam — discriminated, scope-filtered, deliberately unable to tell "unknown id"
 * from "out of scope" — and none of that applies to the host showing a reader
 * the row the host itself built.
 */
/**
 * The pages a turn actually read, named — ui-specs/009, `citations.pagesRead`.
 *
 * From the emitted chunk ids, which are `{path}#{anchor}`, deduped to pages and
 * given the titles the manifest carries. Capped, because this lands in a refusal
 * that goes into the archive: eight is already more pages than a reader will
 * check, and `history.js` caps every other list on the same argument.
 *
 * A path with no page behind it is dropped rather than rendered as a bare route:
 * an imported page can leave the corpus between the turn and the restore.
 */
const PAGES_READ_MAX = 8

function pagesReadFrom(emitted) {
  const paths = [...new Set((emitted || []).map((id) => String(id).split('#')[0]))]
  return paths
    .map((path) => {
      const page = state.index?.manifest.pages.find((p) => p.path === path)
      return page ? { path, title: page.title } : null
    })
    .filter(Boolean)
    .slice(0, PAGES_READ_MAX)
}

export function passageFor(turn, src) {
  if (!state.config.citations.passage || !src?.id) return ''
  const live = turn?.gate?.chunks?.find((c) => c.id === src.id)
  const chunk = live || state.index?.byId?.get(src.id)
  const text = chunk?.text ? String(chunk.text).trim() : ''
  return text
}

/**
 * A turn that settled before the highlighter arrived gets its colour late.
 *
 * `renderAnswer` is a pure function of (text, knownPaths, cited) and the turn
 * keeps all three, so this is the same render again, in colour. A turn imported
 * from the pre-history payload has citations but no `cited` array; re-rendering
 * that one would strip its markers, so it is left alone — citation integrity
 * outranks syntax colour.
 */
onReady(() => {
  for (const turn of state.turns) {
    if (!turn.answerText) continue
    if (turn.sources?.length && !turn.cited) continue
    turn.answerHtml = renderAnswer(turn.answerText, knownPaths.value, turn.cited || []).html
  }
})

/**
 * The live turn, token by token — UI-SPEC 6.
 *
 * Two rates, deliberately different. Reasoning is appended raw: it renders as
 * plain text in a fixed-height box, so a per-token write costs a text node
 * update. The answer is markdown, and re-parsing it per token on a 1200-word
 * answer is the one thing here that can drop frames, so it re-renders on a
 * ~90ms floor and unconditionally once more when the turn settles.
 *
 * `start` fires per MODEL CALL, not per turn: a turn that searches twice before
 * writing must not show the second call's reasoning glued to the first's.
 */
const RENDER_FLOOR_MS = 90
let lastRender = 0

function onStream(turn, ev, started) {
  if (ev.start) {
    turn.thought = ''
    turn.streaming = true
    lastRender = 0
    return
  }

  if (ev.thinking) {
    turn.thought += ev.thinking
    // Opened for the reader the moment there is something to read, and closed
    // again by the first answer token: reasoning is a progress indicator while
    // it is the only thing happening and a footnote once it is not.
    if (!turn.answerText) turn.thoughtOpen = true
    turn.thoughtSeconds = Math.max(1, Math.round((performance.now() - started) / 1000))
  }

  if (ev.text) {
    turn.thoughtOpen = false
    turn.answerText = ev.text
    const now = performance.now()
    if (now - lastRender < RENDER_FLOOR_MS) return
    lastRender = now
    turn.answerHtml = renderAnswer(ev.text, knownPaths.value).html
  }
}

function makeTurn(question, frozen, quote = '') {
  return reactive({
    id: newId('m'),
    question,
    // The passage the reader selected in an earlier answer before asking this.
    // Always a string, never null: it is rendered with `v-if` and persisted only
    // when non-empty, and a restored turn from before this field existed must
    // land on the same falsy value rather than on `undefined`.
    quote,
    scope: frozen,
    state: 'retrieving',
    answerHtml: '',
    answerText: '',
    sources: [],
    refusal: null,
    thought: '',
    thoughtOpen: false,
    thoughtSeconds: 0,
    streaming: false,
    verdict: null,
    // A true multi-select: a wrong answer is often also an incomplete one, and
    // forcing the reader to pick the single most wrong thing throws away the
    // rest. The VALUES are stable and compared across runs — see REASONS in
    // DocPilot.vue.
    reasons: [],
    comment: '',
    reasonOpen: false,
    // 0 means nothing has been sent for this turn yet. Raised on every send, and
    // PERSISTED — a restored turn that re-votes from 0 would be dropped by the
    // receiver's `where excluded.revision >= …` guard, silently, forever.
    feedbackRevision: 0,
    startedAt: performance.now(),
  })
}

/**
 * One turn. The gate runs FIRST and can end it before any model call — on a
 * refusal buildMessages() is never invoked and no token is ever sent.
 *
 * Ahead of even the gate sits the credential test, for the reason set out in
 * credentials.js: the gate refuses a pasted key as off-topic, which is the
 * correct verdict and the wrong outcome. Both stop the turn locally; only this
 * one stops it before the question reaches the embedder.
 */
export async function submit(question, { quote = '' } = {}) {
  const q = String(question || '').trim()
  if (!q || state.busy) return
  await ensureIndex()
  if (state.degraded) return

  const frozen = scopeApi.freeze(state.scope)

  /**
   * The selection, normalised and redacted before it is anything else.
   *
   * Redacted for the reason `turn.question` is: everything a turn carries is
   * written to the archive and can be attached to a feedback report, so the
   * invariant is "nothing unredacted reaches a turn", and a quote is no
   * exception — an answer can quote a page that quotes a key.
   *
   * But a key found HERE does not refuse the turn, and the difference is who
   * typed it. The credential branch below exists because a reader who pastes
   * their own key needs to be told before it leaves the browser. A reader who
   * selects a passage the docs already published did not disclose anything, and
   * refusing them would be a warning about somebody else's mistake, delivered
   * to the one person who cannot fix it. Mask it and carry on.
   */
  const selected = clampQuote(redactSecrets(quote).clean)

  // ── credentials: settled here, with zero network calls ────────────────────
  //
  // `clean` replaces `q` from this line on. The original is referenced nowhere
  // below, is never assigned to `turn.question`, and so cannot reach the stored
  // archive (saveCurrent), its row title, or a feedback report — all three read
  // the turn, not the composer.
  const { clean, kinds, count } = redactSecrets(q)
  if (count) {
    const turn = makeTurn(clean, frozen, selected)
    turn.state = 'no-answer'
    turn.refusal = {
      cause: 'credential',
      scopeLabel: frozen.label,
      scopeKind: frozen.kind,
      pagesRead: 0,
      degraded: false,
      closest: [],
      closestAreOutside: false,
    }
    // The copy is picked by the host, from the same script/function-word
    // detector the language directive uses — there is no model call in which a
    // "answer in the reader's language" instruction could be honoured.
    turn.credential = { kinds, count, copy: replyT(localeOf(detectLanguage(clean)), 'reply.credential') }
    state.turns.push(turn)
    finishTurn(turn, performance.now())
    return
  }

  // ── a greeting is not a failed question ───────────────────────────────────
  //
  // Second local settlement, same shape as the credential one above and placed
  // after it so that a greeting carrying a pasted key is still handled as a key.
  // The gate would refuse "привет" on `no-evidence`, which is the right verdict
  // and reads to the reader as a broken feature — see social.js. Settled from a
  // template with no model call, so nothing is sampled and nothing is invented.
  const social = detectSocial(clean, { hasQuote: !!selected })
  if (social) {
    const turn = makeTurn(clean, frozen, selected)
    turn.state = 'no-answer'
    turn.refusal = {
      cause: 'social',
      scopeLabel: frozen.label,
      scopeKind: frozen.kind,
      pagesRead: 0,
      degraded: false,
      closest: [],
      closestAreOutside: false,
    }
    // Same language detector the credential copy uses, and for the same reason:
    // there is no model call in which an "answer in the reader's language"
    // instruction could be honoured.
    turn.social = {
      kind: social.kind,
      copy: replyT(localeOf(detectLanguage(clean)), `reply.social.${social.kind}`, {
        product: state.config.product || 'this documentation',
      }),
    }
    state.turns.push(turn)
    finishTurn(turn, performance.now())
    return
  }

  stop()
  controller = new AbortController()
  const signal = controller.signal

  const turn = makeTurn(q, frozen, selected)
  state.turns.push(turn)
  state.busy = true
  state.status = { phase: 'searching' }

  const cfg = state.config
  const started = performance.now()

  try {
    /**
     * Query embedding. If the embedder is unreachable, retrieval degrades to
     * BM25 and the gate switches to G = L.
     *
     * That degradation used to be recorded and never surfaced, and the cost of
     * the silence is not subtle: a local Ollama that has simply stopped takes
     * the dense channel with it, and on this English corpus a Russian question
     * then scores L = 0 — no lexical overlap exists to score. The panel answers
     * "I couldn't find this in the docs", which is false. It did not look. That
     * is the same failure as the original outage with a different cause, so the
     * cause is now named rather than the symptom reported.
     *
     * `state.retrieval` is also reset per turn: left sticky, one failed turn
     * made every later turn report lexical-only long after the embedder was
     * back.
     */
    let queryVec = null
    let mode = 'hybrid'
    state.retrieval = 'hybrid'
    state.retrievalError = ''
    /**
     * A deployment that DECLARED no embedder is not one whose embedder is down,
     * and everything the branch below does is a report of an outage: it names an
     * unreachable service on the console once per question for the lifetime of
     * the site, files the reason in `retrievalError`, and marks the refusal
     * `degraded` — which tells the reader the semantic index is unavailable. All
     * of that is false where no semantic index was ever built. The two modes
     * retrieve identically; only one of them went wrong.
     *
     * Entered without touching `embedderMatchesIndex` or `embed`, so no request
     * is made to a service the config declined to name and no allowance is spent
     * on one.
     */
    if (cfg.embed.lexicalOnly) {
      mode = 'lexical-only'
      state.retrieval = 'lexical-only'
    } else {
      try {
        if (!embedderMatchesIndex()) throw new Error('embedder does not match the index')
        queryVec = await embed(q, cfg, signal)
      } catch (e) {
        // A reader who pressed stop is not an outage. `embedQuery` is handed the
        // turn's signal, so cancelling it lands here, and treating that as an
        // unreachable embedder both prints the alarming console line above and
        // lets the turn run on to a gate it will fail — so the reader is told
        // their question isn't in the docs, about a question they withdrew.
        if (signal.aborted) throw e
        mode = 'lexical-only'
        state.retrieval = 'lexical-only'
        state.retrievalError = String(e?.message || e)
        const t = embedTarget(cfg)
        // eslint-disable-next-line no-console
        console.error(
          `[docpilot] the embedder is unreachable (${t.provider}/${t.model} at ${t.baseURL}): ` +
            `${state.retrievalError}. Retrieval is running lexical-only, which on an ` +
            'English corpus finds nothing for a question in another language.',
        )
      }
    }

    const retrieval = createRetrieval({
      index: state.index,
      scope: frozen,
      guard: guard.value,
      tuning: tuning.value,
      dev: import.meta.env?.DEV,
      onDebug: (kind, data) => state.debug && console.debug('[docpilot]', kind, data),
    })

    /**
     * The antecedent of the composed channel — RAG-SPEC 3.4.5, and the only
     * place a quote is allowed to touch the gate.
     *
     * A selection is a BETTER antecedent than the previous question, and it is
     * the one the reader chose: "explain this" resolves against the passage
     * under the cursor, not against whatever was asked one turn ago. So when a
     * quote is attached it takes the slot.
     *
     * What it is NOT is part of `question`. Gluing the two would put the quote's
     * terms into the raw query, where `lexicalCoverage` would count them — and a
     * quote lifted from an answer this corpus produced matches this corpus by
     * construction, so L would saturate on every question carrying one. That is
     * exactly the "off-topic question padded with domain nouns" the gate's
     * `df ?? 0` default exists to catch, arriving through the front door. Here it
     * can only raise G through a channel `admissible()` still polices against the
     * reader's OWN words, and G is a maximum, so refusals can only decrease.
     */
    const previous = state.turns.length > 1 ? state.turns[state.turns.length - 2].question : null
    const antecedent = selected || previous
    /**
     * `null` is not `undefined` here, and `evaluate()` reads the difference:
     * undefined means "there is no second query to score", null means "score it
     * with no vector".
     *
     * A lexical-only turn still HAS a composed channel — composing is a string
     * operation, and `L` is computed over the composed query either way — and
     * `docpilot calibrate` sweeps `tauLexical` with that channel running
     * (`probeLexicalOnly`, and `eval/run.js` under `--lexical`). Leaving it
     * undefined here scored every follow-up on the raw question alone against a
     * threshold measured on both, which shows up as "and for backend calls?"
     * being refused on the one deployment shape that cannot fall back to a
     * dense channel.
     */
    let composedVec
    if (antecedent && mode === 'lexical-only') {
      composedVec = null
    } else if (antecedent && queryVec) {
      try {
        composedVec = await embed(`${antecedent}\n${q}`, cfg, signal)
      } catch (e) {
        // Same reason as the query embedding above: cancellation has to keep
        // travelling outward, where the turn ends as aborted.
        if (signal.aborted) throw e
        composedVec = undefined
      }
    }

    const g = {
      ...retrieval.evaluate({
        question: q,
        previousQuestion: antecedent,
        queryVec,
        composedVec,
        mode,
      }),
      /**
       * WHICH antecedent the composed channel ran on, not merely that one did.
       *
       * `channel: 'composed'` used to mean exactly one thing — a follow-up whose
       * other half is the previous question — and `src/feedback/stratum.js`
       * routes on it, filing the record as an F or N5 probe with "add
       * prev_question from the conversation". A quoted turn has no previous
       * question to add: its antecedent is a passage the corpus wrote. Without
       * this field those records enter the calibration set as probes nobody can
       * complete, and F's over-refusal bound is applied to a population it was
       * never measured on.
       */
      antecedent: selected ? 'quote' : previous ? 'question' : null,
    }
    if (state.debug) console.debug('[docpilot] gate', g)

    // ── the gate may end the turn here, before any model call ────────────────
    if (cfg.guard.mode !== 'off' && !g.pass) {
      const cause = g.wouldPassUnscoped ? 'out-of-scope' : 'no-evidence'
      turn.state = 'no-answer'
      turn.refusal = {
        cause,
        scopeLabel: frozen.label,
        scopeKind: frozen.kind,
        pagesRead: 0,
        // NOT "is the dense channel missing" but "did something break". This
        // drives `refusal.degraded`, whose sentence is that the semantic index
        // isn't available — a promise of a better search once the outage clears,
        // and a lie on a site that never had one and never will.
        degraded: mode === 'lexical-only' && !cfg.embed.lexicalOnly,
        closest: retrieval.closest({
          query: q,
          queryVec,
          outsideScope: cause === 'out-of-scope',
        }),
        closestAreOutside: cause === 'out-of-scope',
      }
      turn.gate = g
      finishTurn(turn, started)
      return
    }

    /**
     * The capability probe, and when it is worth a request.
     *
     * `detectTools` is a full model call made before the reader has read a
     * word — on a pool it asks up to three candidates — and on a 50-request day
     * it is the single most expensive habit in this package: a reader who opens
     * two pages has spent two answers finding out something the config already
     * implies. A POOL is only ever configured for a hosted OpenAI-compatible
     * service whose members are tool-capable by construction, and the case where
     * one is not is precisely the case the fallback parser recovers, so `'auto'`
     * skips it there. `'always'` keeps the behaviour that shipped, for a local
     * model zoo where the question is genuinely open; `'never'` skips it outright.
     */
    const pooled = !!cfg.llm.models?.length
    const probe = cfg.budget.probe === 'always' || (cfg.budget.probe === 'auto' && !pooled)
    if (probe && state.fallbackUnknown !== false) {
      const native = await detectTools({
        provider: cfg.llm.provider,
        baseURL: cfg.llm.baseURL,
        model: cfg.llm.model,
        models: cfg.llm.models,
        apiKey: cfg.llm.apiKey,
        signal,
        // The probe is a model request like any other and comes out of the same
        // daily allowance, so it is counted like any other. Unreported it was
        // the one request a turn spends that the ledger could not see, and on a
        // pool it is up to three — enough to make "12 of 50 left" a number the
        // panel states and the service disagrees with.
        // `kind` is what the transport made of the response — the probe reports
        // headers only, so it arrives undefined and budget.js classifies from
        // the headers itself. Passed through rather than dropped so this seam
        // stays the same shape as the harness's.
        onHeaders: (headers, kind) => {
          const ledger = ensureBudget()
          ledger.spend(1)
          ledger.observe(headers, kind)
        },
      })
      // `null` means the probe never reached a model — every candidate was busy,
      // or the reader stopped. Nothing was measured, so nothing is remembered:
      // this turn runs on the native path (the optimistic guess, and the one the
      // fallback parser can recover from) and the next turn asks again. Latching
      // it would let one rate-limited second cost the page every tool call it
      // would otherwise have made.
      state.fallback = native === false
      if (native !== null) state.fallbackUnknown = false
    }

    turn.state = 'thinking'
    const result = await runTurn({
      retrieval,
      // The unscoped SCORE, which is what `harness.finish` clamps confidence
      // against when a reader instruction is live. Both arms of the ternary
      // this replaces read `g.G`, so the clamp was `Math.min(G, G)` and the
      // separate measurement retrieval already computes was thrown away.
      gateResult: { ...g, GUnscoped: g.unscopedG ?? g.G },
      question: q,
      quote: selected,
      // A prior turn's quote travels with its question, or the transcript reads
      // as a string of non sequiturs: "what does this mean?" with no `this` in
      // it. buildMessages clamps it harder than the live one — see
      // HISTORY_QUOTE_MAX.
      history: state.turns
        .slice(0, -1)
        .map((t) => ({ question: t.question, answer: t.answerText, quote: t.quote || '' })),
      addendum: state.instruction,
      config: { ...cfg, guard: guard.value },
      fallback: state.fallback,
      queryVec,
      // The harness decides what this turn may spend, learns the answer from
      // every response header it sees, and hands the count back through the same
      // instance — so a turn that ends one-shot is a turn the previous turns paid
      // for, not a setting anybody changed.
      budget: ensureBudget(),
      onPhase: (p) => {
        state.status = p
      },
      // Recorded per turn rather than per session: a pool answers a two-step
      // turn with two different models often enough that "the model" is a
      // property of the answer, and a vote filed against the config's name
      // would be filed against a name that never ran.
      onModel: (m) => {
        turn.model = m
      },
      onStream: (ev) => onStream(turn, ev, started),
      signal,
    })

    turn.gate = g
    turn.iterations = result.iterations
    turn.rejectedFetches = result.rejectedFetches
    turn.support = result.support
    /**
     * THE REASONING SHOWN BELONGS TO THE MODEL THAT ANSWERED, and to no other.
     *
     * This was `if (result.think) turn.thought = result.think` — a guard, so a
     * winner with no reasoning of its own (the common case, not the exception)
     * left whatever the streamer had painted standing under its answer. On a
     * pool that is another candidate's reasoning: the model that was rotated
     * past for answering in prose thinks out loud, the model that actually
     * answered does not, and the panel showed the loser's thinking above the
     * winner's answer with a seconds count attached to it.
     *
     * So it is an ASSIGNMENT, and the empty string is a real value here: the
     * harness returns the reasoning of the call that produced the answer and
     * nothing else, which for a model that did none is "". The seconds count
     * goes with it — a duration for reasoning nobody can read is furniture.
     */
    turn.thought = result.think || ''
    if (turn.thought) {
      turn.thoughtSeconds = Math.max(1, Math.round((performance.now() - started) / 1000))
    } else {
      turn.thoughtSeconds = 0
      turn.thoughtOpen = false
    }

    /**
     * What survives a turn, and what does not.
     *
     * WITHDRAWAL IS FOR UNTRACEABLE TEXT, NOT FOR HEDGING. An answer with no
     * citations is exactly what the guardrail exists to withhold: the reader
     * cannot check it, cannot tell it from a fabrication, and leaving it on
     * screen next to a refusal makes it unclear which of the two is the
     * product's answer. That case still ends the turn with nothing shown.
     *
     * Low self-reported confidence is a different thing and used to be treated
     * the same, which is what threw away answers the reader had already watched
     * being written. A CITED answer is traceable — every claim carries a marker
     * into a source list the reader can open — and `confidence` is the weakest
     * signal in the system: a number the model writes about its own work,
     * unverifiable, and already discarded outright whenever a reader instruction
     * is active (see harness.finish). Deleting a grounded, checkable answer on
     * that basis costs the whole turn's tokens and replaces something useful
     * with "I couldn't find this in the docs", which is false when four sources
     * were found. It is now kept and marked tentative; the reader decides.
     *
     * The floor still catches uncited answers, because harness.finish() pins
     * confidence to 0.3 whenever `citations` came back empty.
     */
    const untraceable = !result.text.trim() || !result.citations.length
    if (untraceable || result.confidence < 0.4) {
      // The turn spent its whole budget, so which condition fired is worth
      // printing: an empty answer, an uncited one and a hedged one look
      // identical to the reader and need opposite fixes.
      //
      // `phantom` separates the two that matter most — the model cited nothing
      // (the guardrail working), or the model cited ids the host then rejected
      // as not-emitted (the guardrail eating a good answer). harness.finish()
      // drops phantoms silently, so without this the second is invisible.
      const why = {
        chars: result.text.trim().length,
        citations: result.citations.length,
        phantom: result.phantom?.length || 0,
        confidence: result.confidence,
        emitted: result.emitted.length,
        iterations: result.iterations,
        kept: !untraceable,
      }
      if (state.debug) {
        console.debug('[docpilot] low-confidence or untraceable', why, {
          citations: result.citations,
          phantom: result.phantom,
        })
      }
      turn.notAnswerable = why

      if (untraceable) {
        turn.answerHtml = ''
        turn.answerText = ''
        turn.state = 'no-answer'
        turn.refusal = {
          cause: 'not-answerable',
          scopeLabel: frozen.label,
          scopeKind: frozen.kind,
          pagesRead: new Set(result.emitted.map((id) => id.split('#')[0])).size,
          // WHICH pages, not just how many — ui-specs/009, and only when the
          // project asked for it. The line above already claims "searched and
          // read N pages"; this is that claim made checkable. Off by default,
          // and built conditionally rather than filtered later, so a project
          // that leaves it off pays nothing for it in the archive either.
          pages: state.config.citations.pagesRead ? pagesReadFrom(result.emitted) : undefined,
          // The same distinction the gate refusal above draws: a declared
          // lexical-only deployment has no semantic index to be missing.
          degraded: mode === 'lexical-only' && !cfg.embed.lexicalOnly,
          closest: retrieval.closest({ query: q, queryVec }),
          closestAreOutside: false,
        }
        finishTurn(turn, started)
        return
      }

      turn.tentative = true
    }

    // Sources first: the answer's inline markers link into this list, so it has
    // to exist before the markdown is rendered.
    //
    // Two citations into one section — the chunker splits a long section into
    // `#aws-s3-bucket` and `#aws-s3-bucket~2`, which share an anchor — are one
    // destination and get one row. `cited` keeps a row per citation so marker
    // [2] still resolves; it simply resolves to the same row as [1].
    //
    // `~N`, not `-N`: the tilde is a CONTINUATION part, while `-N` is how a
    // repeated heading is disambiguated and is a different section entirely.
    // Only the id carries the suffix — every part shares the `anchor` field the
    // href is built from — which is why both parts land on one row here.
    const rows = []
    const byHref = new Map()
    const cited = result.sources.map((c) => {
      const row = sourceRow(c)
      const seen = byHref.get(row.href)
      if (seen) return seen
      row.n = rows.length + 1
      rows.push(row)
      byHref.set(row.href, row)
      return row
    })
    turn.sources = rows
    // Kept so a completed turn can be re-rendered identically — see the
    // onReady() hook below. `cited` holds one entry per citation and `rows` the
    // deduped set, so re-rendering without it would silently drop markers.
    turn.cited = cited
    const { html, delinked } = renderAnswer(result.text, knownPaths.value, cited)
    turn.answerText = result.text
    turn.answerHtml = html
    turn.delinked = delinked
    turn.state = 'complete'
    finishTurn(turn, started)
  } catch (e) {
    if (signal.aborted) {
      // Stopping mid-write keeps what was already written, so the last render is
      // forced here: the throttle above is allowed to be up to one frame behind
      // and this is the frame that stops arriving.
      if (turn.answerText) turn.answerHtml = renderAnswer(turn.answerText, knownPaths.value).html
      turn.state = turn.answerHtml ? 'aborted' : 'no-answer'
      if (!turn.answerHtml) {
        turn.refusal = {
          cause: 'not-answerable',
          scopeLabel: frozen.label,
          scopeKind: frozen.kind,
          pagesRead: 0,
          closest: [],
          closestAreOutside: false,
        }
      }
    } else if (e?.rateLimit?.daily) {
      /**
       * The day's quota, spent — and NOT an error.
       *
       * "The AI service didn't respond" is false here in the way that matters:
       * the service responded, it responded promptly, and it named the hour it
       * will answer again. A reader told that it failed retries, and every retry
       * is a request they do not have; a reader told the limit is spent stops,
       * which is the only useful action either of us has. So it is its own
       * terminal state, carrying the two numbers the panel needs to say when.
       *
       * `resetAt` may be absent — a provider is entitled to say "no" without
       * saying "until when" — and the copy drops the second sentence rather than
       * inventing a time.
       */
      turn.state = 'rate-limited'
      turn.rateLimit = { resetAt: e.rateLimit.resetAt, limit: e.rateLimit.limit }
      // A turn with nothing on screen is still dropped from the archive, exactly
      // as a transport error is: `slimTurn` keeps neither, because it has no
      // answer and no refusal to restore. What it does keep, since this state
      // joined its terminal set, is a turn the limit interrupted AFTER text was
      // painted — and it keeps it under this state rather than coercing it to
      // 'aborted', which restored as "Stopped." and told the reader they had
      // ended a turn the service refused. `turn.rateLimit` deliberately does not
      // travel with it: the reset is rendered as a clock time, and a clock time
      // that has already passed is worse than no line at all.
      if (state.debug) console.debug('[docpilot] daily rate limit', e.rateLimit)
    } else {
      turn.state = 'error'
      turn.error = String(e.message || e)
      // The panel renders one sentence for every transport failure, by design —
      // a reader cannot act on a stack trace. But `?dpdebug=1` exists to print
      // the trace, and the failure that ends the turn is the one thing worth
      // printing most: without this the only signal is "didn't respond", with
      // the cause held in state and shown nowhere.
      if (state.debug) console.error('[docpilot] turn failed', e)
    }
    finishTurn(turn, started)
  }
}

/**
 * When the quota comes back, as a clock time in the reader's locale.
 *
 * It lives in the store rather than in the component because it is SAID as well
 * as shown: `finishTurn` announces a rate-limited turn with this sentence
 * attached, the panel renders the same one under the turn, and two formatters
 * would eventually disagree about the only fact in that turn a reader can act
 * on. The component reads it from here.
 *
 * NOT a relative rendering. This instant is in the FUTURE, and the panel's
 * `relativeParts` clamps the future to "now" on purpose — a relative rendering
 * would read "Answers resume now" while the panel is refusing to answer, which
 * is the one sentence worse than saying nothing. A clock time is also what the
 * reader can act on; the epoch the API sent is not, and it never reaches the
 * page.
 *
 * The day is named when the reset lands on a different one, because "3:00 AM"
 * alone is read as three in the morning TODAY, which for a window that resets at
 * midnight UTC is wrong for most of the planet.
 *
 * Empty when the header carried no reset — a partial rate-limit read is normal,
 * and the line is dropped rather than filled with a guess.
 */
export function resetLine(turn) {
  const at = Number(turn?.rateLimit?.resetAt)
  if (!Number.isFinite(at)) return ''
  const when = new Date(at)
  const sameDay = when.toDateString() === new Date().toDateString()
  try {
    const fmt = new Intl.DateTimeFormat(normaliseLocale(state.lang, tree()), {
      ...(sameDay ? {} : { weekday: 'long' }),
      hour: 'numeric',
      minute: '2-digit',
    })
    return T('error.rateResets', { when: fmt.format(when) })
  } catch {
    // The device's own formatting rather than the page's: a locale `Intl`
    // rejected would reject the fallback too.
    return T('error.rateResets', { when: when.toLocaleTimeString() })
  }
}

function finishTurn(turn, started) {
  turn.latencyMs = Math.round(performance.now() - started)
  turn.streaming = false
  turn.thoughtOpen = false
  // THE TURN'S OWN CONTEXT, frozen at the moment it settled.
  //
  // `writeFeedback` used to read all six of these from live session state, which
  // made a vote a statement about the session rather than about the answer it
  // was cast on: a reader who edits their instruction — or votes on a thread
  // restored from the archive — reported a prompt the turn never ran under. With
  // amendments it is worse than wrong, because revision 0 and revision 1 can
  // disagree, and a revision 1 that decided `promptStock: false` deletes the
  // `answer` revision 0 stored.
  // Whatever actually answered wins; the configured name is the floor for a
  // turn that never reached a model — one the gate refused, or one the reader
  // stopped. `models[0]` covers the pooled case, where there is no configured
  // name at all and a blank is worse than an approximation.
  turn.model = turn.model || state.config.llm.model || state.config.llm.models?.[0] || null
  turn.retrieval = state.retrieval
  turn.promptHash = promptHash(state.config.prompt, state.config.product)
  turn.promptStock = !state.instruction
  turn.addendumHash = instruction.hash(state.instruction)
  turn.addendumChars = state.instruction.length
  state.busy = false
  state.status = null
  controller = null
  // What the turn just spent, and what that leaves the next one. Read once here
  // rather than watched: the count only ever moves during a turn, and a line
  // that changes under the reader's eye mid-answer is a distraction from the
  // answer.
  refreshBudget()
  // The reader may have switched conversations while this one was running. It
  // still settles — the object is live and whoever comes back to it gets a
  // finished turn — but nothing about a thread that is no longer on screen is
  // announced, and nothing about it is written either.
  //
  // The save has to come after this check, not before. `saveCurrent` writes
  // whichever thread is on screen NOW, stamped with the current index hash, and
  // clears `conversationStale` as it goes — so an abandoned turn settling in the
  // background used to silently retire the "this thread predates the current
  // index" warning on a conversation the reader had only just opened and not
  // touched.
  if (!state.turns.includes(turn)) return
  saveCurrent()
  if (turn.state === 'complete') say(T('announce.answerReady', { n: turn.sources.length }))
  // A credential turn searched nothing, so "I couldn't find this in the docs"
  // would be a claim about the corpus for a turn that never looked at it — the
  // same falsehood §13 already forbids on a degraded search. The announcement
  // is the warning itself, in the language it was written in.
  else if (turn.refusal?.cause === 'credential') say(turn.credential.copy.lead)
  else if (turn.state === 'no-answer')
    say(T('refusal.notFound', { scope: turn.refusal.scopeLabel }))
  // The limit, spoken — BOTH sentences. A reader on a screen reader gets the
  // same three seconds of silence for a spent quota as for a slow answer
  // otherwise, and then a panel that has simply stopped producing them. The
  // reset time travels with it because it is the actionable half: announced
  // without it, the reader is told the day is over and not when it starts
  // again, which is the part that was rendered for sighted readers only.
  else if (turn.state === 'rate-limited')
    say([T('error.rateLimited'), resetLine(turn)].filter(Boolean).join(' '))
}

export function vote(turn, verdict) {
  const was = turn.verdict
  const next = was === verdict ? null : verdict
  turn.verdict = next
  turn.reasonOpen = next === 'down'
  // A form belongs to a down-vote. Carrying reasons or a sentence across to a
  // thumb up — or to no thumb at all — would attach "wrong answer" to a verdict
  // that says the opposite.
  if (next !== 'down') {
    turn.reasons = []
    turn.comment = ''
  }
  // SEND FIRST, THEN WRITE DOWN. `writeFeedback` raises the revision counter,
  // and a save taken before it stores the OLD one — so the next vote on a
  // restored turn would repeat a revision under different content, which is
  // precisely the ambiguity the counter exists to remove.
  //
  // Sent even when the vote was withdrawn. The endpoint holding a down-vote the
  // reader has since retracted is the one outcome a thumb the reader can press
  // twice must not produce, and once that thumb can carry a sentence, what is
  // being retracted is the reader's own words. `retracted` tells the send filter
  // which verdict this record is about; the receiver upserts on messageId.
  writeFeedback(turn, {retracted: was})
  // The stored turn also has to stop showing a thumb the reader has taken back.
  saveCurrent()
  if (next) say(T('announce.feedbackRecorded'))
}

/**
 * The comment ON THE TURN, redacted in place.
 *
 * `feedback.record` redacts its own copy, which covers the network and the
 * feedback store — but `turn.comment` is ALSO written to the conversation
 * archive by `slimTurn`, and a draft the reader closed with Escape is written
 * there too. Redacting only inside `record` left a pasted key sitting in
 * localStorage in clear text, which is the third of the four directions
 * credentials.js exists to close.
 *
 * Same treatment `turn.question` already gets in submit(): one string, redacted
 * once, used for what is shown, what is stored and what is sent. `redactSecrets`
 * is idempotent, so calling it on every close costs nothing.
 */
function redactComment(turn) {
  if (!turn.comment) return
  const { clean } = redactSecrets(turn.comment)
  if (clean !== turn.comment) turn.comment = clean
}

/**
 * NO POST. Four clicks are not four records — the amendment goes out once, from
 * submitFeedback, with everything the reader chose.
 */
export function toggleReason(turn, reason) {
  const at = turn.reasons.indexOf(reason)
  if (at >= 0) turn.reasons.splice(at, 1)
  else turn.reasons.push(reason)
  // Every path that writes the draft to the archive redacts it first. A reader
  // who types a key into the comment and then clicks a reason pill reaches
  // `slimTurn` through here, and if the tab closes before Submit or Skip the
  // unredacted draft is what stays on disk.
  redactComment(turn)
  saveCurrent()
}

export function submitFeedback(turn) {
  turn.reasonOpen = false
  redactComment(turn)
  /**
   * The line that replaces the form — ui-specs/009, `feedback.confirm`.
   *
   * Set on BOTH paths, including the early return below, because the reader
   * pressed Send either way and the verdict itself was already recorded when
   * they pressed the thumb. The form is the amendment, not the report.
   *
   * Not persisted: `slimTurn` is a whitelist and this is not on it. A restored
   * conversation showing "thanks" for a report sent two days ago would be
   * describing an interaction that is not on screen.
   */
  turn.feedbackDone = state.config.feedback.confirm
  // Nothing to amend is a Skip. Re-posting the same record under a higher
  // revision would cost the reader's bandwidth to tell the owner nothing.
  if (!turn.reasons.length && !turn.comment.trim()) {
    saveCurrent()
    return
  }
  writeFeedback(turn)
  saveCurrent()
  say(T('announce.feedbackSent'))
}

export function skipFeedback(turn) {
  turn.reasonOpen = false
  // The draft survives — the reader can reopen the form and finish it — but not
  // with a live key in it.
  redactComment(turn)
  saveCurrent()
}

function writeFeedback(turn, {retracted = null} = {}) {
  const revision = turn.feedbackRevision ?? 0
  // OMITTED, never []. history.js drops `gate.chunks` on purpose, so a vote cast
  // on a restored turn cannot re-derive what was retrieved — and under an upsert
  // an empty array would overwrite the perfectly good list revision 0 sent. An
  // absent key lets the receiver's `coalesce` keep what it already has.
  const retrievedIds = turn.gate?.chunks?.map((c) => c.id) || []
  feedback.record(
    {
      ts: Date.now(),
      sessionId,
      // The thread this turn belongs to. `F` and `N5` calibration probes need
      // the PREVIOUS question, which no single record carries — this is what
      // makes a reviewer able to go and find it.
      conversationId: state.conversationId,
      messageId: turn.id,
      revision,
      question: turn.question,
      // What the question was ABOUT, when the reader pointed at something. A
      // record without it describes a question no reviewer can read: the whole
      // subject of "why is that?" is in this field and nowhere else.
      quote: turn.quote || null,
      answer: turn.answerText,
      citations: turn.sources.map((s) => s.href),
      ...(retrievedIds.length ? {retrievedIds} : {}),
      ...(turn.restored ? {restored: true} : {}),
      // Read off the TURN, not off live state — frozen in finishTurn. The `??`
      // covers a turn stored before this field existed.
      retrieval: turn.retrieval ?? state.retrieval,
      model: turn.model ?? state.config.llm.model,
      iterations: turn.iterations ?? 0,
      rejectedFetches: turn.rejectedFetches ?? 0,
      latencyMs: turn.latencyMs,
      verdict: turn.verdict,
      retracted,
      reasons: [...turn.reasons],
      comment: turn.comment || null,
      refusal: turn.refusal?.cause || null,
      gate: turn.gate
        ? {
            G: turn.gate.G,
            tau: turn.gate.threshold,
            mode: turn.gate.mode,
            /**
             * Whether `lexical-only` here is an OUTAGE or the mode this site was
             * built in — `mode` alone cannot say, and the two mean opposite
             * things to the reviewer downstream.
             *
             * `src/feedback/stratum.js` drops a lexical-only record on the
             * grounds that its G was scored against a threshold the calibrator
             * is not sweeping. That is true of an embedder that stopped
             * answering. On a declared no-embed site EVERY record is
             * lexical-only, `G = L` is scored against `tauLexical` on every
             * turn, and `tauLexical` is exactly what `docpilot calibrate`
             * sweeps there — so dropping them empties the one loop that grows
             * that site's probe set.
             */
            degraded: turn.gate.mode === 'lexical-only' && !state.config.embed.lexicalOnly,
            n: turn.gate.n,
            channel: turn.gate.channel,
            // What `channel: 'composed'` was composed WITH. stratum.js needs it
            // to tell a follow-up from a quoted turn.
            antecedent: turn.gate.antecedent ?? null,
            source: guard.value.source,
            wouldPassUnscoped: turn.gate.wouldPassUnscoped,
          }
        : null,
      support: turn.support ?? null,
      scope: turn.scope,
      promptHash: turn.promptHash ?? promptHash(state.config.prompt, state.config.product),
      promptStock: turn.promptStock ?? !state.instruction,
      addendumHash: turn.addendumHash ?? instruction.hash(state.instruction),
      addendumChars: turn.addendumChars ?? state.instruction.length,
    },
    {
      feedbackEndpoint: state.config.feedbackEndpoint,
      send: state.config.feedback.send,
      debug: state.debug,
    },
  )
  turn.feedbackRevision = revision + 1
}

/**
 * Cut the thread at a turn and ask again from there.
 *
 * The two paths that TRUNCATE — a rewritten question and a re-asked one — as
 * against the three that append (`error.retry`, `widen`, `askWithoutSecret`).
 * Those three re-ask the SAME question and leave the old turn where it is,
 * because the old answer is still a true record of what was asked. These two
 * withdraw the answer itself, and with it everything said after: the history
 * this panel hands the model is `state.turns.slice(0, -1)`, so a turn left
 * behind would go on answering text that is no longer in the thread the reader
 * can see — once per turn, for the rest of the conversation.
 *
 * Returns false when nothing was done, so a caller can leave its editor open
 * rather than dropping a draft into a thread it never reached.
 */
function truncateAndAsk(turn, question) {
  // Both guards come BEFORE the splice. `submit` returns early on either — busy
  // at its own first line, degraded after `ensureIndex` — so a truncation here
  // would leave the thread short by one turn and gain nothing. `stop()` cannot
  // stand in for the busy check: it aborts the controller, but `state.busy` is
  // cleared asynchronously in `finishTurn`, so the submit below would still see
  // it set.
  if (!question || state.busy || state.degraded) return false
  const i = state.turns.indexOf(turn)
  // The conversation can be swapped between the render that drew the control
  // and the click that pressed it — the race `openConversation` already guards.
  if (i < 0) return false

  const quote = turn.quote // read before the splice drops the object
  stop()
  state.turns.splice(i)
  // The archive is otherwise only written a whole answer later, from
  // `finishTurn`. Without this the reader could truncate a thread, close the
  // panel mid-answer, and reopen the conversation with the deleted turns back.
  // Skipped when nothing is left: `store.save` refuses an empty thread, which
  // is the same rule that keeps an unanswered conversation out of the list.
  if (state.turns.length) saveCurrent()
  submit(question, { quote })
  return true
}

/** The reader rewrote a question. */
export function editTurn(turn, question) {
  const q = String(question || '').trim()
  // Not an edit. Re-asking would destroy an answer that is already on screen to
  // get another one to the same question — which is `retryTurn`, and is a
  // different button.
  if (!q || q === turn.question) return false
  const ok = truncateAndAsk(turn, q)
  if (ok) say(T('announce.turnEdited'))
  return ok
}

/**
 * The reader wants a different answer to the same question.
 *
 * The refusal case is why this exists: "I couldn't find this in the docs" is a
 * verdict about one retrieval, and retrieval is not deterministic across a
 * reindex, a scope change or an embedder that was down a minute ago. Without
 * this the only way to test that verdict is to retype the question.
 *
 * Not offered on a credential or social turn, and the component is where that
 * is decided: both settle from a template with no model call, so asking again
 * returns the identical text — and the credential turn already carries its own
 * affirmative button.
 */
export function retryTurn(turn) {
  const ok = truncateAndAsk(turn, turn.question)
  if (ok) say(T('announce.retrying'))
  return ok
}

export function widen(turn) {
  state.scope = { ...scopeApi.ALL }
  scopeApi.save(state.scope, state.index.manifest.hash)
  // With its quote. Every re-submit path carries it: a question whose whole
  // subject was a passage, re-run without that passage, fails silently — there
  // is no error to attach to it and it reads as the model losing the thread.
  submit(turn.question, { quote: turn.quote })
}

/**
 * The affirmative half of the credential refusal — RAG-SPEC 3.5.
 *
 * Refusing outright would be the wrong product: the reader asked a real
 * question ("where does this go?") and the docs answer it. What was wrong was
 * the value, not the question. `turn.question` is already the redacted text, so
 * this is an ordinary submit — the gate runs, the model is called, and the
 * envelope's placeholder rule (4.4) makes the sample come back as a placeholder.
 *
 * It re-enters through submit(), so a second secret pasted into the same
 * question could not slip past: redactSecrets is idempotent and MASK matches
 * none of the patterns, so the test simply does not fire again.
 */
export function askWithoutSecret(turn) {
  submit(turn.question, { quote: turn.quote })
}
