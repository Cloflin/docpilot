import { describe, it, expect, afterEach, vi } from 'vitest'

import { setVocabulary, glossQuery } from '../src/theme/docpilot/text.js'
import { embedQuery } from '../src/theme/docpilot/embed.js'

// Engine-spec 025: the embedder reads the corpus's own terms beside the reader's.

const MAP = {
  locale: ['локаль', 'язык редактора'],
  'Initialization Settings': ['настройки инициализации'],
  initialization: ['инициации'],
  config: ['конфиг'],
}

afterEach(() => {
  setVocabulary(null)
  vi.unstubAllGlobals()
})

describe('glossQuery', () => {
  it('returns the question unchanged with no vocabulary', () => {
    expect(glossQuery('как добавить локаль?')).toBe('как добавить локаль?')
  })

  it('appends the canonical terms its aliases name, in order, once each', () => {
    setVocabulary(MAP)
    expect(glossQuery('подскажи, как добавить свою локаль при инициации в конфиг? локаль!')).toBe(
      'подскажи, как добавить свою локаль при инициации в конфиг? локаль!\nlocale, initialization, config',
    )
  })

  it('takes the longest declared phrase first', () => {
    setVocabulary(MAP)
    expect(glossQuery('где настройки инициализации?')).toBe('где настройки инициализации?\nInitialization Settings')
    expect(glossQuery('как сменить язык редактора')).toBe('как сменить язык редактора\nlocale')
  })

  it('does not repeat a canonical the question already contains', () => {
    setVocabulary(MAP)
    expect(glossQuery('how do I set the locale in the config?')).toBe('how do I set the locale in the config?')
    expect(glossQuery('локаль, то есть locale')).toBe('локаль, то есть locale')
  })

  it('leaves a question with no alias alone', () => {
    setVocabulary(MAP)
    expect(glossQuery('what is the refusal gate?')).toBe('what is the refusal gate?')
  })
})

describe('embedQuery sends the glossed question', () => {
  it('to the embedder, and only there', async () => {
    setVocabulary(MAP)
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) }))
    vi.stubGlobal('fetch', fetch)
    await embedQuery('где мой конфиг?', { provider: 'openai', model: 'text-embedding-3-small', apiKey: 'k' })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.input).toBe('где мой конфиг?\nconfig')
  })
})
