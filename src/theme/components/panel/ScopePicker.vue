<template>
  <div id="dp-picker" class="docpilot__picker" tabindex="-1">
    <div class="docpilot__picker-acts">
      <!-- aria-hidden: the group below is already named "Set the scope" -->
      <span class="docpilot__picker-label" aria-hidden="true">{{ T('picker.label') }}</span>
      <!-- the group wraps the presets only: closing the picker is not
           setting a scope, so the close button stays outside it -->
      <div class="docpilot__picker-presets" role="group" :aria-label="T('picker.setScope')">
        <button type="button" class="docpilot__text-btn" @click="preset('all')">{{ T('picker.all') }}</button>
        <button
          v-if="currentPathIndexed"
          type="button"
          class="docpilot__text-btn"
          @click="preset('page')"
        >
          {{ T('picker.page') }}
        </button>
        <button
          v-if="offersSection"
          type="button"
          class="docpilot__text-btn"
          @click="preset('section')"
        >
          {{ T('picker.section') }}
        </button>
      </div>
      <!-- same exit the Esc cascade takes, and the same focus return -->
      <button
        type="button"
        class="docpilot__icon-btn docpilot__picker-close"
        :aria-label="T('picker.close')"
        @click="closeDock()"
      >
        <Icon name="x" />
      </button>
    </div>
    <!--
      A listbox is ONE tab stop — ui-specs/009.

      Every row used to carry `tabindex="0"`, which on a three-hundred
      page corpus put three hundred stops between this list and the
      composer. Roving tabindex instead: exactly one row is in the tab
      order at a time and the arrow keys move it, which is what the
      pattern has always expected and what a reader arrives expecting.
    -->
    <!--
      The filter — ui-specs/009. OUTSIDE the listbox, because a text
      input is not an option, and bound to it with `aria-controls`.
      `'auto'` shows it once the corpus is past the point where scanning
      a list works, which is the number `promptListLimit` already picked.
    -->
    <template v-if="showFilter">
      <label class="docpilot__sr" for="dp-pick-filter">{{ T('picker.filterLabel') }}</label>
      <input
        id="dp-pick-filter"
        v-model="pickFilter"
        type="search"
        class="docpilot__picker-filter"
        :placeholder="T('picker.filterPlaceholder')"
        aria-controls="dp-picker-list"
        @keydown.down.prevent="focusPickAt(0)"
      />
    </template>
    <div
      id="dp-picker-list"
      class="docpilot__picker-list"
      role="listbox"
      aria-multiselectable="true"
      :aria-label="T('picker.list')"
    >
      <!--
        Grouped by section, and FLAT while a filter is on: grouping a
        filtered list fragments it into headings with one row under each,
        which is the opposite of what narrowing was for.

        `g.offset + j` is the flat index, and it has to match DOM order —
        `focusPickAt` reaches a row by position among the rendered
        `.docpilot__pick` nodes, so the groups' concatenation IS the
        keyboard's list. `pickFlat` is derived from these groups for
        exactly that reason rather than computed alongside them.
      -->
      <template v-for="(g, gi) in pickGroups" :key="g.label || gi">
        <div v-if="g.label" role="group" :aria-label="g.label">
          <!-- aria-hidden: the group is already named by the label above -->
          <p class="docpilot__pick-group" aria-hidden="true">{{ g.label }}</p>
          <div
            v-for="(p, j) in g.pages"
            :key="p.path"
            class="docpilot__pick"
            role="option"
            :aria-selected="String(selected.has(p.path))"
            :tabindex="p.path === rovingPath ? 0 : -1"
            @click="pickClicked(g.offset + j)"
            @keydown="onPickKeydown($event, g.offset + j)"
          >
            <span class="docpilot__pick-mark">
              <Icon v-if="selected.has(p.path)" name="check" />
            </span>
            <span>
              <span class="docpilot__source-title">{{ p.title }}</span
              ><span v-if="p.tail" class="docpilot__source-tail"> · {{ p.tail }}</span>
            </span>
          </div>
        </div>
        <!-- The ungrouped case: no wrapper, so the rows sit directly
             in the listbox where `role="option"` expects to be. -->
        <template v-else>
          <div
            v-for="(p, j) in g.pages"
            :key="p.path"
            class="docpilot__pick"
            role="option"
            :aria-selected="String(selected.has(p.path))"
            :tabindex="p.path === rovingPath ? 0 : -1"
            @click="pickClicked(g.offset + j)"
            @keydown="onPickKeydown($event, g.offset + j)"
          >
            <span class="docpilot__pick-mark">
              <Icon v-if="selected.has(p.path)" name="check" />
            </span>
            <span>
              <span class="docpilot__source-title">{{ p.title }}</span
              ><span v-if="p.tail" class="docpilot__source-tail"> · {{ p.tail }}</span>
            </span>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/** The scope picker — which pages the next question is asked of. */
import { computed, nextTick, onBeforeUnmount } from 'vue'
import * as session from '../../docpilot/session.js'
import { sectionFor } from '../../docpilot/scope.js'
import { FILTER_AUTO_ABOVE } from '../../docpilot/switches.js'
import { usePanel } from './context.js'
import Icon from './Icon.vue'

const s = session.state
const { T, panel, closeDock, pickFilter, activePick } = usePanel()
const offersSection = session.offersSection
const currentPathIndexed = session.currentPathIndexed

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

/**
 * ── the picker at corpus scale — ui-specs/009 ───────────────────────────────
 *
 * A flat, unfiltered list of every page in a `min(240px, 32dvh)` scroller is
 * fine at twelve pages and unusable at three hundred. The filter's text,
 * `pickFilter`, is the panel's: closing a dock is what clears it — docks.js.
 */
const showFilter = computed(() => {
  const mode = s.config.scope.filter
  if (typeof mode === 'boolean') return mode
  return pages.value.length > FILTER_AUTO_ABOVE
})

/** Title first, then route: a reader filtering by `/guide/` means the route. */
const pickPages = computed(() => {
  const q = pickFilter.value.trim().toLowerCase()
  if (!q) return orderedPages.value
  return orderedPages.value.filter(
    (p) => (p.title || '').toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  )
})

/**
 * The rendered structure, and the keyboard's list, in one object.
 *
 * `offset` is the flat index of a group's first row, so `offset + j` is the
 * position among the rendered `.docpilot__pick` nodes — which is how
 * `focusPickAt` reaches one. Deriving `pickFlat` FROM these groups rather than
 * computing it alongside them is what keeps those two definitions from drifting
 * the day the grouping changes the order.
 *
 * Flat while a filter is on: grouping a filtered list fragments it into headings
 * with one row under each, which is the opposite of what narrowing was for.
 */
const pickGroups = computed(() => {
  const list = pickPages.value
  if (!s.config.scope.groupBySection || pickFilter.value.trim() || !s.index) {
    return [{ label: '', offset: 0, pages: list }]
  }
  const manifest = s.index.manifest
  const labelOf = new Map()
  for (const section of manifest.sections || []) {
    for (const i of section.pageIdx) {
      const page = manifest.pages[i]
      // First section wins, so a page in a nested section is named by the
      // outermost one it appears in — the order `manifest.sections` is built in.
      if (page && !labelOf.has(page.path)) labelOf.set(page.path, section.label)
    }
  }
  const groups = []
  const byLabel = new Map()
  for (const page of list) {
    const label = labelOf.get(page.path) || ''
    let group = byLabel.get(label)
    if (!group) {
      group = { label, offset: 0, pages: [] }
      byLabel.set(label, group)
      groups.push(group)
    }
    group.pages.push(page)
  }
  let offset = 0
  for (const group of groups) {
    group.offset = offset
    offset += group.pages.length
  }
  return groups
})

const pickFlat = computed(() => pickGroups.value.flatMap((g) => g.pages))

/**
 * ── the picker's keyboard — ui-specs/009 ────────────────────────────────────
 *
 * Roving tabindex, not `aria-activedescendant`. Both are legal for a listbox and
 * this one picks the variant where **focus is really on the option**, because
 * every other row-shaped control in this package is styled from `:focus-visible`
 * and the alternative would need a second, parallel "looks focused" rule that
 * only this list uses.
 *
 * `activePick` is a PATH rather than an index, because the list it indexes into
 * is re-sorted by `orderedPages` and, once the filter lands, re-filtered as well;
 * an index would silently come to mean a different row. Like the filter, it is
 * the panel's, and closing the dock is what clears it.
 */

/**
 * The one row in the tab order.
 *
 * Falls to the first row whenever `activePick` names nothing in the current
 * list — nothing visited yet, or a filter that has just removed it. Never null
 * while there are rows, which is the invariant that matters: a listbox with no
 * tab stop is a listbox the keyboard cannot enter at all.
 */
const rovingPath = computed(() => {
  const pages = pickFlat.value
  if (!pages.length) return null
  return pages.some((p) => p.path === activePick.value) ? activePick.value : pages[0].path
})

function focusPickAt(i) {
  const page = pickFlat.value[i]
  if (!page) return
  activePick.value = page.path
  // By position in the rendered list, not by a selector built from the path: a
  // route contains `/` and would have to be escaped, and `CSS.escape` is one
  // more thing to be missing in an engine somewhere.
  nextTick(() => panel.value?.querySelectorAll('.docpilot__pick')?.[i]?.focus())
}

// A press moves the tab stop as well as toggling, so tabbing out and back in
// returns to the row the reader was last working on rather than to the top.
function pickClicked(i) {
  const page = pickFlat.value[i]
  if (!page) return
  activePick.value = page.path
  togglePage(page.path)
}

/**
 * Type-ahead, which a listbox is expected to offer whether or not a filter field
 * also exists — they answer different questions. The filter narrows the list and
 * is a decision; this jumps to a row and is a reflex.
 */
let typeBuf = ''
let typeTimer: ReturnType<typeof setTimeout> | null = null

function onPickKeydown(e: KeyboardEvent, i: number) {
  const pages = pickFlat.value
  const last = pages.length - 1
  switch (e.key) {
    // Clamped rather than wrapping. APG leaves the choice open, and a list this
    // long is one a reader arrows through to get somewhere — arriving back at
    // the top by surprise is the failure mode, not running out of list.
    case 'ArrowDown':
      e.preventDefault()
      return focusPickAt(Math.min(last, i + 1))
    case 'ArrowUp':
      e.preventDefault()
      return focusPickAt(Math.max(0, i - 1))
    case 'Home':
      e.preventDefault()
      return focusPickAt(0)
    case 'End':
      e.preventDefault()
      return focusPickAt(last)
    case 'Enter':
    case ' ':
      // `preventDefault` on Space is not optional: without it the key scrolls
      // the picker's own scroller out from under the row it just toggled.
      e.preventDefault()
      return pickClicked(i)
  }

  if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return
  clearTimeout(typeTimer)
  typeBuf += e.key.toLowerCase()
  typeTimer = setTimeout(() => (typeBuf = ''), 700)
  const hit = pages.findIndex((p) => (p.title || '').toLowerCase().startsWith(typeBuf))
  if (hit >= 0) {
    e.preventDefault()
    focusPickAt(hit)
  }
}

onBeforeUnmount(() => clearTimeout(typeTimer))

function preset(kind) {
  if (kind === 'all') return session.setScope([])
  if (kind === 'page') return session.setScope([s.currentPath])
  const section = sectionFor(s.currentPath, s.index.manifest)
  if (section) session.setScope(section.paths)
}
</script>
