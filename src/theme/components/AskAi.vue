<template>
  <Teleport to="body">
    <div v-if="s.open" class="ask-ai">
      <div v-if="mobile" class="ask-ai__scrim" @click="close" />

      <!--
        Desktop is NON-MODAL: no scrim, no focus trap, docs stay readable beside
        the answer. Declaring aria-modal there would be a lie. Below 960px there
        is no room to read anything else, so it is honestly modal.
      -->
      <section
        ref="panel"
        class="ask-ai__panel"
        tabindex="-1"
        :role="mobile ? 'dialog' : 'complementary'"
        :aria-modal="mobile ? 'true' : undefined"
        aria-labelledby="ask-ai-title"
        @keydown.esc.stop.prevent="onEsc"
      >
        <header class="ask-ai__header">
          <!-- the trigger's own glyph: the control pressed and the panel it
               produced carry one mark. aria-hidden, so the heading is still
               named "Ask AI" for aria-labelledby on the mobile dialog. -->
          <h2 id="ask-ai-title" class="ask-ai__title"><Icon name="sparkle" />Ask AI</h2>
          <div class="ask-ai__header-actions">
            <button
              v-if="s.turns.length"
              type="button"
              class="ask-ai__icon-btn"
              aria-label="New chat"
              @click="newChat"
            >
              <Icon name="plus" />
            </button>
            <button type="button" class="ask-ai__icon-btn" aria-label="Close" @click="close">
              <Icon name="x" />
            </button>
          </div>
        </header>

        <div
          ref="thread"
          class="ask-ai__thread"
          tabindex="0"
          role="region"
          aria-label="Conversation"
        >
          <!-- empty state: a centred greeting, three questions anchored to the
               composer. The greeting is resident in every scope; the questions
               are not. -->
          <div v-if="!s.turns.length" class="ask-ai__empty">
            <div class="ask-ai__greeting">
              <p class="ask-ai__greeting-h">How can I help you today?</p>
              <p class="ask-ai__greeting-p">
                I search through your documentation to help you find setup guides, feature
                details and troubleshooting tips, fast.
              </p>
            </div>
            <div class="ask-ai__suggestions">
              <button
                v-for="q in suggestions"
                :key="q"
                type="button"
                class="ask-ai__suggestion"
                @click="submitText(q)"
              >
                {{ q }}
              </button>
            </div>
          </div>

          <article v-for="turn in s.turns" :key="turn.id" class="ask-ai__turn">
            <p class="ask-ai__question">{{ turn.question }}</p>

            <!-- one live node of fixed geometry whose text is replaced in place -->
            <div
              v-if="s.busy && turn === s.turns[s.turns.length - 1]"
              class="ask-ai__status"
              aria-hidden="true"
            >
              <span class="ask-ai__status-dot" />
              <span class="ask-ai__status-label">{{ statusLabel }}</span>
            </div>

            <!-- reasoning: above the answer, open while it is the only thing happening -->
            <template v-if="turn.thought">
              <button
                type="button"
                class="ask-ai__thoughts-toggle"
                :aria-expanded="String(!!turn.thoughtOpen)"
                :aria-controls="`ask-thoughts-${turn.id}`"
                @click="turn.thoughtOpen = !turn.thoughtOpen"
              >
                {{ thoughtLabel(turn) }}
              </button>
              <div
                v-if="turn.thoughtOpen"
                :id="`ask-thoughts-${turn.id}`"
                class="ask-ai__thoughts"
                role="region"
                aria-label="Model reasoning"
              >{{ turn.thought }}</div>
            </template>

            <div
              v-if="turn.answerHtml"
              class="ask-ai__answer"
              tabindex="-1"
              role="region"
              aria-label="Answer"
              :aria-busy="s.busy && turn === s.turns[s.turns.length - 1] ? 'true' : 'false'"
              v-html="turn.answerHtml"
              @click="onAnswerClick"
              @pointerover="onCiteEnter"
              @pointerout="linkedCite = null"
              @focusin="onCiteEnter"
              @focusout="linkedCite = null"
            />

            <p v-if="turn.state === 'aborted'" class="ask-ai__meta">Stopped.</p>

            <!-- Kept rather than withdrawn: cited, so checkable, but the model
                 was not sure. The sources below are the point. -->
            <p v-if="turn.tentative && turn.state === 'complete'" class="ask-ai__meta">
              The model was unsure of this one — check the sources below.
            </p>

            <!-- refusal: one state, four causes -->
            <template v-if="turn.state === 'no-answer'">
              <p v-if="settledLine(turn)" class="ask-ai__meta">{{ settledLine(turn) }}</p>
              <p class="ask-ai__lead">{{ leadLine(turn) }}</p>
              <p v-if="turn.credential" class="ask-ai__meta">{{ turn.credential.copy.body }}</p>
              <p v-if="turn.refusal.closest.length" class="ask-ai__meta">
                {{ turn.refusal.closestAreOutside ? 'Closest pages elsewhere' : 'Closest pages' }}
              </p>
              <ol v-if="turn.refusal.closest.length" class="ask-ai__sources" aria-label="Closest pages">
                <li v-for="(c, i) in turn.refusal.closest" :key="c.path" class="ask-ai__source">
                  <span class="ask-ai__source-n">{{ i + 1 }}</span>
                  <a :href="c.path" @click.prevent="goSource(c.path)">
                    <span class="ask-ai__source-title">{{ c.title }}</span
                    ><span v-if="c.tail" class="ask-ai__source-tail"> · {{ c.tail }}</span>
                  </a>
                </li>
              </ol>
              <button
                v-if="turn.refusal.cause === 'out-of-scope'"
                type="button"
                class="ask-ai__text-btn"
                @click="widen(turn)"
              >
                Clear the scope and search all docs
              </button>
              <!-- The question was fine; the value in it was not. This runs the
                   same question with the value already replaced by YOUR_SECRET_KEY. -->
              <button
                v-if="turn.credential"
                type="button"
                class="ask-ai__text-btn"
                @click="askWithoutSecret(turn)"
              >
                {{ turn.credential.copy.action }}
              </button>
            </template>

            <template v-if="turn.state === 'error'">
              <p class="ask-ai__lead" role="alert">The AI service didn't respond.</p>
              <p class="ask-ai__row">
                <button type="button" class="ask-ai__text-btn" @click="submitText(turn.question)">
                  Retry
                </button>
                <button type="button" class="ask-ai__text-btn" @click="openSearch">
                  Search the docs
                </button>
              </p>
            </template>

            <ol v-if="turn.sources.length" class="ask-ai__sources" aria-label="Sources">
              <li
                v-for="src in turn.sources"
                :key="src.id"
                class="ask-ai__source"
                :class="{ 'is-linked': linkedCite === src.n }"
              >
                <span class="ask-ai__source-n">{{ src.n }}</span>
                <a :href="src.href" @click.prevent="goSource(src.href)">
                  <span class="ask-ai__source-title">{{ src.title }}</span
                  ><span v-if="src.tail" class="ask-ai__source-tail"> · {{ src.tail }}</span>
                </a>
              </li>
            </ol>

            <div
              v-if="turn.state === 'complete' || turn.state === 'no-answer' || turn.state === 'aborted'"
              class="ask-ai__actions"
              :class="{ 'is-resident': !!s.config.feedbackEndpoint }"
            >
              <button
                v-if="turn.state !== 'no-answer'"
                type="button"
                class="ask-ai__icon-btn"
                aria-label="Copy answer"
                @click="copy(turn)"
              >
                <Icon :name="turn.copied ? 'check' : 'copy'" />
              </button>
              <button
                type="button"
                class="ask-ai__icon-btn"
                aria-label="Helpful answer"
                :aria-pressed="String(turn.verdict === 'up')"
                @click="vote(turn, 'up')"
              >
                <Icon name="thumbUp" :filled="turn.verdict === 'up'" />
              </button>
              <button
                type="button"
                class="ask-ai__icon-btn"
                aria-label="Not helpful"
                :aria-pressed="String(turn.verdict === 'down')"
                @click="vote(turn, 'down')"
              >
                <Icon name="thumbDown" :filled="turn.verdict === 'down'" />
              </button>
            </div>

            <div v-if="turn.reasonOpen" class="ask-ai__reasons" role="group" aria-label="What went wrong?">
              <button
                v-for="[value, label] in REASONS"
                :key="value"
                type="button"
                class="ask-ai__text-btn"
                @click="chooseReason(turn, value)"
              >
                {{ label }}
              </button>
            </div>
          </article>
        </div>

        <div class="ask-ai__composer">
          <!-- at most one disclosure open; both absent from the DOM at rest -->
          <div v-if="s.dockPanel === 'picker'" id="ask-picker" class="ask-ai__picker" tabindex="-1">
            <div class="ask-ai__picker-acts">
              <!-- aria-hidden: the group below is already named "Set the scope" -->
              <span class="ask-ai__picker-label" aria-hidden="true">Scope</span>
              <!-- the group wraps the presets only: closing the picker is not
                   setting a scope, so the close button stays outside it -->
              <div class="ask-ai__picker-presets" role="group" aria-label="Set the scope">
                <button type="button" class="ask-ai__text-btn" @click="preset('all')">All docs</button>
                <button
                  v-if="currentPathIndexed"
                  type="button"
                  class="ask-ai__text-btn"
                  @click="preset('page')"
                >
                  This page
                </button>
                <button
                  v-if="offersSection"
                  type="button"
                  class="ask-ai__text-btn"
                  @click="preset('section')"
                >
                  This section
                </button>
              </div>
              <!-- same exit the Esc cascade takes, and the same focus return -->
              <button
                type="button"
                class="ask-ai__icon-btn ask-ai__picker-close"
                aria-label="Close the scope picker"
                @click="closeDock()"
              >
                <Icon name="x" />
              </button>
            </div>
            <div class="ask-ai__picker-list" role="listbox" aria-multiselectable="true" aria-label="Pages to search">
              <div
                v-for="p in orderedPages"
                :key="p.path"
                class="ask-ai__pick"
                role="option"
                :aria-selected="String(selected.has(p.path))"
                tabindex="0"
                @click="togglePage(p.path)"
                @keydown.enter.prevent="togglePage(p.path)"
                @keydown.space.prevent="togglePage(p.path)"
              >
                <span class="ask-ai__pick-mark">
                  <Icon v-if="selected.has(p.path)" name="check" />
                </span>
                <span>
                  <span class="ask-ai__source-title">{{ p.title }}</span
                  ><span v-if="p.tail" class="ask-ai__source-tail"> · {{ p.tail }}</span>
                </span>
              </div>
            </div>
          </div>

          <div v-if="s.dockPanel === 'prompt'" id="ask-prompt" class="ask-ai__prompt" tabindex="0"
               role="region" aria-label="How this assistant works">
            <template v-for="block in promptBlocks" :key="block.heading">
              <p class="ask-ai__prompt-h">{{ block.heading }}</p>
              <textarea
                v-if="block.yours && editing"
                v-model="draft"
                class="ask-ai__prompt-edit"
                rows="3"
                :maxlength="s.config.prompt.appendMaxChars"
              />
              <p v-else :class="block.yours ? 'ask-ai__prompt-yours' : null">{{ block.body }}</p>
            </template>
            <p v-if="s.config.prompt.allowAppend" class="ask-ai__row">
              <template v-if="editing">
                <button type="button" class="ask-ai__text-btn" @click="saveEdit">Save</button>
                <button type="button" class="ask-ai__text-btn" @click="editing = false">Cancel</button>
              </template>
              <template v-else>
                <button type="button" class="ask-ai__text-btn" :aria-disabled="String(s.busy)" @click="startEdit">
                  {{ s.instruction ? 'Edit instruction' : 'Add instruction' }}
                </button>
                <button
                  v-if="s.instruction"
                  type="button"
                  class="ask-ai__text-btn"
                  :aria-disabled="String(s.busy)"
                  @click="removeInstruction"
                >
                  Remove instruction
                </button>
              </template>
            </p>
          </div>

          <template v-if="s.degraded">
            <p class="ask-ai__lead">AI answers are off in this environment.</p>
            <p class="ask-ai__row">
              <button type="button" class="ask-ai__text-btn" @click="openSearch">Search the docs</button>
            </p>
          </template>

          <template v-else>
            <div class="ask-ai__field">
              <textarea
                v-model="input"
                rows="1"
                maxlength="1000"
                placeholder="Ask about the plugin"
                :readonly="s.busy"
                aria-describedby="ask-hint ask-counter ask-footnote"
                @input="grow"
                @keydown="onKeydown"
              />
              <button
                type="button"
                class="ask-ai__send"
                :class="{ 'is-ready': canSend || s.busy }"
                :aria-disabled="String(!canSend && !s.busy)"
                :aria-label="s.busy ? 'Stop generating' : 'Send question'"
                @click="send"
              >
                <Icon :name="s.busy ? 'square' : 'arrowUp'" :filled="s.busy" />
              </button>
            </div>

            <p v-if="input.length >= 950" id="ask-counter" class="ask-ai__counter">
              {{ input.length }}/1000
            </p>

            <p id="ask-footnote" class="ask-ai__footnote">
              <button
                v-if="s.config.scope.enabled"
                id="ask-scope-btn"
                type="button"
                class="ask-ai__scope"
                :aria-expanded="String(s.dockPanel === 'picker')"
                aria-controls="ask-picker"
                :aria-label="`${scopeLabel}. Change the pages searched`"
                @click="toggleDock('picker')"
              >{{ scopeLabel }}</button><span v-if="s.turns.length"> · {{ disclaimer }}</span>
              <button
                v-if="s.config.prompt.show && (s.turns.length || s.instruction)"
                type="button"
                class="ask-ai__prompt-toggle"
                :aria-expanded="String(s.dockPanel === 'prompt')"
                aria-controls="ask-prompt"
                @click="toggleDock('prompt')"
              >{{ promptToggleText }}</button>
            </p>
          </template>
        </div>

        <span id="ask-hint" class="ask-ai__sr">Type a question to send. Searching {{ scopeLabel }}.</span>
        <div class="ask-ai__sr" aria-live="polite">{{ announced }}</div>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, h, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useData, useRouter } from 'vitepress'
import * as session from '../ask-ai/session.js'
import { promptDocument } from '../ask-ai/prompt.js'
import { sectionFor } from '../ask-ai/scope.js'
import { GLYPHS, GLYPH_BOX } from '../ask-ai/glyphs.js'

const s = session.state
const { theme, page } = useData()
const router = useRouter()

const panel = ref(null)
const thread = ref(null)
const mobile = ref(false)
const input = ref('')
const draft = ref('')
const editing = ref(false)
const announced = ref('')
let trigger = null
let mql = null

const scopeLabel = session.scopeLabel
const offersSection = session.offersSection
const currentPathIndexed = session.currentPathIndexed

function routeOf(rel) {
  if (!rel) return '/'
  return `/${rel.replace(/\.md$/, '').replace(/\/index$/, '')}`.replace(/\/$/, '') || '/'
}

onMounted(() => {
  mql = window.matchMedia('(min-width: 960px)')
  const sync = () => (mobile.value = !mql.matches)
  sync()
  mql.addEventListener('change', sync)
  session.configure(theme.value, routeOf(page.value.relativePath))
})

onBeforeUnmount(() => mql?.removeEventListener('change', sync))
function sync() {
  mobile.value = !mql?.matches
}

watch(() => page.value.relativePath, (rel) => (s.currentPath = routeOf(rel)))

// The polite region is throttled: pushing every token through it is a single
// uninterruptible blast that cannot be paused, rewound or navigated.
let announceTimer = null
watch(
  () => s.announce,
  (msg) => {
    if (!msg) return
    clearTimeout(announceTimer)
    announceTimer = setTimeout(() => (announced.value = msg), 500)
  },
)

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
        else panel.value?.querySelector('textarea')?.focus()
      }, 60)
    } else {
      const fallback =
        document.querySelector('.ask-ai-nav-trigger') ||
        document.getElementById('VPContent') ||
        document.querySelector('main')
      if (trigger && document.contains(trigger)) trigger.focus()
      else fallback?.focus?.()
      trigger = null
    }
  },
)

// Autoscroll: written inside one coalesced rAF, and disengaged by pointer or
// keyboard intent — never by a `scroll` event, which smooth scrolling makes
// indistinguishable from user input.
let pinned = true
watch(
  () => s.turns.map((t) => t.answerHtml + (t.thought || '').length + t.state).join('|'),
  () => {
    if (!pinned) return
    requestAnimationFrame(() => {
      const el = thread.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)
function onIntent() {
  const el = thread.value
  if (!el) return
  pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
onMounted(() => {
  const el = () => thread.value
  const h2 = () => onIntent()
  document.addEventListener('wheel', h2, { passive: true })
  document.addEventListener('touchmove', h2, { passive: true })
  onBeforeUnmount(() => {
    document.removeEventListener('wheel', h2)
    document.removeEventListener('touchmove', h2)
  })
  void el
})

const close = () => session.close()
const newChat = () => {
  session.newChat()
  input.value = ''
}
const vote = session.vote
const chooseReason = session.chooseReason
const widen = session.widen
const askWithoutSecret = session.askWithoutSecret

function onEsc() {
  const active = document.activeElement
  const has = (sel) => panel.value?.querySelector(sel)?.contains(active)
  if (s.dockPanel && (has('.ask-ai__picker') || has('.ask-ai__prompt'))) return closeDock()
  const reasonTurn = s.turns.find((t) => t.reasonOpen)
  if (reasonTurn && has('.ask-ai__reasons')) return (reasonTurn.reasonOpen = false)
  if (s.dockPanel) return closeDock()
  if (reasonTurn) return (reasonTurn.reasonOpen = false)
  if (s.busy) return session.stop()
  close()
}

function closeDock() {
  const opener = s.dockPanel === 'picker' ? '#ask-scope-btn' : '.ask-ai__prompt-toggle'
  s.dockPanel = null
  editing.value = false
  nextTick(() => panel.value?.querySelector(opener)?.focus())
}

function toggleDock(which) {
  s.dockPanel = s.dockPanel === which ? null : which
  if (s.dockPanel) nextTick(() => panel.value?.querySelector(`.ask-ai__${which}`)?.focus())
}

// ── scope ────────────────────────────────────────────────────────────────────
const pages = computed(() => s.index?.manifest.pages || [])
const selected = computed(() => new Set(s.scope.paths))

const orderedPages = computed(() => {
  const here = s.currentPath
  const section = s.index ? sectionFor(here, s.index.manifest) : null
  const inSection = new Set(section?.paths || [])
  const orphans = new Set(s.index?.manifest.orphanPages || [])
  const rank = (p) =>
    p.path === here ? 0 : inSection.has(p.path) ? 1 : orphans.has(p.path) ? 3 : 2
  return [...pages.value].sort((a, b) => rank(a) - rank(b))
})

const togglePage = (path) => {
  const next = new Set(s.scope.paths)
  next.has(path) ? next.delete(path) : next.add(path)
  session.setScope([...next])
}

function preset(kind) {
  if (kind === 'all') return session.setScope([])
  if (kind === 'page') return session.setScope([s.currentPath])
  const section = sectionFor(s.currentPath, s.index.manifest)
  if (section) session.setScope(section.paths)
}

// ── prompt ───────────────────────────────────────────────────────────────────
const promptBlocks = computed(() =>
  promptDocument({
    scope: s.scope,
    fallback: s.fallback,
    addendum: s.instruction,
    promptListLimit: s.config.scope.promptListLimit,
    prompt: s.config.prompt,
  }),
)
const promptToggleText = computed(() =>
  s.instruction ? 'How this works, with your instruction' : 'How this works',
)
function startEdit() {
  draft.value = s.instruction
  editing.value = true
  nextTick(() => panel.value?.querySelector('.ask-ai__prompt-edit')?.focus())
}
function saveEdit() {
  session.setInstruction(draft.value)
  editing.value = false
}
function removeInstruction() {
  session.setInstruction('')
  editing.value = false
}

// ── composer ─────────────────────────────────────────────────────────────────
const canSend = computed(() => input.value.trim().length > 0)
const grow = (e) => {
  e.target.style.height = 'auto'
  e.target.style.height = `${e.target.scrollHeight}px`
}
function send() {
  if (s.busy) return session.stop()
  if (!canSend.value) return
  submitText(input.value)
  input.value = ''
  nextTick(() => {
    const ta = panel.value?.querySelector('textarea')
    if (ta) ta.style.height = 'auto'
  })
}
function submitText(q) {
  pinned = true
  session.submit(q)
}
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

async function copy(turn) {
  try {
    await navigator.clipboard.writeText(turn.answerText)
    turn.copied = true
    setTimeout(() => (turn.copied = false), 2000)
    s.announce = 'Copied'
  } catch {
    /* clipboard denied — the answer is still selectable */
  }
}

const DEFAULT_SUGGESTIONS = [
  'How do I connect the editor to my app?',
  'How do I authenticate requests?',
  'How do I build a custom extension?',
]
// Suppressed under a narrower scope: the defaults are almost certainly outside
// it and the gate would refuse all three on contact.
const suggestions = computed(() =>
  s.scope.kind !== 'all'
    ? []
    : (s.config.suggestions?.length ? s.config.suggestions : DEFAULT_SUGGESTIONS).slice(0, 3),
)

const disclaimer = computed(() =>
  s.config.feedbackEndpoint
    ? 'AI-generated. Check the linked pages. Not-helpful reports are sent to the docs team.'
    : 'AI-generated. Check the linked pages.',
)

// The reasoning line counts up while reasoning is what is happening, and stops
// at its final value the moment the first answer token lands. One second is the
// resolution the number is read at, so it is also the tick rate — a rAF loop
// here would re-render the thread 60 times a second to move a digit once.
const tick = ref(0)
let tickTimer = null
watch(
  () => s.busy,
  (busy) => {
    clearInterval(tickTimer)
    if (busy) tickTimer = setInterval(() => (tick.value += 1), 1000)
  },
)
onBeforeUnmount(() => clearInterval(tickTimer))

function thoughtLabel(turn) {
  if (!turn.streaming || turn.answerText) return `Thought for ${turn.thoughtSeconds}s`
  void tick.value
  return `Thinking for ${Math.max(1, Math.round((performance.now() - turn.startedAt) / 1000))}s`
}

// The reasoning box is a fixed-height scroller, so live text has to be followed
// the same way the thread is.
watch(
  () => s.turns[s.turns.length - 1]?.thought,
  () => {
    requestAnimationFrame(() => {
      // The last one in the thread, not the first: a reader who reopened an
      // earlier turn's reasoning must not have it yanked to the bottom.
      const boxes = panel.value?.querySelectorAll('.ask-ai__thoughts')
      const el = boxes?.[boxes.length - 1]
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

const statusLabel = computed(() => {
  const p = s.status
  if (!p) return ''
  return {
    indexing: 'Loading the docs index',
    thinking: 'Thinking',
    listing: 'Looking at the page list',
    writing: 'Writing the answer',
    reading: p.label ? `Reading ${p.label}` : 'Reading a page',
  }[p.phase] || 'Searching the docs'
})

const shortScope = (label) => (label === 'All docs' ? 'the docs' : label)
const settledLine = (turn) => {
  // A credential turn settles before retrieval, so it has no provenance line to
  // print: "Searched the docs" would describe work that did not happen.
  if (turn.refusal?.cause === 'credential') return ''
  const S = shortScope(turn.refusal?.scopeLabel || 'All docs')
  if (turn.refusal?.cause === 'not-answerable' || turn.state === 'error') {
    const n = turn.refusal?.pagesRead ?? 0
    return `Searched ${S} and read ${n} ${n === 1 ? 'page' : 'pages'}`
  }
  return `Searched ${S}`
}
/**
 * "I couldn't find this" is a claim about the DOCS. It is only true when the
 * search actually ran — when the embedder is down, retrieval is BM25 alone, and
 * on an English corpus a question in another language has no lexical overlap to
 * score at all. Saying the docs lack the answer there blames the corpus for a
 * broken dependency and sends the reader looking for a page that exists.
 *
 * The credential lead is the same rule taken one step further: nothing was
 * searched at all, and unlike every other line in this panel it is written in
 * the reader's language, because the host wrote it instead of the model.
 */
const leadLine = (turn) =>
  turn.credential?.copy.lead ||
  (turn.refusal?.degraded
    ? "Search is running degraded — the semantic index isn't available, so only word matching ran. This may be why nothing was found."
    : `I couldn't find this in ${shortScope(turn.refusal?.scopeLabel || 'All docs')}.`)

function goSource(href) {
  if (mobile.value) close()
  router.go(href)
}

// The answer is v-html, so its links have no Vue handlers of their own: without
// this delegation a citation marker is a full page load out of the SPA, which
// on mobile also drops the panel it was opened from.
const linkedCite = ref(null)

function onAnswerClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const btn = e.target.closest?.('[data-copy-code]')
  if (btn) return copyCode(btn)
  const a = e.target.closest?.('a[href]')
  if (!a) return
  const href = a.getAttribute('href')
  if (!href?.startsWith('/')) return
  e.preventDefault()
  goSource(href)
}

// The copy button lives inside v-html and has no component instance, so its
// confirmation is a class on the clicked element rather than reactive state. A
// re-render mid-stream replaces the node and drops both, which is correct: the
// block it was confirming no longer exists.
const copiedTimers = new WeakMap()

async function copyCode(btn) {
  const wrap = btn.parentElement
  const pre = wrap?.querySelector('pre')
  if (!pre) return
  const raw = pre.textContent ?? ''
  // A shell block is copied to be run, and a leading prompt breaks that.
  const text = wrap.dataset.lang === 'bash' ? raw.replace(/^ *(\$|>) /gm, '') : raw
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return /* clipboard denied — the code is still selectable */
  }
  btn.classList.add('is-copied')
  clearTimeout(copiedTimers.get(btn))
  copiedTimers.set(btn, setTimeout(() => btn.classList.remove('is-copied'), 2000))
  // A distinct string from the turn-level 'Copied': the polite region watcher
  // fires on change, so reusing it would go unannounced right after one.
  s.announce = 'Code copied'
}

// Pointing at a marker lights the row it goes to. UI-SPEC 573: no timer, no
// coarse-pointer branch — a touch that lands on the marker navigates anyway.
function onCiteEnter(e) {
  const cite = e.target.closest?.('.ask-ai__cite')
  linkedCite.value = cite ? Number(cite.dataset.cite) : null
}
function openSearch() {
  document.querySelector('.VPNavBarSearchButton, .DocSearch-Button')?.click()
}

const REASONS = [
  ['wrong', 'Wrong answer'],
  ['incomplete', 'Incomplete'],
  ['not-in-docs', 'Not in the docs'],
  ['bad-links', 'Bad links'],
]

// One glyph is drawn on a 24 box at 20px — the nav trigger's sparkle, reused
// here rather than redrawn. Everything else is the 16×16 default it always was.
const Icon = (props) => {
  const paths = [GLYPHS[props.name]].flat()
  const { box = '0 0 16 16', size = 16 } = GLYPH_BOX[props.name] || {}
  return h(
    'svg',
    {
      viewBox: box,
      width: size,
      height: size,
      fill: props.filled ? 'currentColor' : 'none',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    paths.map((d) => h('path', { key: d, d })),
  )
}
</script>
