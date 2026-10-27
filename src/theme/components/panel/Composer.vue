<template>
  <div class="docpilot__composer">
    <!-- at most one disclosure open; all three absent from the DOM at
         rest. Two of the three are here, and both are opened from the
         footnote row directly below: a disclosure opens where its trigger
         is. The third — past conversations — is opened from the HEADER,
         so it is docked up there. ui-specs/003. -->
    <Transition name="dp-dock">
      <ScopePicker v-if="s.dockPanel === 'picker'" />
    </Transition>

    <Transition name="dp-dock">
      <PromptDoc v-if="s.dockPanel === 'prompt'" />
    </Transition>

    <template v-if="s.degraded">
      <p class="docpilot__lead">{{ T('degraded.lead') }}</p>
      <p class="docpilot__row" v-if="hasSearch">
        <button type="button" class="docpilot__text-btn" @click="openSearch">{{ T('degraded.search') }}</button>
      </p>
    </template>

    <template v-else>
      <!-- The quote as a draft: it is the reader's, so they can take it
           back. `maxlength` on the field below is untouched by it — the
           passage is not part of what they typed. -->
      <div v-if="quote" class="docpilot__quote docpilot__quote--draft">
        <Icon name="quote" /><span id="dp-quote" class="docpilot__quote-text"
          ><span class="docpilot__sr">{{ T('quote.label') }} </span>{{ quote }}</span
        >
        <button
          type="button"
          class="docpilot__icon-btn"
          :aria-label="T('quote.drop')"
          @click="dropQuote"
        >
          <Icon name="x" />
        </button>
      </div>

      <!-- In the bar instead, under `panel: 'bar'` on a wide screen —
           everything else in this block stays here, in the window. -->
      <Field v-if="!fieldInBar" :in-bar="false" />

      <p v-if="input.length >= 950" id="dp-counter" class="docpilot__counter">
        {{ T('composer.counter', { n: input.length }) }}
      </p>

      <!-- What the next question is limited to — what is left of the day's
           free answers, and whether this site retrieves without an
           embedder — in the place the reader is deciding whether to spend
           one. Described BY the field for the same reason the counter is:
           it changes what a question costs and what it can find, and a
           reader who cannot see it is the one most likely to be surprised
           when the answers stop. -->
      <p v-if="statusLine" id="dp-budget" class="docpilot__budget">
        {{ statusLine }}<span v-if="showBudgetLow"> · {{ T('error.budgetLow') }}</span>
      </p>

      <Footnote />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The foot of the window — the two disclosures that grow out of it, the
 * quoted passage, the field, and the lines that describe what the next
 * question can do.
 */
import * as session from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Field from './Field.vue'
import Footnote from './Footnote.vue'
import Icon from './Icon.vue'
import PromptDoc from './PromptDoc.vue'
import ScopePicker from './ScopePicker.vue'

const s = session.state
const { T, input, quote, dropQuote, fieldInBar, statusLine, showBudgetLow, hasSearch, openSearch } =
  usePanel()
</script>
