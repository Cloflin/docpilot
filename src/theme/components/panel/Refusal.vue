<template>
  <p v-if="settledLine(turn)" class="docpilot__meta">{{ settledLine(turn) }}</p>
  <p class="docpilot__lead">{{ leadLine(turn) }}</p>
  <p v-if="turn.credential" class="docpilot__meta">{{ turn.credential.copy.body }}</p>
  <!-- social: what this is, what it covers, and a question back. The
       suggestion rows repeat here because an invitation with nothing
       to act on is the refusal it was written to replace. -->
  <template v-if="turn.social">
    <p v-if="turn.social.copy.body" class="docpilot__meta">{{ turn.social.copy.body }}</p>
    <p v-if="turn.social.copy.invite" class="docpilot__meta">
      {{ turn.social.copy.invite }}
    </p>
    <div
      v-if="turn.social.copy.invite && suggestions.length"
      class="docpilot__suggestions docpilot__suggestions--inline"
    >
      <button
        v-for="q in suggestions"
        :key="q"
        type="button"
        class="docpilot__suggestion"
        @click="submitText(q)"
      >
        {{ q }}
      </button>
    </div>
  </template>
  <!--
    What "read N pages" was reading — ui-specs/009,
    `citations.pagesRead`, off by default.

    Under the verdict rather than under the provenance line it
    belongs to, because the verdict is the message and evidence for
    it reads after it, not before. Same position, same treatment and
    the same list idiom as the closest pages directly below.
  -->
  <template v-if="turn.refusal.pages?.length">
    <p class="docpilot__meta">{{ T('refusal.pagesReadLabel') }}</p>
    <ol class="docpilot__sources" role="list" :aria-label="T('refusal.pagesReadLabel')">
      <li v-for="(p, i) in turn.refusal.pages" :key="p.path" class="docpilot__source">
        <span class="docpilot__source-n">{{ i + 1 }}</span>
        <a :href="p.path" @click="onSourceClick($event, { href: p.path })">
          <span class="docpilot__source-title">{{ p.title }}</span>
        </a>
      </li>
    </ol>
  </template>
  <p v-if="turn.refusal.closest.length" class="docpilot__meta">
    {{ T(turn.refusal.closestAreOutside ? 'refusal.closestPagesElsewhere' : 'refusal.closestPages') }}
  </p>
  <ol
    v-if="turn.refusal.closest.length"
    class="docpilot__sources"
    role="list"
    :aria-label="T('panel.closestPages')"
  >
    <li v-for="(c, i) in turn.refusal.closest" :key="c.path" class="docpilot__source">
      <span class="docpilot__source-n">{{ i + 1 }}</span>
      <a
        :href="c.origin || c.path"
        :target="c.origin ? '_blank' : null"
        :rel="c.origin ? 'noopener noreferrer' : null"
        @click="onSourceClick($event, { origin: c.origin, href: c.path })"
      >
        <span class="docpilot__source-title">{{ c.title }}</span
        ><span v-if="c.tail" class="docpilot__source-tail"> · {{ c.tail }}</span>
      </a>
    </li>
  </ol>
  <button
    v-if="turn.refusal.cause === 'out-of-scope'"
    type="button"
    class="docpilot__text-btn"
    @click="widen(turn)"
  >
    {{ T('refusal.widen') }}
  </button>
  <!-- The question was fine; the value in it was not. This runs the
       same question with the value already replaced by YOUR_SECRET_KEY. -->
  <button
    v-if="turn.credential"
    type="button"
    class="docpilot__text-btn"
    @click="askWithoutSecret(turn)"
  >
    {{ turn.credential.copy.action }}
  </button>
</template>

<script setup lang="ts">
/** A turn the panel did not answer — one state, four causes. */
import type { PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { usePanel } from './context.js'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const { T, settledLine, shortScope, suggestions, submitText, onSourceClick } = usePanel()
const widen = session.widen
const askWithoutSecret = session.askWithoutSecret

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
  turn.social?.copy.lead ||
  turn.credential?.copy.lead ||
  (turn.refusal?.degraded
    ? T('refusal.degraded')
    : T('refusal.notFound', { scope: shortScope(turn.refusal) }))
</script>
