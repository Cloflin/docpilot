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
import { resolveUi } from './ui.js'

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
  },
  // Configured separately from `llm` on purpose: Anthropic has no embeddings
  // endpoint, so the two halves must be able to point at different services.
  // `baseURL: null` means "same as llm.baseURL".
  embed: { provider: null, baseURL: null, model: 'bge-m3', apiKey: null },
  topK: 5,
  // See config.mjs: the host primes the turn with the gate's own excerpts, and
  // every observation is re-sent on every step, so iterations 3 and 4 mostly
  // paid to repeat evidence the model already had.
  maxIterations: 2,
  suggestions: [],
  // The product this documentation is about. Null renders as "this
  // documentation" everywhere it appears — in the instruction, in the composer
  // placeholder, in the assistant's own introduction.
  product: null,
  feedbackEndpoint: null,
  // WHICH votes leave the device, and whether the reader may write a sentence.
  // The RESOLVED shape — equal to `resolveFeedback({})` by construction, like
  // `ui` below.
  feedback: { send: 'both', comment: true },
  // The configured DELTA only — the shipped tree lives in i18n.js and is looked
  // up behind it, so a project that overrides nothing ships no extra bytes.
  i18n: { translations: {}, locales: {} },
  guard: { mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3 },
  scope: { enabled: true, default: 'all', promptListLimit: 12 },
  // The reader's own conversations, on their device. Off means "do not record
  // AND clear what is there" — see `configure` below.
  history: { enabled: true, maxConversations: 20 },
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
  },
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
  currentPath: '/',
  // The page's locale, pushed in by the component. Drives every panel string;
  // the reply copies key off the language the reader typed instead.
  lang: 'en',
  retrieval: 'hybrid',
  // Why the dense channel is missing, when it is. Read by the refusal copy so a
  // degraded search is never reported as an absent answer.
  retrievalError: '',
  fallback: false,
  debug: false,
})

let controller = null
let sessionId = null

function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`
}

export function configure(themeConfig, path, lang) {
  const cfg = themeConfig?.docPilot || {}
  state.config = {
    ...DEFAULTS,
    ...cfg,
    llm: { ...DEFAULTS.llm, ...(cfg.llm || {}) },
    embed: { ...DEFAULTS.embed, ...(cfg.embed || {}) },
    guard: { ...DEFAULTS.guard, ...(cfg.guard || {}) },
    scope: { ...DEFAULTS.scope, ...(cfg.scope || {}) },
    history: { ...DEFAULTS.history, ...(cfg.history || {}) },
    prompt: { ...DEFAULTS.prompt, ...(cfg.prompt || {}) },
    // Resolved, not spread. `themeDocPilot` already emits a finished structure, so
    // this call is a no-op on a normal build; it earns its place on the
    // `{enabled: false}` payload, which carries no `ui`, and on a themeConfig
    // written by hand. A spread would let a half-filled object through.
    ui: resolveUi(cfg),
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
    model: cfg.embed.model,
    apiKey: cfg.embed.apiKey ?? cfg.llm.apiKey,
  }
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
  const built = state.index?.manifest.embedModel
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
 * `useData()` is unreachable here, so the page locale is pushed in by the
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

export async function ensureIndex() {
  if (state.index || state.degraded) return
  try {
    state.index = await loadIndex()
    const restored = scopeApi.restore(state.index.manifest)
    state.scope = restored.scope
    if (restored.reset) say(T('announce.scopeReset'))
    state.instruction = state.config.prompt.show ? instruction.get() : ''
    restoreConversation()
    state.ready = true
  } catch (e) {
    state.degraded = true
    state.degradedReason = String(e.message || e)
  }
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
    try {
      if (!embedderMatchesIndex()) throw new Error('embedder does not match the index')
      queryVec = await embedQuery(q, { ...embedTarget(cfg), signal })
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

    const retrieval = createRetrieval({
      index: state.index,
      scope: frozen,
      guard: guard.value,
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
    let composedVec
    if (antecedent && queryVec) {
      try {
        composedVec = await embedQuery(`${antecedent}\n${q}`, { ...embedTarget(cfg), signal })
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
        degraded: mode === 'lexical-only',
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

    if (state.fallbackUnknown !== false) {
      state.fallback = !(await detectTools({
        provider: cfg.llm.provider,
        baseURL: cfg.llm.baseURL,
        model: cfg.llm.model,
        apiKey: cfg.llm.apiKey,
        signal,
      }))
      state.fallbackUnknown = false
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
      onPhase: (p) => {
        state.status = p
      },
      onStream: (ev) => onStream(turn, ev, started),
      signal,
    })

    turn.gate = g
    turn.iterations = result.iterations
    turn.rejectedFetches = result.rejectedFetches
    turn.support = result.support
    if (result.think) turn.thought = result.think
    if (turn.thought) {
      turn.thoughtSeconds = Math.max(1, Math.round((performance.now() - started) / 1000))
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
          degraded: mode === 'lexical-only',
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
    // Two citations into one section — the retriever splits a long section into
    // `#aws-s3-bucket` and `#aws-s3-bucket-2`, which share an anchor — are one
    // destination and get one row. `cited` keeps a row per citation so marker
    // [2] still resolves; it simply resolves to the same row as [1].
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
  turn.model = state.config.llm.model
  turn.retrieval = state.retrieval
  turn.promptHash = promptHash(state.config.prompt, state.config.product)
  turn.promptStock = !state.instruction
  turn.addendumHash = instruction.hash(state.instruction)
  turn.addendumChars = state.instruction.length
  state.busy = false
  state.status = null
  controller = null
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
