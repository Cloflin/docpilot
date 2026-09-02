import { describe, it, expect, vi } from 'vitest'

import { runDoctor } from '../src/cli-doctor.js'

/**
 * `doctor`, now that it is a function.
 *
 * It was 428 lines of `bin/docpilot.js`, which is why none of this could be
 * asserted: every path through it ended in `process.exit`, and a function that
 * ends the process ends the test runner with it. The `run*` contract — return a
 * code, never exit — is what makes the three questions below answerable.
 */
const capture = async (opts) => {
  const out = []
  const err = []
  const log = vi.spyOn(console, 'log').mockImplementation((m) => out.push(String(m)))
  const error = vi.spyOn(console, 'error').mockImplementation((m) => err.push(String(m)))
  try {
    const code = await runDoctor(opts)
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

/** Enough settings for `readiness` to have an opinion, and no network anywhere. */
const base = async (over = {}) => {
  const { resolveDocPilot } = await import('../src/config.js')
  const settings = { product: 'Acme', ...over }
  return {
    settings,
    docPilot: resolveDocPilot(settings, {}),
    env: {},
    configPath: 'docs/.vitepress/config.mjs',
    argv: [],
  }
}

describe('runDoctor', () => {
  it('returns a code rather than ending the process', async () => {
    const r = await capture(await base())
    expect(typeof r.code).toBe('number')
    expect([0, 1]).toContain(r.code)
  })

  /**
   * The check this command never ran. `flagErrors('doctor', ['--bogus'])` has
   * returned a complete message naming `--proxy --embed --models` since the
   * table was written; `doctor` read `rest.includes('--proxy')` instead, so a
   * typo produced no output about itself and the command exited on project
   * readiness — which is not what it had been asked about.
   */
  it('refuses a flag it does not have, and exits 2', async () => {
    const r = await capture({ ...(await base()), argv: ['--proxyy'] })
    expect(r.code).toBe(2)
    expect(r.err).toContain('unknown flag --proxyy')
    expect(r.err).toContain('--proxy')
    // Nothing was diagnosed: a usage error is refused before any work.
    expect(r.out).toBe('')
  })

  it('takes the flags it does have', async () => {
    const r = await capture({ ...(await base()), argv: ['--proxy'] })
    expect(r.code).not.toBe(2)
    expect(r.out).toContain('[docpilot] proxy')
  })

  /**
   * `nodeChatTarget` throws on a provider it cannot resolve, and it was called
   * bare — above the readiness block, so a broken `chat.provider` ended the one
   * command whose entire job is to explain a broken configuration in a stack
   * trace, before it printed the block naming the fault.
   */
  it('prints a provider it cannot resolve as a finding, and keeps going', async () => {
    const r = await capture(await base({ chat: { provider: 'nonesuch-service' } }))
    expect(r.out).toContain('cannot resolve this provider')
    // The diagnosis carried on to its verdict — the readiness block is the last
    // thing this command prints, and it used to be the thing the throw skipped.
    expect(`${r.out}\n${r.err}`).toContain('[docpilot] ready')
    // A finding, not a stack: `DOCPILOT_DEBUG=1` is what prints one.
    expect(r.err).not.toMatch(/^\s+at /m)
  })

  /** The report is the product; the refusal is diagnostics. */
  it('writes the readiness refusal to stderr, not into the report', async () => {
    const r = await capture(await base({ chat: { provider: 'openai' } }))
    if (r.code === 0) return
    expect(r.err).toContain('[docpilot] ready')
    expect(r.err).toContain('NO —')
    expect(r.out).not.toContain('NO —')
  })

  /** The launcher holds the path; `doctor` prints it rather than re-deriving it. */
  it('names the config file the launcher loaded', async () => {
    const r = await capture({ ...(await base()), configPath: 'somewhere/else.mjs' })
    expect(r.out).toContain('somewhere/else.mjs')
  })

  it('says so plainly when there is no config at all', async () => {
    const r = await capture({ ...(await base()), configPath: null })
    expect(r.out).toContain('none — shipped defaults')
  })
})
