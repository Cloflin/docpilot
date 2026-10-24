import { describe, it, expect } from 'vitest'

import { buildMessages, condenseAnswer, LAST_ANSWER_MAX, SUMMARY_INSTRUCTION } from '../src/theme/docpilot/prompt.js'

// Engine-spec 026: the last pair's answer travels whole up to LAST_ANSWER_MAX;
// every older pair travels as its summary, or as the skeleton when it has none.

const STEPS = [1, 2, 3, 4]
  .map((n) => `${n}. **Step ${n}**:\n   Some explanation of step ${n} that runs on for a while.\n   \`\`\`js\n   const step${n} = true\n   \`\`\``)
  .join('\n\n')
const assistants = (msgs) => msgs.filter((m) => m.role === 'assistant').map((m) => m.content)

describe('buildMessages — the last answer in full', () => {
  it('sends the last answer whole while it fits, and condenses the others', () => {
    expect(condenseAnswer(STEPS)).not.toContain('const step4')
    const history = [
      { question: 'a?', answer: STEPS },
      { question: 'b?', answer: STEPS },
    ]
    const [older, last] = assistants(buildMessages({ history, question: 'what is step 4 for?' }))
    expect(older).toBe(condenseAnswer(STEPS))
    expect(last).toBe(STEPS)
  })

  it('condenses an answer over the budget to the budget, not to the skeleton', () => {
    const long = `${STEPS}\n\n${'Closing paragraph. '.repeat(150)}`
    expect(Array.from(long).length).toBeGreaterThan(LAST_ANSWER_MAX)
    const [last] = assistants(buildMessages({ history: [{ question: 'a?', answer: long }], question: 'q' }))
    expect(last).toBe(condenseAnswer(long, LAST_ANSWER_MAX))
    expect(last).toContain('const step4')
  })

  it('skips a refused turn: the last ANSWERED pair is the one sent whole', () => {
    const history = [
      { question: 'a?', answer: STEPS },
      { question: 'refused?', answer: '' },
    ]
    expect(assistants(buildMessages({ history, question: 'q' }))).toEqual([STEPS])
  })
})

describe('buildMessages — summary-each+last, the shipped mode (engine-spec 026)', () => {
  it('sends an older pair as its summary and the last pair whole', () => {
    const history = [
      { question: 'a?', answer: STEPS, summary: 'Four steps; step 4 sets `step4`.' },
      { question: 'b?', answer: STEPS, summary: 'ignored while it is the last pair' },
    ]
    const [older, last] = assistants(buildMessages({ history, question: 'q' }))
    expect(older).toBe('Four steps; step 4 sets `step4`.')
    expect(last).toBe(STEPS)
  })

  it('falls back to the skeleton for a pair with no summary', () => {
    const history = [
      { question: 'a?', answer: STEPS },
      { question: 'b?', answer: STEPS },
    ]
    const [older] = assistants(buildMessages({ history, question: 'q' }))
    expect(older).toBe(condenseAnswer(STEPS))
  })

  it('asks for the summary on the question, and drops it under DOCPILOT_ANSWER_SUMMARY=0', () => {
    const lastUser = (msgs) => msgs.filter((m) => m.role === 'user').at(-1).content
    expect(lastUser(buildMessages({ history: [], question: 'q' }))).toContain(SUMMARY_INSTRUCTION)
    process.env.DOCPILOT_ANSWER_SUMMARY = '0'
    try {
      expect(lastUser(buildMessages({ history: [], question: 'q' }))).not.toContain(SUMMARY_INSTRUCTION)
    } finally {
      delete process.env.DOCPILOT_ANSWER_SUMMARY
    }
  })
})

describe('the summary field travels — engine-spec 026', () => {
  it('is a required field of the answer schema, and absent under DOCPILOT_ANSWER_SUMMARY=0', async () => {
    const { toolSchemas } = await import('../src/theme/docpilot/llm.js')
    const answerOf = () => toolSchemas().find((t) => t.function.name === 'answer').function.parameters
    expect(answerOf().required).toContain('summary')
    expect(answerOf().properties.summary.type).toBe('string')
    process.env.DOCPILOT_ANSWER_SUMMARY = '0'
    try {
      expect(answerOf().required).not.toContain('summary')
      expect(answerOf().properties.summary).toBeUndefined()
    } finally {
      delete process.env.DOCPILOT_ANSWER_SUMMARY
    }
  })

  it('is kept by the archive, so a reopened thread sends it', async () => {
    const { slimTurn } = await import('../src/theme/docpilot/history.js')
    const stored = slimTurn({ id: 't1', question: 'q', state: 'complete', answerText: 'A.', answerSummary: 'S.', sources: [] })
    expect(stored.answerSummary).toBe('S.')
    expect(slimTurn({ id: 't2', question: 'q', state: 'complete', answerText: 'A.', sources: [] })).not.toHaveProperty('answerSummary')
  })
})
