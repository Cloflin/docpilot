/**
 * The reader instruction — RAG-SPEC 4.7.
 *
 * sessionStorage only: it must not survive the tab and must not be shareable.
 * No URL parameter reads or writes it, and there is no window setter.
 */

import { clampAddendum, APPEND_MAX } from './prompt.js'

const KEY = 'stripo-ask-ai:instruction'

/** Held in a module variable when storage throws, so the feature degrades to the page. */
let memory = ''

export { clampAddendum, APPEND_MAX }

export function get() {
  try {
    return clampAddendum(sessionStorage.getItem(KEY) || memory)
  } catch {
    return clampAddendum(memory)
  }
}

export function set(value) {
  const clamped = clampAddendum(value)
  memory = clamped
  try {
    if (clamped) sessionStorage.setItem(KEY, clamped)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* private mode — the instruction lives for this page only */
  }
  return clamped
}

export function clear() {
  set('')
}

/** 8 hex of the instruction, for the feedback record. The text itself never leaves. */
export function hash(value) {
  const s = clampAddendum(value)
  if (!s) return null
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
