/**
 * Every reader-facing string, and the one place a project replaces one.
 *
 * SHAPE. `docPilot.i18n` is `{ translations, locales }` — byte-for-byte the inside
 * of VitePress's own `search.options` i18n, so the example in their reference
 * transfers here unchanged:
 *
 *   i18n: {
 *     translations: { empty: { heading: 'How can I help?' } },   // every locale
 *     locales: { ru: { translations: { empty: { heading: 'Чем помочь?' } } } },
 *   }
 *
 * The outer key is `i18n` rather than `locales` because a VitePress config
 * already has a top-level `locales` meaning something else, and two keys with
 * one name in one file is a support question waiting to happen.
 *
 * TWO SELECTORS, ONE KEY SPACE. There are two different "reader's language"s in
 * this panel and conflating them regresses behaviour that ships today:
 *
 *   · uiLocale    — the locale of the PAGE (the host binding's `lang`). Drives all panel
 *                   chrome: buttons, aria labels, status lines, refusals.
 *   · replyLocale — the language the reader TYPED (`detectLanguage`, mapped to a
 *                   subtag by `localeOf`). Drives only `reply.*`, the two copies
 *                   the host writes with no model call — credentials and social.
 *
 * Which selector a key uses is a property of the key and is not configurable:
 * everything under `reply.` follows the typed language, everything else follows
 * the page. One selector for both would either answer a Russian greeting in
 * English or write Russian into an English page's chrome.
 *
 * Because both selectors are SUBTAGS, a site that already declares
 * `locales: { ru: … }` in VitePress writes exactly one `ru` block here and
 * covers both.
 *
 * FALLBACK, per leaf, in order:
 *   1. i18n.locales[selector].translations.<path>
 *   2. i18n.translations.<path>
 *   3. reply.* only: i18n.locales[uiLocale].translations.<path>
 *   4. the shipped default for `selector`
 *   5. the shipped default for `en`
 *
 * The merge is DEEP and per-leaf: overriding one string keeps the other seventy.
 *
 * WHERE THE MERGE HAPPENS. Validation is in Node (`validateI18n`, called from
 * `themeDocPilot`), the merge is in the browser. `themeConfig` is inlined into the
 * hydration payload of every page, so merging server-side would ship the whole
 * default tree — ~80 UI strings plus eighteen languages of reply copy — on every
 * page of the site. Shipping only the delta keeps the defaults inside the lazy
 * panel chunk where they already live.
 *
 * NOT COVERED: the system instruction. `promptHash` names every eval report, and
 * a translatable prompt would give two readers of one build two hashes and break
 * every cross-report comparison. `docPilot.prompt.override` / `extend` is where the
 * instruction changes, and `languageDirective` already makes the model answer in
 * the reader's language. The prompt DISCLOSURE's headings are chrome and are
 * here; its bodies are the prompt and are not.
 */

import { CREDENTIAL_COPY } from './credentials.js'
import { SOCIAL_COPY } from './social.js'

/**
 * The shipped tree.
 *
 * `en` carries everything. Every other locale carries only `reply.*`, because
 * that is the copy that already existed in eighteen languages — the panel chrome
 * has never been translated and shipping a machine translation of it would be
 * worse than shipping English somebody can override.
 */
const UI_EN = {
  panel: {
    title: 'Docpilot',
    newChat: 'New chat',
    // The whole conversation as Markdown — ui-specs/009. Per-turn copy already
    // existed; the artefact a support engineer wants is the thread.
    copyThread: 'Copy conversation',
    close: 'Close',
    conversation: 'Conversation',
    reasoning: 'Model reasoning',
    answer: 'Answer',
    sources: 'Sources',
    closestPages: 'Closest pages',
    jumpToLatest: 'Jump to latest',
  },
  empty: {
    heading: 'How can I help you today?',
    body: 'I search through your documentation to help you find setup guides, feature details and troubleshooting tips, fast.',
    // ── ui-specs/009 ────────────────────────────────────────────────────────
    // Under a narrow scope the panel used to offer nothing at all, because the
    // built-in three would fall outside it and the gate would refuse all of
    // them. What goes there instead is the pages the reader scoped TO, which is
    // the question they actually have at that moment.
    scopedLead: 'Asking about these pages',
    // A follow-up is a heading, not an invented question. The template is
    // grammatical for any heading in any corpus, which is the whole reason it
    // is a template and not a generator — see 009 on the A5/B3 asymmetry.
    followUp: 'Tell me about {heading}',
    followUpsLabel: 'Follow-up questions',
    // The one thing a reader will not find on their own. Named once, on a first
    // visit, and never again — an onboarding overlay is what a panel gets
    // removed for.
    hint: 'Select any passage to ask about it.',
    hintDismiss: 'Got it',
  },
  status: {
    searching: 'Searching the docs',
    indexing: 'Loading the docs index',
    thinking: 'Thinking',
    listing: 'Looking at the page list',
    writing: 'Writing the answer',
    reading: 'Reading a page',
    readingPage: 'Reading {label}',
  },
  turn: {
    stopped: 'Stopped.',
    tentative: 'The model was unsure of this one — check the sources below.',
    thoughtFor: 'Thought for {n}s',
    thinkingFor: 'Thinking for {n}s',
  },
  /**
   * A citation, and what a reader can do with it besides believe it —
   * ui-specs/009.
   *
   * Its own block rather than more keys under `panel`, because these follow the
   * `citations.*` settings and a reader of either one should find the other.
   */
  citation: {
    // A disclosure, so the label says what pressing it DOES rather than what is
    // behind it — and it changes with the state, because the control is the same
    // control either way and `aria-expanded` is not read aloud by every tool.
    showPassage: 'Show the passage',
    hidePassage: 'Hide the passage',
    // Names the region the passage opens into. Not "Passage": the point of the
    // control is that this is the text the citation was actually drawn from, and
    // the accessible name is where that survives without a visible caption.
    passageLabel: 'The passage this citation was drawn from',
    // The heading over the source list appended to a copied answer. One word,
    // because it lands in somebody's ticket under text they wrote themselves.
    copyHeading: 'Sources:',
  },
  refusal: {
    closestPages: 'Closest pages',
    closestPagesElsewhere: 'Closest pages elsewhere',
    // What "read N pages" was actually reading — `citations.pagesRead`.
    pagesReadLabel: 'Pages read',
    widen: 'Clear the scope and search all docs',
    searched: 'Searched {scope}',
    searchedAndRead: 'Searched {scope} and read {n} {n, page|pages}',
    notFound: "I couldn't find this in {scope}.",
    degraded:
      "Search is running degraded — the semantic index isn't available, so only word matching ran. This may be why nothing was found.",
    allDocsShort: 'the docs',
  },
  error: {
    lead: "The AI service didn't respond.",
    retry: 'Retry',
    search: 'Search the docs',
    // ── the free tier's daily budget ────────────────────────────────────────
    // A quota is not a failure, and saying "The AI service didn't respond" to a
    // reader who has spent the day's fiftieth request is both wrong and
    // unactionable: the service answered, and it said exactly when it will
    // answer again. Its own sentence, so `retry` never appears under it —
    // pressing it would spend nothing and change nothing.
    rateLimited: "The free daily limit for this site's AI is used up.",
    // `{when}` is a clock time in the reader's locale, never the epoch the API
    // sent — the panel is the only thing here that knows what time it is where
    // the reader is.
    rateResets: 'Answers resume {when}.',
    // The count sits under the composer, in the tense of the decision it
    // informs: what is left, not what was spent.
    budgetLeft: '{n} of {limit} free answers left today',
    // Below the cutoff the panel drops to one model call per question, which
    // a reader experiences as shorter, less researched answers. Stating the
    // trade beats letting them conclude the panel got worse.
    budgetLow: 'Running low — answers get shorter to stretch the daily limit.',
    // NOT a failure, which is why it reads as a statement rather than as an
    // apology: the site declared `embed: false`, so retrieval is BM25 over the
    // chunk text and there is no semantic channel to be missing. It shares the
    // line — and the switch — with the request count above it, because both
    // answer the one question a reader has while deciding whether to type:
    // what is this search limited to. `refusal.degraded` is the other case,
    // an embedder that was configured and could not be reached.
    noEmbedder: 'No embedding model — search matches words only.',
  },
  actions: {
    copy: 'Copy answer',
    copyQuestion: 'Copy question',
    edit: 'Edit question',
    // The composer's own verb, because committing an edit IS asking: the thread
    // below the question is discarded and the model answers again.
    editSave: 'Send',
    editCancel: 'Cancel',
    // The field's accessible name. A textarea that replaces a paragraph has no
    // label to inherit, and the button that opened it is gone by then.
    editLabel: 'Edit your question',
    // Not `error.retry`'s word. That one re-runs a question the transport
    // dropped; this one throws away an answer that arrived and asks again.
    retry: 'Ask again',
    helpful: 'Helpful answer',
    notHelpful: 'Not helpful',
    reasonsGroup: 'What went wrong?',
    // The way back into a form the reader closed. Without it the only control
    // left is the thumb, and pressing that again withdraws the vote.
    tellUsMore: 'Tell us more',
  },
  reasons: {
    wrong: 'Wrong answer',
    incomplete: 'Incomplete',
    'not-in-docs': 'Not in the docs',
    'bad-links': 'Bad links',
  },
  feedback: {
    commentLabel: 'What went wrong, in your words',
    commentPlaceholder: 'Optional. What were you looking for?',
    // Says what happens to the text, in the sentence where the reader is
    // deciding whether to write it. The redaction is not a reassurance the panel
    // can decline to make: it is what feedback.js does to every comment.
    commentHint: 'Sent to the docs team. Keys and tokens are removed automatically.',
    // The cap is a code constant, so it is written into the copy — the same
    // thing `composer.counter` does with its own thousand.
    counter: '{n}/500',
    submit: 'Send',
    skip: 'Skip',
    // ── ui-specs/009 ──────────────────────────────────────────────────────
    // Submitting used to remove the form and say nothing a sighted reader could
    // see, which is indistinguishable from closing it unsent. TWO lines,
    // because one of them would be false under two of the four `send` modes —
    // the same reason `disclaimer` has three.
    thanks: 'Thanks — this is recorded on your device.',
    thanksSent: 'Thanks — sent to the docs team.',
  },
  picker: {
    label: 'Scope',
    setScope: 'Set the scope',
    all: 'All docs',
    page: 'This page',
    section: 'This section',
    close: 'Close the scope picker',
    list: 'Pages to search',
    // ── ui-specs/009 ──────────────────────────────────────────────────────
    // A flat list of every page in a `min(240px, 32dvh)` scroller is fine at
    // twelve pages and unusable at three hundred. The field is OUTSIDE the
    // listbox — a text input is not an option — and bound to it by aria-controls.
    filterLabel: 'Filter the pages',
    filterPlaceholder: 'Filter',
  },
  history: {
    open: 'Past conversations',
    label: 'Conversations',
    list: 'Past conversations',
    close: 'Close the conversation list',
    delete: 'Delete "{title}"',
    empty: 'Nothing saved yet. Conversations are kept on this device once you ask something.',
    clearAll: 'Delete all',
    // Two steps rather than a native confirm(): the panel has no modal of its
    // own, and a blocking browser dialog would be the only one in it.
    clearAllConfirm: 'Delete all — press again',
    stale: 'The docs have changed since this conversation. Some links may no longer work.',
  },
  promptDoc: {
    region: 'How this assistant works',
    toggle: 'How this works',
    toggleWithYours: 'How this works, with your instruction',
    save: 'Save',
    cancel: 'Cancel',
    add: 'Add instruction',
    edit: 'Edit instruction',
    remove: 'Remove instruction',
    headingInstructions: 'Instructions',
    headingToolsNative: 'Tools (delivered as tool definitions)',
    headingToolsText: 'Tools (sent as text)',
    headingScope: 'Scope',
    headingYours: 'Your instruction',
    scopeAllPages: 'All documentation pages are searched.',
    yoursNone: 'None. Anything you add is sent with your question, never as part of the instruction above.',
  },
  composer: {
    placeholder: 'Ask about {product}',
    placeholderNoProduct: 'Ask about the docs',
    send: 'Send question',
    stop: 'Stop generating',
    counter: '{n}/1000',
    hint: 'Type a question to send. Searching {scope}.',
    scopeAria: '{scope}. Change the pages searched',
  },
  quote: {
    // The selection popover's one action. Deliberately not `trigger.label`,
    // which reads the same and is configurable through `ui.fabLabel`: two
    // controls that happen to share two words are not one string.
    ask: 'Ask AI',
    // A visually-hidden prefix, so the chip is not announced as a bare fragment
    // of somebody else's sentence.
    label: 'Quoted from the answer:',
    drop: 'Remove the quote',
  },
  disclaimer: {
    base: 'AI-generated. Check the linked pages.',
    // Three, because two would be a lie under two of the four send modes. This
    // one is the truth when only down-votes are transmitted…
    withFeedback:
      'AI-generated. Check the linked pages. Not-helpful reports are sent to the docs team.',
    // …and this one when a thumb up travels too.
    withRating: 'AI-generated. Check the linked pages. Your rating is sent to the docs team.',
  },
  degraded: {
    lead: 'AI answers are off in this environment.',
    search: 'Search the docs',
  },
  scope: {
    all: 'All docs',
    nPages: '{n} {n, page|pages}',
  },
  trigger: {
    label: 'DocPilot',
    title: 'DocPilot ({hint})',
    // The words ON the floating button, where `label` is what a screen reader
    // hears. Two strings because they answer different questions: one names the
    // control, the other says what pressing it gets you. A project that wants
    // its own wording sets `ui.fabLabel` and skips this lookup entirely — see
    // ui-specs/005.
    fabLabel: 'Ask AI',
  },
  cta: {
    label: "Didn't find it? Ask DocPilot",
  },
  announce: {
    copied: 'Copied',
    questionCopied: 'Question copied',
    codeCopied: 'Code copied',
    threadCopied: 'Conversation copied',
    // Says what was destroyed, not just what was changed: the turns below the
    // edited one are gone, and a reader who cannot see the thread has no other
    // way to learn that.
    turnEdited: 'Question edited. Everything below it was removed.',
    retrying: 'Asking again. The previous answer was removed.',
    quoteAdded: 'Quote added to your question.',
    quoteRemoved: 'Quote removed.',
    scopeReset: 'Scope reset to all docs.',
    scope: 'Scope: {scope}.',
    instructionSaved: 'Instruction saved.',
    instructionRemoved: 'Instruction removed.',
    answerReady: 'Answer ready. {n} {n, source|sources}.',
    feedbackRecorded: 'Feedback recorded.',
    feedbackSent: 'Report sent.',
    conversationOpened: 'Opened {title}.',
    conversationDeleted: 'Conversation deleted.',
    historyCleared: 'All conversations deleted.',
  },
}

/** `{ en: {...}, ru: { reply: {...} }, … }` — assembled once, at module load. */
const SHIPPED = (() => {
  const out = { en: { ...UI_EN, reply: { credential: CREDENTIAL_COPY.en, social: SOCIAL_COPY.en } } }
  for (const locale of new Set([...Object.keys(CREDENTIAL_COPY), ...Object.keys(SOCIAL_COPY)])) {
    if (locale === 'en') continue
    out[locale] = {
      reply: {
        ...(CREDENTIAL_COPY[locale] ? { credential: CREDENTIAL_COPY[locale] } : {}),
        ...(SOCIAL_COPY[locale] ? { social: SOCIAL_COPY[locale] } : {}),
      },
    }
  }
  return out
})()

export const SHIPPED_LOCALES = Object.keys(SHIPPED)

/** Every leaf path an override may address. Anything else is a typo. */
export const KEY_PATHS = (() => {
  const out = new Set()
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object') walk(v, p)
      else out.add(p)
    }
  }
  walk(SHIPPED.en, '')
  return out
})()

const isReply = (path) => path === 'reply' || path.startsWith('reply.')

const at = (node, path) => {
  let cur = node
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

/**
 * `{name}` slots, plus a two-form plural written `{n, singular|plural}`.
 *
 * Two forms only, and deliberately so: this is a UI string table, not an ICU
 * runtime, and the four strings that count anything are all counting pages or
 * sources. A locale whose plural rules need more than two forms overrides the
 * whole sentence, which is what the override mechanism is for.
 */
export function interpolate(text, vars = {}) {
  if (typeof text !== 'string') return text
  return text
    .replace(/\{(\w+),\s*([^|{}]*)\|([^{}]*)\}/g, (m, key, one, many) => {
      const n = Number(vars[key])
      return Number.isFinite(n) && Math.abs(n) === 1 ? one : many
    })
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

/**
 * The resolved delta, memoised by object identity.
 *
 * Only the OVERRIDE is stored — the shipped tree is looked up separately, so a
 * project that overrides nothing pays for nothing.
 */
let memoKey = null
let memoValue = null

export function resolveI18n(i18n) {
  if (i18n === memoKey) return memoValue
  const src = i18n && typeof i18n === 'object' ? i18n : {}
  memoKey = i18n
  memoValue = {
    translations: src.translations && typeof src.translations === 'object' ? src.translations : {},
    locales: src.locales && typeof src.locales === 'object' ? src.locales : {},
  }
  return memoValue
}

/**
 * One string.
 *
 * @param {any} tree         the resolved override, from `resolveI18n`
 * @param {string} locale    the selector for THIS key — see the two-selector rule
 * @param {string} path      a dotted leaf path, e.g. `refusal.notFound`
 * @param {Record<string, any>} vars values for `{name}` slots
 * @param {string} uiLocale  the page's locale, used only for the reply fallback
 */
export function t(tree, locale, path, vars = {}, uiLocale = null) {
  const chain = [
    at(tree.locales?.[locale]?.translations, path),
    at(tree.translations, path),
    ...(isReply(path) && uiLocale && uiLocale !== locale
      ? [at(tree.locales?.[uiLocale]?.translations, path)]
      : []),
    at(SHIPPED[locale], path),
    at(SHIPPED.en, path),
  ]
  const hits = chain.filter((v) => v != null)
  if (!hits.length) return ''
  if (typeof hits[0] === 'string') return interpolate(hits[0], vars)

  /**
   * A BLOCK read, which `reply.credential` and `reply.social.<kind>` both are:
   * the panel wants all three strings at once.
   *
   * Merged across the whole chain rather than taken from the first hit, because
   * the first hit is usually PARTIAL — someone overrides `lead` and nothing
   * else. Returning that object alone would delete `body` and `invite`, which is
   * the exact "one override deletes its siblings" failure the per-leaf rule
   * exists to prevent, hiding inside the one code path that reads objects.
   * Applied lowest-priority first so the earliest hit still wins per leaf.
   */
  const merged = {}
  for (const h of hits.filter((v) => typeof v === 'object').reverse()) deepAssign(merged, h)
  return mapLeaves(merged, vars)
}

function deepAssign(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      into[k] = deepAssign(into[k] && typeof into[k] === 'object' ? into[k] : {}, v)
    } else {
      into[k] = v
    }
  }
  return into
}

const mapLeaves = (node, vars) =>
  Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      v && typeof v === 'object' ? mapLeaves(v, vars) : interpolate(v, vars),
    ]),
  )

/**
 * A page locale matched against what is actually configured.
 *
 * VitePress hands out things like `en-US` and `zh-CN`; the tree is keyed by bare
 * subtags. Exact match first, then the primary subtag, then `en` — never a throw
 * and never an empty panel because someone wrote `pt-BR`.
 */
export function normaliseLocale(lang, tree) {
  const l = String(lang || '').toLowerCase()
  if (!l) return 'en'
  const known = (k) => Boolean(tree?.locales?.[k]) || Boolean(SHIPPED[k])
  if (known(l)) return l
  const primary = l.split('-')[0]
  return known(primary) ? primary : 'en'
}

/**
 * Build-time validation: drop what cannot be a key and name every drop.
 *
 * Runs in Node with no Vue import, which is why this module holds no composable.
 * The discipline is `resolveSuggestions`'s: never throw over a typo in copy —
 * failing a docs build because someone misspelled `empty.headng` is out of
 * proportion — but never swallow it either.
 *
 * What it CANNOT check: whether `locales.ru` corresponds to a real VitePress
 * locale. `themeDocPilot` does not see the site's own `locales`, so an override for
 * a language the site does not publish validates cleanly and never renders.
 */
export function validateI18n(i18n, warn = console.warn) {
  const out = { translations: {}, locales: {} }
  if (i18n == null) return out
  if (typeof i18n !== 'object' || Array.isArray(i18n)) {
    warn(`[docpilot] i18n must be an object with "translations" and/or "locales" — ignoring`)
    return out
  }

  let dropped = 0
  const copy = (src, into, where) => {
    const walk = (node, prefix) => {
      for (const [k, v] of Object.entries(node || {})) {
        const p = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          walk(v, p)
          continue
        }
        if (typeof v !== 'string') {
          warn(`[docpilot] i18n.${where}${p} is ${typeof v}, not a string — dropped`)
          dropped++
          continue
        }
        if (!KEY_PATHS.has(p)) {
          warn(`[docpilot] i18n.${where}${p} is not a key this panel has — dropped`)
          dropped++
          continue
        }
        let cur = into
        const parts = p.split('.')
        for (const part of parts.slice(0, -1)) cur = cur[part] ||= {}
        cur[parts.at(-1)] = v
      }
    }
    walk(src, '')
  }

  copy(i18n.translations, out.translations, 'translations.')
  for (const [locale, block] of Object.entries(i18n.locales || {})) {
    const into = (out.locales[locale] = { translations: {} })
    copy(block?.translations, into.translations, `locales.${locale}.translations.`)
  }
  out.dropped = dropped
  return out
}

/** One line for the startup block — what was configured, and what was ignored. */
export function summariseI18n(validated) {
  const locales = Object.keys(validated.locales || {})
  const root = Object.keys(validated.translations || {}).length
  if (!locales.length && !root) return null
  return (
    `${root ? 'root' : 'no root'} + ${locales.length} locale${locales.length === 1 ? '' : 's'}` +
    (locales.length ? ` (${locales.join(', ')})` : '') +
    (validated.dropped ? ` · ${validated.dropped} unknown key${validated.dropped === 1 ? '' : 's'} ignored` : '')
  )
}
