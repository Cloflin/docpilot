import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { srcText } from './helpers/source.js'

import { assembleIndex, __setIndex } from '../src/theme/docpilot/store.js'
import * as session from '../src/theme/docpilot/session.js'
import { matchOpener, similarity, answerFor, openerQuestions, openerFingerprint } from '../src/theme/docpilot/openers.js'
import { normalise, questionsHash } from '../src/theme/docpilot/text.js'
import { resolveSuggestions, DEFAULT_SUGGESTIONS, MATCH_NEVER } from '../src/theme/docpilot/switches.js'
import { bakeOpeners } from '../src/build/lib/openers.js'

/**
 * A QUESTION THIS BUILD ALREADY RESOLVED — engine-specs/009, ui-specs/013.
 *
 * Two halves, pinned separately because they fail differently. The bake is a
 * build step whose failures are loud and land on the author; the match is a
 * runtime branch whose failures are silent and land on the reader — a
 * paraphrase served the wrong answer, with real citations, about the wrong
 * thing. Most of what is below is about the second kind.
 */

const ROWS = [
  {
    id: 'install#one',
    path: '/install',
    anchor: 'one',
    title: 'Installing',
    breadcrumb: 'Docs',
    kind: 'guide',
    text: 'Docs — Installing\nInstall the package with npm and mount the plugin in your config.',
    prev: null,
    next: null,
  },
  {
    id: 'gate#one',
    path: '/gate',
    anchor: 'one',
    title: 'The refusal gate',
    breadcrumb: 'Docs',
    kind: 'reference',
    text: 'Docs — The refusal gate\nThe gate scores two channels and refuses below tau.',
    prev: null,
    next: null,
  },
  {
    id: 'sidebar#one',
    path: '/sidebar',
    anchor: 'one',
    title: 'The sidebar',
    breadcrumb: 'Docs',
    kind: 'guide',
    text: 'Docs — The sidebar\nThe sidebar is generated from the directory tree.',
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

const DF = { n: ROWS.length, df: { instal: 1, packag: 1, npm: 1, gate: 1, refus: 1, tau: 1, sidebar: 1, channel: 1 } }

let n = 0
function indexWith(openers, { lexicalOnly = true } = {}) {
  const hash = `openers-${++n}`
  return assembleIndex({
    manifest: {
      version: 3,
      hash,
      embedModel: lexicalOnly ? null : 'fake-embed',
      dims: lexicalOnly ? 0 : 4,
      vectors: lexicalOnly ? null : `vectors.${hash}.bin`,
      chunkCount: ROWS.length,
      pages: ROWS.map((r) => ({ path: r.path, title: r.title, tail: 'Docs' })),
      sections: [],
      guard: GUARD,
      tuning: null,
      vocabulary: null,
      vocabHash: null,
      tokenizer: null,
      openers: openers ? `openers.${hash}.json` : null,
    },
    shards: [ROWS],
    vectorBuffer: lexicalOnly ? null : new Int8Array(ROWS.length * 4).buffer,
    dfDoc: DF,
    openersDoc: openers ? { hash, ...openers } : null,
  })
}

const QUESTIONS = ['How do I configure the refusal gate?', 'How do I install the package?']

const bundleFor = (entries, over = {}) => ({
  configHash: questionsHash(QUESTIONS),
  embedModel: 'fake-embed',
  dims: 4,
  matchTau: 0.75,
  entries,
  ...over,
})

const entry = (q, over = {}) => ({
  q,
  qnorm: normalise(q),
  lang: 'en',
  vec: null,
  ids: ['gate#one'],
  gate: { pass: true, G: 0.8, D: 0.9, L: 0.6, z: 1, n: 3, channel: 'raw', threshold: 0.3, mode: 'lexical-only' },
  answer: null,
  ...over,
})

const CONFIG = { suggestions: resolveSuggestions({ suggestions: QUESTIONS }), embed: { lexicalOnly: false } }
const ARGS = { config: CONFIG, scope: { kind: 'all' }, quote: '', turns: [], locale: 'en' }

describe('openers — the match', () => {
  it('hits on the question as written', () => {
    const index = indexWith(bundleFor([entry(QUESTIONS[0])]))
    const hit = matchOpener(QUESTIONS[0], { index, ...ARGS })
    expect(hit?.matched).toBe('exact')
    expect(hit.score).toBe(1)
  })

  it('hits through case, spacing and a trailing question mark', () => {
    const index = indexWith(bundleFor([entry(QUESTIONS[0])]))
    for (const typed of [
      'how do i configure the refusal gate',
      '  How  do I   configure the refusal gate?  ',
      'HOW DO I CONFIGURE THE REFUSAL GATE!!',
    ]) {
      expect(matchOpener(typed, { index, ...ARGS })?.matched, typed).toBe('exact')
    }
  })

  /**
   * THE SUBSET TRAP, and it is the whole reason the score is symmetric.
   *
   * One-directional coverage scores "gate" at 1.0 against "How do I configure
   * the refusal gate?" — every rare term of the query is present. A reader
   * asking one thing would be handed the answer to another, cited correctly,
   * about the other thing.
   */
  it('refuses a fragment of an opener', () => {
    const index = indexWith(bundleFor([entry(QUESTIONS[0])]))
    expect(matchOpener('gate', { index, ...ARGS })).toBe(null)
    expect(matchOpener('refusal', { index, ...ARGS })).toBe(null)
  })

  it('refuses a question about something else', () => {
    const index = indexWith(bundleFor([entry(QUESTIONS[0])]))
    expect(matchOpener('How do I configure the sidebar?', { index, ...ARGS })).toBe(null)
  })

  it('refuses a tie rather than picking by array order', () => {
    const twins = ['How do I configure the gate?', 'How do I configure the gate!']
    const index = indexWith(
      bundleFor(twins.map((q) => entry(q)), { configHash: questionsHash(twins) }),
    )
    const config = { ...CONFIG, suggestions: resolveSuggestions({ suggestions: twins }) }
    expect(matchOpener('configure gate', { index, ...ARGS, config })).toBe(null)
  })

  it('matchTau false leaves exact matching and retires the paraphrase', () => {
    const config = {
      ...CONFIG,
      suggestions: resolveSuggestions({ suggestions: { questions: QUESTIONS, matchTau: false } }),
    }
    expect(config.suggestions.matchTau).toBe(MATCH_NEVER)
    const index = indexWith(bundleFor([entry(QUESTIONS[0])]))
    expect(matchOpener(QUESTIONS[0], { index, ...ARGS, config })?.matched).toBe('exact')
    expect(matchOpener('configure the refusal gate please', { index, ...ARGS, config })).toBe(null)
  })

  it('is symmetric', () => {
    const index = indexWith(bundleFor([entry(QUESTIONS[0])]))
    const a = similarity('gate', QUESTIONS[0], index.df)
    const b = similarity(QUESTIONS[0], 'gate', index.df)
    expect(a).toBe(b)
  })
})

describe('openers — every precondition declines', () => {
  const index = () => indexWith(bundleFor([entry(QUESTIONS[0], { answer: { lang: 'en', text: 'a', citations: ['gate#one'] } })]))

  it('precomputed off', () => {
    const config = {
      ...CONFIG,
      suggestions: resolveSuggestions({ suggestions: { questions: QUESTIONS, precomputed: false } }),
    }
    expect(matchOpener(QUESTIONS[0], { index: index(), ...ARGS, config })).toBe(null)
  })

  it('no bundle at all', () => {
    expect(matchOpener(QUESTIONS[0], { index: indexWith(null), ...ARGS })).toBe(null)
  })

  /**
   * The load-bearing guard: an author edits a question and ships without
   * reindexing. The whole bundle is ignored, so there is no state in which a
   * question can be served evidence resolved for a different question.
   */
  it('a configHash that no longer matches the configured questions', () => {
    const config = {
      ...CONFIG,
      suggestions: resolveSuggestions({ suggestions: ['How do I configure the refusal gate, exactly?'] }),
    }
    expect(matchOpener(QUESTIONS[0], { index: index(), ...ARGS, config })).toBe(null)
  })

  it('a bundle baked against another index', () => {
    const i = index()
    i.openers.hash = 'somewhere-else'
    expect(matchOpener(QUESTIONS[0], { index: i, ...ARGS })).toBe(null)
  })

  it('a narrowed scope keeps the vector and drops the answer', () => {
    const hit = matchOpener(QUESTIONS[0], { index: index(), ...ARGS, scope: { kind: 'pages' } })
    expect(hit?.matched).toBe('exact')
    expect(hit.answer).toBe(null)
  })

  it('an attached quote drops the answer', () => {
    expect(matchOpener(QUESTIONS[0], { index: index(), ...ARGS, quote: 'a passage' }).answer).toBe(null)
  })

  it('a follow-up drops the answer', () => {
    expect(matchOpener(QUESTIONS[0], { index: index(), ...ARGS, turns: [{}] }).answer).toBe(null)
  })

  it('answers off drops the answer and keeps the match', () => {
    const config = {
      ...CONFIG,
      suggestions: resolveSuggestions({ suggestions: { questions: QUESTIONS, answers: false } }),
    }
    const hit = matchOpener(QUESTIONS[0], { index: index(), ...ARGS, config })
    expect(hit.matched).toBe('exact')
    expect(hit.answer).toBe(null)
  })
})

describe('openers — the baked answer and the reader’s language', () => {
  const withAnswer = (lang) =>
    indexWith(bundleFor([entry(QUESTIONS[0], { answer: { lang, text: 'Install it.', citations: ['install#one'] } })]))

  it('serves an English answer to an English question', () => {
    expect(matchOpener(QUESTIONS[0], { index: withAnswer('en'), ...ARGS }).answer?.text).toBe('Install it.')
  })

  it('never serves an English answer to a Russian one', () => {
    const hit = matchOpener(QUESTIONS[0], { index: withAnswer('en'), ...ARGS, locale: 'ru' })
    expect(hit.answer).toBe(null)
    expect(hit.matched).toBe('exact')
  })

  it('zh-CN reads a zh bake; fr does not read an en bake', () => {
    expect(answerFor({ answer: { lang: 'zh', text: 't', citations: ['x'] } }, 'zh-CN')).toBeTruthy()
    expect(answerFor({ answer: { lang: 'en', text: 't', citations: ['x'] } }, 'fr')).toBe(null)
  })

  it('never serves an answer with no citations', () => {
    expect(answerFor({ answer: { lang: 'en', text: 't', citations: [] } }, 'en')).toBe(null)
  })
})

describe('openers — what gets baked', () => {
  const MANIFEST = {
    version: 3,
    hash: 'bake-1',
    embedModel: null,
    dims: 0,
    vectors: null,
    chunkCount: ROWS.length,
    pages: ROWS.map((r) => ({ path: r.path, title: r.title, tail: 'Docs' })),
    sections: [],
    guard: GUARD,
    tuning: null,
    vocabulary: null,
    vocabHash: null,
    tokenizer: null,
  }
  const base = {
    manifest: MANIFEST,
    chunks: ROWS,
    vectorBuffer: null,
    dfDoc: DF,
    hash: 'bake-1',
    embed: { model: null, provider: null, baseURL: null, apiKey: null, cache: null },
    docPilot: { prompt: {}, product: 'Docs' },
    warn: () => {},
  }

  it('bakes nothing, and asks for nothing, when no question is configured', async () => {
    let called = 0
    const out = await bakeOpeners({
      ...base,
      questions: [],
      chat: { searchOnly: true },
      embedFn: () => { called++ },
    })
    expect(out.bundle).toBe(null)
    expect(called).toBe(0)
  })

  it('a vectorless index bakes evidence with no embedding request', async () => {
    let called = 0
    const out = await bakeOpeners({
      ...base,
      questions: QUESTIONS,
      answers: false,
      chat: { searchOnly: true },
      embedFn: () => { called++ },
    })
    expect(called).toBe(0)
    expect(out.entries).toHaveLength(2)
    expect(out.entries.every((e) => e.vec === null)).toBe(true)
    expect(out.entries.every((e) => e.gate.mode === 'lexical-only')).toBe(true)
    expect(out.bundle.configHash).toBe(questionsHash(QUESTIONS))
  })

  it('stamps qnorm as the lookup key, never an array position', async () => {
    const out = await bakeOpeners({
      ...base, questions: QUESTIONS, answers: false, chat: { searchOnly: true },
    })
    expect(out.entries.map((e) => e.qnorm)).toEqual(QUESTIONS.map(normalise))
  })

  it('reports an opener the gate refuses instead of hiding it', async () => {
    const out = await bakeOpeners({
      ...base,
      questions: ['How do I file my taxes in Portugal?'],
      answers: false,
      chat: { searchOnly: true },
    })
    expect(out.report.refused.map((r) => r.q)).toEqual(['How do I file my taxes in Portugal?'])
    expect(out.entries[0].gate.pass).toBe(false)
  })

  it('reports two openers a paraphrase could not choose between', async () => {
    const twins = ['How do I configure the gate?', 'How do I configure the gate!']
    const out = await bakeOpeners({
      ...base, questions: twins, answers: false, chat: { searchOnly: true },
    })
    expect(out.report.collisions).toHaveLength(1)
  })

  it('never bakes an answer with no citations', async () => {
    const out = await bakeOpeners({
      ...base,
      questions: [QUESTIONS[0]],
      chat: { searchOnly: false, model: 'm', promptHash: 'p', maxIterations: 0, llm: {} },
      turnFn: async () => ({ text: 'Confident prose about nothing.', citations: [], confidence: 0.9 }),
    })
    expect(out.entries[0].answer).toBe(null)
    expect(out.report.answered).toBe(0)
  })

  it('bakes a cited answer and stamps it with the language it was asked in', async () => {
    const out = await bakeOpeners({
      ...base,
      questions: [QUESTIONS[0]],
      chat: { searchOnly: false, model: 'm', promptHash: 'p', maxIterations: 0, llm: {} },
      turnFn: async () => ({ text: 'The gate refuses below tau.', citations: ['gate#one'], confidence: 0.8 }),
    })
    expect(out.entries[0].answer.text).toBe('The gate refuses below tau.')
    expect(out.entries[0].answer.lang).toBe('en')
    expect(out.report.answered).toBe(1)
  })

  it('reuses a previous answer rather than paying for it again', async () => {
    let calls = 0
    const turnFn = async () => {
      calls++
      return { text: 'The gate refuses below tau.', citations: ['gate#one'], confidence: 0.8 }
    }
    const chat = { searchOnly: false, model: 'm', promptHash: 'p', maxIterations: 0, llm: {} }
    const first = await bakeOpeners({ ...base, questions: [QUESTIONS[0]], chat, turnFn })
    expect(calls).toBe(1)
    const second = await bakeOpeners({
      ...base, questions: [QUESTIONS[0]], chat, turnFn, previous: first.bundle,
    })
    expect(calls).toBe(1)
    expect(second.report.reused).toBe(1)
  })

  it('a moved corpus retires the cached answer', async () => {
    let calls = 0
    const turnFn = async () => {
      calls++
      return { text: 'The gate refuses below tau.', citations: ['gate#one'], confidence: 0.8 }
    }
    const chat = { searchOnly: false, model: 'm', promptHash: 'p', maxIterations: 0, llm: {} }
    const first = await bakeOpeners({ ...base, questions: [QUESTIONS[0]], chat, turnFn })
    await bakeOpeners({
      ...base,
      hash: 'bake-2',
      manifest: { ...MANIFEST, hash: 'bake-2' },
      questions: [QUESTIONS[0]],
      chat,
      turnFn,
      previous: first.bundle,
    })
    expect(calls).toBe(2)
  })
})

describe('openers — the list is one list', () => {
  it('falls back to the built-in three, so the build bakes what the panel shows', () => {
    expect(openerQuestions(resolveSuggestions({}))).toEqual(DEFAULT_SUGGESTIONS)
    expect(openerQuestions(resolveSuggestions({ suggestions: QUESTIONS }))).toEqual(QUESTIONS)
  })

  it('the fingerprint moves with an edit and with a reordering', () => {
    const a = questionsHash(['one?', 'two?'])
    expect(questionsHash(['one?', 'two?'])).toBe(a)
    expect(questionsHash(['two?', 'one?'])).not.toBe(a)
    expect(questionsHash(['one?', 'three?'])).not.toBe(a)
    // What `normalise` erases must not invalidate a bundle that still matches.
    expect(questionsHash(['  One ?', 'TWO'])).toBe(a)
  })
})

/**
 * The invariant a reviewer cannot hold and a grep can: this module's whole claim
 * is that a match costs no embedding request, and the way that stops being true
 * is an import nobody notices.
 */
describe('openers — the match path never embeds', () => {
  it('imports nothing that can reach the network', () => {
    const src = srcText('src/theme/docpilot/openers.js')
    const imports = src.match(/^import .*$/gm) || []
    expect(imports.join('\n')).not.toMatch(/embed|llm|providers|harness/)
  })

  /**
   * The same rule, applied to the tooling, and for a SHARPER reason rather than
   * a weaker one: both skill scripts print "0 requests" in their own headers,
   * and a script that makes the claim and then makes a request is worse than one
   * that never claimed it. `opener-candidates.js` assembles a real index and
   * runs the real retriever, so it is one import away from the embedder at all
   * times.
   *
   * A dynamic `import()` rather than a static one, because these load out of
   * `dist/` at run time — hence the second pattern.
   */
  it('the skill scripts import nothing that can reach the network', () => {
    const dir = 'skills/docs-rag/scripts'
    const scripts = fs.readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.js'))
    expect(scripts.length, 'skill scripts to check').toBeGreaterThan(0)
    for (const file of scripts) {
      const src = srcText(`${dir}/${file}`)
      const specifiers = [
        ...(src.match(/^import .*$/gm) || []),
        ...(src.match(/import\(pathToFileURL\([^)]*\)[^)]*\)/g) || []),
        ...(src.match(/'theme\/docpilot\/[a-z-]+\.js'/g) || []),
      ].join('\n')
      expect(specifiers, `${file} reaches the network`).not.toMatch(/embed\.js|llm\.js|providers\.js|harness\.js/)
    }
  })

  /**
   * `SUGGESTION_LIMIT` has one spelling and two readers.
   *
   * `DocPilot.vue` held its own literal `3` while `questionsOf` sliced at the
   * constant, so the warning an author read and the list a reader saw were free
   * to disagree and nothing was watching. The number is not allowed back into
   * the component.
   */
  it('the component slices at the constant, not at a literal', () => {
    const vue = srcText('src/theme/components/DocPilot.vue')
    const computed = vue.match(/const suggestions = computed\(\(\) => \{[\s\S]*?\n\}\)/)
    expect(computed, 'the suggestions computed').not.toBe(null)
    expect(computed[0]).toContain('SUGGESTION_LIMIT')
    expect(computed[0], 'a second copy of the number').not.toMatch(/slice\(0,\s*\d/)
  })
})

/**
 * THE HEADLINE CLAIM, driven through the real `submit()`.
 *
 * Everything above tests a function. This tests the promise: a reader who
 * clicks an opener does not cause a request to the embeddings endpoint. It is
 * asserted by counting URLs on a stubbed `fetch`, because that is the only
 * assertion a reader would recognise.
 */
describe('openers — a turn that costs no embedding request', () => {
  const ENV = { OPENROUTER_API_KEY: 'k' }
  const OPENER = 'How do I configure the refusal gate?'

  const withVectors = () => {
    const hash = 'openers-live'
    // Four dimensions, and the opener's vector points straight at the gate row.
    const vectors = new Int8Array([0, 0, 0, 0, 127, 0, 0, 0, 0, 127, 0, 0])
    return assembleIndex({
      manifest: {
        version: 3,
        hash,
        embedModel: 'fake-embed',
        dims: 4,
        vectors: `vectors.${hash}.bin`,
        chunkCount: ROWS.length,
        pages: ROWS.map((r) => ({ path: r.path, title: r.title, tail: 'Docs' })),
        sections: [],
        guard: GUARD,
        tuning: null,
        vocabulary: null,
        vocabHash: null,
        tokenizer: null,
        openers: `openers.${hash}.json`,
      },
      shards: [ROWS],
      vectorBuffer: vectors.buffer,
      dfDoc: DF,
      openersDoc: {
        hash,
        configHash: questionsHash([OPENER]),
        embedModel: 'fake-embed',
        dims: 4,
        matchTau: 0.75,
        entries: [
          entry(OPENER, {
            vec: Buffer.from(new Int8Array([0, 127, 0, 0])).toString('base64'),
            gate: { pass: true, G: 0.9, D: 1, L: 0.7, z: 2, n: 3, channel: 'raw', threshold: 0.3, mode: 'hybrid' },
            answer: { lang: 'en', text: 'The gate refuses below tau. [1]', citations: ['gate#one'] },
          }),
        ],
      },
    })
  }

  const setup = async (over = {}) => {
    const { resolveDocPilot, themeDocPilot } = await import('../src/config.js')
    session.configure(
      {
        docPilot: themeDocPilot(
          resolveDocPilot({ suggestions: { questions: [OPENER], ...over } }, ENV),
          ENV,
        ),
      },
      '/gate',
      'en',
    )
    session.state.turns = []
    session.state.busy = false
    session.state.degraded = false
    session.state.index = withVectors()
    __setIndex(Promise.resolve(session.state.index))
  }

  afterEach(async () => {
    __setIndex(null)
    vi.unstubAllGlobals()
    const { resetPools } = await import('../src/theme/docpilot/llm.js')
    resetPools()
  })

  it('serves the baked answer with no request of any kind', async () => {
    const urls = []
    vi.stubGlobal('fetch', async (u) => {
      urls.push(String(u))
      return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) }
    })
    await setup()
    await session.submit(OPENER)
    const turn = session.state.turns.at(-1)
    expect(urls).toEqual([])
    expect(turn.state).toBe('complete')
    expect(turn.answerText).toBe('The gate refuses below tau. [1]')
    expect(turn.sources).toHaveLength(1)
    expect(turn.sources[0].href).toBe('/gate#one')
    expect(turn.opener).toEqual({ matched: 'exact', score: 1, baked: true })
  })

  /**
   * THE CASE THE LANGUAGE RULE ACTUALLY EXISTS FOR, and it is not the obvious
   * one.
   *
   * A chip carries the AUTHOR's words, so the language detected from the text is
   * the author's on every click, in every locale. What differs between two
   * readers of the same chip is the page they are on. Here a Russian build of an
   * English-authored site clicks an English opener: the baked English answer is
   * withheld and the model writes a Russian one — from evidence that was already
   * resolved, so the embeddings endpoint is still never called.
   *
   * A question typed in Russian is a different matter entirely and is covered
   * below: it matches no opener, so it is an ordinary turn.
   */
  it('withholds the baked answer on a Russian page and still skips the embedder', async () => {
    const urls = []
    vi.stubGlobal('fetch', async (u) => {
      urls.push(String(u))
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
    })
    await setup()
    session.setLang('ru')
    await session.submit(OPENER)
    const turn = session.state.turns.at(-1)
    expect(turn.answerText).not.toBe('The gate refuses below tau. [1]')
    expect(turn.opener).toEqual({ matched: 'exact', score: 1, baked: false })
    expect(urls.some((u) => /embeddings|api\/embed/.test(u))).toBe(false)
    expect(urls.some((u) => /chat|messages/.test(u))).toBe(true)
  })

  it('a question typed in another language is an ordinary turn', async () => {
    const urls = []
    vi.stubGlobal('fetch', async (u) => {
      urls.push(String(u))
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
    })
    await setup()
    await session.submit('Как настроить порог отказа в документации?')
    expect(session.state.turns.at(-1).opener).toBeUndefined()
    expect(urls.some((u) => /embeddings|api\/embed/.test(u))).toBe(true)
  })

  it('asks the embedder for a question that is not an opener', async () => {
    const urls = []
    vi.stubGlobal('fetch', async (u) => {
      urls.push(String(u))
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
    })
    await setup()
    await session.submit('How do I generate the sidebar from a directory tree?')
    expect(urls.some((u) => /embeddings|api\/embed/.test(u))).toBe(true)
  })
})

/**
 * `docpilot feedback faq` — the other end of the loop.
 *
 * The bake makes three configured questions cheap. This proposes which three
 * they should be, from what readers actually asked, and its one non-obvious
 * property is that it groups with the RUNTIME scorer: a cluster here is exactly
 * what one opener would catch in the panel.
 */
describe('feedback faq — proposing the three', () => {
  const cand = (question, over = {}) => ({
    question,
    asked: 3,
    sessions: 3,
    downRate: 0,
    refusals: { none: 3 },
    ...over,
  })

  it('groups what one opener would catch, and sums the asking', async () => {
    const { clusterQuestions } = await import('../src/feedback/faq.js')
    const out = clusterQuestions(
      [cand('How do I configure the refusal gate?'), cand('configure the refusal gate', { asked: 2, sessions: 2 })],
      { df: null, matchTau: 0.75 },
    )
    expect(out).toHaveLength(1)
    expect(out[0].asked).toBe(5)
    // Verbatim, never a synthesis: an opener is copy the reader submits.
    expect(out[0].head.question).toBe('How do I configure the refusal gate?')
  })

  it('keeps two questions apart when the panel would keep them apart', async () => {
    const { clusterQuestions } = await import('../src/feedback/faq.js')
    const out = clusterQuestions(
      [cand('How do I install the package?'), cand('How do I configure the refusal gate?')],
      { df: null, matchTau: 0.75 },
    )
    expect(out).toHaveLength(2)
  })

  /**
   * A question readers complained about is the site's WEAKEST answer. Promoting
   * it would put that answer where every reader's first click lands.
   */
  it('drops a question readers complained about', async () => {
    const { clusterQuestions } = await import('../src/feedback/faq.js')
    expect(clusterQuestions([cand('A bad one', { downRate: 0.5 })], { df: null })).toHaveLength(0)
  })

  it('drops a question the corpus refused, and a one-off', async () => {
    const { clusterQuestions } = await import('../src/feedback/faq.js')
    expect(
      clusterQuestions([cand('Refused', { refusals: { 'not-answerable': 3 } })], { df: null }),
    ).toHaveLength(0)
    expect(clusterQuestions([cand('Asked once', { asked: 1 })], { df: null })).toHaveLength(0)
  })

  it('names a configured opener nobody has ever asked for', async () => {
    const { clusterQuestions, against } = await import('../src/feedback/faq.js')
    const clusters = clusterQuestions([cand('How do I install the package?')], { df: null })
    const { rows, unasked } = against(clusters, ['How do I install the package?', 'How do I file my taxes?'], {
      df: null,
      matchTau: 0.75,
    })
    expect(rows[0].configured).toBe(true)
    expect(unasked).toEqual(['How do I file my taxes?'])
  })

  it('renders a paste-able block and keeps the bias warning', async () => {
    const { clusterQuestions, against, renderFaqReport } = await import('../src/feedback/faq.js')
    const clusters = clusterQuestions([cand('How do I install the package?')], { df: null })
    const { rows, unasked } = against(clusters, [], { df: null })
    const md = renderFaqReport(rows, {
      configured: [],
      unasked,
      send: 'down',
      source: 'x.jsonl',
      generatedAt: 'now',
    })
    expect(md).toContain('sample of VOTED turns')
    expect(md).toContain('complaints')
    expect(md).toContain('"How do I install the package?"')
    expect(md).toContain('npx docpilot index')
  })
})

/**
 * THE CACHE THAT ATE THE OTHER CACHE.
 *
 * `openEmbedCache.commit(texts)` rewrites its pair with exactly the texts its
 * caller used — self-evicting by design, so a deleted chunk stops costing disk.
 * Its namespace is derived from model, provider, baseURL and prefix, and for
 * every model that is not nomic BOTH prefixes are empty: the corpus pass and the
 * openers pass resolved to one file, and whichever committed last won. The
 * openers pass commits three questions, so it replaced 476 chunk vectors with
 * three — and said `3 embedded, 0 cached` while doing it. The next build re-bought
 * the corpus: fifteen requests, every build, silently.
 *
 * Two tests, because the bug had two halves and either one alone lets it back.
 */
describe('openers — the bake does not evict the corpus cache', () => {
  it('commits exactly the questions it used', async () => {
    const committed = []
    const cache = {
      get: () => null,
      set: () => {},
      commit: (texts) => committed.push(...texts),
      stats: () => ({ hits: 0 }),
    }
    await bakeOpeners({
      questions: QUESTIONS,
      manifest: {
        version: 3, hash: 'c-1', embedModel: 'm', dims: 4, vectors: 'v.bin',
        chunkCount: ROWS.length, pages: [], sections: [], guard: GUARD,
        tuning: null, vocabulary: null, vocabHash: null, tokenizer: null,
      },
      chunks: ROWS,
      vectorBuffer: new Int8Array(ROWS.length * 4).buffer,
      dfDoc: DF,
      hash: 'c-1',
      embed: { model: 'm', provider: 'p', baseURL: 'b', apiKey: null, cache },
      chat: { searchOnly: true },
      docPilot: { prompt: {}, product: 'Docs' },
      answers: false,
      warn: () => {},
      embedFn: async () => new Float64Array([127, 0, 0, 0]),
    })
    // Committed at all — without this the cache is a Map that dies with the
    // process and every build re-buys the same three vectors.
    expect(committed).toEqual(QUESTIONS)
  })

  it('keeps the openers cache in a directory of its own', () => {
    const src = srcText('src/build/build-rag-index.js')
    // The corpus pass and the openers pass must not be able to resolve to one
    // file, whatever the model is called and whatever its prefix rule is.
    const openerCache = src.match(/cache: vectorless[\s\S]*?\}\),/)[0]
    expect(openerCache).toMatch(/path\.join\(EMBED_CACHE_DIR, 'openers'\)/)
    expect(openerCache).not.toMatch(/dir: EMBED_CACHE_DIR,/)
  })
})

/**
 * An opener the model answered with nothing citable is dropped — and the fact
 * that it was ASKED has to survive, or the most expensive question on the site
 * is the one that never produces anything, re-asked once per build forever.
 */
describe('openers — a refusal is remembered', () => {
  const MANIFEST = {
    version: 3, hash: 'r-1', embedModel: null, dims: 0, vectors: null,
    chunkCount: ROWS.length, pages: [], sections: [], guard: GUARD,
    tuning: null, vocabulary: null, vocabHash: null, tokenizer: null,
  }
  const base = {
    manifest: MANIFEST, chunks: ROWS, vectorBuffer: null, dfDoc: DF, hash: 'r-1',
    embed: { model: null, provider: null, baseURL: null, apiKey: null, cache: null },
    docPilot: { prompt: {}, product: 'Docs' },
    warn: () => {},
  }
  const chat = { searchOnly: false, model: 'm', promptHash: 'p', maxIterations: 0, llm: {} }

  it('does not re-ask for the same nothing', async () => {
    let calls = 0
    const turnFn = async () => {
      calls++
      return { text: 'Prose with no citation.', citations: [] }
    }
    const first = await bakeOpeners({ ...base, questions: [QUESTIONS[0]], chat, turnFn })
    expect(calls).toBe(1)
    expect(first.entries[0].answer).toBe(null)
    expect(first.entries[0].answerAttempt).toEqual({ promptHash: 'p', model: 'm' })

    const second = await bakeOpeners({
      ...base, questions: [QUESTIONS[0]], chat, turnFn, previous: first.bundle,
    })
    expect(calls).toBe(1)
    expect(second.report.reusedRefusal).toBe(1)
  })

  it('but a corpus edit is exactly the thing that earns a retry', async () => {
    let calls = 0
    const turnFn = async () => {
      calls++
      return { text: 'Prose with no citation.', citations: [] }
    }
    const first = await bakeOpeners({ ...base, questions: [QUESTIONS[0]], chat, turnFn })
    await bakeOpeners({
      ...base,
      hash: 'r-2',
      manifest: { ...MANIFEST, hash: 'r-2' },
      questions: [QUESTIONS[0]],
      chat,
      turnFn,
      previous: first.bundle,
    })
    expect(calls).toBe(2)
  })

  it('a transport failure is not a refusal and is retried', async () => {
    let calls = 0
    const turnFn = async () => {
      calls++
      throw new Error('connection refused')
    }
    const first = await bakeOpeners({ ...base, questions: [QUESTIONS[0]], chat, turnFn })
    expect(first.entries[0].answerAttempt).toBe(null)
    await bakeOpeners({ ...base, questions: [QUESTIONS[0]], chat, turnFn, previous: first.bundle })
    expect(calls).toBe(2)
  })
})

/**
 * THE ANSWER THE AUTHOR WROTE — engine-specs/017.
 *
 * The bake's other half inverted: the model is not asked, and the invariant it
 * exists to protect — nothing ships as an answer without citations into this
 * corpus — is enforced against the config instead. Every test below is either
 * "the prose survives verbatim" or "a malformed entry costs the answer and
 * never the question".
 */
describe('openers — an answer the author wrote', () => {
  const MANIFEST = {
    version: 3,
    hash: 'authored-1',
    embedModel: null,
    dims: 0,
    vectors: null,
    chunkCount: ROWS.length,
    pages: ROWS.map((r) => ({ path: r.path, title: r.title, tail: 'Docs' })),
    sections: [],
    guard: GUARD,
    tuning: null,
    vocabulary: null,
    vocabHash: null,
    tokenizer: null,
  }
  const base = {
    manifest: MANIFEST,
    chunks: ROWS,
    vectorBuffer: null,
    dfDoc: DF,
    hash: 'authored-1',
    embed: { model: null, provider: null, baseURL: null, apiKey: null, cache: null },
    docPilot: { prompt: {}, product: 'Docs' },
    warn: () => {},
  }
  const WRITTEN = {
    q: QUESTIONS[0],
    answer: 'It refuses below tau, and tau is measured on your corpus.',
    cite: ['gate#one'],
  }

  it('lifts the written answer off the question and leaves questions a list of strings', () => {
    const s = resolveSuggestions({ suggestions: [WRITTEN, QUESTIONS[1]] }, () => {})
    expect(s.questions).toEqual(QUESTIONS)
    expect(s.authored).toEqual([WRITTEN])
  })

  it('survives being resolved a second time — themeDocPilot, then session', () => {
    const once = resolveSuggestions({ suggestions: [WRITTEN, QUESTIONS[1]] }, () => {})
    const twice = resolveSuggestions({ suggestions: once }, () => {})
    expect(twice.authored).toEqual([WRITTEN])
    expect(twice.questions).toEqual(QUESTIONS)
  })

  it('drops an answer that cites nothing, and keeps its question', () => {
    const warn = vi.fn()
    const s = resolveSuggestions({ suggestions: [{ ...WRITTEN, cite: [] }] }, warn)
    expect(s.questions).toEqual([QUESTIONS[0]])
    expect(s.authored).toEqual([])
    expect(warn.mock.calls[0][0]).toMatch(/no cite/)
  })

  it('drops an answer that is not a string, and keeps its question', () => {
    const warn = vi.fn()
    const s = resolveSuggestions({ suggestions: [{ ...WRITTEN, answer: 42 }] }, warn)
    expect(s.questions).toEqual([QUESTIONS[0]])
    expect(s.authored).toEqual([])
    expect(warn.mock.calls[0][0]).toMatch(/not a non-empty string/)
  })

  it('an edited answer moves the fingerprint even though the question has not', () => {
    const before = resolveSuggestions({ suggestions: [WRITTEN] }, () => {})
    const after = resolveSuggestions(
      { suggestions: [{ ...WRITTEN, answer: 'It refuses below tau. Run calibrate.' }] },
      () => {},
    )
    expect(openerFingerprint(after)).not.toBe(openerFingerprint(before))
    expect(questionsHash(after.questions)).toBe(questionsHash(before.questions))
  })

  it('bakes the prose verbatim and asks no model for it', async () => {
    let calls = 0
    const out = await bakeOpeners({
      ...base,
      questions: [QUESTIONS[0]],
      authored: [WRITTEN],
      chat: { searchOnly: false, model: 'm', promptHash: 'p', maxIterations: 0, llm: {} },
      turnFn: async () => {
        calls++
        return { text: 'A model wrote this.', citations: ['gate#one'], confidence: 0.8 }
      },
    })
    expect(calls).toBe(0)
    expect(out.entries[0].answer.text).toBe(WRITTEN.answer)
    expect(out.entries[0].answer.citations).toEqual(['gate#one'])
    expect(out.report.authored).toBe(1)
    expect(out.report.answered).toBe(0)
  })

  it('needs no model at all — a searchOnly site still gets its written answers', async () => {
    const out = await bakeOpeners({
      ...base, questions: [QUESTIONS[0]], authored: [WRITTEN], chat: { searchOnly: true },
    })
    expect(out.entries[0].answer.text).toBe(WRITTEN.answer)
  })

  it('refuses to bake prose that cites a chunk this index does not hold', async () => {
    let calls = 0
    const warn = vi.fn()
    const out = await bakeOpeners({
      ...base,
      warn,
      questions: [QUESTIONS[0]],
      authored: [{ ...WRITTEN, cite: ['gate#one', 'gone#one'] }],
      chat: { searchOnly: false, model: 'm', promptHash: 'p', maxIterations: 0, llm: {} },
      turnFn: async () => {
        calls++
        return { text: 'A model wrote this.', citations: ['gate#one'], confidence: 0.8 }
      },
    })
    expect(out.report.uncitable).toEqual([{ q: QUESTIONS[0], ids: ['gone#one'] }])
    expect(warn.mock.calls[0][0]).toMatch(/does not contain/)
    // The question is not lost — the model answers it, exactly as it did before
    // anybody wrote one down.
    expect(calls).toBe(1)
    expect(out.entries[0].answer.text).toBe('A model wrote this.')
  })

  it('a gate that refuses does not withhold the answer the author wrote', async () => {
    const q = 'How do I file my taxes in Portugal?'
    const out = await bakeOpeners({
      ...base,
      questions: [q],
      authored: [{ q, answer: 'You do not — this is a docs site.', cite: ['sidebar#one'] }],
      chat: { searchOnly: true },
    })
    expect(out.entries[0].gate.pass).toBe(false)
    expect(out.entries[0].answer.text).toBe('You do not — this is a docs site.')
    // Moved out of `refused`, because the four-line warning there says the chip
    // fails on the reader's first click and that is no longer true.
    expect(out.report.refused).toEqual([])
    expect(out.report.covered.map((r) => r.q)).toEqual([q])
  })

  it('`answers: false` reverts the written answers too', async () => {
    const out = await bakeOpeners({
      ...base, questions: [QUESTIONS[0]], authored: [WRITTEN], answers: false, chat: { searchOnly: true },
    })
    expect(out.entries[0].answer).toBe(null)
  })

  it('serves it to the reader, with its sources resolved against the index', () => {
    const config = {
      suggestions: resolveSuggestions({ suggestions: [WRITTEN, QUESTIONS[1]] }, () => {}),
      embed: { lexicalOnly: true },
    }
    const index = indexWith({
      configHash: openerFingerprint(config.suggestions),
      embedModel: null,
      dims: 0,
      matchTau: 0.75,
      entries: [
        entry(QUESTIONS[0], {
          answer: {
            lang: 'en',
            text: WRITTEN.answer,
            citations: WRITTEN.cite,
            confidence: null,
            promptHash: 'authored',
            model: 'authored',
          },
        }),
      ],
    })
    const hit = matchOpener(QUESTIONS[0], { ...ARGS, config, index })
    expect(hit.answer.text).toBe(WRITTEN.answer)
    expect(hit.answer.citations.every((id) => index.byId.has(id))).toBe(true)
  })

  it('a bundle baked before the answer was rewritten is ignored whole', () => {
    const before = resolveSuggestions({ suggestions: [WRITTEN, QUESTIONS[1]] }, () => {})
    const after = resolveSuggestions(
      { suggestions: [{ ...WRITTEN, answer: 'Something else entirely.' }, QUESTIONS[1]] },
      () => {},
    )
    const index = indexWith({
      configHash: openerFingerprint(before),
      embedModel: null,
      dims: 0,
      matchTau: 0.75,
      entries: [entry(QUESTIONS[0])],
    })
    expect(matchOpener(QUESTIONS[0], { ...ARGS, config: { suggestions: after, embed: { lexicalOnly: true } }, index })).toBe(null)
  })
})
