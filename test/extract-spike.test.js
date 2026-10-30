/**
 * The extraction spike's adoption rule (engine-spec 043, D-02, D-08, HTML-11).
 *
 * `scripts/extract-spike.mjs` measured two decisions and recorded the outcome in
 * the spec. What a later edit could break without any other test failing is the
 * rule that turned the numbers into a decision:
 *
 *   · a tie is not a win, and a gain below ADOPT_MIN_F1_GAIN is not one either
 *   · a gain of exactly ADOPT_MIN_F1_GAIN is adopted
 *   · lower code retention or higher noise leakage blocks adoption
 *   · fewer than MIN_SPIKE_PAGES pages is "not measurable" and adopts nothing
 *   · the median of an even count is the mean of the two middle values
 *
 * The rows below are synthetic, in the shape `score()` writes. The test needs no
 * parse5, no Readability, no defuddle, no built docs site and no network, and
 * importing the script must not run `main()` (G-1).
 */
import { describe, expect, it } from 'vitest'

import {
  ADOPT_MIN_F1_GAIN,
  MIN_SPIKE_PAGES,
  fallbackDecision,
  median,
  parserDecision,
  summarise,
} from '../scripts/extract-spike.mjs'

/** One scored page: the `rules` arm and a candidate named `cand`. */
function row(id, rulesF1, candF1, over = {}) {
  const arm = (f1, extra = {}) => ({ ok: true, reason: '', f1, codeFound: 2, noise: 0, chars: 100, ...extra })
  return {
    id,
    truthTokens: 50,
    codeBlocks: 2,
    arms: { rules: arm(rulesF1, over.rules), cand: arm(candF1, over.cand) },
    ...(over.parserDiff === undefined ? {} : { parserDiff: over.parserDiff }),
  }
}

/** `n` pages whose rule F1 is `base` and whose candidate F1 is `base + gain`. */
const pages = (n, base, gain, over) => Array.from({ length: n }, (_, i) => row(`p${i}`, base, base + gain, over))

describe('extract spike — importing the script', () => {
  it('does not run main(), which needs a built docs site and exits 2 without one', () => {
    expect(typeof median).toBe('function')
    expect(typeof summarise).toBe('function')
    expect(typeof fallbackDecision).toBe('function')
    expect(typeof parserDecision).toBe('function')
  })
})

describe('extract spike — median', () => {
  it('is the middle value for an odd count, whatever the order', () => {
    expect(median([0.9, 0.1, 0.5])).toBe(0.5)
  })

  it('is the mean of the two middle values for an even count', () => {
    expect(median([0.1, 0.4, 0.2, 0.9])).toBeCloseTo(0.3, 10)
    expect(median([1, 3])).toBe(2)
  })

  it('is 0 for no values, and does not reorder its input', () => {
    expect(median([])).toBe(0)
    const values = [3, 1, 2]
    median(values)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('extract spike — summarise', () => {
  it('counts wins, losses and ties against the rules arm, and a tie is not a win', () => {
    const results = [row('a', 0.5, 0.6), row('b', 0.5, 0.4), row('c', 0.5, 0.5)]
    const s = summarise(results, 'cand')
    expect(s).toMatchObject({ pages: 3, winsVsRules: 1, lossesVsRules: 1, tiesVsRules: 1 })
    expect(s.medianF1).toBe(0.5)
  })

  it('pools code retention over pages and sums noise leakage', () => {
    const results = [row('a', 0.5, 0.5, { cand: { codeFound: 1, noise: 2 } }), row('b', 0.5, 0.5, { cand: { noise: 1 } })]
    const s = summarise(results, 'cand')
    expect(s).toMatchObject({ codeBlocks: 4, codeFound: 3, codeRetention: 0.75, noiseLeakage: 3 })
  })

  it('reports no retention for pages with no code, rather than dividing by zero', () => {
    const results = [row('a', 0.5, 0.5)].map((r) => ({ ...r, codeBlocks: 0 }))
    expect(summarise(results, 'cand').codeRetention).toBe(null)
  })
})

describe('extract spike — the fallback adoption rule', () => {
  const decide = (results) => fallbackDecision(results, ['cand']).candidates.cand

  it('does not adopt a tie', () => {
    const d = decide(pages(MIN_SPIKE_PAGES, 0.5, 0))
    expect(d.medianF1Gain).toBe(0)
    expect(d.gainMeetsMinimum).toBe(false)
    expect(d.adopted).toBe(false)
  })

  it('adopts a gain of exactly ADOPT_MIN_F1_GAIN', () => {
    const d = decide(pages(MIN_SPIKE_PAGES, 0.5, ADOPT_MIN_F1_GAIN))
    expect(d.medianF1Gain).toBe(ADOPT_MIN_F1_GAIN)
    expect(d.gainMeetsMinimum).toBe(true)
    expect(d.adopted).toBe(true)
  })

  it('does not adopt a gain just below ADOPT_MIN_F1_GAIN', () => {
    const d = decide(pages(MIN_SPIKE_PAGES, 0.5, ADOPT_MIN_F1_GAIN - 0.001))
    expect(d.gainMeetsMinimum).toBe(false)
    expect(d.adopted).toBe(false)
  })

  it('adopts a larger gain with code and noise no worse', () => {
    expect(decide(pages(MIN_SPIKE_PAGES, 0.5, 0.1)).adopted).toBe(true)
  })

  it('does not adopt a gain that loses code retention', () => {
    const d = decide(pages(MIN_SPIKE_PAGES, 0.5, 0.1, { cand: { codeFound: 1 } }))
    expect(d.gainMeetsMinimum).toBe(true)
    expect(d.codeRetentionNotLower).toBe(false)
    expect(d.adopted).toBe(false)
  })

  it('does not adopt a gain that leaks more noise', () => {
    const d = decide(pages(MIN_SPIKE_PAGES, 0.5, 0.1, { cand: { noise: 1 } }))
    expect(d.gainMeetsMinimum).toBe(true)
    expect(d.noiseLeakageNotHigher).toBe(false)
    expect(d.adopted).toBe(false)
  })

  it('accepts equal noise and equal code retention', () => {
    const d = decide(pages(MIN_SPIKE_PAGES, 0.5, 0.1, { rules: { noise: 1 }, cand: { noise: 1 } }))
    expect(d.noiseLeakageNotHigher).toBe(true)
    expect(d.codeRetentionNotLower).toBe(true)
  })

  it('records MIN_SPIKE_PAGES - 1 pages as not measurable and adopts nothing', () => {
    const decision = fallbackDecision(pages(MIN_SPIKE_PAGES - 1, 0.5, 0.3), ['cand'])
    expect(decision.measurable).toBe(false)
    expect(decision.minPages).toBe(MIN_SPIKE_PAGES)
    expect(decision.candidates.cand.gainMeetsMinimum).toBe(true)
    expect(decision.candidates.cand.adopted).toBe(false)
  })

  it('is measurable at exactly MIN_SPIKE_PAGES', () => {
    expect(fallbackDecision(pages(MIN_SPIKE_PAGES, 0.5, 0.3), ['cand']).measurable).toBe(true)
  })

  it('reads the gain from the median, so one outlier page does not decide it', () => {
    const results = [...pages(MIN_SPIKE_PAGES, 0.5, 0), row('outlier', 0.1, 0.99)]
    expect(decide(results).adopted).toBe(false)
  })
})

describe('extract spike — the parser decision', () => {
  it('keeps the parser when no page differs', () => {
    const d = parserDecision([row('a', 0.5, 0.5, { parserDiff: 0 })])
    expect(d.switchParser).toBe(false)
    expect(d.pagesWithDiff).toEqual([])
  })

  const withParse5 = (id, rules, parse5, diff) => {
    const r = row(id, rules.f1, parse5.f1, { parserDiff: diff })
    r.arms.rules.codeFound = rules.code
    r.arms.parse5 = { ...r.arms.cand, f1: parse5.f1, codeFound: parse5.code }
    return r
  }

  it('does not switch for a differing page that parse5 scores no higher', () => {
    const d = parserDecision([withParse5('a', { f1: 0.6, code: 2 }, { f1: 0.6, code: 2 }, 3)])
    expect(d.pagesWithDiff).toHaveLength(1)
    expect(d.switchParser).toBe(false)
  })

  it('switches when a differing page scores higher on F1 or on code', () => {
    expect(parserDecision([withParse5('a', { f1: 0.6, code: 2 }, { f1: 0.7, code: 2 }, 3)]).switchParser).toBe(true)
    expect(parserDecision([withParse5('b', { f1: 0.6, code: 1 }, { f1: 0.6, code: 2 }, 3)]).switchParser).toBe(true)
  })

  it('ignores a page that scores higher but whose Markdown does not differ', () => {
    expect(parserDecision([withParse5('a', { f1: 0.6, code: 2 }, { f1: 0.9, code: 2 }, 0)]).switchParser).toBe(false)
  })
})
