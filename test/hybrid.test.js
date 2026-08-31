import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { srcText } from './helpers/source.js'

import { resolveDocPilot, themeDocPilot } from '../src/config.js'
import { assembleIndex, __setIndex } from '../src/theme/docpilot/store.js'
import { resetPools } from '../src/theme/docpilot/llm.js'
import * as session from '../src/theme/docpilot/session.js'

/**
 * THE HYBRID ANSWER — the last rung of the answer ladder.
 *
 * Every service the environment selected was asked and none of them answered.
 * By the time that is known the turn has already embedded the question or
 * deliberately not, searched the corpus on both channels, and scored the gate —
 * none of which needed a model. The panel used to throw all of it away and print
 * "The AI service didn't respond." with a Retry button.
 *
 * So the turn settles as the search-only product, reached at runtime rather than
 * by configuration: the same rows, the same links, the same empty-state floor,
 * under one sentence saying the models are unreachable. What this file pins is
 * WHEN that settle applies and when the old error is still the right answer —
 * the distinction is "was there anything retrieved", not "did something fail".
 */

const ENV = { OPENROUTER_API_KEY: 'k' }

const ROWS = [
  {
    id: 'a#one',
    path: '/a',
    anchor: 'one',
    title: 'Alpha',
    breadcrumb: 'Docs',
    kind: 'guide',
    text: 'Docs — Alpha\nThe alpha widget is configured with a manifest and a token.',
    prev: null,
    next: null,
  },
  {
    id: 'b#one',
    path: '/b',
    anchor: 'one',
    title: 'Beta',
    breadcrumb: 'Docs',
    kind: 'reference',
    text: 'Docs — Beta\nThe beta gizmo installs from the registry and needs no token.',
    prev: null,
    next: null,
  },
]

const GUARD = {
  tau: 0.3,
  tauLexical: 0.3,
  wDense: 0.75,
  wLexical: 0.25,
  denseMode: 'cosine',
  cosFloor: 0.44,
  cosCeil: 0.64,
  zexp: null,
}

let fixtureCount = 0
const install = () => {
  // A distinct hash per fixture: `miniSearchFor` memoises its instance on it.
  const hash = `hybrid-${++fixtureCount}`
  const index = assembleIndex({
    manifest: {
      version: 3,
      hash,
      embedModel: null,
      dims: 0,
      vectors: null,
      chunkCount: ROWS.length,
      pages: [
        { path: '/a', title: 'Page /a', tail: 'Docs' },
        { path: '/b', title: 'Page /b', tail: 'Docs' },
      ],
      sections: [],
      guard: GUARD,
    },
    shards: [ROWS.map((r) => ({ ...r }))],
    vectorBuffer: null,
    dfDoc: { df: {} },
  })
  __setIndex(Promise.resolve(index))
  return index
}

/**
 * Every request fails, however many services are asked.
 *
 * 404 rather than 503 deliberately: a retryable status would make each candidate
 * wait out its backoff, and what is under test is the settle, not the waiting
 * free-pool.test.js already pins.
 */
const allDown = (status = 404) =>
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({}),
  }))

const lastTurn = () => session.state.turns[session.state.turns.length - 1]

describe('a turn no service could answer', () => {
  beforeEach(() => {
    // An answering configuration — `embed: false` only so the turn needs no
    // embedding call to reach retrieval. The chat half is live, and the point of
    // the file is that every call it makes fails.
    session.configure(
      { docPilot: themeDocPilot(resolveDocPilot({ embed: false }, ENV), ENV) },
      '/a',
      'en',
    )
    session.state.turns = []
    session.state.index = null
    session.state.busy = false
    session.state.degraded = false
    install()
  })

  afterEach(() => {
    __setIndex(null)
    vi.unstubAllGlobals()
    resetPools()
  })

  it('settles as the passages, saying why they are the answer', async () => {
    allDown()
    await session.submit('alpha widget token')
    const turn = lastTurn()
    expect(turn.state).toBe('results')
    expect(turn.hybrid).toBe(true)
    expect(turn.results.length).toBeGreaterThan(0)
    expect(turn.results[0].href).toBe('/a#one')
    // Nothing wrote prose, so nothing claims anything — the same contract the
    // search-only mode answers under.
    expect(turn.answerText).toBe('')
    expect(turn.sources).toEqual([])
    // The cause travels for `?dpdebug=1` and is never rendered.
    expect(turn.error).toMatch(/404/)
  })

  /**
   * THE GATE STILL COMES FIRST WHERE IT IS ENFORCED, and the ladder is never
   * climbed to find that out.
   *
   * A question the corpus does not answer is refused before any service is
   * asked — no request, no rotation, no hybrid settle — and it keeps the
   * refusal's own copy, which says the corpus has nothing rather than that the
   * models are down. Reporting an outage on a turn where nothing was ever
   * dialled would be the same lie in the other direction.
   *
   * `guard: {mode: 'calibrated'}` is written here rather than inherited: this
   * fixture is a VECTORLESS index, which is exactly the shape the shipped
   * `dense-only` stops enforcing on, and the next test is the other half of that
   * pair. Both are worth pinning — the refusal path has to keep working for the
   * deployments that ask for it.
   */
  it('is never reached when the gate refuses first, where the gate is enforced', async () => {
    session.configure(
      { docPilot: themeDocPilot(resolveDocPilot({ embed: false, guard: { mode: 'calibrated' } }, ENV), ENV) },
      '/a',
      'en',
    )
    let asked = 0
    vi.stubGlobal('fetch', async () => {
      asked++
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
    })
    await session.submit('quarterly hiring headcount forecast')
    const turn = lastTurn()
    expect(asked).toBe(0)
    expect(turn.state).toBe('no-answer')
    expect(turn.hybrid).toBe(false)
    expect(turn.gate.pass).toBe(false)
  })

  /**
   * AND THE SHIPPED GATE DOES NOT REFUSE IT — the other half, on the same
   * fixture and the same question.
   *
   * `dense-only` is the default and this is the deployment shape it changes: no
   * vectors, so `G = L`, and `L` is token overlap between the question and the
   * corpus. A refusal computed from that says the corpus has nothing when the
   * truth is that this channel cannot tell — which is the same sentence for a
   * question in another language, a question using another name for the product,
   * and a question the corpus genuinely does not answer.
   *
   * So the request IS made. Here every service refuses it, so the turn settles
   * as the hybrid answer above — the passages, under the sentence that says the
   * models are unreachable — and the verdict travels with it rather than
   * deciding it.
   */
  it('reaches the model on a vectorless turn, because L alone cannot tell', async () => {
    let asked = 0
    vi.stubGlobal('fetch', async () => {
      asked++
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
    })
    await session.submit('quarterly hiring headcount forecast')
    const turn = lastTurn()
    expect(asked).toBeGreaterThan(0)
    expect(turn.gate.pass).toBe(false)
    expect(turn.state).toBe('results')
    expect(turn.hybrid).toBe(true)
  })

  /**
   * A failure BEFORE there is anything to show is still the transport error it
   * always was. The distinction the settle turns on is whether retrieval ran,
   * not whether something failed — "here are the passages" with no passages
   * behind it would be the same empty apology in nicer words.
   *
   * Pinned from source: an index that never loads settles as `state.degraded`
   * and never reaches a turn at all, so the branch below it is unreachable from
   * `submit` and only its text can say it is still there.
   */
  it('keeps the transport error for a failure with nothing retrieved', () => {
    const src = srcText('src/theme/docpilot/session.js')
    const catchBlock = src.slice(src.indexOf('} catch (e) {', src.indexOf('const started = performance.now()')))
    // The hybrid arm is GUARDED on retrieval having happened...
    expect(catchBlock).toMatch(/\} else if \(retrieval && !turn\.answerText\) \{/)
    // ...and the transport error is the arm behind it, unchanged.
    const hybridAt = catchBlock.indexOf('} else if (retrieval && !turn.answerText) {')
    const errorAt = catchBlock.indexOf("turn.state = 'error'")
    expect(errorAt).toBeGreaterThan(hybridAt)
  })

  /**
   * The day's quota keeps ITS state — its own sentence, its reset, no Retry —
   * and gains the rows beneath it. They cost nothing: retrieval settled before
   * the first request went out.
   */
  it('lists the passages under a spent daily limit without changing the state', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 429,
      headers: new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Date.now() + 7200_000),
      }),
      json: async () => ({ error: { message: 'Rate limit exceeded: free-models-per-day' } }),
    }))
    await session.submit('alpha widget token')
    const turn = lastTurn()
    expect(turn.state).toBe('rate-limited')
    // NOT the hybrid settle: that state has its own explanation, and two
    // explanations for one turn is one too many.
    expect(turn.hybrid).toBe(false)
    expect(turn.results.length).toBeGreaterThan(0)
    expect(turn.rateLimit.resetAt).toBeGreaterThan(Date.now())
  })
})

/**
 * The panel's half of the settle, pinned from source text.
 *
 * These are one-line renderings whose absence is invisible to every other test
 * in the suite: a `turn.hybrid` nothing reads is a settle that reaches the
 * reader as an unexplained list of links.
 */
describe('what the panel does with it', () => {
  const panel = srcText('src/theme/components/DocPilot.vue')
  const i18n = srcText('src/theme/docpilot/i18n.js')

  it('leads a hybrid turn with the reason, and offers Retry on it alone', () => {
    expect(panel).toMatch(/turn\.hybrid\s*\n?\s*\?[\s\S]{0,120}hybrid\.lead/)
    expect(panel).toMatch(/v-if="turn\.hybrid"[\s\S]{0,400}error\.retry/)
  })

  it('lists the passages under a spent limit, with their own quieter line', () => {
    expect(panel).toMatch(/turn\.results\?\.length[\s\S]{0,200}hybrid\.meanwhile/)
  })

  /**
   * NO `role="alert"`. The settle is announced through the polite live region
   * like every other settled turn — an assertive region on top of that reads the
   * same sentence twice. The rate-limited state established the precedent.
   */
  it('does not shout it', () => {
    const results = panel.slice(panel.indexOf("turn.state === 'results'"))
    expect(results.slice(0, results.indexOf("turn.state === 'error'"))).not.toMatch(/role="alert"/)
  })

  it('ships the two sentences and the announcement', () => {
    expect(i18n).toMatch(/hybrid:\s*\{[\s\S]{0,400}lead:/)
    expect(i18n).toMatch(/meanwhile:/)
    expect(i18n).toMatch(/hybrid: 'The AI models are unavailable/)
  })

  /**
   * `fallback` ALREADY MEANS TWO OTHER THINGS in this codebase — the text-mode
   * tool transport, and `embed.fallback: 'lexical'` at build time. A third
   * meaning in the reader's copy would make every one of them unsearchable.
   */
  it('does not call any of it a fallback', () => {
    const ladder = srcText('src/theme/docpilot/llm.js')
    const hybridCopy = i18n.slice(i18n.indexOf('hybrid: {'), i18n.indexOf('refusal: {'))
    expect(hybridCopy).not.toMatch(/fallback/i)
    expect(ladder.match(/memberRotatable|orderMembers|walkOne/g)?.length).toBeGreaterThan(0)
  })
})
