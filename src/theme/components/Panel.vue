<template>
  <Teleport to="body">
    <!--
      RESIDENT, where it used to be `v-if="s.open"` — ui-specs/015. Two things
      need it to outlive the panel: an exit animation, which keeps the panel's
      node until it has played, and the bar, which is on the page whether the
      window is open or not. With neither, it is one empty block in `<body>`.

      Under `panel: 'bar'` this element IS the bar's stack — fixed at the bottom
      centre, the window above the bar in one column — so the window always sits
      on top of the bar however tall the reader's question makes it.
    -->
    <div ref="root" class="docpilot" :class="rootClass">
      <Transition name="dp-scrim">
        <div v-if="s.open && mobile" class="docpilot__scrim" @click="close" />
      </Transition>

      <!--
        Desktop is NON-MODAL: no scrim, no focus trap, docs stay readable beside
        the answer. Declaring aria-modal there would be a lie. Below 960px there
        is no room to read anything else, so it is honestly modal — and Tab is
        held inside to make it so (`holdTab`).

        One transition for every shape: the stylesheet picks the exit from the
        shape's class, and below 960px every shape leaves as the sheet it is.
      -->
      <Transition name="dp-panel">
      <section
        v-if="s.open"
        id="dp-panel"
        ref="panel"
        class="docpilot__panel"
        :class="[`docpilot__panel--${panelKind}`, `is-side-${s.config.ui.side}`]"
        tabindex="-1"
        :role="mobile ? 'dialog' : 'complementary'"
        :aria-modal="mobile ? 'true' : undefined"
        aria-labelledby="dp-title"
        @keydown.esc.stop.prevent="onEsc"
        @keydown.tab="holdTab"
        @pointerover="aimLens"
        @pointerout="leaveLens"
      >
        <Header />

        <!--
          Past conversations, docked under the header — ui-specs/003.

          It opens where its trigger is: the button is top right, beside New chat
          and Close, and a disclosure that appears three hundred pixels away at
          the other end of the panel is a disclosure the reader has to go find.
          It is also a navigation surface — picking a row replaces the whole
          thread — and one that pushed the composer around while being read.

          Its own shell rather than the scope picker's: that one carries a rule
          on its TOP edge, which is correct under a thread and inverted here.
        -->
        <Transition name="dp-dock">
          <History v-if="s.dockPanel === 'history'" />
        </Transition>

        <div
          ref="thread"
          class="docpilot__thread"
          tabindex="0"
          role="region"
          :aria-label="T('panel.conversation')"
          @scroll.passive="onThreadScroll"
          @click="onThreadClick"
        >
          <!-- The docs were rebuilt since this conversation was written. The
               answers still render — every in-answer link is re-checked against
               the current index — but a citation ROW is host-built data and can
               still point at a page that has gone. -->
          <p v-if="s.conversationStale && s.turns.length" class="docpilot__meta">
            {{ T('history.stale') }}
          </p>

          <!-- `!s.busy` as well as `!s.turns.length`: editing the FIRST question
               empties the thread for the width of one flush before the
               replacement turn is pushed, and a greeting that blinks through
               that gap reads as the panel resetting itself. -->
          <EmptyState v-if="!s.turns.length && !s.busy" />

          <Turn v-for="turn in s.turns" :key="turn.id" :turn="turn" />
        </div>

        <!--
          Back to the newest answer, on a rail of zero height between the thread
          and everything under it.

          The `v-if` is on the RAIL and a class does the showing, because a
          `v-if` on the button itself would give the reveal no fade — and a
          `<Transition>` for one control would be a mechanism this package does
          not otherwise have. The opacity/pointer-events pair is the code card's
          copy chip, one floor down.

          Hidden from the tab order rather than merely faded, which is where it
          differs from that chip: at the foot of the thread "go to the foot of
          the thread" is not an action. Withdrawn entirely while a dock is open —
          the picker and the prompt grow out of the composer and the pill would
          be pointing into the part they cover.
        -->
        <div v-if="s.turns.length && !s.dockPanel" class="docpilot__jump-rail">
          <button
            type="button"
            class="docpilot__jump"
            :class="{ 'is-visible': !atBottom }"
            :tabindex="atBottom ? -1 : 0"
            :aria-hidden="atBottom ? 'true' : undefined"
            :aria-label="T('panel.jumpToLatest')"
            @click="jumpToLatest"
          >
            <Icon name="chevronDown" />
          </button>
        </div>

        <!--
          The selection popover — ui-specs/007.

          BETWEEN the thread and the composer, and that is the tab order it
          exists for: a reader who selected inside the thread presses Tab once to
          reach "Ask AI" and once more to reach the field. It is also still
          inside the panel, so the Esc handler on the section above still fires
          when focus is on the button.

          Top layer where the platform has one, so the popup shape's
          `overflow: hidden` cannot clip it; a plain fixed box where it does not,
          which is not clipped either. `manual`, never `auto`: an auto popover
          light-dismisses on the pointerdown that BEGINS the next selection, and
          Esc belongs to the cascade rather than to the platform.
        -->
        <div
          v-if="askOpen"
          ref="askEl"
          class="docpilot__ask"
          :class="{ 'is-below': askBelow }"
          :popover="canPopover ? 'manual' : null"
          :style="askStyle"
        >
          <button type="button" class="docpilot__text-btn docpilot__ask-btn" @click="takeQuote">
            <Icon name="quote" />{{ T('quote.ask') }}
          </button>
        </div>

        <Composer />
      </section>
      </Transition>

      <!--
        The bar — ui-specs/015, `panel: 'bar'`. After mount only (`barOn` waits
        for it): the settings that ask for it are read in the browser, and a
        fixed box arriving late shifts nothing.
      -->
      <Bar v-if="barOn" />
    </div>
    <!--
      OUTSIDE the `v-if`, and that is the whole point of it being down here.

      It used to live in the composer, which meant it was destroyed with the
      panel — so a turn that settled while the panel was shut announced into
      nothing, and ui-specs/010 made that the normal case rather than an edge
      one. It also means the region is now RESIDENT: a live region inserted in
      the same frame as its text is a region some screen readers do not
      announce, which is a race this used to run on every open.

      This component is mounted on every page; only its subtree is conditional.
    -->
    <div class="docpilot__sr" aria-live="polite">{{ announced }}</div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * The panel — the window, the bar, and what ties their parts together.
 *
 * WHAT IS HERE: the shell both are drawn in, the panel's life on the page —
 * mount, unmount, the store's handoffs — focus on open and close, the Esc
 * cascade, and the state its parts share, provided to them as one context
 * (`panel/context.ts`).
 *
 * WHAT IS NOT: every region of the window is a component under `panel/`, and
 * every mechanism with a life of its own — the live region's queue, the push
 * layout, the hover lens, the draft, the composer's limits line, the docks,
 * following the stream, quoting — is a composable beside them. Each one owns
 * the comments that explain it.
 */
import { computed, nextTick, onMounted, onBeforeUnmount, provide, reactive, ref, watch } from 'vue'
import * as session from '../docpilot/session.js'
import { useHost, hostConfig } from '../docpilot/host.js'
import { resolveI18n, t as translate, normaliseLocale } from '../docpilot/i18n.js'
import { DEFAULT_SUGGESTIONS, SUGGESTION_LIMIT } from '../docpilot/switches.js'
import { bindUnload, unbindUnload } from '../docpilot/unload.js'
import { PANEL } from './panel/context.js'
import { useAnnouncer } from './panel/announcer.js'
import { useAutoscroll } from './panel/autoscroll.js'
import { useDocks } from './panel/docks.js'
import { useDraft } from './panel/draft.js'
import { useLens } from './panel/lens.js'
import { useLimits } from './panel/limits.js'
import { useLinks } from './panel/links.js'
import { useProgress } from './panel/progress.js'
import { usePush } from './panel/push.js'
import { useQuoting } from './panel/quoting.js'
import Bar from './panel/Bar.vue'
import Composer from './panel/Composer.vue'
import EmptyState from './panel/EmptyState.vue'
import Header from './panel/Header.vue'
import History from './panel/History.vue'
import Icon from './panel/Icon.vue'
import Turn from './panel/Turn.vue'

const s = session.state
const { theme, route, lang, router } = useHost()

/**
 * Every reader-facing string in the panel goes through `T`.
 *
 * The tree is the configured DELTA — the shipped defaults live inside i18n.js
 * and are looked up behind it, so a project that overrides nothing ships no
 * extra bytes. The selector is the PAGE's locale: this is chrome. The two
 * strings that follow the reader's typed language instead — the credential and
 * social replies — are settled in session.js and arrive already rendered.
 */
const i18nTree = computed(() => resolveI18n(s.config.i18n))
const uiLocale = computed(() => normaliseLocale(lang.value, i18nTree.value))
const T = (path, vars) => translate(i18nTree.value, uiLocale.value, path, vars)

const panel = ref<HTMLElement | null>(null)
// The resident root — the panel AND the bar. Anything that has to find the
// composer's field looks here rather than in `panel`: under `panel: 'bar'` the
// field is not inside the panel at all. ui-specs/015.
const root = ref<HTMLElement | null>(null)
const fieldEl = () => root.value?.querySelector<HTMLTextAreaElement>('.docpilot__field textarea') ?? null
const thread = ref<HTMLElement | null>(null)
const askEl = ref<HTMLElement | null>(null)
const mobile = ref(false)
// Not the same question as `mobile`. A narrow window is about how much room
// there is; this is about what the platform draws over a selection — see
// `place()` in selection.js, which flips the popover below one on a touchscreen.
const coarse = ref(false)

/**
 * Has the thread moved off its top? — ui-specs/002.
 *
 * The header's divider is absent at rest and appears the moment there is
 * something above the fold, so the title reads as a layer over the conversation
 * rather than as a permanent second boundary competing with the panel's edge.
 *
 * CSS scroll-state queries (`@container scroll-state(scrollable: top)`) are the
 * native form of this and are Chromium-only today, so this is the fallback that
 * guide itself documents: one class, from one predicate. The listener is
 * passive — it never calls `preventDefault`, and a non-passive scroll handler on
 * the panel's one scroller is a jank source for no gain.
 */
const scrolled = ref(false)

const { atBottom, threadFollow, syncAtBottom, onThoughtScroll, jumpToLatest } = useAutoscroll(panel, thread)

const onThreadScroll = (e: Event) => {
  scrolled.value = e.target.scrollTop > 0
  // Whatever moved the thread — a wheel, a finger, a scrollbar, PageUp, a
  // screen reader — this is where the follower hears about it. An autoscroll
  // write lands at the foot, so its own event can only re-pin: follow.js.
  threadFollow.read(e.target)
  syncAtBottom()
  // The selection popover is placed against the viewport, so a scrolling thread
  // moves the passage out from under it. `reposition` is a no-op when it is
  // closed, which is nearly always.
  reposition()
}

/**
 * Which of the two shapes this panel is — resolved once, in the store, and read
 * here as a finished value. Never `'auto'`: `resolveUi` settles that at build
 * time and again in `configure()`, so the template's only job is to name it.
 */
const panelKind = computed(() => s.config.ui.panel)
const input = ref('')
const announced = useAnnouncer()

/**
 * ── the bar — ui-specs/015 ──────────────────────────────────────────────────
 *
 * `hydrated` because the bar is decided in the browser: the settings that ask
 * for it reach the store in `configure()`, on mount, and a server render that
 * guessed would hand the client a node it then has to take away.
 *
 * `fieldInBar` is the one question the template asks: on a wide screen the
 * field leaves the composer for the bar, and below 960px it stays in the sheet
 * where it has always been.
 */
const hydrated = ref(false)
const barOn = computed(
  () => hydrated.value && panelKind.value === 'bar' && s.config.enabled !== false,
)
const fieldInBar = computed(() => barOn.value && !mobile.value)
const barFocus = ref(false)
// Wide while it is being used: focused, holding a question, or under an open
// window, which takes the bar's width.
const barWide = computed(() => fieldInBar.value && (barFocus.value || !!input.value.trim() || s.open))
const rootClass = computed(() => ({
  'docpilot--bar': barOn.value,
  'is-open': s.open,
  'is-wide': barWide.value,
}))
// How the hotkey is written at rest in the bar — the trigger's own rule.
const mac = ref(false)
const hotkey = computed(() => (mac.value ? '⌘I' : 'Ctrl I'))
/**
 * A press outside the bar and the window closes the window, and that press has
 * put the reader somewhere — so focus is NOT handed back to the bar the way a
 * close from the keyboard hands it back. One flag, read once by the watcher.
 */
let skipFocusReturn = false

/**
 * The turns the reader asked while looking — they rise in; ui-specs/015.
 *
 * One more turn than there was, while the panel is open, is an arrival the
 * reader caused. A restored conversation replaces the list, and reopening the
 * panel re-mounts every turn: neither is news, and neither is in here — the set
 * is emptied when the panel closes.
 */
const fresh = reactive(new Set<string>())
watch(
  () => s.turns.length,
  (n, was) => {
    const last = s.turns[n - 1]
    // `restored` as well: a stored conversation of exactly one turn also lands
    // as one more turn than there was.
    if (s.open && n === was + 1 && last && !last.restored) fresh.add(last.id)
  },
)

let trigger: HTMLElement | null = null
let mql: MediaQueryList | null = null
let coarseMql: MediaQueryList | null = null
// The selection watcher's five listeners, released as one — see `bindAsk`.
let unbindAsk: (() => void) | null = null

// Declared once, at module-body level, because it is both ADDED and REMOVED.
// It used to be an arrow inside `onMounted` while the removal named a hoisted
// function of the same name — two different references, so the listener was
// added on every mount and removed on none of them.
function sync() {
  mobile.value = !mql?.matches
}
function syncPointer() {
  coarse.value = !!coarseMql?.matches
}

onMounted(() => {
  mql = window.matchMedia('(min-width: 960px)')
  sync()
  mql.addEventListener('change', sync)
  coarseMql = window.matchMedia('(pointer: coarse)')
  syncPointer()
  coarseMql.addEventListener('change', syncPointer)

  // What the page keeps when it goes away — ui-specs/012. Bound here rather than
  // in `open()` because a turn outlives the panel (ui-specs/010): the thing that
  // has to survive leaving is the TURN, and it runs whether the panel is on
  // screen or not. The component is resident — the polite region lives outside
  // the `v-if` for the same reason — so this listener's life is the panel's life
  // on the page.
  bindUnload(onLeaving)

  // Read on mount, not in the ref's initialiser: `localStorage` does not exist
  // during SSR, and the default is `true` so a server render and the first
  // client frame agree on showing nothing.
  try {
    hintSeen.value = localStorage.getItem(HINT_KEY) === '1'
  } catch {
    hintSeen.value = true
  }

  // Same reason, and armed HERE rather than at setup — see limits.ts.
  armBudgetLow()

  unbindAsk = bindAsk()

  session.configure(theme.value, route.value, lang.value)

  // After `configure`, which is what tells this component whether there is a
  // bar at all — ui-specs/015.
  hydrated.value = true
  mac.value = /mac/i.test(navigator.platform || navigator.userAgent)
  // Capture, like the selection watcher's: a host control that stops
  // propagation must not keep the window open over the page it was pressed on.
  document.addEventListener('pointerdown', onOutsidePointer, true)
  // `ui.prefetch: 'idle'` is scheduled by the trigger that draws, and under the
  // bar no trigger draws in the corner. The bar is the placement here, so it
  // schedules — the index load is memoised, so a navbar trigger doing the same
  // costs nothing.
  if (barOn.value && s.config.ui.prefetch === 'idle') {
    const run = () => session.prefetchIndex()
    idleHandle = window.requestIdleCallback
      ? window.requestIdleCallback(run, { timeout: 3000 })
      : setTimeout(run, 1200)
  }

  // The composer's own text, before the deep link that may replace it.
  restoreDraft()

  // `?dp-ask=` — ui-specs/009. After `configure`, because the switch that
  // governs it arrives with the config; the question lands in `pendingQuestion`
  // and is drained by the watcher below, which is also where a passage quoted
  // in the host's article arrives.
  session.applyDeepLink(location.search, (params) => {
    const q = params.toString()
    history.replaceState(history.state, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`)
  })
})

/**
 * A question handed in from outside the panel — ui-specs/009.
 *
 * The store carries it rather than the component reading the URL itself,
 * because two surfaces put a question there: the deep link above, and the
 * article's own selection popover. Draining it here keeps `input` the single
 * owner of what is in the field.
 *
 * NOT SUBMITTED, in either case. The reader reads what somebody else wrote
 * before it is asked on their behalf.
 */
watch(
  () => s.pendingQuestion,
  (q) => {
    if (!q) return
    input.value = q
    s.pendingQuestion = ''
    nextTick(() => {
      const ta = fieldEl()
      if (!ta) return
      fit(ta)
      // The caret at the end, so the reader can add to it without pressing End
      // first — `startTurnEdit`'s rule, and for the same reason.
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  },
)

// The passage half of the same handoff: a selection taken in the host's article
// arrives as a draft chip, exactly as one taken inside an answer does.
watch(
  () => s.pendingQuote,
  (text) => {
    if (!text) return
    quote.value = text
    s.pendingQuote = ''
  },
)

// The page's locale, kept in the store as well as here: session.js writes the
// screen-reader announcements and settles the credential and social replies, and
// none of that runs inside a component where `useHost()` is reachable.
watch(lang, (l) => session.setLang(l))

// A config pushed in after mount — `mountDocPilot().setConfig()`, the React
// adapter's `config` prop — lands on the host's `theme`, and `configure` above
// ran once. The trigger reads `theme` itself, so it followed while the panel
// kept the first config. A second `configure` replaces the config and touches
// no turn, index or scope: the reader's thread survives the push. It watches
// the `docPilot` block, not `theme`: a VitePress 2 locale hands a new `theme`
// object on every navigation, and that is not a new config.
watch(
  () => theme.value?.docPilot,
  () => session.configure(theme.value, route.value, lang.value),
)

onBeforeUnmount(() => {
  mql?.removeEventListener('change', sync)
  coarseMql?.removeEventListener('change', syncPointer)
  document.removeEventListener('pointerdown', onOutsidePointer, true)
  if (idleHandle != null) {
    window.cancelIdleCallback ? window.cancelIdleCallback(idleHandle) : clearTimeout(idleHandle)
    idleHandle = null
  }
  unbindUnload()
  unbindAsk?.()
  unbindAsk = null
})

watch(route, (r) => (s.currentPath = r))

usePush(mobile, panelKind)

watch(
  () => s.open,
  async (open) => {
    if (open) {
      trigger = document.activeElement
      await nextTick()
      setTimeout(() => {
        // Below 960px focus the container, never the textarea: a tabindex="-1"
        // container does not raise the software keyboard over the whole sheet.
        if (mobile.value) panel.value?.focus()
        // The composer, by its own class — a bare `textarea` is whichever one
        // comes first in the DOM, and an open feedback comment or question
        // editor sits above the composer in the thread. Under the bar it is the
        // bar's field, which is where the reader was typing anyway.
        else fieldEl()?.focus()
      }, 60)
    } else {
      // The popover's node unmounts with the panel, which implicitly closes it —
      // but `askOpen` would stay true and the next open would call showPopover()
      // against a stale rect.
      closeAsk()
      quote.value = ''
      // Reopening is not an arrival — see `fresh`.
      fresh.clear()
      // Wait for the panel to leave the DOM first. The floating button is
      // hidden by a `:has()` rule while a panel is open, and `focus()` on a
      // `display: none` element is a silent no-op — so without this the focus
      // would be dropped on the floor exactly in the mode where the button the
      // reader pressed is the only thing to return to. A panel that is still
      // playing its exit no longer counts as open to that rule — ui-specs/015.
      await nextTick()
      // Closed by a press somewhere on the page: the reader is there now.
      if (skipFocusReturn) {
        skipFocusReturn = false
        trigger = null
        return
      }
      if (trigger && document.contains(trigger)) trigger.focus()
      else visibleTrigger()?.focus?.()
      trigger = null
    }
  },
)

/**
 * THE SHEET IS MODAL, SO TAB STAYS IN IT — t4 R-5.
 *
 * Below 960px the section says `aria-modal="true"`, and that is a promise to a
 * screen reader only: nothing held the keyboard. Tab from the last control
 * walked out to the page under the scrim, and Esc — a listener on this section
 * — stopped working the moment it had. So the sheet's last stop wraps to its
 * first and the first, or the sheet itself, back to the last.
 *
 * A trap, not `inert` on the page. The panel is teleported into a host's
 * `<body>`; marking the host's own nodes inert would also freeze a dialog the
 * host opens over the sheet — its search, say — which is the host's to run.
 *
 * "Is there a stop left in this direction", not "is this the last stop": focus
 * can sit on a `tabindex="-1"` node — the sheet, a dock, a picker row — that no
 * list of stops contains. `getClientRects` is `visibleTrigger`'s test: a closed
 * popover or a collapsed block is still in the DOM, and a node with no box is
 * no stop.
 *
 * Read at the keystroke, from `mobile`, so a window widened past 960px lets go
 * on the next Tab with nothing to undo, and the listener leaves with the section.
 */
const TAB_STOPS = 'a[href], button, input, select, textarea, summary, [tabindex]'

function holdTab(e: KeyboardEvent) {
  const box = panel.value
  if (!mobile.value || !box) return
  const stops = [...box.querySelectorAll<HTMLElement>(TAB_STOPS)].filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0,
  )
  const at = e.target as Node
  const way = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING
  if (stops.some((el) => at.compareDocumentPosition(el) & way)) return
  e.preventDefault()
  ;((e.shiftKey ? stops.at(-1) : stops[0]) ?? box).focus()
}

/**
 * Where focus lands when the element that opened the panel is gone — a route
 * change while it was open, or a `v-if` that unmounted the mobile nav screen.
 *
 * HARDENING, NOT A FIX, and worth saying so plainly: no configuration is known
 * where this changes the outcome today. It was written when `trigger` became a
 * list, on the reasoning that `document.querySelector('.docpilot-nav-trigger')`
 * returns whichever placement is FIRST IN THE DOCUMENT — the navbar button
 * whenever there is one — and `focus()` on a `display: none` element is a silent
 * no-op. Measured across 320–1400px on VitePress 1.6.4 and 2.0.0-alpha.19, the
 * navbar button is displayed at every width, so the premise does not currently
 * bite; the placements are configurable and the hide rules are CSS, so "the
 * first one is the one you can see" is an assumption this had no reason to keep.
 *
 * `getClientRects()` is the test, not `offsetParent`: a `position: fixed`
 * element — which the FAB is — reports a null `offsetParent` in every browser
 * even when it is plainly on screen.
 *
 * The host's own content is the last resort and was already: somewhere in the
 * document beats nowhere, which is what a dropped focus means for a keyboard.
 */
function visibleTrigger() {
  // Under the bar the bar IS the trigger, and it is always on screen.
  if (barOn.value) {
    const bar = root.value?.querySelector('.docpilot__bar textarea, .docpilot__bar-btn')
    if (bar) return bar
  }
  const buttons = document.querySelectorAll('.docpilot-nav-trigger')
  for (const el of buttons) if (el.getClientRects().length) return el
  return document.querySelector(hostConfig(s.config).content)
}

const close = () => session.close()

// The form unmounts on submit, and focus would land on <body> — a keyboard
// reader would be returned to the top of the document, three screens from where
// they were. Back to the thumb that opened it, which is `closeDock`'s own rule.
function refocusThumb(turn) {
  nextTick(() => panel.value?.querySelector(`#dp-down-${turn.id}`)?.focus())
}
const submitFeedback = (turn) => {
  session.submitFeedback(turn)
  refocusThumb(turn)
}
const skipFeedback = (turn) => {
  session.skipFeedback(turn)
  refocusThumb(turn)
}

// An answer's action form — ui-specs/018. Closed from its own Cancel and from
// the Esc cascade below, so it is the panel's; ToolActions.vue opens it.
const focusIn = (selector) => nextTick(() => panel.value?.querySelector(selector)?.focus())

function closeAction(turn, a) {
  a.open = false
  a.errors = {}
  focusIn(`#dp-act-${turn.id}-${a.id}`)
}

const { draft, editing, confirmClear, pickFilter, activePick, closeDock, dismissDock, toggleDock } = useDocks(panel)

function onEsc() {
  // FIRST. The popover is the most recently opened thing on screen and the one
  // the reader is looking at; anything below this would close a disclosure they
  // are not thinking about, or the panel itself. It does NOT clear the chip:
  // that is content the reader chose, like a typed draft, and the same rule the
  // feedback comment keeps applies. The `×` is its removal.
  if (askOpen.value) return closeAsk()
  const active = document.activeElement
  const has = (sel) => panel.value?.querySelector(sel)?.contains(active)
  // `.docpilot__dock` is named here as well as the picker and the prompt: the
  // conversation list stopped wearing the picker's class when it moved to the
  // top of the panel, and without this Esc inside it would fall past the
  // disclosure and close the whole panel.
  if (s.dockPanel && (has('.docpilot__picker') || has('.docpilot__prompt') || has('.docpilot__dock')))
    return closeDock()
  // The question editor, when the caret is in it. The draft IS discarded here,
  // where the feedback comment's is kept — and the difference is that the
  // original question is still one line above, unharmed, while a comment exists
  // nowhere else once it is gone.
  if (editingId.value && has('.docpilot__edit')) return cancelTurnEdit()
  // An action's form — ui-specs/018 — closes on Esc and keeps the panel, on the
  // feedback form's terms. Matched by its own id, because it wears that form's
  // class and the first one in the panel is not necessarily this one.
  for (const t of s.turns) {
    for (const a of t.actions || []) {
      if (a.open && panel.value?.querySelector(`#dp-form-${t.id}-${a.id}`)?.contains(active)) return closeAction(t, a)
    }
  }
  const reasonTurn = s.turns.find((t) => t.reasonOpen)
  // The FORM, not the reasons row inside it. Focus is usually in the textarea,
  // which is the row's SIBLING — testing the row let Esc fall through to
  // `close()` and take the whole panel with it, discarding what was typed.
  // Escape closes the form and keeps the draft: the reader can reopen it.
  if (reasonTurn && has('.docpilot__feedback')) return skipFeedback(reasonTurn)
  if (s.dockPanel) return closeDock()
  if (reasonTurn) return skipFeedback(reasonTurn)
  // Focus left the editor without closing it — clicked into the composer, say.
  // Esc still belongs to the open thing before it belongs to the panel.
  if (editingId.value) return cancelTurnEdit()
  if (s.busy) return session.stop()
  close()
}

/**
 * A press in the thread, and only a press — ui-specs/019. Three clicks reach
 * the thread with no press in it behind them:
 *
 *   · Enter or Space on a control inside it. The click that synthesises has
 *     `detail` 0; a pointer's carries its count.
 *   · The end of a drag that selected text. It lands on the common ancestor,
 *     and the "Ask AI" button is already placed on that selection: moving the
 *     thread up under it would leave the button over other lines.
 *   · Chromium's own scrollbar, whose click reaches the element. Closing the
 *     list there grows the thread under the thumb the reader is holding.
 */
function onThreadClick(e: MouseEvent) {
  if (e.detail === 0) return
  if (document.getSelection()?.isCollapsed === false) return
  const el = e.currentTarget as HTMLElement
  if (e.target === el) {
    const box = el.getBoundingClientRect()
    const x = e.clientX - box.left - el.clientLeft
    const y = e.clientY - box.top - el.clientTop
    if (x < 0 || y < 0 || x >= el.clientWidth || y >= el.clientHeight) return
  }
  dismissDock()
}

const { aimLens, leaveLens } = useLens(panel)

/**
 * ── editing a question ──────────────────────────────────────────────────────
 *
 * The state is LOCAL to the panel, and two refs rather than a flag on each
 * turn. Three reasons, in order of weight: a turn is the transcript — it is
 * archived, attached to a feedback report and handed to the model, and a draft
 * is none of those; one `editingId` makes "at most one editor is open"
 * structurally true instead of an invariant somebody has to maintain in a loop;
 * and the object a flag would live on is the one `editTurn` destroys.
 *
 * The editor itself is Question.vue's. It opens from the pencil there and from
 * the composer's ↑, and closes from the Esc cascade above — which is why its
 * state is here. `editing` and `draft` are the prompt instruction's, which is
 * the same pattern one layer down.
 */
const editingId = ref<string | null>(null)
const editDraft = ref('')

function startTurnEdit(turn) {
  if (s.busy) return
  editingId.value = turn.id
  editDraft.value = turn.question
  nextTick(() => {
    const ta = panel.value?.querySelector(`#dp-edit-field-${turn.id}`)
    if (!ta) return
    fit(ta)
    ta.focus()
    // Stated, not assumed: focusing a textarea that already has a value does
    // not put the caret at the end in every engine, and a reader who opens an
    // editor to add a word should not have to press End first.
    ta.setSelectionRange(ta.value.length, ta.value.length)
  })
}

function cancelTurnEdit() {
  const id = editingId.value
  editingId.value = null
  editDraft.value = ''
  // Back to the control that opened it — `refocusThumb`'s rule. The row is
  // hover-revealed, but focus keeps it visible through `:focus-within`.
  nextTick(() => panel.value?.querySelector(`#dp-edit-${id}`)?.focus())
}

// The measurement itself, separate from the handler: the inline question editor
// opens with text already in it and has to size itself once before any input
// event exists to carry it.
const fit = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
  // A scroller only once the text is past the five-line cap. `scrollHeight` is
  // rounded, so a single line at 16 × 1.65 is 0.4px taller than the height it
  // was just given — invisible under an overlay scrollbar, and a grey thumb in
  // the field on a host that styles its scrollbars (this package's own docs
  // site does). Found under the bar, which is never out of sight — ui-specs/015.
  el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden'
}
const grow = (e: Event) => fit(e.target as HTMLTextAreaElement)

// Untyped for the trigger's reason: an idle-callback id or a timer, by engine.
let idleHandle = null

/**
 * A press anywhere else on the page puts the window away — under the bar, and
 * only there.
 *
 * The window rises over the middle of the article, where the drawer and the
 * popup sit beside it, so it is the one shape a reader has to be able to dismiss
 * by going back to what they were reading. The popup keeps its old behaviour: a
 * panel parked in a corner beside the docs is not in the way of them.
 *
 * This package's own controls elsewhere on the page — a trigger, the article's
 * quote popover, the call to action under the article — feed this window rather
 * than leave it, so a press on one is not a press outside.
 */
function onOutsidePointer(e: PointerEvent) {
  if (!barOn.value || !s.open || mobile.value) return
  const target = e.target as Element | null
  if (!target || root.value?.contains(target)) return
  if (target.closest?.('.docpilot-nav-trigger, .docpilot__ask, .docpilot-cta')) return
  skipFocusReturn = true
  close()
}
/**
 * The default second argument is load-bearing. Three call sites pass one
 * argument — the suggestion rows and the retry beside them — and a suggestion is
 * a FRESH question: it must not silently pick up a passage the reader attached
 * and then abandoned. Only the two sites that mean it name a quote.
 */
function submitText(q, quoted = '') {
  threadFollow.repin()
  closeAsk()
  session.submit(q, { quote: quoted })
}

const {
  quote,
  askOpen,
  askStyle,
  askBelow,
  canPopover,
  closeAsk,
  reposition,
  bindAsk,
  takeQuote,
  dropQuote,
} = useQuoting({ panel, thread, askEl, coarse, fieldEl, T })

/**
 * One open passage across the whole thread — Sources.vue says why. The panel's
 * rather than a list's, because "at most one" is a rule across every turn.
 */
const openPassage = ref<string | null>(null)

/**
 * The copied answer carries its sources — ui-specs/009, `citations.inCopy`.
 *
 * `answerText` alone is what this used to write, and the markers survive the
 * paste with nothing behind them: `[1]` in a ticket is worse than no citation at
 * all, because it looks like provenance. Absolute URLs, because the paste lands
 * outside the site that could have resolved a route.
 *
 * Built from `turn.sources`, which is the list the reader is looking at — not
 * from the answer text, which would mean parsing markers back out of prose the
 * model wrote. Both copy paths read it: one answer, and the whole thread.
 */
function withSources(turn) {
  const text = turn.answerText || ''
  if (!s.config.citations.inCopy || !turn.sources?.length) return text
  const origin = typeof location === 'undefined' ? '' : location.origin
  const lines = turn.sources.map((src) => {
    // A site tool's reply has no address to paste — engine-spec 038 — so the
    // line says where it came from, as its row does.
    if (src.kind === 'tool') return `${src.n}. ${src.title} · ${T('tools.fromSite')}`
    const href = src.origin || `${origin}${src.href}`
    return `${src.n}. [${src.title}](${href})`
  })
  return `${text}\n\n${T('citation.copyHeading')}\n${lines.join('\n')}`
}

// The built-in three now live in switches.js, beside the resolver, because
// `docpilot index` bakes WHAT THE PANEL WILL SHOW and cannot import a constant
// out of a .vue file. Two copies of the list would bake questions the reader
// never sees — and the SLICE was the second copy of the NUMBER: this line read
// `.slice(0, 3)` while `questionsOf` sliced at `SUGGESTION_LIMIT`, so the
// warning an author reads and the list a reader gets were free to disagree.
//
// Suppressed under a narrower scope: the defaults are almost certainly outside
// it and the gate would refuse all three on contact. What goes there instead is
// `scopedPages` in EmptyState.vue — ui-specs/009.
const suggestions = computed(() => {
  if (s.scope.kind !== 'all') return []
  const configured = s.config.suggestions.questions
  return (configured.length ? configured : DEFAULT_SUGGESTIONS).slice(0, SUGGESTION_LIMIT)
})

/**
 * Whether the first-visit line has been seen — ui-specs/009, `ui.firstRunHint`;
 * EmptyState.vue decides whether to show it.
 *
 * `localStorage` directly rather than through history.js's store: this is one
 * boolean about this device, it outlives the tab on purpose, and a private-mode
 * throw here should cost the hint and nothing else.
 */
const HINT_KEY = 'docpilot:hint-seen'
const hintSeen = ref(true)

function dismissHint() {
  hintSeen.value = true
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    /* private mode — the hint simply returns on the next visit */
  }
}

// The one place the reader is told what they may ask about, so it names the
// product when there is one to name and stays honest when there is not.
const placeholder = computed(() =>
  s.config.product
    ? T('composer.placeholder', { product: s.config.product })
    : T('composer.placeholderNoProduct'),
)

const { statusLine, showBudgetLow, armBudgetLow } = useLimits(T)
const { restoreDraft, onLeaving } = useDraft(input)

// Does a vote reach anywhere? Decides whether the action row stays visible at
// rest rather than appearing on hover.
const feedbackLive = computed(
  () => !!s.config.feedbackEndpoint && s.config.feedback.send !== 'none',
)

const { thoughtLabel, statusLabel } = useProgress(T)

/**
 * "the docs" in a sentence, where the picker says "All docs" on a button.
 *
 * Decided on the scope's KIND, never on its label. Comparing the label against
 * the literal `'All docs'` is what this used to do, and it is a trap with no
 * error attached: the moment that one string is translated — or a section is
 * ever named "All docs" — the comparison silently fails and every refusal line
 * reads "I couldn't find this in All docs." The kind is the fact; the label is
 * one rendering of it.
 */
const scopeWord = (kind, label) => ((kind ?? 'all') === 'all' ? T('refusal.allDocsShort') : label)
const shortScope = (refusal) => scopeWord(refusal?.scopeKind, refusal?.scopeLabel)
// The same word for a turn that ANSWERED with passages. A refusal carries its
// scope flattened into `refusal.scopeKind`/`scopeLabel`; a results turn has the
// frozen `turn.scope` itself, and one renderer for both is what keeps "All docs"
// from appearing in a sentence that reads "in All docs".
const turnScope = (turn) => scopeWord(turn?.scope?.kind, turn?.scope?.label)
const settledLine = (turn) => {
  // A credential turn settles before retrieval, so it has no provenance line to
  // print: "Searched the docs" would describe work that did not happen. A social
  // turn settles even earlier, for the same reason and with the same result.
  if (turn.refusal?.cause === 'credential' || turn.refusal?.cause === 'social') return ''
  // A refusal carries its scope flattened onto `turn.refusal`; every other
  // settled turn — a search-only one above all — has only the frozen
  // `turn.scope`. Reading the refusal's copy unconditionally made a scoped
  // search-only turn print "Searched the docs" for a search that was confined to
  // one page, because `refusal.scopeKind` was undefined and defaulted to 'all'.
  const scope = turn.refusal ? shortScope(turn.refusal) : turnScope(turn)
  if (turn.refusal?.cause === 'not-answerable' || turn.state === 'error') {
    return T('refusal.searchedAndRead', { scope, n: turn.refusal?.pagesRead ?? 0 })
  }
  return T('refusal.searched', { scope })
}

// Which result row holds the tab stop, per turn — Results.vue. The panel's, so
// the stop a reader left survives the window closing and opening again.
const resultCursor = ref({})

const { onSourceClick, onAnswerClick, hasSearch, openSearch } = useLinks({ mobile, close, router, T })

provide(PANEL, {
  T,
  uiLocale,
  panel,
  thread,
  fieldEl,
  mobile,
  coarse,
  onEsc,
  scrolled,
  atBottom,
  threadFollow,
  onThoughtScroll,
  fresh,
  thoughtLabel,
  statusLabel,
  submitText,
  suggestions,
  hintSeen,
  dismissHint,
  settledLine,
  shortScope,
  turnScope,
  withSources,
  openPassage,
  resultCursor,
  feedbackLive,
  submitFeedback,
  skipFeedback,
  focusIn,
  closeAction,
  editingId,
  editDraft,
  startTurnEdit,
  cancelTurnEdit,
  onSourceClick,
  onAnswerClick,
  hasSearch,
  openSearch,
  input,
  quote,
  closeAsk,
  dropQuote,
  placeholder,
  fit,
  grow,
  fieldInBar,
  barWide,
  barFocus,
  hotkey,
  statusLine,
  showBudgetLow,
  toggleDock,
  closeDock,
  dismissDock,
  confirmClear,
  activePick,
  pickFilter,
  editing,
  draft,
})
</script>
