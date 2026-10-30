/**
 * The internal document contract — engine-spec 041: the content hash, the
 * deny-by-default visibility check and the per-runtime size limits.
 *
 * Pure functions, so no project, no network and no build: the module is
 * imported from `src/` as the other build-lib tests do.
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'

import {
  BROWSER_LIMITS,
  SERVER_LIMITS,
  NonPublicDocument,
  assertPublic,
  contentHashOf,
  limitsFor,
} from '../src/build/lib/source-doc.js'

const md = (markdown) => ({ format: 'markdown', markdown })

describe('contentHashOf', () => {
  it('gives the same hex for the same document twice', () => {
    const doc = { id: '/guide/a', body: md('---\ntitle: A\n---\n\nHello there.\n') }
    expect(contentHashOf(doc)).toBe(contentHashOf({ ...doc }))
    expect(contentHashOf(doc)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives the same hex when only updatedAt differs', () => {
    const base = { id: '/guide/a', body: md('# A\n\nText.\n') }
    expect(contentHashOf({ ...base, updatedAt: '2026-01-01T00:00:00Z' })).toBe(
      contentHashOf({ ...base, updatedAt: '2026-10-30T12:00:00Z' }),
    )
  })

  it('differs when the body text differs', () => {
    const a = contentHashOf({ id: '/guide/a', body: md('# A\n\nOne.\n') })
    const b = contentHashOf({ id: '/guide/a', body: md('# A\n\nTwo.\n') })
    expect(a).not.toBe(b)
  })

  it('differs when the id differs', () => {
    const body = md('# A\n\nOne.\n')
    expect(contentHashOf({ id: '/a', body })).not.toBe(contentHashOf({ id: '/b', body }))
  })

  it('hashes an OpenAPI body as [id, yaml text]', () => {
    const yaml = 'openapi: 3.1.0\ninfo:\n  title: T\n'
    const want = crypto
      .createHash('sha256')
      .update(JSON.stringify(['/reference/t', yaml]), 'utf8')
      .digest('hex')
    expect(contentHashOf({ id: '/reference/t', body: { format: 'openapi', yaml } })).toBe(want)
  })
})

describe('assertPublic', () => {
  it('returns silently for public documents', () => {
    expect(() =>
      assertPublic([
        { id: '/a', visibility: 'public' },
        { id: '/b', visibility: 'public' },
      ]),
    ).not.toThrow()
  })

  it('throws NonPublicDocument naming every internal document', () => {
    let err
    try {
      assertPublic([
        { id: '/a', visibility: 'public' },
        { id: '/secret', visibility: 'internal' },
        { id: '/also-secret', visibility: 'internal' },
      ])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NonPublicDocument)
    expect(err.ids).toEqual(['/secret', '/also-secret'])
    expect(err.message).toContain('/secret, /also-secret')
    expect(err.message).toContain('[docpilot] not public:')
  })

  it('refuses a document whose visibility is missing', () => {
    expect(() => assertPublic([{ id: '/x' }])).toThrow(NonPublicDocument)
  })
})

describe('limitsFor', () => {
  it('returns the browser ceilings for browser, undefined and anything else', () => {
    for (const v of ['browser', undefined, null, 'nonsense', 'Server', '']) {
      expect(limitsFor(v)).toBe(BROWSER_LIMITS)
    }
    expect(BROWSER_LIMITS).toEqual({
      manifestMaxBytes: 65536,
      warnBytes: 3145728,
      failBytes: 5242880,
    })
  })

  it('lifts all three ceilings for server', () => {
    expect(limitsFor('server')).toBe(SERVER_LIMITS)
    expect(SERVER_LIMITS).toEqual({
      manifestMaxBytes: Infinity,
      warnBytes: Infinity,
      failBytes: Infinity,
    })
  })
})
