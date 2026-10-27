/**
 * The three disclosures — the scope picker, the prompt document and the past
 * conversations — at most one open, each opened where its trigger is.
 * ui-specs/003.
 *
 * The state the three of them carry lives HERE rather than in the components
 * that draw it, because closing a dock is what clears it and a closed dock is
 * a component that no longer exists: `resetDock` is the one place that decides
 * what a dock forgets.
 */
import { nextTick, ref, type Ref } from 'vue'
import * as session from '../../docpilot/session.js'

const OPENERS = {
  picker: '#dp-scope-btn',
  prompt: '.docpilot__prompt-toggle',
  history: '#dp-history-btn',
}

export function useDocks(panel: Ref<HTMLElement | null>) {
  const s = session.state
  // The prompt document's own editor — PromptDoc.vue.
  const draft = ref('')
  const editing = ref(false)
  // The two-step "Clear all" — History.vue.
  const confirmClear = ref(false)
  // The picker's filter and its one tab stop — ScopePicker.vue.
  const pickFilter = ref('')
  const activePick = ref<any>(null)

  function closeDock() {
    const opener = OPENERS[s.dockPanel] || OPENERS.prompt
    resetDock()
    nextTick(() => panel.value?.querySelector<HTMLElement>(opener)?.focus())
  }

  function resetDock() {
    s.dockPanel = null
    editing.value = false
    confirmClear.value = false
    // The picker's tab stop and its filter both go back with it. A reopened
    // picker is a fresh decision, and returning the reader to a row — or to a
    // narrowing — from three conversations ago is a memory nobody asked this
    // control to keep.
    activePick.value = null
    pickFilter.value = ''
  }

  /**
   * The scope picker and the conversation list let go when the reader moves on —
   * a press in the thread, or typing in the composer. ui-specs/019.
   *
   * Without the focus return `closeDock()` makes: focus is already where the
   * reader put it, and handing it to the opener would pull the caret out of the
   * field between two keystrokes. The prompt document is not one of the two: it
   * is read beside the question it shapes.
   */
  function dismissDock() {
    if (s.dockPanel === 'picker' || s.dockPanel === 'history') resetDock()
  }

  // Focused by id, not by class: the conversation list also carries the picker's
  // class, so a class selector would focus the wrong node the day both exist.
  function toggleDock(which) {
    s.dockPanel = s.dockPanel === which ? null : which
    confirmClear.value = false
    // What stands in for a `storage` event: another tab may have added or removed
    // a conversation since this list was last drawn.
    if (s.dockPanel === 'history') session.refreshHistory()
    if (s.dockPanel) nextTick(() => panel.value?.querySelector<HTMLElement>(`#dp-${which}`)?.focus())
  }

  return { draft, editing, confirmClear, pickFilter, activePick, closeDock, dismissDock, toggleDock }
}
