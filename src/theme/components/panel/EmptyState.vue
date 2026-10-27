<template>
  <!-- empty state: a centred greeting, the configured questions anchored
       to the composer. The greeting is resident in every scope; the
       questions are not. -->
  <div class="docpilot__empty">
    <div class="docpilot__greeting">
      <p class="docpilot__greeting-h">{{ T('empty.heading') }}</p>
      <p class="docpilot__greeting-p">{{ T('empty.body') }}</p>
    </div>
    <div v-if="suggestions.length" class="docpilot__suggestions">
      <!-- `--docpilot-i` is the row's place in the stagger they rise
           in — ui-specs/015. Plumbing, not a token: it is never read
           outside the one animation-delay that multiplies it. -->
      <button
        v-for="(q, i) in suggestions"
        :key="q"
        type="button"
        class="docpilot__suggestion"
        :style="{ '--docpilot-i': i }"
        @click="submitText(q)"
      >
        {{ q }}
      </button>
    </div>

    <!--
      Under a narrow scope, the pages in it — ui-specs/009.

      The three built-in openers are suppressed there, correctly: they
      would fall outside the scope and the gate would refuse all of them
      on contact. The result was a blank panel shown to the one reader
      who had expressed their intent more precisely than usual.

      ROWS, not generated questions. The source-row recipe, because it is
      the same object — a page with a title and a tail that opens when
      pressed — and because nothing here is invented.
    -->
    <template v-if="scopedPages.length">
      <p class="docpilot__meta">{{ T('empty.scopedLead') }}</p>
      <ol class="docpilot__sources" role="list" :aria-label="T('empty.scopedLead')">
        <li v-for="(p, i) in scopedPages" :key="p.path" class="docpilot__source">
          <span class="docpilot__source-n">{{ i + 1 }}</span>
          <a :href="p.path" @click="onSourceClick($event, { href: p.path })">
            <span class="docpilot__source-title">{{ p.title }}</span
            ><span v-if="p.tail" class="docpilot__source-tail"> · {{ p.tail }}</span>
          </a>
        </li>
      </ol>
    </template>

    <!--
      The one thing a reader will not discover — ui-specs/009,
      `ui.firstRunHint`, off by default. Withheld when neither quoting
      switch is on, because a hint naming a gesture the panel does not
      answer is worse than no hint.
    -->
    <p v-if="showHint" class="docpilot__row docpilot__hint">
      <span class="docpilot__meta">{{ T('empty.hint') }}</span>
      <button type="button" class="docpilot__text-btn" @click="dismissHint">
        {{ T('empty.hintDismiss') }}
      </button>
    </p>
  </div>
</template>

<script setup lang="ts">
/** The thread before its first question — a greeting, and where to start. */
import { computed } from 'vue'
import * as session from '../../docpilot/session.js'
import { usePanel } from './context.js'

const s = session.state
const { T, suggestions, submitText, onSourceClick, hintSeen, dismissHint } = usePanel()

/**
 * The pages the reader scoped to — ui-specs/009, `suggestions.scoped`.
 *
 * Not capped and not scrolled on its own: the empty state lives inside the
 * thread, which is already the panel's one scroller, so a long scope simply
 * makes it longer. A second scroller inside a scroller is what the dock and the
 * picker have to be, and neither of them is inside this one.
 */
const scopedPages = computed(() => {
  if (!s.config.suggestions.scoped || s.scope.kind === 'all' || !s.index) return []
  const known = new Map(s.index.manifest.pages.map((p) => [p.path, p]))
  return s.scope.paths.map((path) => known.get(path)).filter(Boolean)
})

/**
 * The first-visit line — ui-specs/009, `ui.firstRunHint`, off by default.
 *
 * WITHHELD WHEN NEITHER QUOTING SWITCH IS ON. The hint names one gesture, and a
 * panel that does not answer that gesture must not advertise it — the same rule
 * the three `disclaimer` variants keep about what they claim.
 */
const showHint = computed(
  () =>
    s.config.ui.firstRunHint &&
    !hintSeen.value &&
    (s.config.quote.fromAnswer || s.config.quote.fromDocs),
)
</script>
