<template>
  <!--
    `role="list"` on an ordered list is redundant markup everywhere
    except here. `.docpilot__sources` sets `list-style: none`, and
    Safari drops list semantics from a list styled that way outside a
    `nav` — which takes the item count with it and leaves the
    `aria-label` below naming an element that no longer has a role to
    be named. Every list in this panel carries it for that reason.
  -->
  <ol class="docpilot__sources" role="list" :aria-label="T('panel.sources')">
    <li
      v-for="src in turn.sources"
      :key="src.id"
      class="docpilot__source"
      :class="{ 'is-linked': linkedCite === src.n, 'has-passage': passage(turn, src) }"
    >
      <span class="docpilot__source-n">{{ src.n }}</span>
      <!-- A site tool's reply — ui-specs/018: no page to open, so no
           link, and the tail says where it came from instead. -->
      <span v-if="src.kind === 'tool'">
        <span class="docpilot__source-title">{{ src.title }}</span
        ><span class="docpilot__source-tail"> · {{ T('tools.fromSite') }}</span>
      </span>
      <a
        v-else
        :href="src.origin || src.href"
        :target="src.origin ? '_blank' : null"
        :rel="src.origin ? 'noopener noreferrer' : null"
        @click="onSourceClick($event, src)"
      >
        <span class="docpilot__source-title">{{ src.title }}</span
        ><span v-if="src.tail" class="docpilot__source-tail"> · {{ src.tail }}</span>
      </a>
      <!--
        The passage this citation was drawn from — ui-specs/009.

        Absent, not disabled, when there is nothing to show: a restored
        conversation whose chunk the rebuilt index no longer has. A
        control that opens onto nothing is worse than no control.

        A disclosure on the ROW rather than a preview on the marker.
        ChatGPT Search previews on hover and its own help page says
        that does not exist on mobile — where checking a source means
        clicking through. A disclosure is one control for pointer,
        touch and keyboard alike.
      -->
      <button
        v-if="src.kind !== 'tool' && passage(turn, src)"
        type="button"
        class="docpilot__icon-btn"
        :aria-expanded="String(openPassage === src.id)"
        :aria-controls="`dp-passage-${turn.id}-${src.n}`"
        :aria-label="T(openPassage === src.id ? 'citation.hidePassage' : 'citation.showPassage')"
        @click="togglePassage(src.id)"
      >
        <Icon name="chevronDown" :class="openPassage === src.id ? 'is-open' : null" />
      </button>
      <!--
        Rendered markdown, not the chunk's source. It is corpus text
        either way; the only question is whether the reader parses the
        `##` and the `**` or the panel does — and the answer above it
        never asks them to.

        `onAnswerClick` for the same reason the answer carries it: a
        link inside v-html has no Vue handler of its own, and a chunk's
        own cross-references are exactly the links a reader following
        provenance will press.
      -->
      <div
        v-if="openPassage === src.id"
        :id="`dp-passage-${turn.id}-${src.n}`"
        class="docpilot__passage"
        tabindex="0"
        role="region"
        :aria-label="T('citation.passageLabel')"
        v-html="passageHtml(turn, src)"
        @click="onAnswerClick"
      ></div>
    </li>
  </ol>
</template>

<script setup lang="ts">
/**
 * ── the passage behind a citation — ui-specs/009 ────────────────────────────
 *
 * One id, so at most one passage is open across the whole thread — which is why
 * `openPassage` is the panel's and not this list's. Two open passages in a 420px
 * column is a column of quotations with an answer somewhere in it, and the
 * reader opened one to check one thing.
 *
 * The text itself comes from the store — see `passageFor`, which prefers the
 * chunk THIS turn put in front of the model and falls back to the index by id.
 */
import type { PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Icon from './Icon.vue'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const { T, linkedCite, openPassage, onSourceClick, onAnswerClick } = usePanel()

const passage = (turn, src) => session.passageFor(turn, src)
const passageHtml = (turn, src) => session.passageHtml(turn, src)
const togglePassage = (id) => (openPassage.value = openPassage.value === id ? null : id)
</script>
