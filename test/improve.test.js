/**
 * `docpilot improve` — engine-spec 035: the diagnosis is deterministic, the plan
 * groups by (cause, page), compare applies the 2-point rule, and check catches a
 * test gold answer pasted into the docs.
 */
import { describe, it, expect } from 'vitest'

import { diagnose } from '../src/improve/diagnose.js'
import { planOf } from '../src/improve/plan.js'
import { compareRuns, okOf } from '../src/improve/compare.js'
import { leaks, ngrams } from '../src/improve/check.js'
import { terms } from '../src/theme/docpilot/text.js'

const chunks = [
  { id: 'guides/dead-letter#retention', text: 'Dead-letter queue — Retention\nJobs that run out of attempts move to the dead-letter queue and are kept for 14 days.' },
  { id: 'guides/retries#backoff', text: 'Retries — Backoff\nmaxAttempts defaults to 5. Backoff is exponential with a two second base delay.' },
  { id: 'guides/retries#limits', text: 'Retries — Limits\nmaxDelay caps the wait at fifteen minutes between attempts.' },
  { id: 'guides/webhooks#delivery', text: 'Webhooks — Delivery\nEndpoints must answer within ten seconds; deliveries retry eight times over a day.' },
]
const records = new Map(
  [
    { id: 'v1', question: 'How long does the DLQ keep poison messages?', expect: 'answer', gold_chunks: ['guides/dead-letter#retention'] },
    { id: 'v2', question: 'When are failed jobs from the DLQ deleted?', expect: 'answer', gold_chunks: ['guides/dead-letter#retention'] },
    { id: 'r1', question: 'What is the retry backoff delay?', expect: 'answer', gold_chunks: ['guides/retries#backoff'] },
    { id: 's1', question: 'How do retries back off and how long can the wait be?', expect: 'answer', gold_chunks: ['guides/retries#backoff', 'guides/retries#limits'] },
    { id: 'n1', question: 'Does Harborline speak AMQP?', expect: 'refuse:no-evidence', gold_chunks: [] },
  ].map((r) => [r.id, r]),
)

const rows = [
  { id: 'v1', expect: 'answer', observed: 'answer', rankedIds: ['guides/webhooks#delivery'], retrievedIds: ['guides/webhooks#delivery'] },
  { id: 'v2', expect: 'answer', observed: 'answer', rankedIds: ['guides/webhooks#delivery'], retrievedIds: [] },
  { id: 'r1', expect: 'answer', observed: 'answer', rankedIds: ['guides/webhooks#delivery', 'guides/dead-letter#retention'], retrievedIds: [] },
  { id: 's1', expect: 'answer', observed: 'answer', answerF1: 0.1, rankedIds: ['guides/retries#backoff'], retrievedIds: ['guides/retries#backoff'], citations: ['guides/retries#backoff'] },
  { id: 'n1', expect: 'refuse:no-evidence', observed: 'answer' },
]

describe('diagnose', () => {
  const found = diagnose({ rows, records, chunks, terms })
  const byId = Object.fromEntries(found.map((f) => [f.record, f]))

  it('names a vocabulary gap when the reader’s words are not the page’s', () => {
    expect(byId.v1.cause).toBe('vocabulary-gap')
    expect(byId.v1.missingTerms).toEqual(expect.arrayContaining(['dlq']))
  })

  it('names ranking when the words are there and another page wins', () => {
    expect(byId.r1.cause).toBe('ranking')
    expect(byId.r1.outranking).toContain('/guides/webhooks')
  })

  it('names structure when the answer spans chunks the turn did not all see', () => {
    expect(byId.s1.cause).toBe('structure')
    expect(byId.s1.unseen).toEqual(['guides/retries#limits'])
  })

  it('flags an answered negative, but not under a gate-only report', () => {
    expect(byId.n1.cause).toBe('answered-negative')
    expect(diagnose({ rows, records, chunks, terms, gateOnly: true }).some((f) => f.cause === 'answered-negative')).toBe(false)
  })
})

describe('planOf', () => {
  it('groups by cause and page, corpus edits first, most records first', () => {
    const items = planOf(diagnose({ rows, records, chunks, terms }), { docsDir: 'docs', llmsFile: 'docs/public/llms.txt' })
    expect(items[0]).toMatchObject({ id: 'P1', lever: 'describe-page', page: '/guides/dead-letter', records: ['v1', 'v2'] })
    expect(items[0].files).toEqual(['docs/public/llms.txt', 'docs/guides/dead-letter.md'])
    expect(items.at(-1).lever).toBe('investigate')
  })
})

describe('compareRuns', () => {
  const before = { rows: [{ id: 'a', expect: 'answer', observed: 'answer', mrr: 0.5, recall8: 1 }, { id: 'b', expect: 'answer', observed: 'refuse:not-answerable', mrr: 0, recall8: 0 }, { id: 'n', expect: 'refuse:no-evidence', observed: 'refuse:not-answerable' }] }

  it('keeps a change that moved records from wrong to right', () => {
    const after = { rows: [{ ...before.rows[0] }, { id: 'b', expect: 'answer', observed: 'answer', mrr: 1, recall8: 1 }, before.rows[2]] }
    const r = compareRuns(before, after)
    expect(r.mcnemar).toMatchObject({ b: 0, c: 1 })
    expect(r.verdict).not.toBe('revert')
  })

  it('reverts past the 2-point line', () => {
    const after = { rows: [{ ...before.rows[0], mrr: 0.25 }, before.rows[1], before.rows[2]] }
    expect(compareRuns(before, after).verdict).toBe('revert')
  })

  it('counts a negative refused for any cause as right', () => {
    expect(okOf({ expect: 'refuse:no-evidence', observed: 'refuse:not-answerable' })).toBe(true)
    expect(okOf({ expect: 'refuse:no-evidence', observed: 'answer' })).toBe(false)
  })
})

describe('check', () => {
  it('finds a test gold answer copied into a page, and ignores dev', () => {
    const gold = [
      { id: 't1', split: 'test', gold_answer: 'Dead jobs are kept for fourteen days and then deleted from the dead letter queue for good.' },
      { id: 'd1', split: 'dev', gold_answer: 'Backoff doubles from a two second base until it reaches the fifteen minute ceiling set by maxDelay.' },
    ]
    const added = new Map([
      ['docs/guides/dead-letter.md', 'Note: dead jobs are kept for fourteen days and then deleted from the dead letter queue.\n'],
      ['docs/guides/retries.md', 'Backoff doubles from a two second base until it reaches the fifteen minute ceiling set by maxDelay.\n'],
    ])
    const found = leaks(added, gold, { split: 'test' })
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.file === 'docs/guides/dead-letter.md' && f.records.includes('t1'))).toBe(true)
    expect(ngrams('a b c d e f g').size).toBe(0)
  })
})
