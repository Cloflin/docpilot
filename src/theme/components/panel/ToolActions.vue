<template>
  <div
    class="docpilot__suggestions docpilot__suggestions--inline"
    role="group"
    :aria-label="T('tools.groupLabel')"
  >
    <template v-for="a in turn.actions" :key="a.id">
      <p
        v-if="a.state === 'done'"
        :id="`dp-act-${turn.id}-${a.id}`"
        tabindex="-1"
        class="docpilot__meta"
        aria-live="polite"
      >
        {{ a.message || T('tools.done') }}
      </p>
      <button
        v-else
        :id="`dp-act-${turn.id}-${a.id}`"
        type="button"
        class="docpilot__suggestion"
        :aria-disabled="String(a.state === 'running' || a.state === 'unavailable')"
        :aria-expanded="a.confirm === 'form' ? String(a.open) : null"
        @click="pressAction(turn, a)"
      >
        {{ a.state === 'running' ? T('tools.running') : a.label }}
        <!-- The model's arguments, ON the pill and so in its name —
             ui-specs/018. One press sends them, and a reader who
             cannot see them has not agreed to them. -->
        <span v-if="argsLine(a)" class="docpilot__suggestion-args">
          {{ T('tools.argsLabel', { args: argsLine(a) }) }}
        </span>
      </button>
    </template>
  </div>
  <template v-for="a in turn.actions" :key="`said-${a.id}`">
    <p v-if="a.state === 'failed' || a.state === 'unavailable'" class="docpilot__meta" aria-live="polite">
      {{ T(a.state === 'failed' ? 'tools.failed' : 'tools.unavailable') }}
    </p>
  </template>
  <!-- The feedback form's shape, for the same reasons it has it: the
       pressed pill answers "a checkbox wants a resting border", and
       `novalidate` because the check that decides is the site's own
       schema, run in session.runAction, not the browser's bubble. -->
  <template v-for="a in turn.actions" :key="`form-${a.id}`">
    <form
      v-if="a.open"
      :id="`dp-form-${turn.id}-${a.id}`"
      class="docpilot__feedback"
      novalidate
      :aria-label="a.title"
      @submit.prevent="sendAction(turn, a)"
    >
      <template v-for="(f, key) in fieldsOf(a)" :key="key">
        <template v-if="f.kind === 'choice' || f.kind === 'toggle'">
          <p :id="`dp-field-${turn.id}-${a.id}-${key}`" class="docpilot__meta">
            {{ f.label }}<span v-if="f.required"> · {{ T('tools.required') }}</span>
          </p>
          <div
            class="docpilot__reasons"
            role="group"
            :aria-labelledby="`dp-field-${turn.id}-${a.id}-${key}`"
          >
            <template v-if="f.kind === 'choice'">
              <button
                v-for="v in f.options"
                :key="String(v)"
                type="button"
                class="docpilot__text-btn"
                :aria-pressed="String(a.values[key] === v)"
                @click="a.values[key] = a.values[key] === v ? null : v"
              >
                {{ String(v) }}
              </button>
            </template>
            <button
              v-else
              type="button"
              class="docpilot__text-btn"
              :aria-pressed="String(a.values[key] === true)"
              @click="a.values[key] = a.values[key] !== true"
            >
              {{ f.label }}
            </button>
          </div>
        </template>
        <template v-else>
          <label :for="`dp-field-${turn.id}-${a.id}-${key}`" class="docpilot__meta">
            {{ f.label }}<span v-if="f.required"> · {{ T('tools.required') }}</span>
          </label>
          <textarea
            v-if="f.kind === 'multiline'"
            :id="`dp-field-${turn.id}-${a.id}-${key}`"
            v-model="a.values[key]"
            class="docpilot__comment"
            rows="3"
            :maxlength="f.maxLength"
            :aria-required="f.required ? 'true' : null"
            :aria-invalid="a.errors[key] ? 'true' : null"
            :aria-describedby="a.errors[key] ? `dp-err-${turn.id}-${a.id}-${key}` : null"
          ></textarea>
          <input
            v-else
            :id="`dp-field-${turn.id}-${a.id}-${key}`"
            v-model="a.values[key]"
            class="docpilot__comment"
            :type="f.inputType"
            :min="f.minimum"
            :max="f.maximum"
            :maxlength="f.maxLength"
            :aria-required="f.required ? 'true' : null"
            :aria-invalid="a.errors[key] ? 'true' : null"
            :aria-describedby="a.errors[key] ? `dp-err-${turn.id}-${a.id}-${key}` : null"
          />
        </template>
        <p v-if="a.errors[key]" :id="`dp-err-${turn.id}-${a.id}-${key}`" class="docpilot__meta">
          {{ T('tools.invalid') }}
        </p>
      </template>
      <div class="docpilot__reasons">
        <button type="submit" class="docpilot__text-btn" :aria-disabled="String(a.state === 'running')">
          {{ a.state === 'running' ? T('tools.running') : a.label }}
        </button>
        <button type="button" class="docpilot__text-btn" @click="closeAction(turn, a)">
          {{ T('tools.cancel') }}
        </button>
      </div>
    </form>
  </template>
</template>

<script setup lang="ts">
/**
 * The answer's actions — ui-specs/018, engine-spec 038. Between the answer and
 * its sources, on a settled answer only: an action is a next step FROM an
 * answer. Every word on a pill is the author's `label`; what the model chose is
 * the pill's description, read as data. Nothing here runs until the reader
 * presses it.
 */
import type { PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { usePanel } from './context.js'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const s = session.state
const { T, focusIn, closeAction } = usePanel()

/** The model's arguments, as the pill's description reads them. */
function argsLine(a) {
  return Object.entries(a.args || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
}

/**
 * One field per parameter of the action's own schema, in the order the author
 * wrote them. The label is the parameter's description — the sentence the
 * author already wrote for the model — and the control follows the type.
 */
function fieldsOf(a) {
  const def = (s.config.tools || []).find((t) => t.name === a.tool)
  if (!def) return {}
  const required = new Set(def.parameters.required)
  const kindOf = (f) =>
    Array.isArray(f.enum) ? 'choice' : f.type === 'boolean' ? 'toggle' : f.format === 'multiline' ? 'multiline' : 'input'
  const inputType = (f) =>
    f.type === 'number' || f.type === 'integer'
      ? 'number'
      : ({ email: 'email', uri: 'url', date: 'date' })[f.format] || 'text'
  return Object.fromEntries(
    Object.entries(def.parameters.properties).map(([key, f]: [string, any]) => [
      key,
      {
        label: f.description || key,
        required: required.has(key),
        kind: kindOf(f),
        options: f.enum || [],
        inputType: inputType(f),
        minimum: f.minimum ?? null,
        maximum: f.maximum ?? null,
        maxLength: f.maxLength ?? null,
      },
    ]),
  )
}

/** A pill: a button action runs, a form action opens — or closes, pressed again. */
function pressAction(turn, a) {
  if (a.state === 'running' || a.state === 'unavailable') return
  if (a.confirm !== 'form') return session.runAction(turn, a)
  if (a.open) return closeAction(turn, a)
  // From what was OFFERED, every time it opens: a reader who cancelled has
  // said no to their edits as well.
  a.values = { ...a.args }
  a.errors = {}
  a.open = true
  focusIn(`#dp-form-${turn.id}-${a.id} input, #dp-form-${turn.id}-${a.id} textarea, #dp-form-${turn.id}-${a.id} button`)
}

async function sendAction(turn, a) {
  if (a.state === 'running') return
  await session.runAction(turn, a)
  // A field that failed keeps the form open, and focus goes to it; a send that
  // went through closes the form, and focus has nowhere better than the group.
  const bad = Object.keys(a.errors || {})[0]
  if (bad) focusIn(`#dp-field-${turn.id}-${a.id}-${bad}`)
  else if (!a.open) focusIn(`#dp-act-${turn.id}-${a.id}`)
}
</script>
