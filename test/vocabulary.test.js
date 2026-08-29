import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  terms,
  setVocabulary,
  vocabularyHash,
  vocabularySignature,
  vocabularyTerms,
} from '../src/theme/docpilot/text.js'
import { lexicalCoverage, Q_CAP } from '../src/theme/docpilot/gate.js'
import { systemText, promptHash, vocabularyDoc, VOCABULARY_LIMIT } from '../src/theme/docpilot/prompt.js'
import { assembleIndex } from '../src/theme/docpilot/store.js'
import { resetPools } from '../src/theme/docpilot/llm.js'
import { resolveDocPilot, themeDocPilot, assertVocabulary, DEFAULTS } from '../src/config.js'
import { guardFor, vocabularyFor } from '../src/build/build-rag-index.js'
import { toMap, dedupe, harvestHeadings, proposeVocabulary } from '../src/build/vocabulary.js'

/**
 * THE VOCABULARY — the documentation's own name for what readers call something
 * else.
 *
 * The failure it exists for is one sentence long and the code already carried it
 * as a comment before there was anything to do about it: on an English corpus a
 * question asked in another language scores L = 0, "the panel answers I couldn't
 * find this in the docs, which is false. It did not look." A reader who says
 * `виджет` where the docs say `DocPilot` is the same failure without changing
 * language at all — no shared token, no score, a refusal about the product.
 *
 * What is pinned here is that the rewrite is SYMMETRIC and CONSERVATIVE. Both
 * words matter:
 *
 *   · symmetric — the same map runs over the corpus at build time and over the
 *     query in the browser, through one tokenizer, so a rewrite can only add
 *     matches. `terms()` is module state precisely so that no call site can miss
 *     it, and the tests below check the two sides against each other rather than
 *     against a remembered answer;
 *   · conservative — it REWRITES and never adds. `gate.js` treats an unlisted
 *     term as maximally rare, and that default is the whole sign of the guard:
 *     if aliases were appended to Q rather than replacing what the reader typed,
 *     L would saturate on any off-topic question padded with product nouns.
 */

const MAP = {
  DocPilot: ['виджет', 'widget', 'ии чат', 'ассистент'],
  provider: ['провайдер'],
  'chat.chain': ['фоллбек'],
}

afterEach(() => {
  setVocabulary(null)
  resetPools()
})

describe('the rewrite, in the one tokenizer', () => {
  it('brings a reader’s word and the documentation’s to the same token', () => {
    // The two share nothing at all before the map, which is the whole problem.
    expect(terms('что умеет виджет')).toEqual(['умеет', 'виджет'])
    expect(terms('What DocPilot does')).toEqual(['docpilot'])

    setVocabulary(MAP)
    expect(terms('что умеет виджет')).toContain('docpilot')
    expect(terms('What DocPilot does')).toContain('docpilot')
  })

  /**
   * A SINGLE-WORD NAME IS MATCHED AGAIN AFTER STEMMING, which is the half the
   * phrase pass cannot do: `виджеты` is not the string anybody declared.
   */
  it('reaches the inflected forms of a name, not only the one declared', () => {
    setVocabulary(MAP)
    for (const q of ['виджет', 'виджеты', 'виджета', 'виджетом']) {
      expect(terms(q), q).toEqual(['docpilot'])
    }
    expect(terms('провайдеров')).toEqual(['provider'])
  })

  /**
   * A MULTI-WORD NAME IS MATCHED BEFORE ANYTHING IS STEMMED, longest first —
   * otherwise `ии чат` is two tokens by the time anything could recognise it.
   */
  it('takes the longest declared name at each position', () => {
    setVocabulary({ ...MAP, чат: ['chat-window'] })
    // `ии чат` wins over `чат`, which is declared as a name of its own.
    expect(terms('как работает ии чат')).toEqual(['работает', 'docpilot'])
    // `откр` is `stemLite` doing its own job on `открой`; what is pinned here is
    // that the bare `чат` was NOT taken for `ии чат`.
    expect(terms('открой чат')).toEqual(['откр', 'чат'])
  })

  /**
   * A NAME IS A NAME AND AN IDENTIFIER IS AN IDENTIFIER. `stemLite` refuses to
   * touch a token carrying a digit, `.`, `/`, `#`, `_`, `$` or `-`; the rewrite
   * inherits that, and reaches one only where the author named it.
   */
  it('leaves identifiers alone unless the map names them', () => {
    setVocabulary(MAP)
    expect(terms('plugin.init and max_tokens and /getting-started and v2')).toEqual([
      'plugin.init',
      'max_tokens',
      'getting-started',
      'v2',
    ])
    // Named explicitly, it is rewritten TO an identifier, which is the direction
    // that matters: a reader's everyday word reaching a config key.
    expect(terms('где фоллбек')).toEqual(['chat.chain'])
  })

  it('is a no-op with nothing installed, to the token', () => {
    const before = terms('как настроить провайдера в конфиге')
    setVocabulary(MAP)
    setVocabulary(null)
    expect(terms('как настроить провайдера в конфиге')).toEqual(before)
    expect(vocabularyHash()).toBe(null)
    expect(vocabularyTerms()).toBe(null)
  })

  /**
   * THE GATE'S SIGN, pinned directly rather than argued about.
   *
   * `Q` is the question's rarest terms, capped at 12. A rewrite must not grow it
   * with words the reader did not say: a map that APPENDED aliases would let an
   * off-topic question padded with product nouns fill Q with corpus vocabulary
   * and score L ≈ 1 against any evidence at all.
   */
  it('does not grow Q, so an off-topic question cannot fill it with our words', () => {
    const question = 'виджет провайдер quarterly hiring headcount forecast'
    const before = lexicalCoverage(question, '', {}).Q
    setVocabulary(MAP)
    const after = lexicalCoverage(question, '', {}).Q
    expect(after.length).toBe(before.length)
    expect(after.length).toBeLessThanOrEqual(Q_CAP)
    // The off-domain half is untouched — nothing is removed from Q either.
    for (const t of ['quarterly', 'hiring', 'headcount', 'forecast']) expect(after).toContain(t)
  })

  it('raises coverage for a question that named the same thing differently', () => {
    const evidence = 'DocPilot answers questions about the provider you configured.'
    const question = 'что делает виджет и его провайдер'
    const before = lexicalCoverage(question, evidence, {}).L
    setVocabulary(MAP)
    const after = lexicalCoverage(question, evidence, {}).L
    expect(before).toBe(0)
    expect(after).toBeGreaterThan(before)
  })
})

describe('what setVocabulary refuses to install, and what config refuses to ship', () => {
  /**
   * THE SPLIT: text.js reports and never throws, because it runs in a reader's
   * browser over a manifest nobody in that session can edit; config.js throws,
   * because that is the one moment somebody is looking at the file.
   */
  it('drops a cycle rather than looping, and never throws doing it', () => {
    const report = setVocabulary({ DocPilot: ['widget'], widget: ['thing'] })
    expect(report.skipped.map((s) => s.alias)).toContain('widget')
    expect(terms('widget')).toEqual(['widget'])
  })

  it('drops an alias two terms both claim, first term wins', () => {
    const report = setVocabulary({ DocPilot: ['панель'], provider: ['панель'] })
    expect(report.skipped).toHaveLength(1)
    expect(terms('панель')).toEqual(['docpilot'])
  })

  it('refuses the same shapes at build time, by name', () => {
    expect(() => assertVocabulary({ vocabulary: { DocPilot: ['widget'], widget: ['x'] } })).toThrow(
      /is itself a term/,
    )
    expect(() => assertVocabulary({ vocabulary: { DocPilot: 'widget' } })).toThrow(/array of strings/)
    expect(() => assertVocabulary({ vocabulary: { DocPilot: [42] } })).toThrow(/not\n\s+a name/)
    expect(() => assertVocabulary({ vocabulary: ['DocPilot'] })).toThrow(/must be an object/)
    expect(() => assertVocabulary({ vocabulary: null })).not.toThrow()
  })

  it('ships null and stays out of the client half', () => {
    expect(DEFAULTS.vocabulary).toBe(null)
    const emitted = themeDocPilot(resolveDocPilot({ vocabulary: MAP, embed: false }, {}), {})
    expect(emitted.vocabulary).toBeUndefined()
    expect(JSON.stringify(emitted)).not.toContain('виджет')
  })

  /**
   * The signature is what `promptHash` and `vocabHash` are computed over, so a
   * reordered file must not read as a changed one — and a changed map must.
   */
  it('signs the map by content, not by the order it was written in', () => {
    setVocabulary({ DocPilot: ['widget', 'виджет'], provider: ['провайдер'] })
    const a = vocabularySignature()
    setVocabulary({ provider: ['провайдер'], DocPilot: ['виджет', 'widget'] })
    expect(vocabularySignature()).toBe(a)
    setVocabulary({ provider: ['провайдер'], DocPilot: ['виджет'] })
    expect(vocabularySignature()).not.toBe(a)
  })
})

describe('what the model is told', () => {
  it('sends the pairs on a lexical-only turn and on no other', () => {
    setVocabulary(MAP)
    expect(systemText({ lexicalOnly: true })).toContain('DocPilot — виджет')
    expect(systemText({ lexicalOnly: false })).not.toContain('DocPilot — виджет')
    setVocabulary(null)
    expect(systemText({ lexicalOnly: true })).not.toContain('readers call by other names')
  })

  /**
   * The block is a system block on EVERY lexical-only turn, so an unbounded one
   * would push the excerpts out of the window. Capped on terms rather than on
   * characters so it can never end mid-pair.
   */
  it('caps the block and says how much it left out', () => {
    const big = Object.fromEntries(
      Array.from({ length: VOCABULARY_LIMIT + 5 }, (_, i) => [`term${i}`, [`alias${i}`]]),
    )
    const doc = vocabularyDoc(big)
    expect(doc.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(VOCABULARY_LIMIT)
    expect(doc).toContain('5 more not listed')
  })

  /**
   * The map is not only text the model reads — it is the tokenizer both channels
   * were scored with. Two sites whose maps differ produced different retrieval,
   * and one hash over both would file their reports under one number.
   */
  it('moves the prompt hash, so two maps are two configurations', () => {
    const bare = promptHash()
    setVocabulary(MAP)
    expect(promptHash()).not.toBe(bare)
    setVocabulary(null)
    expect(promptHash()).toBe(bare)
  })

  it('drops the old advice to avoid synonyms, which this contradicts', () => {
    const src = fs.readFileSync(new URL('../src/theme/docpilot/prompt.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/try a different concrete term, not a synonym/)
  })
})

describe('the manifest carries it, and the guard notices when it moved', () => {
  const index = (vocabulary, vocabHash) =>
    assembleIndex({
      manifest: {
        version: 3,
        hash: 'h',
        embedModel: null,
        dims: 0,
        vectors: null,
        chunkCount: 1,
        pages: [],
        sections: [],
        guard: {},
        ...(vocabulary === undefined ? {} : { vocabulary, vocabHash }),
      },
      shards: [
        [
          {
            id: 'a#1',
            path: '/a',
            anchor: '1',
            title: 'A',
            breadcrumb: 'D',
            kind: 'guide',
            text: 'DocPilot answers',
            prev: null,
            next: null,
          },
        ],
      ],
      vectorBuffer: null,
      dfDoc: { df: {} },
    })

  it('installs the map as the index loads, before anything tokenises', () => {
    index(MAP, 'x')
    expect(terms('виджет')).toEqual(['docpilot'])
  })

  /**
   * An index built before the key existed carries no `vocabulary`, and that has
   * to leave the tokenizer byte-identical — every deployed site is one.
   */
  it('leaves an index that predates the key exactly as it was', () => {
    setVocabulary(MAP)
    index(undefined)
    expect(terms('виджет')).toEqual(['виджет'])
    expect(vocabularyHash()).toBe(null)
  })

  /**
   * THE BLIND SPOT THIS CLOSES. The index hash is sha256 over chunk TEXT, so a
   * changed tokenizer does not move it — which is exactly how the stemmer
   * shipped with its recalibration undetectable, in as many words in the
   * CHANGELOG. `vocabHash` is the signal the hash cannot carry.
   */
  it('marks a calibrated threshold stale when the vocabulary moved under it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-vocab-'))
    const file = path.join(dir, 'calibration.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        calibratedAt: 'abc',
        embedModel: null,
        lexicalOnly: true,
        vocabHash: 'aaaa1111',
        guard: {
          tau: null,
          tauLexical: 0.31,
          wDense: 0.75,
          wLexical: 0.25,
          denseMode: 'cosine',
          cosFloor: 0.44,
          cosCeil: 0.64,
          source: 'calibrated',
          calibratedAt: 'abc',
          zexp: null,
          zexpSource: 'measured',
        },
      }),
    )
    const opts = { file, warn: () => {}, note: () => {}, embedModel: null }

    expect(guardFor('abc', { ...opts, vocabHash: 'aaaa1111' }).source).toBe('calibrated')
    expect(guardFor('abc', { ...opts, vocabHash: 'bbbb2222' }).source).toBe('provisional')
    expect(guardFor('abc', { ...opts, vocabHash: null }).source).toBe('provisional')

    // A calibration written before the field existed and a build with no
    // vocabulary are the same state — nothing declared — so every deployment's
    // first rebuild does not report a stale guard it cannot act on.
    const older = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete older.vocabHash
    fs.writeFileSync(file, JSON.stringify(older))
    expect(guardFor('abc', { ...opts, vocabHash: null }).source).toBe('calibrated')
    expect(guardFor('abc', { ...opts, vocabHash: 'cccc3333' }).source).toBe('provisional')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('where the map comes from', () => {
  const withFile = (contents, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-vocab-src-'))
    const file = path.join(dir, 'vocabulary.json')
    if (contents !== null) fs.writeFileSync(file, contents)
    try {
      return fn(file)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const quiet = { note: () => {} }

  it('reads the sidecar when the config declared none', () => {
    withFile(JSON.stringify({ version: 1, terms: { DocPilot: ['виджет'] } }), (file) => {
      expect(vocabularyFor({ file, own: null, ...quiet })).toEqual({ DocPilot: ['виджет'] })
      expect(terms('виджет')).toEqual(['docpilot'])
    })
  })

  /**
   * The config OVERRIDES per term rather than wholesale, on `guard.tau`'s
   * precedent: adding one pair by hand must not discard the twenty a model
   * found.
   */
  it('lets the config override one term without discarding the rest', () => {
    withFile(JSON.stringify({ terms: { DocPilot: ['виджет'], provider: ['провайдер'] } }), (file) => {
      const merged = vocabularyFor({ file, own: { DocPilot: ['панель'] }, ...quiet })
      expect(merged).toEqual({ DocPilot: ['панель'], provider: ['провайдер'] })
    })
  })

  /**
   * `{}` IS NOT AN OMITTED KEY. Declared-and-empty takes nothing, including the
   * sidecar — the same split `chat.model` draws between `null` and a name.
   */
  it('reads an empty object as "declared none" and stops there', () => {
    withFile(JSON.stringify({ terms: { DocPilot: ['виджет'] } }), (file) => {
      expect(vocabularyFor({ file, own: {}, ...quiet })).toBe(null)
      expect(vocabularyHash()).toBe(null)
    })
  })

  it('builds without one when the sidecar is unreadable, rather than failing', () => {
    withFile('{ not json', (file) => {
      expect(vocabularyFor({ file, own: null, warn: () => {}, ...quiet })).toBe(null)
    })
  })

  it('refuses a merged map with a cycle, because an author wrote half of it', () => {
    withFile(JSON.stringify({ terms: { DocPilot: ['widget'] } }), (file) => {
      expect(() => vocabularyFor({ file, own: { widget: ['x'] }, ...quiet })).toThrow(/itself a term/)
    })
  })
})

describe('what the command proposes', () => {
  /**
   * A REPEATED CANONICAL IS A UNION. Nothing in the schema stops a model listing
   * one term twice, and replacing meant the last row won — which on a real reply
   * is the shorter one, so aliases were proposed, accepted and then gone.
   */
  it('merges a term the model listed twice instead of keeping the last', () => {
    expect(
      toMap([
        { canonical: 'DocPilot', aliases: ['виджет', 'чат'] },
        { canonical: 'DocPilot', aliases: ['плагин', 'виджет'] },
      ]),
    ).toEqual({ DocPilot: ['виджет', 'чат', 'плагин'] })
  })

  it('drops an alias that repeats its own term, in any case', () => {
    expect(toMap([{ canonical: 'DocPilot', aliases: ['docpilot', 'виджет'] }])).toEqual({
      DocPilot: ['виджет'],
    })
    expect(toMap([{ canonical: 'x', aliases: [] }])).toEqual({})
  })

  it('resolves the two collisions text.js would drop silently', () => {
    const said = []
    const out = dedupe(
      { DocPilot: ['widget', 'панель'], widget: ['thing'], provider: ['панель'] },
      { warn: (m) => said.push(m) },
    )
    expect(out).toEqual({ DocPilot: ['панель'], widget: ['thing'] })
    expect(said).toHaveLength(2)
  })

  /**
   * THE LIMIT IS ENFORCED, not merely asked for. `qwen3:8b` answered a request
   * for twelve terms with twenty, and a flag that describes what was requested
   * rather than what was kept is a flag that does nothing — the number matters,
   * because the file becomes a system block on every lexical-only turn.
   */
  it('keeps only as many terms as it was asked to keep', async () => {
    const many = Array.from({length: 20}, (_, i) => ({canonical: `t${i}`, aliases: [`a${i}`]}))
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({choices: [{message: {content: JSON.stringify({terms: many})}}], usage: {}}),
    }))
    const out = await proposeVocabulary({
      target: {provider: 'openai', baseURL: '/ai', model: 'm', apiKey: 'k'},
      product: 'X',
      headings: ['A'],
      languages: ['en'],
      limit: 5,
    })
    expect(Object.keys(out)).toHaveLength(5)
    vi.unstubAllGlobals()
  })

  /**
   * ONE RETRY, because `chat()` rotates past a bad shape only where there is a
   * second candidate — and here there is usually one model, often a local one.
   * A small model answers this prompt correctly most of the time and not every
   * time, with nothing changed between the two runs.
   */
  it('asks once more when the reply will not parse, and says so', async () => {
    let call = 0
    const said = []
    vi.stubGlobal('fetch', async () => {
      call++
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  call === 1
                    ? 'Sure! Here you go:'
                    : JSON.stringify({terms: [{canonical: 'DocPilot', aliases: ['виджет']}]}),
              },
            },
          ],
          usage: {},
        }),
      }
    })
    const out = await proposeVocabulary({
      target: {provider: 'openai', baseURL: '/ai', model: 'm', apiKey: 'k'},
      product: 'X',
      headings: ['A'],
      languages: ['en'],
      limit: 5,
      onRetry: (why) => said.push(why),
    })
    expect(call).toBe(2)
    expect(said).toHaveLength(1)
    expect(out).toEqual({DocPilot: ['виджет']})
    vi.unstubAllGlobals()
  })

  it('gives up with the reason after the last attempt', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({choices: [{message: {content: 'nope'}}], usage: {}}),
    }))
    await expect(
      proposeVocabulary({
        target: {provider: 'openai', baseURL: '/ai', model: 'm', apiKey: 'k'},
        product: 'X',
        headings: ['A'],
        languages: ['en'],
        limit: 5,
      }),
    ).rejects.toThrow(/did not answer in the requested shape/)
    vi.unstubAllGlobals()
  })

  /** It reads markdown, so it runs before the first index exists. */
  it('harvests titles and headings from the corpus itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-vocab-docs-'))
    fs.writeFileSync(
      path.join(dir, 'index.md'),
      '---\ntitle: DocPilot\n---\n# What it is\n## The panel {#panel}\n#### too deep\n',
    )
    fs.mkdirSync(path.join(dir, 'public'))
    fs.writeFileSync(path.join(dir, 'public', 'skip.md'), '# Not the corpus\n')
    const got = harvestHeadings(dir)
    expect(got).toEqual(['DocPilot', 'What it is', 'The panel'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
