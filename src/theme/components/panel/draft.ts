/**
 * ── the composer's draft — ui-specs/012 ──────────────────────────────────────
 *
 * `sessionStorage`, paired with `docpilot:conversation` rather than with the
 * `localStorage` archive, and for that key's own reason: a draft belongs to the
 * tab that is typing it. Two tabs are two questions.
 *
 * REDACTED BEFORE IT IS WRITTEN, and this is the part that is not optional. A
 * pasted key is caught before a turn exists, and every path that writes to
 * storage redacts first — the draft is the one text in this panel that reaches
 * disk BEFORE any of that machinery has seen it, which makes it the exact shape
 * of hole every other path has closed.
 *
 * GATED ON `history.enabled` AS WELL. That setting is published as "stops
 * recording AND clears what is already stored"; a draft surviving it would make
 * the sentence false. Which is also why a mount with either switch off REMOVES
 * the key rather than merely declining to write one.
 */
import { onBeforeUnmount, watch, type Ref } from 'vue'
import * as session from '../../docpilot/session.js'
import { redactSecrets } from '../../docpilot/credentials.js'

const DRAFT_KEY = 'docpilot:draft'

export function useDraft(input: Ref<string>) {
  const s = session.state
  let draftTimer: ReturnType<typeof setTimeout> | null = null

  const draftsOn = () => s.config.composer.draft && s.config.history.enabled

  function keepDraft(text) {
    try {
      const clean = draftsOn() ? redactSecrets(text || '').clean : ''
      if (clean) sessionStorage.setItem(DRAFT_KEY, clean)
      else sessionStorage.removeItem(DRAFT_KEY)
    } catch {
      /* private mode — the draft does not survive, and nothing else changes */
    }
  }

  /**
   * Read once, at mount, and only into an EMPTY composer.
   *
   * Before `applyDeepLink`, which is the precedence that matters: `?dp-ask=` is an
   * intent the reader expressed a second ago by following a link, and a draft is
   * one they left behind. The deep link drains through `pendingQuestion` and
   * overwrites this.
   */
  function restoreDraft() {
    try {
      if (!draftsOn()) return sessionStorage.removeItem(DRAFT_KEY)
      const saved = sessionStorage.getItem(DRAFT_KEY)
      if (saved && !input.value) input.value = saved
    } catch {
      /* see above */
    }
  }

  watch(input, (v) => {
    clearTimeout(draftTimer)
    // Clearing is IMMEDIATE, writing is debounced. `send()` empties the field, and
    // a reader who leaves inside the debounce window would otherwise come back to
    // a draft of the question they had just asked.
    if (!v) return keepDraft('')
    draftTimer = setTimeout(() => keepDraft(v), 400)
  })

  /**
   * The page is going away — ui-specs/012. Both halves of "keep what you have":
   * the turn that is still streaming, and the sentence still in the field, whose
   * debounce has not fired yet.
   */
  function onLeaving() {
    session.saveIfRunning()
    clearTimeout(draftTimer)
    keepDraft(input.value)
  }

  onBeforeUnmount(() => clearTimeout(draftTimer))

  return { restoreDraft, onLeaving }
}
