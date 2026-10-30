import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseImportFlags, readHtml, runImport } from '../src/build/import.js'
import { htmlConfigProblems } from '../src/build/lib/html-options.js'
import { checkSource, parseAllowlist } from '../src/build/lib/sources.js'
import { resolveDocPilot, themeDocPilot } from '../src/config.js'

/**
 * The `docPilot.html.fetcher` hook of `docpilot import` (engine-spec 043, D-09,
 * D-27, D-29): an owner's own renderer feeds the importer a page that only
 * renders in a browser, inside the same allowlist, with a timeout, and without
 * the function ever reaching a client artifact.
 *
 * The global `fetch` is stubbed to throw: a test that reaches the network fails.
 */
const SOURCE = 'https://acme.test/help/rate-limits'
const PAGE =
  '<!doctype html><html lang="en"><head><title>Rate limits</title></head><body><main><h1>Rate limits</h1>' +
  '<p>Every plan is capped at sixty requests a minute, and the cap resets on the hour.</p></main></body></html>'

const allow = (() => {
  const { entries } = parseAllowlist({ allow: ['https://acme.test'] })
  return (u) => checkSource(u, entries)
})()

let dir
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the network was reached')
  })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-fetcher-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

const run = async (fetcher, extra = [], docPilotExtra = {}) => {
  const said = []
  const log = { log: (m) => said.push(String(m)), error: (m) => said.push(String(m)) }
  const code = await runImport({
    docPilot: {
      importDir: path.join(dir, 'kb'),
      sources: { allow: ['https://acme.test'] },
      html: { fetcher },
      ...docPilotExtra,
    },
    argv: [SOURCE, '--no-annotate', '--no-alternate', '--dry-run', ...extra],
    log,
  })
  return { code, out: said.join('\n') }
}

describe('import — the fetcher hook', () => {
  it('uses a fetcher that returns a string as the page', async () => {
    const seen = []
    const { code, out } = await run(async (url, init) => {
      seen.push([url, typeof init.signal])
      return PAGE
    })
    expect(code).toBe(0)
    expect(seen).toEqual([[SOURCE, 'object']])
    expect(out).toContain('Rate limits')
  })

  it('uses { html, url } when that origin is allowed, and the citation stays the asked-for URL', async () => {
    const out = await readHtml({
      url: SOURCE,
      allow,
      fetcher: async () => ({ html: PAGE, url: 'https://acme.test/final' }),
    })
    expect(out.html).toBe(PAGE)
    expect(out.url).toBe('https://acme.test/final')
    const run2 = await run(async () => ({ html: PAGE, url: 'https://acme.test/final' }))
    expect(run2.code).toBe(0)
    expect(run2.out).toContain(SOURCE)
  })

  it('refuses a fetcher result whose url is outside sources.allow', async () => {
    const { code, out } = await run(async () => ({ html: PAGE, url: 'https://evil.test/x' }))
    expect(code).toBe(1)
    expect(out).toContain('outside docPilot.sources.allow')
    expect(out).toContain('https://evil.test/x')
  })

  it('refuses a fetcher result that is neither a string nor { html }', async () => {
    const { code, out } = await run(async () => 42)
    expect(code).toBe(1)
    expect(out).toContain('the fetcher returned neither a string nor { html }')
  })

  it('honours an X-Robots-Tag header the fetcher returns', async () => {
    const { code, out } = await run(async () => ({ html: PAGE, headers: { 'X-Robots-Tag': 'noindex' } }))
    expect(code).toBe(1)
    expect(out).toContain('noindex')
  })

  it('reads x-robots-tag from the response of the built-in fetch', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'x-robots-tag' ? 'none' : null) },
      text: async () => PAGE,
    })
    const out = await readHtml({ url: SOURCE, allow, fetchImpl })
    expect(out.headers['x-robots-tag']).toBe('none')
    expect(out.html).toBe(PAGE)
  })

  it('aborts a fetcher that never resolves after timeoutMs, and names the timeout', async () => {
    const never = (url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    await expect(readHtml({ url: SOURCE, allow, fetcher: never, timeoutMs: 50 })).rejects.toThrow(
      /did not answer within 50 ms/,
    )
  })

  it('cuts off a fetcher that ignores its signal and never settles (WR-01, T-02-12)', async () => {
    const started = Date.now()
    await expect(readHtml({ url: SOURCE, allow, fetcher: () => new Promise(() => {}), timeoutMs: 100 })).rejects.toThrow(
      /did not answer within 100 ms/,
    )
    // A bound well above the deadline and far below "for ever".
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('cuts off a built-in fetch that ignores its signal, and a call in time clears its timer', async () => {
    const fetchImpl = () => new Promise(() => {})
    await expect(readHtml({ url: SOURCE, allow, fetchImpl, timeoutMs: 100 })).rejects.toThrow(
      /did not answer within 100 ms/,
    )
    // A call that finishes in time clears its own timer.
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const out = await readHtml({ url: SOURCE, allow, fetcher: async () => PAGE, timeoutMs: 60_000 })
    expect(out.html).toBe(PAGE)
    expect(cleared).toHaveBeenCalled()
    cleared.mockRestore()
  })

  it('aborts the built-in fetch on the same timeout', async () => {
    const fetchImpl = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    await expect(readHtml({ url: SOURCE, allow, fetchImpl, timeoutMs: 50 })).rejects.toThrow(
      /did not answer within 50 ms/,
    )
  })

  it('--html <file> wins over a configured fetcher', async () => {
    const file = path.join(dir, 'page.html')
    fs.writeFileSync(file, PAGE)
    let called = false
    const { code } = await run(
      async () => {
        called = true
        return PAGE
      },
      ['--html', file],
    )
    expect(code).toBe(0)
    expect(called).toBe(false)
  })

  it('reads --html-select and --html-exclude in both spellings', () => {
    const flags = parseImportFlags(['u', '--html-select', 'main', '--html-exclude=.toc'])
    expect(flags).toMatchObject({ htmlSelect: 'main', htmlExclude: '.toc' })
    const other = parseImportFlags(['u', '--html-select=article', '--html-exclude', '.nav'])
    expect(other).toMatchObject({ htmlSelect: 'article', htmlExclude: '.nav' })
  })

  it('names docPilot.html.fetcher when it is not a function', () => {
    expect(htmlConfigProblems({ fetcher: 'x' }).join('\n')).toContain('docPilot.html.fetcher')
    expect(htmlConfigProblems({ fetcher: () => '' })).toEqual([])
  })

  it('stops with the config problem before any page is fetched', async () => {
    const { code, out } = await run('not a function')
    expect(code).toBe(1)
    expect(out).toContain('docPilot.html.fetcher must be a function')
  })

  it('never puts the fetcher or the html key into the client config', () => {
    const client = themeDocPilot(resolveDocPilot({ html: { fetcher: () => '', content: 'main' } }))
    const text = JSON.stringify(client)
    expect(text).not.toContain('fetcher')
    expect(text).not.toContain('"html"')
  })
})
