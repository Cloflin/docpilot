import { describe, it, expect, vi } from 'vitest'
import MarkdownIt from 'markdown-it'

import {
  ROADMAP_API,
  ROADMAP_TAG,
  MIN_BODY_CHARS,
  bodyOf,
  loadRoadmap,
  readSnapshot,
  renderRoadmap,
  withoutHeader,
} from '../docs/.vitepress/roadmap-source.mjs'

/**
 * "Roadmap to 3.0" prints the GitHub pre-release `roadmap-3.0` from a component,
 * not from Markdown, so the assistant's index never holds it. These tests hold the
 * two things that make that safe to deploy: a build with no usable answer from
 * GitHub still has a page, and the text from outside cannot put markup on it.
 */

const BODY = `**DocPilot 3.0 — roadmap and progress.** This is not a release.\n\n${'A plan line.\n'.repeat(60)}`
const snapshot = { tag: ROADMAP_TAG, url: 'u', capturedAt: '2026-11-02', body: BODY }
const release = (over = {}) => ({ tag_name: ROADMAP_TAG, body: BODY, ...over })
const answer = (json, status = 200) => async () => ({ ok: status < 400, status, json: async () => json })

describe('loadRoadmap', () => {
  it('reads the body from the GitHub API and sends no credential', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push([url, init])
      return answer(release({ body: `${BODY}\nlive` }))()
    }
    const r = await loadRoadmap({ snapshot, fetchImpl, now: () => new Date('2026-12-01T10:00:00Z') })
    expect(r).toEqual({ body: `${BODY}\nlive`, source: 'github', capturedAt: '2026-12-01' })
    expect(seen[0][0]).toBe(ROADMAP_API)
    expect(Object.keys(seen[0][1].headers).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  it.each([
    ['a rate-limited answer', answer({ message: 'rate limit' }, 403)],
    ['a network error', async () => { throw new Error('getaddrinfo ENOTFOUND') }],
    ['another release', answer(release({ tag_name: 'v2.2.0' }))],
    ['an empty body', answer(release({ body: '' }))],
    ['a body too short to be the roadmap', answer(release({ body: 'x'.repeat(MIN_BODY_CHARS - 1) }))],
    ['no body at all', answer({ tag_name: ROADMAP_TAG })],
  ])('uses the committed snapshot on %s', async (_name, fetchImpl) => {
    const warn = vi.fn()
    const r = await loadRoadmap({ snapshot, fetchImpl, warn })
    expect(r).toEqual({ body: BODY, source: 'snapshot', capturedAt: '2026-11-02' })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/^\[docpilot\] roadmap-3\.0 was not read from GitHub/)
  })
})

describe('the committed snapshot', () => {
  it('is a roadmap that bodyOf accepts, so the fallback is a real page', () => {
    const s = readSnapshot()
    expect(s.tag).toBe(ROADMAP_TAG)
    expect(() => bodyOf({ tag_name: s.tag, body: s.body })).not.toThrow()
    expect(s.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('withoutHeader', () => {
  it('drops the note\'s own header paragraph, which the page writes itself', () => {
    expect(withoutHeader('**DocPilot 3.0 — roadmap and progress.** This is not a release: x.\n\n**After 3.0:** y.\n')).toBe(
      '**After 3.0:** y.\n',
    )
  })

  it('keeps a note that opens with anything else', () => {
    const other = '**Progress:** 3 of 12\n\nmore'
    expect(withoutHeader(other)).toBe(other)
  })
})

describe('renderRoadmap', () => {
  const md = () => new MarkdownIt({ html: false, linkify: false })

  it('shows a tag in the note as text', () => {
    const html = renderRoadmap('para <script>alert(1)</script> and <img src=x onerror=y>', md())
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps one h1 on the page: headings after the note\'s own # go one level down', () => {
    const html = renderRoadmap('## Latest update\n\ntext\n\n# Roadmap: DocPilot\n\n## Overview\n\n### Phase 1\n', md())
    expect(html).not.toMatch(/<h1/)
    expect(html).toMatch(/<h2>Latest update<\/h2>/)
    expect(html).toMatch(/<h2>Roadmap: DocPilot<\/h2>/)
    expect(html).toMatch(/<h3>Overview<\/h3>/)
    expect(html).toMatch(/<h4>Phase 1<\/h4>/)
  })

  it('renders a table', () => {
    expect(renderRoadmap('| a | b |\n|---|---|\n| 1 | 2 |\n', md())).toContain('<table>')
  })
})
