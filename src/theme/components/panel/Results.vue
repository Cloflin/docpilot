<template>
  <p v-if="settledLine(turn)" class="docpilot__meta">{{ settledLine(turn) }}</p>
  <!--
    `turn.hybrid` is the last rung of the answer ladder: every
    service the environment selected was asked, none answered, and
    the retrieval this turn had already done is what is left. It
    names the cause once and then reads exactly like the search-only
    product, because that is what it is.
  -->
  <p class="docpilot__lead">
    {{
      turn.hybrid
        ? turn.results.length
          ? T('hybrid.lead')
          : T('error.lead')
        : turn.results.length
          ? T(turn.noStrongMatches ? 'results.noStrong' : 'results.lead', {
              scope: turnScope(turn),
            })
          : T('results.empty', { scope: turnScope(turn) })
    }}
  </p>
  <ol
    v-if="turn.results.length"
    class="docpilot__sources docpilot__results"
    role="list"
    :aria-label="T('results.label')"
    @keydown="onResultsKey($event, turn)"
  >
    <li v-for="(r, i) in turn.results" :key="r.id" class="docpilot__source">
      <span class="docpilot__source-n">{{ i + 1 }}</span>
      <div class="docpilot__result-body">
        <!-- `href` is already the original for an imported page —
             `resultRows` builds it from `page.origin` — so there is
             no second address to choose between here. -->
        <a
          :href="r.href"
          :target="r.origin ? '_blank' : null"
          :rel="r.origin ? 'noopener noreferrer' : null"
          :tabindex="i === resultFocus(turn) ? 0 : -1"
          :data-dp-result="i"
          @click="onSourceClick($event, { origin: r.origin, href: r.href })"
        >
          <span class="docpilot__source-title">{{ r.title }}</span
          ><span v-if="r.breadcrumb" class="docpilot__source-tail">
            · {{ r.breadcrumb }}</span
          >
        </a>
        <!-- Escaped in `markQuery` before any markup is added: the
             snippet is corpus text and the marks are ours. -->
        <p
          v-if="r.snippet"
          class="docpilot__result-snippet"
          v-html="markQuery(r.snippet, turn.question)"
        ></p>
      </div>
    </li>
  </ol>
  <!-- No rows at all: pages instead of sections, the same floor a
       refusal falls to. -->
  <template v-if="!turn.results.length && turn.closest.length">
    <p class="docpilot__meta">
      {{ T(turn.closestAreOutside ? 'refusal.closestPagesElsewhere' : 'refusal.closestPages') }}
    </p>
    <ol class="docpilot__sources" role="list" :aria-label="T('panel.closestPages')">
      <li v-for="(c, i) in turn.closest" :key="c.path" class="docpilot__source">
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
  </template>
  <button
    v-if="turn.wouldWiden"
    type="button"
    class="docpilot__text-btn"
    @click="widen(turn)"
  >
    {{ T('refusal.widen') }}
  </button>
  <!--
    Retry belongs on this one and on no other `results` turn: a
    search-only site has nothing to retry, and here the outage may
    well have cleared. The same pair the transport error offers, for
    the same reasons — the quote travels with the question, and
    search stays offered because it never depended on a model.
  -->
  <p v-if="turn.hybrid" class="docpilot__row">
    <button
      type="button"
      class="docpilot__text-btn"
      @click="submitText(turn.question, turn.quote)"
    >
      {{ T('error.retry') }}
    </button>
    <button v-if="hasSearch" type="button" class="docpilot__text-btn" @click="openSearch">
      {{ T('error.search') }}
    </button>
  </p>
</template>

<script setup lang="ts">
/**
 * SEARCH-ONLY — the passages, as the answer.
 *
 * The rows render whether or not the gate passed; `noStrongMatches` chooses the
 * lead and nothing else. Every row is a verbatim passage under a link into the
 * docs, so there is no generated claim here for the panel to be wrong about,
 * and hiding matches that exist in order to say "not in the docs" would be the
 * less honest of the two.
 */
import { nextTick, type PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { terms } from '../../docpilot/text.js'
import { usePanel } from './context.js'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const { T, settledLine, turnScope, resultCursor, submitText, onSourceClick, hasSearch, openSearch } =
  usePanel()
const widen = session.widen

/**
 * The reader's own words, marked inside a search-only snippet.
 *
 * ESCAPED FIRST, ALWAYS. The snippet is corpus text — a page author's prose,
 * which can contain angle brackets and does on any page documenting HTML.
 * Escaping and then inserting our own `<mark>` is the order that makes the marks
 * the only markup in the string; matching first and escaping after would escape
 * the marks too, and escaping neither is an injection.
 *
 * The passage disclosure is the other place corpus text becomes `v-html`, and it
 * arrives already parsed: markdown-it runs with `html: false`, so an author's
 * angle bracket is escaped there by the renderer rather than by this function.
 *
 * COMPUTED AT RENDER, NEVER STORED. A results turn is persisted to the archive,
 * and marked-up HTML in a stored record is a hazard that outlives the render it
 * was correct for — the query that produced it is right there in `turn.question`,
 * so the marks can always be re-derived.
 *
 * `terms()` rather than a split on spaces, so the tokens marked are the tokens
 * the retriever actually matched on: stop words are dropped, an identifier keeps
 * its dots, and a one-character query marks nothing rather than every letter.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])

function markQuery(snippet, question) {
  const safe = escapeHtml(snippet)
  const words = [...new Set(terms(question || ''))].filter((w) => w.length >= 2)
  if (!words.length) return safe
  // Longest first, so `window.initeditor` marks as one run rather than being
  // broken up by an earlier match on `window`.
  const pattern = words
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  // Escaped text, so `&amp;` and `&lt;` are in the haystack — a term can only
  // match inside one of those entities if the reader typed `amp` or `lt`, and
  // marking a substring of an entity would break it. The lookarounds keep the
  // match off any run that is part of an entity.
  return safe.replace(new RegExp(`(?<![&#\\w])(${pattern})(?![\\w;])`, 'giu'), '<mark>$1</mark>')
}

/**
 * Arrow keys move between result rows — a roving tabindex, scoped to the list.
 *
 * One tab stop for the whole list rather than one per row: eight results is
 * eight tab presses to get past, and a reader who wants the composer back should
 * not have to walk the answer to reach it. `resultFocus` is which row holds that
 * stop; the arrows move it, Enter follows the link the browser already activates.
 *
 * Keyed per turn, because a thread can hold several results turns and a single
 * index would move all of them at once — and held by the panel, so the stop a
 * reader left survives the window closing and opening again.
 */
const resultFocus = (turn) => resultCursor.value[turn.id] || 0

function onResultsKey(e: KeyboardEvent, turn: Turn) {
  const n = turn.results.length
  if (!n) return
  const at = resultFocus(turn)
  let next = at
  if (e.key === 'ArrowDown') next = Math.min(at + 1, n - 1)
  else if (e.key === 'ArrowUp') next = Math.max(at - 1, 0)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = n - 1
  else return
  e.preventDefault()
  resultCursor.value = { ...resultCursor.value, [turn.id]: next }
  nextTick(() => {
    const list = e.currentTarget
    list?.querySelector?.(`[data-dp-result="${next}"]`)?.focus()
  })
}
</script>
