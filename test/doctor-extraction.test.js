import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runDoctor } from '../src/cli-doctor.js'

/**
 * `docpilot doctor` reports what the HTML extractor does on this site —
 * engine-spec 043, HTML-10, D-13.
 *
 * Two rows: `html` re-runs the extraction offline over each built-site
 * directory `docPilot.html.sources` names, and `imports` lists the imported
 * pages an older extractor wrote. Both are information. The exit code stays the
 * readiness verdict and the `--json` object gains nothing.
 */

const capture = async (opts) => {
  const out = []
  const err = []
  const log = vi.spyOn(console, 'log').mockImplementation((m) => out.push(String(m)))
  const error = vi.spyOn(console, 'error').mockImplementation((m) => err.push(String(m)))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const code = await runDoctor(opts)
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
    warn.mockRestore()
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

const made = []
const tmp = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-doctor-'))
  made.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

const page = (title, body, head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head>` +
  `<body><nav><a href="/x">nav</a></nav><main>${body}</main><footer>footer text</footer></body></html>`

const BODY = '<p>Refunds are issued to the original payment method within five business days.</p>'

let realFetch
const fetchSpy = vi.fn(() => {
  throw new Error('doctor made a network call for the extraction report')
})

beforeAll(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = fetchSpy
})
afterAll(() => {
  globalThis.fetch = realFetch
})
// Braces: a function returned from a hook is run by vitest as its cleanup.
beforeEach(() => {
  fetchSpy.mockClear()
})
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true })
})

describe('doctor — the html row', () => {
  it('re-extracts a configured built-site directory and prints its table with the skipped page', async () => {
    const dir = tmp({
      'refunds.html': page('Refunds', BODY),
      'shipping.html': page('Shipping', '<p>Parcels leave the warehouse the day after the order is paid.</p>'),
      'hidden.html': page('Hidden', BODY, '<meta name="robots" content="noindex">'),
    })
    const r = await capture(await base({ html: { sources: { [dir]: { content: 'main' } } } }))

    expect(r.out).toContain('[docpilot] html      extraction, re-run offline over docPilot.html.sources')
    const row = r.out.split('\n').find((l) => l.includes(dir) && !l.includes('does not exist'))
    // pages 2, then kept and dropped as digits, then 0 empty and 0 link failures.
    expect(row).toMatch(/\s2\s+\d+\s+\d+\s+0\s+0$/)
    expect(r.out).toContain('skipped hidden.html: noindex')
  })

  it('does not walk a URL-prefix key, and says once that a missing directory does not exist', async () => {
    const gone = path.join(os.tmpdir(), 'docpilot-doctor-never-created')
    const r = await capture(
      await base({
        html: {
          sources: {
            'https://acme.test/help': { content: 'main' },
            [gone]: { content: 'main' },
          },
        },
      }),
    )

    const lines = r.out.split('\n').filter((l) => l.startsWith('[docpilot] html'))
    expect(lines).toEqual([`[docpilot] html      ${gone} does not exist — nothing to re-extract`])
    expect(r.out).not.toContain('extraction, re-run offline')
    expect(r.out).not.toContain('acme.test')
  })

  it('prints no html row when no html setting is given', async () => {
    const r = await capture(await base())
    expect(r.out).not.toContain('[docpilot] html')
  })

  it('leaves the exit code and the --json object as they were', async () => {
    const dir = tmp({ 'refunds.html': page('Refunds', BODY) })
    const withHtml = await base({ html: { sources: { [dir]: { content: 'main' } } } })
    const without = await base()

    const a = await capture(withHtml)
    const b = await capture(without)
    expect(a.code).toBe(b.code)

    const ja = await capture({ ...withHtml, argv: ['--json'] })
    const jb = await capture({ ...without, argv: ['--json'] })
    expect(ja.code).toBe(jb.code)
    const object = JSON.parse(ja.out)
    expect(Object.keys(object).sort()).toEqual(Object.keys(JSON.parse(jb.out)).sort())
    expect(object).not.toHaveProperty('html')
    expect(ja.out).not.toContain('extraction, re-run')
    expect(ja.out).not.toContain(dir)
  })

  it('makes no network call', async () => {
    const dir = tmp({ 'refunds.html': page('Refunds', BODY) })
    const r = await capture(await base({ html: { sources: { [dir]: { content: 'main' } } } }))
    expect(r.out).toContain('[docpilot] html')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
