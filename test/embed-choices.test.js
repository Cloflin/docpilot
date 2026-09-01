import { describe, it, expect } from 'vitest'

import {
  embedChoices,
  embedOverrideSnippet,
  embedQuestion,
  indexCommandFor,
  indexDirQuestion,
  overrideIndexDir,
  parseEmbedFlags,
  PROBEABLE,
} from '../src/embed-choices.js'
import { resolveDocPilot, nodeEmbedTarget } from '../src/config.js'

/**
 * The embedder question, without a terminal.
 *
 * It lives in `src/` for the same reason `init`'s two questions do: `bin/` owns
 * stdin, and a decision that needs a TTY to be exercised is a decision nothing
 * exercises. Everything below runs against a fake environment and touches no
 * network — liveness arrives as the `probed` option, which is the one thing this
 * module is not allowed to find out for itself.
 */
describe('embedChoices', () => {
  const ollamaProbe = [{ id: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' }]

  it('always opens with the config, and always closes with lexical', () => {
    const list = embedChoices({}, {})
    expect(list[0].source).toBe('config')
    expect(list.at(-1).source).toBe('lexical')
    expect(list.at(-1).ready).toBe(true)
  })

  /**
   * The first row says which sentence the config file actually contains. They
   * resolve identically and they do not read identically, and the reader being
   * asked is the one who has to go and edit that file.
   */
  it('distinguishes a written `embed` from an absent one', () => {
    expect(embedChoices({}, {})[0].hint).toMatch(/no `embed` in your config/)
    expect(embedChoices({ embed: 'auto' }, {})[0].hint).toMatch(/as written in your config/)
    expect(embedChoices({ embed: { provider: 'openai' } }, {})[0].hint).toMatch(/as written/)
  })

  /**
   * The defect that made `ready` necessary. With nothing in the environment the
   * chain still ends at its shipped fallback, so the first row named a provider
   * the build would 401 on — offered, in a list, as though it would work.
   */
  it('marks a choice with no key as one that cannot run', () => {
    const [first] = embedChoices({}, {})
    expect(first.provider).toBe('openrouter')
    expect(first.ready).toBe(false)
    expect(first.hint).toMatch(/NO KEY/)

    const [withKey] = embedChoices({}, { OPENROUTER_API_KEY: 'k' })
    expect(withKey.ready).toBe(true)
    expect(withKey.hint).not.toMatch(/NO KEY/)
  })

  it('offers every provider the environment has a key for', () => {
    const list = embedChoices({ embed: { provider: 'openrouter' } }, {
      OPENROUTER_API_KEY: 'k',
      OPENAI_API_KEY: 'sk-x',
    })
    const openai = list.find((c) => c.provider === 'openai')
    expect(openai.source).toBe('env')
    expect(openai.envKey).toBe('OPENAI_API_KEY')
    expect(openai.model).toBe('text-embedding-3-small')
  })

  /**
   * A chat-only provider is not an embedder, and a list that offered one would
   * be offering a build that `assertEmbed` stops. Anthropic is the case the
   * skill documentation calls out by name.
   */
  it('never offers a provider that cannot embed', () => {
    const list = embedChoices({}, { ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'k' })
    expect(list.some((c) => c.provider === 'anthropic')).toBe(false)
    expect(list.some((c) => c.provider === 'groq')).toBe(false)
  })

  /**
   * One option, presented once. "The config names OpenAI" and "OPENAI_API_KEY is
   * set" are two reasons for the same build, and a numbered list with the same
   * answer at 1 and 3 makes a reader doubt they understood the question.
   */
  it('folds a duplicate into a second reason on the row that is already there', () => {
    const list = embedChoices({ embed: { provider: 'openai' } }, { OPENAI_API_KEY: 'sk-x' })
    expect(list.filter((c) => c.provider === 'openai')).toHaveLength(1)
    expect(list[0].envKey).toBe('OPENAI_API_KEY')
    expect(list[0].hint).toMatch(/OPENAI_API_KEY/)
  })

  /** `bge-m3` and `bge-m3:latest` are one model, and Ollama answers to both. */
  it('folds Ollama’s `:latest` tag into the bare name', () => {
    const list = embedChoices({}, { OLLAMA_BASE_URL: 'http://localhost:11434' }, {
      probed: [{ id: 'ollama', model: 'bge-m3:latest', baseURL: 'http://localhost:11434' }],
    })
    expect(list.filter((c) => c.provider === 'ollama')).toHaveLength(1)
    expect(list.find((c) => c.provider === 'ollama').hint).toMatch(/answered a probe/)
  })

  /**
   * The case this whole module was asked for: nothing configured anywhere, and
   * the answer is the Ollama already running on the machine.
   */
  it('offers a probed local server when the environment names nothing', () => {
    const list = embedChoices({}, {}, { probed: ollamaProbe })
    const local = list.find((c) => c.source === 'local')
    expect(local.provider).toBe('ollama')
    expect(local.ready).toBe(true)
    expect(local.model).toBe('bge-m3')
  })

  /** A probe may only speak for a server that has no key to be found by. */
  it('ignores a probe claiming a hosted provider', () => {
    const list = embedChoices({}, {}, { probed: [{ id: 'openai', model: 'x' }] })
    expect(list.some((c) => c.source === 'local')).toBe(false)
    expect(PROBEABLE).not.toContain('openai')
  })

  /**
   * `OLLAMA_BASE_URL` both SELECTS Ollama and says where it is, but
   * `nodeEmbedTarget` reads `embed.baseURL` and falls back to localhost for a
   * provider with no table row. Left off, this row offers a localhost the
   * environment has just said is somewhere else.
   */
  it('carries the address the environment gave Ollama', () => {
    const list = embedChoices({}, { OLLAMA_BASE_URL: 'http://gpu.internal:11434' })
    const ollama = list.find((c) => c.provider === 'ollama')
    expect(ollama.target.baseURL).toBe('http://gpu.internal:11434')
    expect(ollama.label).toContain('http://gpu.internal:11434')
  })
})

describe('overrideIndexDir', () => {
  /**
   * The index is bound to the embedder that built it, so an override gets a
   * path of its own rather than replacing what the deployed site reads —
   * `embedderMatchesIndex` catches the disagreement only when the config names
   * a model, and not at all when it names a pool.
   */
  it('names a directory of its own, per provider and model', () => {
    const base = resolveDocPilot({}, {})
    const target = nodeEmbedTarget({ ...base, embed: { provider: 'openai' } }, {})
    expect(overrideIndexDir(base, target)).toBe('docs/public/rag-openai-text-embedding-3-small')
  })

  it('follows a project that moved its index', () => {
    const base = resolveDocPilot({ indexDir: 'site/public/rag' }, {})
    const target = nodeEmbedTarget({ ...base, embed: { provider: 'ollama' } }, {})
    expect(overrideIndexDir(base, target)).toBe('site/public/rag-ollama-bge-m3')
  })
})

describe('parseEmbedFlags', () => {
  it('reads the four flags and hands everything else back untouched', () => {
    const out = parseEmbedFlags([
      '--embed-provider=openai',
      '--embed-model=text-embedding-3-large',
      '--dry',
      '--html-dir=dist',
      '-y',
    ])
    expect(out.embed).toEqual({ provider: 'openai', model: 'text-embedding-3-large' })
    expect(out.yes).toBe(true)
    expect(out.rest).toEqual(['--dry', '--html-dir=dist'])
    expect(out.unknown).toEqual([])
  })

  /** `false` is an answer, so it must survive as one rather than as "unset". */
  it('spells lexical-only three ways and returns `false` for all of them', () => {
    for (const word of ['none', 'false', 'lexical']) {
      expect(parseEmbedFlags([`--embed-provider=${word}`]).embed).toBe(false)
    }
  })

  it('refuses a provider that does not exist, or cannot embed', () => {
    expect(parseEmbedFlags(['--embed-provider=nope']).unknown).toHaveLength(1)
    expect(parseEmbedFlags(['--embed-provider=anthropic']).unknown).toHaveLength(1)
  })

  /**
   * A model with no provider would be read against whatever the config happened
   * to name — the drift this command was taught to prevent, arriving through
   * the flag added to prevent it.
   */
  it('refuses a model or an address with no provider beside it', () => {
    expect(parseEmbedFlags(['--embed-model=x']).unknown).toHaveLength(1)
    expect(parseEmbedFlags(['--embed-base-url=http://x']).unknown).toHaveLength(1)
  })

  /** Ours if it is spelled like ours — and then it is wrong, not somebody else's. */
  it('reports a misspelling of one of its own flags', () => {
    const out = parseEmbedFlags(['--embed-provdier=openai'])
    expect(out.unknown).toEqual(['--embed-provdier=openai'])
    expect(out.rest).toEqual([])
  })
})

describe('the printed command', () => {
  it('carries a local server’s address and an override’s directory', () => {
    const [, ollama] = embedChoices({ embed: { provider: 'openrouter' } }, {
      OPENROUTER_API_KEY: 'k',
      OLLAMA_BASE_URL: 'http://gpu.internal:11434',
    })
    const cmd = indexCommandFor(ollama)
    expect(cmd).toContain('--embed-provider=ollama')
    expect(cmd).toContain('--embed-base-url=http://gpu.internal:11434')
    expect(cmd).toContain('--index-dir=docs/public/rag-ollama-bge-m3')
  })

  /** The config's own row is not an override, so it moves nothing. */
  it('leaves the config’s own row without a directory', () => {
    const [config] = embedChoices({ embed: { provider: 'openai' } }, { OPENAI_API_KEY: 'k' })
    expect(indexCommandFor(config)).not.toContain('--index-dir')
  })

  /** A lexical rebuild writes too — over a vector index, with no vectors. */
  it('moves a lexical rebuild off the current path', () => {
    const lexical = embedChoices({}, {}).at(-1)
    expect(indexCommandFor(lexical)).toBe('--embed-provider=none --index-dir=docs/public/rag-lexical')
  })
})

describe('the questions and the snippet', () => {
  it('defaults to the config’s own answer, so Enter changes nothing', () => {
    const choices = embedChoices({ embed: { provider: 'openai' } }, { OPENAI_API_KEY: 'k' })
    const q = embedQuestion(choices)
    expect(q.default).toBe(q.options[0])
    expect(q.options).toHaveLength(choices.length)
    // `askOne` indexes hints by the option string; a missing one prints
    // `undefined` at a reader mid-question.
    for (const option of q.options) expect(q.hints[option]).toBeTruthy()
  })

  it('defaults an override to a directory of its own, never over the current one', () => {
    const choice = embedChoices({}, {}, { probed: [{ id: 'ollama', model: 'bge-m3' }] }).find(
      (c) => c.source === 'local',
    )
    const q = indexDirQuestion(choice, 'docs/public/rag')
    expect(q.default).toBe(q.options[0])
    expect(q.options[0]).toContain(choice.indexDir)
    expect(q.options[1]).toContain('docs/public/rag')
  })

  /**
   * The snippet is a RECORD of a build, not a copy of the shorthand that
   * produced it: `'auto'` re-resolves on whoever reads it, and an unnamed model
   * is the one case `embedderMatchesIndex` cannot check — with no name on the
   * config side there is nothing for it to compare.
   */
  it('resolves the shorthand into provider, model and address', () => {
    const choice = embedChoices({}, { OLLAMA_BASE_URL: 'http://localhost:11434' }).find(
      (c) => c.provider === 'ollama',
    )
    // The environment named it, so this row IS the config's own row — resolved
    // from `embed: 'auto'`, which is the shorthand under test.
    expect(choice.embed).toBe('auto')
    const moved = embedOverrideSnippet(choice, 'config.mjs', choice.indexDir, 'docs/public/rag')
    expect(moved).toContain("provider: 'ollama'")
    expect(moved).toContain("model: 'bge-m3'")
    expect(moved).toContain("baseURL: 'http://localhost:11434'")
    expect(moved).not.toContain("embed: 'auto'")
    expect(moved).toContain(`indexDir: '${choice.indexDir}'`)
  })

  /** A pooled provider records the member that will actually answer. */
  it('names a pool member rather than leaving the model out', () => {
    const [openrouter] = embedChoices({}, { OPENROUTER_API_KEY: 'k' })
    expect(embedOverrideSnippet(openrouter, 'config.mjs', 'a', 'b')).toContain(
      `model: '${openrouter.model}'`,
    )
  })

  it('drops the directory line when the index did not move, and says what that costs', () => {
    const choice = embedChoices({}, { OLLAMA_BASE_URL: 'http://localhost:11434' }).find(
      (c) => c.provider === 'ollama',
    )
    const overwrote = embedOverrideSnippet(choice, 'config.mjs', 'docs/public/rag', 'docs/public/rag')
    expect(overwrote).not.toContain('indexDir:')
    expect(overwrote).toContain('OVERWRITES')
  })

  it('writes `embed: false` as itself', () => {
    const lexical = embedChoices({}, {}).at(-1)
    expect(embedOverrideSnippet(lexical, null, 'x', 'y')).toContain('embed: false,')
  })
})
