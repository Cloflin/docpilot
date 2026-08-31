import { describe, it, expect, afterEach } from 'vitest'

import {
  terms,
  identifierParts,
  setTokenizer,
  tokenizerConfig,
  setVocabulary,
  vocabularyHash,
} from '../src/theme/docpilot/text.js'

/**
 * Identifier parts — engine-specs/005.
 *
 * The tokenizer is module state, installed once from a manifest. Every test here
 * puts it back, because a leaked `true` would silently re-tokenise every other
 * suite in this process.
 */
afterEach(() => {
  setTokenizer(null)
  setVocabulary(null)
})

describe('identifierParts', () => {
  it('splits a dotted path and the camel case inside it', () => {
    expect(identifierParts('docPilot.sources.allow')).toEqual(['doc', 'pilot', 'sources', 'allow'])
  })

  it('splits camel and Pascal case', () => {
    expect(identifierParts('getUserName')).toEqual(['get', 'user', 'name'])
    expect(identifierParts('FaqAccordion')).toEqual(['faq', 'accordion'])
  })

  it('keeps an acronym whole and separates the word after it', () => {
    expect(identifierParts('HTTPServer')).toEqual(['http', 'server'])
  })

  it('splits the other separators a path or a flag uses', () => {
    expect(identifierParts('rate_limit')).toEqual(['rate', 'limit'])
    expect(identifierParts('built-in')).toEqual(['built', 'in'])
    expect(identifierParts('guide/indexing')).toEqual(['guide', 'indexing'])
  })

  /**
   * The guard that decides whether this is precision or noise. A token has to
   * LOOK like an identifier — a separator inside it, or an internal capital —
   * so a sentence of ordinary prose contributes nothing at all.
   */
  it('contributes nothing for prose', () => {
    expect(identifierParts('The documentation explains configuration in detail')).toEqual([])
  })

  it('emits nothing when a token is already its own only part', () => {
    // `-foo` is edge-trimmed to `foo`: one part, equal to the whole, and emitting
    // it would double that token's term frequency for nothing.
    expect(identifierParts('-foo-')).toEqual([])
  })
})

describe('terms — off by default', () => {
  it('leaves a dotted identifier as one term, as it always has', () => {
    expect(terms('docPilot.sources.allow')).toEqual(['docpilot.sources.allow'])
  })

  it('is byte-identical on prose whether the flag is on or off', () => {
    const prose = 'Every request is counted against a rolling window of one minute.'
    const off = terms(prose)
    setTokenizer({ splitIdentifiers: true })
    expect(terms(prose)).toEqual(off)
  })
})

describe('terms — with identifier splitting on', () => {
  const on = () => setTokenizer({ splitIdentifiers: true })

  it('keeps the whole token and adds its parts', () => {
    on()
    const out = terms('docPilot.sources.allow')
    expect(out[0]).toBe('docpilot.sources.allow')
    // `sources` stems to `source`, like every other plural in the corpus.
    expect(out).toContain('source')
    expect(out).toContain('allow')
    expect(out).toContain('pilot')
  })

  it('is what makes a two-word query reach a one-token identifier', () => {
    on()
    const chunk = new Set(terms('Set docPilot.sources.allow to the origins you trust.'))
    const query = terms('sources allow')
    expect(query.every((t) => chunk.has(t))).toBe(true)
  })

  it('reaches getUserName from "user name"', () => {
    on()
    const chunk = new Set(terms('Call getUserName to read it.'))
    expect(terms('user name').every((t) => chunk.has(t))).toBe(true)
  })

  it('does not lose the exact form a precise query uses', () => {
    on()
    expect(terms('getUserName')).toContain('getusername')
  })
})

describe('the tokenizer travels with the index', () => {
  it('reads an absent manifest key as off', () => {
    setTokenizer(null)
    expect(tokenizerConfig()).toEqual({ splitIdentifiers: false })
  })

  it('round-trips through the shape the manifest carries', () => {
    setTokenizer({ splitIdentifiers: true })
    expect(tokenizerConfig()).toEqual({ splitIdentifiers: true })
  })

  /**
   * A calibration is a measurement of THIS tokenizer against THIS corpus, and
   * the flag changes it far more than a vocabulary does. Folding it into the
   * hash is what makes the existing stale-calibration guard fire on it instead
   * of a second guard nobody would remember to add.
   */
  it('changes vocabularyHash, so a stale calibration is caught by the guard that exists', () => {
    setTokenizer(null)
    expect(vocabularyHash()).toBeNull()
    setTokenizer({ splitIdentifiers: true })
    expect(vocabularyHash()).toBe('none+split')
  })

  it('changes the hash of a project that also declares a vocabulary', () => {
    setVocabulary({ widget: ['gizmo'] })
    const plain = vocabularyHash()
    expect(plain).toBeTruthy()
    setTokenizer({ splitIdentifiers: true })
    expect(vocabularyHash()).toBe(`${plain}+split`)
  })
})
