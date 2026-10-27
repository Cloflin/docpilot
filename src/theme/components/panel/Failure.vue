<template>
  <template v-if="turn.state === 'error'">
    <p class="docpilot__lead" role="alert">{{ T('error.lead') }}</p>
    <p class="docpilot__row">
      <!-- with its quote: a retry that drops the passage re-runs a
           question whose whole subject has gone missing -->
      <button
        type="button"
        class="docpilot__text-btn"
        @click="submitText(turn.question, turn.quote)"
      >
        {{ T('error.retry') }}
      </button>
      <button
        v-if="hasSearch"
        type="button"
        class="docpilot__text-btn"
        @click="openSearch"
      >
        {{ T('error.search') }}
      </button>
    </p>
  </template>

  <!--
    The day's free requests are spent. A separate state from `error`
    and separate copy, because the service DID answer and what it
    answered was a schedule.

    No `role="alert"` here, unlike the transport failure above: this
    state settles a turn, and session.js announces every settled turn
    through the polite live region already — an assertive region on top
    of that reads the same sentence twice.

    No Retry either. The next request is already known to be refused,
    and offering to spend it is the one affordance that would make
    things worse. Search still works, so it stays offered.
  -->
  <template v-if="turn.state === 'rate-limited'">
    <p class="docpilot__lead">{{ T('error.rateLimited') }}</p>
    <p v-if="resetLine(turn)" class="docpilot__meta">{{ resetLine(turn) }}</p>
    <!--
      The passages, under a spent quota. They cost nothing — retrieval
      settled before the first request went out — and a panel that
      prints "come back at four" while the sections that answer the
      question sit in memory is being less useful than the index it
      shipped with. Links only, no snippets: this is an addition to an
      explanation, not the answer, and the state above keeps its own
      sentence.
    -->
    <template v-if="turn.results?.length">
      <p class="docpilot__meta">{{ T('hybrid.meanwhile') }}</p>
      <ol class="docpilot__sources" role="list" :aria-label="T('results.label')">
        <li v-for="(r, i) in turn.results" :key="r.id" class="docpilot__source">
          <span class="docpilot__source-n">{{ i + 1 }}</span>
          <a
            :href="r.href"
            :target="r.origin ? '_blank' : null"
            :rel="r.origin ? 'noopener noreferrer' : null"
            @click="onSourceClick($event, { origin: r.origin, href: r.href })"
          >
            <span class="docpilot__source-title">{{ r.title }}</span
            ><span v-if="r.breadcrumb" class="docpilot__source-tail">
              · {{ r.breadcrumb }}</span
            >
          </a>
        </li>
      </ol>
    </template>
    <p v-if="hasSearch" class="docpilot__row">
      <button type="button" class="docpilot__text-btn" @click="openSearch">
        {{ T('error.search') }}
      </button>
    </p>
  </template>
</template>

<script setup lang="ts">
/** A turn the service could not answer: it failed, or today's requests are spent. */
import type { PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { usePanel } from './context.js'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const { T, submitText, onSourceClick, hasSearch, openSearch } = usePanel()

// When the quota comes back, as a clock time in the reader's locale — see
// session.js, which owns it because the sentence is SPOKEN as well as shown. A
// rate-limited turn is announced with its reset line attached, and a second
// formatter here would eventually disagree with that one about the only fact in
// the turn a reader can act on.
const resetLine = session.resetLine
</script>
