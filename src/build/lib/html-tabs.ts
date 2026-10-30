/**
 * Tab panels and accordions: content a reader opens, kept with its label —
 * engine-spec 043 (HTML-05, D-07, D-24).
 *
 * The prune in `html-extract.ts` would delete both halves of a tab group. The
 * `hidden` rule removes every inactive panel (F-03), and the `button` rule
 * removes the labels that name them (F-04), so the second and third install
 * method of a page vanish and the first one loses its name. This step runs
 * BEFORE the prune (pipeline step 5 of the research diagram, P-01, P-02): it
 * makes each panel a visible block that starts with its label as a bold lead
 * line, and takes the tab strip out. The prune then has nothing left to
 * misjudge, and every other `hidden` element on the page is still dropped.
 *
 * Unlike `html-extract.ts`, which builds no DOM, this step builds some: one
 * `<p><strong>` per panel, made with the node's own `ownerDocument`.
 *
 * A group the rules cannot pair one to one is left exactly as it was. A wrong
 * pairing would put the label of one panel on the text of another, which is a
 * false statement in the corpus; an unpaired group only loses what it lost
 * before this step existed.
 *
 * NO SELECTOR IS BUILT FROM PAGE TEXT. The ids of the page go into a map once;
 * every selector below is a constant.
 */

import { isCodeBlock } from './html-code.js'
import { textOf } from './html-extract.js'

/**
 * A tab group written without ARIA, recognised by the generator's own classes.
 *
 * Each entry is a named, documented pattern, never a guess: `group` finds the
 * container, `labels` and `panels` are searched INSIDE it, and the two lists
 * pair by position only when they have the same non-zero length. Generator
 * names only, never a brand name (owner rule, D-14).
 */
export interface TabPattern {
  name: string
  group: string
  labels: string
  panels: string
  reason: string
}

export const TAB_PATTERNS: TabPattern[] = [
  {
    name: 'vitepress-code-group',
    group: '.vp-code-group',
    labels: '.tabs label',
    panels: '.blocks > *',
    // The labels are radio-button labels and the inactive panels are hidden by
    // a stylesheet the extractor never sees, so the text of one install method
    // arrives as "npm yarn pnpm" above a run of unlabelled code blocks.
    reason: 'a code group is a row of radio labels over a column of code blocks',
  },
  {
    name: 'generic-tab-container',
    group: '.tabs, .tabset, .tab-group',
    labels: '.tab-label, [data-tab-label]',
    panels: '.tab-pane, .tab-panel',
    // The shape most hand-written and plugin-made tab widgets share. A
    // container that does not hold equal numbers of both is not a tab group.
    reason: 'a tab container holds one label for each pane, in the same order',
  },
]

/** A `display:none` declaration, with or without `!important`. Anchored, no nesting. */
const HIDING_DECLARATION = /^display\s*:\s*none\s*(?:!\s*important)?$/i

/** NFC and whitespace-collapsed, like prose (HTML-05 encoding edge). */
const clean = (text: string): string =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC')

/** The first id in a space-separated reference list that names an element in the map. */
function firstKnown(list: string | null, ids: Map<string, any>): any {
  for (const id of String(list || '').split(/\s+/)) {
    const found = id ? ids.get(id) : null
    if (found) return found
  }
  return null
}

/**
 * Make a panel visible: no `hidden`, no `aria-hidden`, no `display:none`.
 * Only a panel this module has paired with a label ever reaches this (T-02-19).
 */
function unhide(el): void {
  el.removeAttribute('hidden')
  el.removeAttribute('aria-hidden')
  const style = el.getAttribute('style')
  if (style == null) return
  const kept = String(style)
    .split(';')
    .filter((declaration) => !HIDING_DECLARATION.test(declaration.trim()))
    .join(';')
  if (kept.trim()) el.setAttribute('style', kept)
  else el.removeAttribute('style')
}

/**
 * Write the label as `<p><strong>label</strong></p>` at the head of the panel.
 *
 * A panel the code reader takes for ONE code block (a highlighter's wrapper
 * around a single `pre`, or a bare `pre`) is a leaf: a paragraph put inside it
 * would be read as the wrapper's own caption and dropped. The label goes
 * before such a panel instead, which reads the same.
 */
function lead(panel, label: string): void {
  if (!label) return
  const doc = panel.ownerDocument
  const paragraph = doc.createElement('p')
  const strong = doc.createElement('strong')
  strong.textContent = label
  paragraph.appendChild(strong)
  if (isCodeBlock(panel) && panel.parentNode) panel.parentNode.insertBefore(paragraph, panel)
  else panel.insertBefore(paragraph, panel.firstChild)
}

/**
 * Unhide one panel and give it its label, or remove it when it holds no text:
 * a label over nothing is an orphan line (HTML-05 empty edge).
 */
function keep(panel, label: string): boolean {
  unhide(panel)
  if (!textOf(panel)) {
    panel.remove()
    return false
  }
  lead(panel, label)
  return true
}

/** ARIA tab groups: `role=tablist`, `role=tab`, `role=tabpanel`. */
function ariaTabs(root, ids: Map<string, any>): number {
  // A panel can name its tab (`aria-labelledby`) instead of the tab naming the
  // panel (`aria-controls`); both are in the ARIA authoring practice.
  const labelled = new Map<string, any>()
  for (const panel of root.querySelectorAll('[role="tabpanel"]')) {
    for (const id of String(panel.getAttribute('aria-labelledby') || '').split(/\s+/)) {
      if (id && !labelled.has(id)) labelled.set(id, panel)
    }
  }

  let groups = 0
  for (const list of [...root.querySelectorAll('[role="tablist"]')]) {
    if (!root.contains(list)) continue
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    if (!tabs.length) continue

    const panels = tabs.map(
      (tab) =>
        firstKnown(tab.getAttribute('aria-controls'), ids) ||
        (tab.getAttribute('id') ? labelled.get(tab.getAttribute('id')) : null) ||
        null,
    )
    const paired =
      panels.every(Boolean) &&
      new Set(panels).size === panels.length &&
      panels.every((panel) => !panel.contains(list) && !list.contains(panel))
    // One tab with no panel, or two tabs on one panel: the group is not
    // understood, so none of it is touched.
    if (!paired) continue

    tabs.forEach((tab, i) => keep(panels[i], clean(textOf(tab))))
    list.remove()
    groups++
  }
  return groups
}

/** Tab groups without ARIA, by a named TAB_PATTERNS entry. */
function patternTabs(root): number {
  let groups = 0
  for (const pattern of TAB_PATTERNS) {
    for (const group of [...root.querySelectorAll(pattern.group)]) {
      if (!root.contains(group)) continue
      const labels = [...group.querySelectorAll(pattern.labels)]
      const panels = [...group.querySelectorAll(pattern.panels)]
      if (!labels.length || labels.length !== panels.length) continue
      // A nested group puts one group's panels in another's count; the counts
      // would still agree by accident, and the pairs would be wrong.
      const tangled = panels.some(
        (panel, i) =>
          labels.some((label) => panel.contains(label)) ||
          panels.some((other, j) => i !== j && panel.contains(other)),
      )
      if (tangled) continue

      const names = labels.map(
        (label) =>
          clean(textOf(label)) ||
          clean(label.getAttribute('data-title') || label.getAttribute('data-tab-label')),
      )
      panels.forEach((panel, i) => keep(panel, names[i]))
      for (const label of labels) label.remove()
      groups++
    }
  }
  return groups
}

/** ARIA accordions: a trigger with `aria-expanded` and `aria-controls` naming its region. */
function ariaAccordions(root, ids: Map<string, any>): number {
  let regions = 0
  const done = new Set()
  for (const trigger of [...root.querySelectorAll('[aria-expanded][aria-controls]')]) {
    if (!root.contains(trigger)) continue
    if ((trigger.getAttribute('role') || '').toLowerCase() === 'tab') continue
    const region = firstKnown(trigger.getAttribute('aria-controls'), ids)
    if (!region || done.has(region) || !root.contains(region)) continue
    if (region === trigger || region.contains(trigger) || trigger.contains(region)) continue
    done.add(region)
    // The trigger stays: a `button` is the prune's, and the label is already
    // written into the region.
    if (keep(region, clean(textOf(trigger)))) regions++
  }
  return regions
}

/**
 * Keep every tab panel and accordion region under `root`, each with its label.
 *
 * Order: ARIA tab groups, then the named class patterns, then ARIA
 * accordions. `tabs` counts the tab groups unfolded, `accordions` the regions
 * kept. A `details` accordion needs nothing here: its `summary` is the
 * serialiser's lead line (html-to-md.ts).
 */
export function unfoldPanels(root): { tabs: number; accordions: number } {
  const ids = new Map<string, any>()
  for (const el of root.querySelectorAll('[id]')) {
    const id = el.getAttribute('id')
    if (id && !ids.has(id)) ids.set(id, el)
  }
  const tabs = ariaTabs(root, ids) + patternTabs(root)
  const accordions = ariaAccordions(root, ids)
  return { tabs, accordions }
}
