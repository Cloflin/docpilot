/**
 * What the panel's parts share — provided once by `Panel.vue`, read by every
 * component under `panel/` through `usePanel()`.
 *
 * WHAT IS HERE is exactly what crosses a component boundary: state that has to
 * outlive the part that shows it — one open passage across the whole thread, a
 * result list's cursor that survives the window closing — and the actions more
 * than one part takes, above all the ones the Esc cascade in `Panel.vue` takes
 * as well. What only one part reads stays in that part.
 *
 * PROVIDED, NOT A MODULE SINGLETON. The store in `session.js` is one per page;
 * this is one per mounted panel — refs to ITS elements and ITS composer — and
 * two `mountDocPilot()` calls are two panels.
 */
import { inject, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type { Turn } from '../../docpilot/session.js'
import type { createFollower } from '../../docpilot/follow.js'

type Follower = ReturnType<typeof createFollower>
type Dock = 'picker' | 'prompt' | 'history'

export interface PanelContext {
  /** Every reader-facing string — the page's locale over the configured delta. */
  T: (path: string, vars?: Record<string, unknown>) => string
  uiLocale: ComputedRef<string>

  // ── the window ──────────────────────────────────────────────────────────────
  panel: Ref<HTMLElement | null>
  thread: Ref<HTMLElement | null>
  /** The composer's field, wherever it is — in the window or in the bar. */
  fieldEl: () => HTMLTextAreaElement | null
  mobile: Ref<boolean>
  coarse: Ref<boolean>
  /** The Esc cascade, smallest open thing first — the bar sends its Esc here. */
  onEsc: () => void

  // ── the thread ──────────────────────────────────────────────────────────────
  scrolled: Ref<boolean>
  atBottom: Ref<boolean>
  threadFollow: Follower
  onThoughtScroll: (turn: Turn, e: Event) => void
  fresh: Set<string>
  thoughtLabel: (turn: Turn) => string
  statusLabel: ComputedRef<string>
  submitText: (q: string, quoted?: string) => void
  suggestions: ComputedRef<string[]>
  hintSeen: Ref<boolean>
  dismissHint: () => void

  // ── a turn ──────────────────────────────────────────────────────────────────
  settledLine: (turn: Turn) => string
  shortScope: (refusal: any) => string
  turnScope: (turn: Turn) => string
  withSources: (turn: Turn) => string
  openPassage: Ref<string | null>
  linkedCite: Ref<number | null>
  resultCursor: Ref<Record<string, number>>
  feedbackLive: ComputedRef<boolean>
  submitFeedback: (turn: Turn) => void
  skipFeedback: (turn: Turn) => void
  focusIn: (selector: string) => void
  closeAction: (turn: Turn, a: any) => void
  editingId: Ref<string | null>
  editDraft: Ref<string>
  startTurnEdit: (turn: Turn) => void
  cancelTurnEdit: () => void
  onSourceClick: (e: MouseEvent, src: any) => void
  onAnswerClick: (e: MouseEvent) => void
  hasSearch: ComputedRef<boolean>
  openSearch: () => void

  // ── the composer and the bar ────────────────────────────────────────────────
  input: Ref<string>
  quote: Ref<string>
  closeAsk: () => void
  dropQuote: () => void
  placeholder: ComputedRef<string>
  fit: (el: HTMLTextAreaElement) => void
  grow: (e: Event) => void
  fieldInBar: ComputedRef<boolean>
  barWide: ComputedRef<boolean>
  barFocus: Ref<boolean>
  hotkey: ComputedRef<string>
  statusLine: ComputedRef<string>
  showBudgetLow: ComputedRef<boolean>

  // ── the three disclosures ───────────────────────────────────────────────────
  toggleDock: (which: Dock) => void
  closeDock: () => void
  dismissDock: () => void
  confirmClear: Ref<boolean>
  activePick: Ref<string | null>
  pickFilter: Ref<string>
  editing: Ref<boolean>
  draft: Ref<string>
}

export const PANEL: InjectionKey<PanelContext> = Symbol('docpilot-panel')

export function usePanel(): PanelContext {
  const panel = inject(PANEL, null)
  if (!panel) throw new Error('[docpilot] a part of the panel was rendered outside Panel.vue')
  return panel
}
