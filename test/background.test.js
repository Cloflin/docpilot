import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { srcText } from './helpers/source.js'

import { resolveDocPilot, themeDocPilot } from '../src/config.js'
import { assembleIndex, __setIndex } from '../src/theme/docpilot/store.js'
import { resolveUi, UI_BACKGROUND, UI_DEFAULTS } from '../src/theme/docpilot/ui.js'
import * as session from '../src/theme/docpilot/session.js'

/**
 * `ui.background` — a turn that outlives the panel it was asked in.
 *
 * ui-specs/010. The defect this closes did not look like one: closing the panel
 * called `stop()`, `stop()` aborted the controller, and an abort with nothing
 * painted yet has no state of its own — it falls into `'no-answer'` with
 * `cause: 'not-answerable'`, which renders as *I couldn't find this in the
 * docs.* A reader who put the panel away during retrieval, which is most of a
 * turn's latency, was handed the gate's refusal for a turn the gate never ran.
 *
 * One `abort()` was serving two intentions. **Stop** is the composer's button
 * and the `Escape` rung above it; **close** is the `×`, the scrim, the floating
 * button and the hotkey, and none of those ever asked for anything to end.
 *
 * NOTHING HERE MOCKS A NETWORK, for the reason `search-only.test.js` states:
 * `chat: false, embed: false` runs a turn end to end against an empty
 * environment, so a path that grows a request stops this file rather than
 * starts calling something.
 *
 * WHAT THIS FILE CANNOT ASSERT, stated so the gap is a decision rather than an
 * omission: that `close()` under `background: false` still reaches the abort.
 * A search-only turn never consults the signal — it settles off the ranked
 * passages, with no model call to interrupt — so the abort is invisible from
 * here whether it happened or not, and the fixture that WOULD see it needs a
 * live transport. The abort mechanics themselves are unchanged by this feature
 * and are held elsewhere; what changed is the one branch that decides whether
 * to call it, and that branch is pinned by the source check at the end.
 */

const ENV = {}

const ROWS = [
  {
    id: 'a#one',
    path: '/a',
    anchor: 'one',
    title: 'Alpha',
    breadcrumb: 'Docs',
    kind: 'guide',
    text: 'Docs — Alpha\nThe alpha widget token authenticates every request.',
    prev: null,
    next: null,
  },
  {
    id: 'b#one',
    path: '/b',
    anchor: 'one',
    title: 'Beta',
    breadcrumb: 'Docs',
    kind: 'reference',
    text: 'Docs — Beta\nThe beta gizmo installs from the registry.',
    prev: null,
    next: null,
  },
]

const GUARD = {
  tau: 0.3,
  tauLexical: 0.3,
  wDense: 0.75,
  wLexical: 0.25,
  denseMode: 'cosine',
  cosFloor: 0.44,
  cosCeil: 0.64,
  zexp: null,
}

describe('ui.background — the switch', () => {
  it('names the three values and ships the middle one', () => {
    expect(UI_BACKGROUND).toEqual(['notify', 'open', false])
    expect(UI_DEFAULTS.background).toBe('notify')
    expect(resolveUi({}).background).toBe('notify')
  })

  it('carries each value through untouched', () => {
    for (const value of UI_BACKGROUND) {
      expect(resolveUi({ ui: { background: value } }, () => {}).background).toBe(value)
    }
  })

  /**
   * A cosmetic setting never throws — `ui.js` says so at the top and this is the
   * half that matters to a consumer: a typo in somebody else's docs build must
   * report and carry on, not stop it.
   */
  it('reports a value outside the enum and falls back', () => {
    const said = []
    expect(resolveUi({ ui: { background: 'yes' } }, (m) => said.push(m)).background).toBe('notify')
    expect(said.length).toBe(1)
    expect(said[0]).toContain('background')
  })

  it('reaches the browser — it is not a build-only setting', () => {
    const emitted = themeDocPilot(resolveDocPilot({ ui: { background: 'open' } }, ENV), ENV)
    expect(emitted.ui.background).toBe('open')
  })
})

describe('ui.background — a turn that outlives the panel', () => {
  let fixtureCount = 0

  const install = () => {
    // A distinct hash per fixture: `miniSearchFor` memoises on `manifest.hash`.
    const hash = `background-${++fixtureCount}`
    __setIndex(
      Promise.resolve(
        assembleIndex({
          manifest: {
            version: 3,
            hash,
            embedModel: null,
            dims: 0,
            vectors: null,
            chunkCount: ROWS.length,
            pages: [
              { path: '/a', title: 'Page /a', tail: 'Docs' },
              { path: '/b', title: 'Page /b', tail: 'Docs' },
            ],
            sections: [],
            guard: GUARD,
          },
          shards: [ROWS.map((r) => ({ ...r }))],
          vectorBuffer: null,
          dfDoc: { df: {} },
        }),
      ),
    )
  }

  const configure = (background) =>
    session.configure(
      {
        docPilot: themeDocPilot(
          resolveDocPilot({ chat: false, embed: false, ui: { background } }, ENV),
          ENV,
        ),
      },
      '/a',
      'en',
    )

  beforeEach(() => {
    session.state.turns = []
    session.state.index = null
    session.state.unread = false
    install()
  })

  afterEach(() => {
    __setIndex(null)
    session.state.unread = false
  })

  const lastTurn = () => session.state.turns[session.state.turns.length - 1]

  /**
   * The reader's own gesture, in the order they make it.
   *
   * `submit` is not awaited before `close()` — that is the whole scenario. The
   * promise is in flight, the panel goes away under it, and only then is the
   * turn allowed to finish.
   */
  const askThenClose = async (question = 'alpha widget token') => {
    session.open()
    const running = session.submit(question)
    session.close()
    await running
  }

  it('finishes the turn and marks the trigger', async () => {
    configure('notify')
    await askThenClose()

    // THE DEFECT, from the outside: this used to be `'no-answer'` carrying
    // `cause: 'not-answerable'`, which is the sentence about the corpus.
    expect(lastTurn().state).toBe('results')
    expect(lastTurn().refusal).toBe(null)
    expect(lastTurn().results.length).toBeGreaterThan(0)

    expect(session.state.unread).toBe(true)
    // 'notify' does not take the page back. That is the whole difference.
    expect(session.state.open).toBe(false)
  })

  it("brings the panel back under 'open', with the answer already in it", async () => {
    configure('open')
    await askThenClose()

    expect(session.state.open).toBe(true)
    expect(lastTurn().state).toBe('results')
    // `open()` clears the flag on its way through, so a panel the reader is
    // looking at never wears a dot pointing at itself.
    expect(session.state.unread).toBe(false)
  })

  it('under `false` there is no dot and no reopening — the switch removes it whole', async () => {
    configure(false)
    await askThenClose()

    expect(session.state.unread).toBe(false)
    expect(session.state.open).toBe(false)
  })

  it('marks nothing while the reader is watching', async () => {
    configure('notify')
    session.open()
    await session.submit('alpha widget token')

    expect(lastTurn().state).toBe('results')
    expect(session.state.unread).toBe(false)
  })

  it('clears on the next open, and only there', async () => {
    configure('notify')
    await askThenClose()
    expect(session.state.unread).toBe(true)

    // Not on a re-close, not on a route change — on the open. A reader who is
    // looking at the thread has read it.
    session.close()
    expect(session.state.unread).toBe(true)
    session.open()
    expect(session.state.unread).toBe(false)
  })

  it('leaves the thread where it was, so the answer is there on reopening', async () => {
    configure('notify')
    await askThenClose()
    const settled = lastTurn()

    session.open()
    expect(session.state.turns).toContain(settled)
    expect(session.state.unread).toBe(false)
  })
})

/**
 * THE BRANCH ITSELF, read rather than run.
 *
 * The behavioural half above cannot see the abort, for the reason the file
 * header gives. What it can do is hold the shape of the one line that decides:
 * `close()` reaches `stop()` under exactly one value, and a future edit that
 * drops the guard — restoring the unconditional abort, and the refusal with it
 * — fails here instead of in somebody's docs site.
 *
 * The same idiom rule 11 and the stylesheet rules use, and for the same reason:
 * the claim is about a source shape that no fixture in this package can reach.
 */
describe('ui.background — close is not stop', () => {
  const src = srcText('src/theme/docpilot/session.js')
  const body = (name) => {
    const at = src.indexOf(`export function ${name}() {`)
    expect(at, `${name}() is exported from session.js`).toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('\n}\n', at))
  }

  it('guards the abort on the setting', () => {
    expect(body('close')).toContain("if (state.config.ui.background === false) stop()")
  })

  it('leaves `stop()` unconditional — Stop still means stop', () => {
    const stop = body('stop')
    expect(stop).toContain('controller?.abort()')
    expect(stop).not.toContain('background')
  })

  /**
   * A TURN THAT SETTLED INTO A THREAD NOBODY IS IN.
   *
   * `finishTurn` already refuses to SAVE such a turn, and the badge has to sit
   * below the same check: a dot pointing at a conversation the reader let go of
   * would open the panel onto something else entirely.
   *
   * Held as an ordering claim rather than a behavioural one on purpose. The
   * scenario needs `newChat()` to land in the window between the turn being
   * registered and the turn settling, and in search-only that whole window is
   * microtasks — a test that tried to aim at it would be timing the scheduler,
   * not the rule.
   */
  it('places the badge below the abandoned-thread guard', () => {
    const fn = src.slice(src.indexOf('function finishTurn('))
    const guard = fn.indexOf('if (!state.turns.includes(turn)) return')
    const badge = fn.indexOf('state.unread = true')
    expect(guard, 'the abandoned-thread guard').toBeGreaterThan(-1)
    expect(badge, 'the badge').toBeGreaterThan(-1)
    expect(badge).toBeGreaterThan(guard)
  })
})
