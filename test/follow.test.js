import { describe, it, expect } from 'vitest'
import { srcText } from './helpers/source.js'
import { atBottom, createFollower } from '../src/theme/docpilot/follow.js'
import { autoThought, toggleThought } from '../src/theme/docpilot/session.js'

/**
 * FOLLOWING A BOX THAT IS BEING WRITTEN TO, AND LETTING GO OF IT.
 *
 * Two scrollers grow under the reader's eyes — the thread and the reasoning box
 * inside it — and both used to be unescapable while they grew: the pin was read
 * on `wheel`, which fires BEFORE the browser applies the scroll, so it measured
 * the position the reader was leaving and re-pinned on every single notch. The
 * reader scrolled up to re-read a line and the next token put them back at the
 * foot, forever, for as long as the model kept talking.
 *
 * No DOM is needed to state any of that. A scroller is three numbers and a
 * writable `scrollTop`, and that is exactly what `follow.js` takes.
 */
const box = (scrollTop, scrollHeight = 1000, clientHeight = 200) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
})
/** Where the foot is, for a box of this shape. */
const FOOT = 800

describe('follow — the predicate', () => {
  it('is at the foot within the slack, and not past it', () => {
    expect(atBottom(box(FOOT))).toBe(true)
    expect(atBottom(box(FOOT - 39))).toBe(true)
    expect(atBottom(box(FOOT - 40))).toBe(false)
    expect(atBottom(box(0))).toBe(false)
  })

  it('takes the slack as an argument, so a caller can be stricter', () => {
    expect(atBottom(box(FOOT - 20), 10)).toBe(false)
    expect(atBottom(box(FOOT - 20), 40)).toBe(true)
  })
})

describe('follow — the follower', () => {
  it('starts pinned: a fresh turn is followed without being asked', () => {
    const f = createFollower()
    const el = box(0)
    f.follow(el)
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('lets go the moment the reader moves the box off its foot', () => {
    const f = createFollower()
    // The reader scrolls up — whatever they did it with, this is what the
    // scroller reports, and this is the only signal the follower reads.
    f.read(box(120))
    expect(f.pinned).toBe(false)

    const el = box(120)
    f.follow(el)
    expect(el.scrollTop).toBe(120) // not written: the reader is reading
  })

  /**
   * THE INVARIANT THE WHOLE REVERSAL RESTS ON.
   *
   * Listening to `scroll` is only safe because a write from this module always
   * targets the very foot, so the event it provokes can re-affirm the pin and
   * can never drop it. If a future edit ever scrolls to somewhere else, this
   * fails — and it should, because the follower would then unpin itself.
   */
  it('cannot unpin itself: its own write lands at the foot', () => {
    const f = createFollower()
    const el = box(0)
    f.follow(el)
    f.read(el) // the scroll event that write produced
    expect(f.pinned).toBe(true)
  })

  it('picks the chase back up when the reader returns to the foot', () => {
    const f = createFollower()
    f.read(box(120))
    expect(f.pinned).toBe(false)
    f.read(box(FOOT))
    expect(f.pinned).toBe(true)
  })

  it('repins on demand — the jump pill, and a box that was just emptied', () => {
    const f = createFollower()
    f.read(box(0))
    f.repin()
    const el = box(0)
    f.follow(el)
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('survives a box that is not there — a collapsed disclosure', () => {
    const f = createFollower()
    expect(() => f.follow(null)).not.toThrow()
    expect(() => f.read(null)).not.toThrow()
    expect(f.pinned).toBe(true)
  })
})

/**
 * THE READER'S PRESS OUTRANKS THE STREAM'S DEFAULT.
 *
 * `onStream` opens the reasoning box on EVERY thinking delta while no answer
 * text has arrived, so a press that closed it was undone within a frame and the
 * disclosure could not be closed at all while the model was thinking — the one
 * moment it is worth closing. The rule is now a pair of exported functions, and
 * a turn is a plain object as far as they are concerned.
 */
describe('session — the reasoning disclosure', () => {
  const turn = (over = {}) => ({ thoughtOpen: false, thoughtChoice: null, ...over })

  it('opens itself while nobody has said otherwise', () => {
    const t = turn()
    autoThought(t, true)
    expect(t.thoughtOpen).toBe(true)
    autoThought(t, false)
    expect(t.thoughtOpen).toBe(false)
  })

  it('records the press as an intent, not just a state', () => {
    const t = turn()
    toggleThought(t)
    expect(t.thoughtOpen).toBe(true)
    expect(t.thoughtChoice).toBe(true)
    toggleThought(t)
    expect(t.thoughtOpen).toBe(false)
    expect(t.thoughtChoice).toBe(false)
  })

  it('stays closed against a stream that keeps thinking', () => {
    const t = turn({ thoughtOpen: true })
    toggleThought(t) // the reader collapses it mid-thought
    for (let i = 0; i < 50; i += 1) autoThought(t, true)
    expect(t.thoughtOpen).toBe(false)
  })

  it('stays open against the first answer token and the settled turn', () => {
    const t = turn()
    toggleThought(t) // the reader opens it deliberately
    autoThought(t, false) // ev.text: the answer starts
    autoThought(t, false) // finishTurn
    expect(t.thoughtOpen).toBe(true)
  })

  it('is a fact about one turn: the next question reasons out loud again', () => {
    const t = turn()
    toggleThought(t)
    toggleThought(t)
    // A fresh turn carries a fresh `thoughtChoice`, which is the whole of the
    // scoping rule — nothing in `state` and nothing in storage remembers it.
    const next = turn()
    autoThought(next, true)
    expect(next.thoughtOpen).toBe(true)
  })

  /**
   * The source shape, held here for the same reason `ui.background` holds one:
   * the claim is "no other line in session.js writes this flag", and no fixture
   * can reach a line that does not exist yet. A future edit that reaches past
   * the pair — the way `onStream` used to — fails here.
   */
  it('writes `thoughtOpen` from exactly two places', () => {
    const src = srcText('src/theme/docpilot/session.js')
    const writes = src.match(/turn\.thoughtOpen\s*=/g) || []
    expect(writes.length, 'autoThought and toggleThought, and nothing else').toBe(2)
    expect(src).toContain('if (turn.thoughtChoice === null) turn.thoughtOpen = open')
  })
})
