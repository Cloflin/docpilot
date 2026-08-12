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
import { promptHash, detectLanguage } from './prompt.js'
import { redactSecrets, credentialCopy } from './credentials.js'

const THREAD_KEY = 'stripo-ask-ai:session'

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
  feedbackEndpoint: null,
  guard: { mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3 },
  scope: { enabled: true, default: 'all', promptListLimit: 12 },
  // `override` / `extend` are the BUILD-TIME instruction text from
  // ask-ai.config.mjs — a different thing from `allowAppend`, which is the
  // reader's own per-session addendum and never reaches the system message.
  prompt: { show: true, allowAppend: false, appendMaxChars: 500, override: null, extend: '' },
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
  status: null, // { phase, label }
  busy: false,
  dockPanel: null, // 'picker' | 'prompt' | null
  instruction: '',
  announce: '',
  currentPath: '/',
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

export function configure(themeConfig, path) {
  const cfg = themeConfig?.askAI || {}
  state.config = {
    ...DEFAULTS,
    ...cfg,
    llm: { ...DEFAULTS.llm, ...(cfg.llm || {}) },
    embed: { ...DEFAULTS.embed, ...(cfg.embed || {}) },
    guard: { ...DEFAULTS.guard, ...(cfg.guard || {}) },
    scope: { ...DEFAULTS.scope, ...(cfg.scope || {}) },
    prompt: { ...DEFAULTS.prompt, ...(cfg.prompt || {}) },
  }
  // scope.default keeps a rejected value in the schema deliberately: a build-time
  // default of `page` would silently narrow every reader's first question.
  if (state.config.scope.default !== 'all') {
    // eslint-disable-next-line no-console
    console.error('[ask-ai] scope.default only accepts "all"; ignoring', state.config.scope.default)
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
  if (path) state.currentPath = path
  sessionId = sessionId || newId('s')
  if (typeof window !== 'undefined') {
    state.debug = new URLSearchParams(location.search).has('askdebug')
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
    `[ask-ai] index was built with "${built}" but this build embeds with "${live}" — ` +
      'retrieval is running lexical-only. Rebuild the index (npm run rag:index) or fix embed.model.',
  )
  return false
}

export const knownPaths = computed(
  () => new Set((state.index?.manifest.pages || []).map((p) => p.path)),
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

export const scopeLabel = computed(() => state.scope.label || 'All docs')

export const offersSection = computed(
  () => !!state.index && scopeApi.offersSection(state.currentPath, state.index.manifest),
)

export const currentPathIndexed = computed(() => knownPaths.value.has(state.currentPath))

function say(message) {
  state.announce = message
}

export async function ensureIndex() {
  if (state.index || state.degraded) return
  try {
    state.index = await loadIndex()
    const restored = scopeApi.restore(state.index.manifest)
    state.scope = restored.scope
    if (restored.reset) say('Scope reset to all docs.')
    state.instruction = state.config.prompt.show ? instruction.get() : ''
    restoreThread()
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

export function newChat() {
  stop()
  state.turns = []
  state.scope = { ...scopeApi.ALL }
  instruction.clear()
  state.instruction = ''
  state.dockPanel = null
  persistThread()
  if (state.index) scopeApi.save(state.scope, state.index.manifest.hash)
}

export function setScope(paths) {
  state.scope = scopeApi.makeScope(paths, state.index.manifest)
  scopeApi.save(state.scope, state.index.manifest.hash)
  say(`Scope: ${state.scope.label}.`)
}

export function setInstruction(value) {
  state.instruction = instruction.set(value)
  say(state.instruction ? 'Instruction saved.' : 'Instruction removed.')
}

function persistThread() {
  try {
    sessionStorage.setItem(
      THREAD_KEY,
      JSON.stringify({ hash: state.index?.manifest.hash, turns: state.turns }),
    )
  } catch {
    /* nothing to do — the thread lives for this page */
  }
}

function restoreThread() {
  try {
    const raw = sessionStorage.getItem(THREAD_KEY)
    if (!raw) return
    const { hash, turns } = JSON.parse(raw)
    if (hash === state.index?.manifest.hash && Array.isArray(turns)) state.turns = turns
  } catch {
    /* ignore */
  }
}

/**
 * One row of the source list.
 *
 * The leading slot is the SECTION heading, not the page title. Three citations
 * into one long page — `#aws-s3-bucket`, `#default-stripo-storage`, `#azure` —
 * render as three identical rows otherwise, and the reader has no way to tell
 * which link goes where. The page title moves into the ancestor tail, in front
 * of the sidebar section, so the row reads inward: heading · page · section.
 * A page-level chunk has no heading of its own and keeps the old two-part row.
 */
function sourceRow(c) {
  const page = state.index.manifest.pages.find((p) => p.path === c.path)
  const pageTitle = page?.title || c.breadcrumb || c.title
  const heading = c.title && c.title !== pageTitle ? c.title : null
  return {
    n: 0,
    id: c.id,
    href: `${c.path}${c.anchor ? `#${c.anchor}` : ''}`,
    title: heading || pageTitle,
    tail: [heading ? pageTitle : null, page?.tail].filter(Boolean).join(' · '),
  }
}

/**
 * A turn that settled before the highlighter arrived gets its colour late.
 *
 * `renderAnswer` is a pure function of (text, knownPaths, cited) and the turn
 * keeps all three, so this is the same render again, in colour. A turn restored
 * from an older sessionStorage payload has citations but no `cited` array;
 * re-rendering that one would strip its markers, so it is left alone —
 * citation integrity outranks syntax colour.
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

function makeTurn(question, frozen) {
  return reactive({
    id: newId('m'),
    question,
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
    reasons: [],
    reasonOpen: false,
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
export async function submit(question) {
  const q = String(question || '').trim()
  if (!q || state.busy) return
  await ensureIndex()
  if (state.degraded) return

  const frozen = scopeApi.freeze(state.scope)

  // ── credentials: settled here, with zero network calls ────────────────────
  //
  // `clean` replaces `q` from this line on. The original is referenced nowhere
  // below, is never assigned to `turn.question`, and so cannot reach
  // sessionStorage (persistThread) or a feedback report — both of which read
  // the turn, not the composer.
  const { clean, kinds, count } = redactSecrets(q)
  if (count) {
    const turn = makeTurn(clean, frozen)
    turn.state = 'no-answer'
    turn.refusal = {
      cause: 'credential',
      scopeLabel: frozen.label,
      pagesRead: 0,
      degraded: false,
      closest: [],
      closestAreOutside: false,
    }
    // The copy is picked by the host, from the same script/function-word
    // detector the language directive uses — there is no model call in which a
    // "answer in the reader's language" instruction could be honoured.
    turn.credential = { kinds, count, copy: credentialCopy(detectLanguage(clean)) }
    state.turns.push(turn)
    finishTurn(turn, performance.now())
    return
  }

  stop()
  controller = new AbortController()
  const signal = controller.signal

  const turn = makeTurn(q, frozen)
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
      mode = 'lexical-only'
      state.retrieval = 'lexical-only'
      state.retrievalError = String(e?.message || e)
      const t = embedTarget(cfg)
      // eslint-disable-next-line no-console
      console.error(
        `[ask-ai] the embedder is unreachable (${t.provider}/${t.model} at ${t.baseURL}): ` +
          `${state.retrievalError}. Retrieval is running lexical-only, which on an ` +
          'English corpus finds nothing for a question in another language.',
      )
    }

    const retrieval = createRetrieval({
      index: state.index,
      scope: frozen,
      guard: guard.value,
      dev: import.meta.env?.DEV,
      onDebug: (kind, data) => state.debug && console.debug('[ask-ai]', kind, data),
    })

    const previous = state.turns.length > 1 ? state.turns[state.turns.length - 2].question : null
    let composedVec
    if (previous && queryVec) {
      try {
        composedVec = await embedQuery(`${previous}\n${q}`, { ...embedTarget(cfg), signal })
      } catch {
        composedVec = undefined
      }
    }

    const g = retrieval.evaluate({
      question: q,
      previousQuestion: previous,
      queryVec,
      composedVec,
      mode,
    })
    if (state.debug) console.debug('[ask-ai] gate', g)

    // ── the gate may end the turn here, before any model call ────────────────
    if (cfg.guard.mode !== 'off' && !g.pass) {
      const cause = g.wouldPassUnscoped ? 'out-of-scope' : 'no-evidence'
      turn.state = 'no-answer'
      turn.refusal = {
        cause,
        scopeLabel: frozen.label,
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
      gateResult: { ...g, GUnscoped: g.wouldPassUnscoped ? g.G : g.G },
      question: q,
      history: state.turns.slice(0, -1).map((t) => ({ question: t.question, answer: t.answerText })),
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
        console.debug('[ask-ai] low-confidence or untraceable', why, {
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
          pagesRead: 0,
          closest: [],
          closestAreOutside: false,
        }
      }
    } else {
      turn.state = 'error'
      turn.error = String(e.message || e)
      // The panel renders one sentence for every transport failure, by design —
      // a reader cannot act on a stack trace. But `?askdebug=1` exists to print
      // the trace, and the failure that ends the turn is the one thing worth
      // printing most: without this the only signal is "didn't respond", with
      // the cause held in state and shown nowhere.
      if (state.debug) console.error('[ask-ai] turn failed', e)
    }
    finishTurn(turn, started)
  }
}

function finishTurn(turn, started) {
  turn.latencyMs = Math.round(performance.now() - started)
  turn.streaming = false
  turn.thoughtOpen = false
  state.busy = false
  state.status = null
  controller = null
  persistThread()
  if (turn.state === 'complete') say(`Answer ready. ${turn.sources.length} sources.`)
  // A credential turn searched nothing, so "I couldn't find this in the docs"
  // would be a claim about the corpus for a turn that never looked at it — the
  // same falsehood §13 already forbids on a degraded search. The announcement
  // is the warning itself, in the language it was written in.
  else if (turn.refusal?.cause === 'credential') say(turn.credential.copy.lead)
  else if (turn.state === 'no-answer') say(`I couldn't find this in ${turn.refusal.scopeLabel}.`)
}

export function vote(turn, verdict) {
  turn.verdict = turn.verdict === verdict ? null : verdict
  turn.reasonOpen = turn.verdict === 'down'
  if (!turn.verdict) return
  writeFeedback(turn)
  say('Feedback recorded.')
}

export function chooseReason(turn, reason) {
  turn.reasons = [reason]
  turn.reasonOpen = false
  writeFeedback(turn)
}

function writeFeedback(turn) {
  feedback.record(
    {
      ts: Date.now(),
      sessionId,
      messageId: turn.id,
      question: turn.question,
      answer: turn.answerText,
      citations: turn.sources.map((s) => s.href),
      retrievedIds: turn.gate?.chunks?.map((c) => c.id) || [],
      retrieval: state.retrieval,
      model: state.config.llm.model,
      iterations: turn.iterations ?? 0,
      rejectedFetches: turn.rejectedFetches ?? 0,
      latencyMs: turn.latencyMs,
      verdict: turn.verdict,
      reasons: turn.reasons,
      comment: null,
      refusal: turn.refusal?.cause || null,
      gate: turn.gate
        ? {
            G: turn.gate.G,
            tau: turn.gate.threshold,
            mode: turn.gate.mode,
            n: turn.gate.n,
            channel: turn.gate.channel,
            source: guard.value.source,
            wouldPassUnscoped: turn.gate.wouldPassUnscoped,
          }
        : null,
      support: turn.support ?? null,
      scope: turn.scope,
      promptHash: promptHash(state.config.prompt),
      promptStock: !state.instruction,
      addendumHash: instruction.hash(state.instruction),
      addendumChars: state.instruction.length,
    },
    { feedbackEndpoint: state.config.feedbackEndpoint },
  )
}

export function widen(turn) {
  state.scope = { ...scopeApi.ALL }
  scopeApi.save(state.scope, state.index.manifest.hash)
  submit(turn.question)
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
  submit(turn.question)
}
