// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'

import { mountDocPilot } from '../src/mount.js'
import { __resetHostForTests } from '../src/theme/docpilot/host.js'
import * as session from '../src/theme/docpilot/session.js'
import { assembleIndex } from '../src/theme/docpilot/store.js'
import { normaliseTools, registerTool, runTool, unregisterTools } from '../src/theme/docpilot/tools.js'
import { resolveDocPilot, themeDocPilot } from '../src/config.js'

/**
 * The half of engine-spec 038 and ui-specs/018 that needs a page: the two
 * runners that only exist where `window` does, and the panel drawing what an
 * answer offers. tools.test.js holds the rest, in Node, where a module that
 * quietly needed `window` would fail — which is why these are not there.
 */

const ENV = { OPENAI_API_KEY: 'k' }

afterEach(() => {
  vi.unstubAllGlobals()
  unregisterTools()
})

describe('the runners that need a page', () => {
  it('href: the same host navigates in place; another opens a new tab, without an opener', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const [here, there] = normaliseTools({
      here: { description: 'x', confirm: true, parameters: { type: 'object', properties: { plan: { type: 'string' } } }, run: { href: '/pricing?plan={plan}' } },
      there: { description: 'x', confirm: true, run: { href: 'https://cal.example.com/sales' } },
    })
    await runTool(here, { plan: 'pro' })
    await runTool(there, {})
    expect(assign).toHaveBeenCalledWith(new URL('/pricing?plan=pro', location.href).href)
    expect(open).toHaveBeenCalledWith('https://cal.example.com/sales', '_blank', 'noopener,noreferrer')
  })

  it('event: the site’s own code receives the tool, its arguments and the context', async () => {
    const seen = []
    const listen = (e) => seen.push(e.detail)
    window.addEventListener('acme:demo', listen)
    const [demo] = normaliseTools({ open_demo: { description: 'x', confirm: true, run: { event: 'acme:demo' } } })
    await runTool(demo, { size: 'team' }, { question: 'q', page: '/p' })
    window.removeEventListener('acme:demo', listen)
    expect(seen).toEqual([{ tool: 'open_demo', args: { size: 'team' }, context: { question: 'q', page: '/p' } }])
  })
})

describe('the panel draws what an answer offers — ui-specs/018', () => {
  let panel = null
  afterEach(() => {
    panel?.destroy()
    panel = null
    document.body.innerHTML = ''
  })

  const index = () => {
    const vectors = new Int8Array(4)
    vectors[0] = 127
    return assembleIndex({
      manifest: {
        version: 3,
        hash: 'tools-dom',
        embedModel: 'test-embed',
        dims: 4,
        chunkCount: 1,
        vectors: 'vectors.tools.bin',
        pages: [{ path: '/a', title: 'Alpha', tail: 'Docs' }],
        guard: { tau: 0.3, tauLexical: 0.3, wDense: 0.75, wLexical: 0.25, denseMode: 'cosine', cosFloor: 0.44, cosCeil: 0.64, zexp: null },
      },
      shards: [[{ id: 'a#one', path: '/a', anchor: 'one', title: 'Alpha', breadcrumb: 'Docs', kind: 'guide', text: 'Pro allows more requests than Free.', prev: null, next: null }]],
      vectorBuffer: vectors.buffer,
      dfDoc: { df: {} },
    })
  }

  const respond = (call) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content: '', tool_calls: [{ function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: 'tool_calls' }],
    }),
  })

  it('a pill per action with the author’s label, a form from the schema, Esc that closes only the form, and a source with no link', async () => {
    __resetHostForTests()
    const config = themeDocPilot(
      resolveDocPilot({
        product: 'Acme',
        chat: { provider: 'openai' },
        guard: { mode: 'off' },
        budget: { mode: 'agentic', probe: 'never' },
        ui: { trigger: 'fab', panel: 'popup' },
        tools: {
          plan_limits: {
            description: 'Live limits of one plan.',
            parameters: { type: 'object', properties: { plan: { type: 'string', enum: ['free', 'pro'] } }, required: ['plan'] },
          },
          contact_support: {
            title: 'Contact support',
            label: 'Write to support',
            description: 'Send the question to support.',
            parameters: {
              type: 'object',
              properties: {
                email: { type: 'string', format: 'email', description: 'Where support replies' },
                message: { type: 'string', format: 'multiline', description: 'The problem' },
              },
              required: ['email', 'message'],
            },
            confirm: 'form',
            run: { event: 'acme:support' },
          },
        },
      }),
      ENV,
    )
    registerTool('plan_limits', async () => ({ requestsPerDay: 5000 }))
    let step = 0
    vi.stubGlobal('fetch', async (url, init) => {
      if (String(url).includes('/embeddings')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] }) }
      }
      if (!String(url).includes('/chat/completions')) throw new Error('offline')
      step++
      return step === 1
        ? respond({ name: 'plan_limits', args: { plan: 'pro' } })
        : respond({
            name: 'answer',
            args: {
              text: 'Pro allows 5000 requests a day [1].',
              citations: ['tool:plan_limits:1'],
              confidence: 0.8,
              actions: [{ tool: 'contact_support', args: { message: 'Pro limits' } }],
            },
          })
    })

    panel = mountDocPilot({ config })
    session.state.index = index()
    session.state.degraded = false
    panel.open()
    await session.submit('How many requests does Pro allow?')
    await nextTick()

    // The source row: the tool's title, "from the site", and no link.
    const row = [...document.querySelectorAll('.docpilot__source')].find((li) => li.textContent.includes('Plan limits'))
    expect(row.textContent).toContain('from the site')
    expect(row.querySelector('a')).toBe(null)

    // The pill: the author's label, and under it the model's arguments, on the
    // pill itself — a sighted reader sees what one press sends.
    const group = document.querySelector('[role="group"][aria-label="Actions"]')
    const pill = group.querySelector('button.docpilot__suggestion')
    expect(pill.textContent).toContain('Write to support')
    const args = pill.querySelector('.docpilot__suggestion-args')
    expect(args.textContent.trim()).toBe('With message: Pro limits')
    expect(args.classList.contains('docpilot__sr')).toBe(false)

    // Pressed: a form from the schema, filled with what the model offered.
    pill.click()
    await nextTick()
    await nextTick()
    const form = document.querySelector('form.docpilot__feedback[aria-label="Contact support"]')
    expect(form).not.toBe(null)
    expect(form.querySelector('input[type="email"]')).not.toBe(null)
    expect(form.querySelector('textarea').value).toBe('Pro limits')
    expect(form.textContent).toContain('Where support replies')

    // Esc inside it closes the form, and only the form.
    form.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.querySelector('form.docpilot__feedback[aria-label="Contact support"]')).toBe(null)
    expect(session.state.open).toBe(true)
  })
})
