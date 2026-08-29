/**
 * `npx docpilot vocabulary` — the documentation's own names, and the ones
 * readers use instead.
 *
 * THE PROBLEM IT EXISTS FOR. A plugin that is also an assistant, a chat and a
 * widget has four names before anybody translates one, and the lexical channel
 * knows only the one the docs happened to use. A reader who types `виджет`
 * against a corpus that says `DocPilot` shares no token with it, so lexical
 * coverage L is 0 — and where there is no dense channel that is the whole score,
 * so the gate refuses a question ABOUT THE PRODUCT before any model is asked.
 *
 * IT PROPOSES AND NEVER DECIDES. The output is a file the author commits and
 * edits, on the same terms as the golden set: which words a reader is likely to
 * type is a judgement about somebody's product, and a model's guess at it is a
 * draft. `docpilot index` reads the file; `vocabulary` in the config file
 * overrides it per term. Nothing here writes into the index.
 *
 * IT RUNS BEFORE THE FIRST INDEX EXISTS, which is why it reads MARKDOWN rather
 * than chunks. Headings and titles are where a corpus states its own vocabulary
 * anyway — the prose around them is the same nouns with sentences attached — so
 * the cheaper input is also the better one.
 *
 * RE-RUNNING MERGES. A second run must not silently discard a hand-edited alias
 * list, so an existing term keeps what the file says unless `--replace` is
 * passed.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { chat } from '../theme/docpilot/llm.js'
import { setVocabulary, vocabularyHash } from '../theme/docpilot/text.js'
import { nodeChatTarget, assertVocabulary } from '../config.js'

/**
 * The reply shape, as a STRICT JSON schema — an array of pairs rather than the
 * map it becomes.
 *
 * A map is what the config file holds and what `terms()` reads, and it cannot be
 * expressed strictly: its keys are the data. Every adapter that enforces a
 * schema at all enforces the strict dialect, so the wire shape is the one that
 * can be enforced and `toMap` below is the two lines that reconcile them.
 */
export const VOCABULARY_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
        },
        required: ['canonical', 'aliases'],
        additionalProperties: false,
      },
    },
  },
  required: ['terms'],
  additionalProperties: false,
}

/** How many headings the model is shown. Enough to see the product, not the corpus. */
export const HEADING_CAP = 400

/** How many terms it is asked for. The system block that ships them is capped at 24. */
export const DEFAULT_LIMIT = 24

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const TITLE = /^title:\s*(?:"([^"]*)"|'([^']*)'|(.*))\s*$/m

/**
 * Every markdown heading and frontmatter title under a root.
 *
 * Deliberately not the chunker: this runs before the first index exists, and a
 * heading is a heading whether or not anything has decided where a chunk ends.
 */
export function harvestHeadings(root, { cap = HEADING_CAP } = {}) {
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  const push = (s) => {
    const t = String(s || '')
      .replace(/\{#[^}]*\}\s*$/, '')
      .replace(/[`*_]/g, '')
      .trim()
    if (!t || t.length > 120 || seen.has(t.toLowerCase())) return
    seen.add(t.toLowerCase())
    out.push(t)
  }
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= cap) return
      const full = path.join(dir, e.name)
      // `.vitepress` holds the config and the theme, not the corpus; `public` is
      // assets, and `node_modules` under a docs root is somebody's mistake this
      // command does not need to walk to report.
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'public' || e.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!e.name.endsWith('.md')) continue
      let src = ''
      try {
        src = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const fm = FRONTMATTER.exec(src)
      if (fm) {
        const t = TITLE.exec(fm[1])
        if (t) push(t[1] ?? t[2] ?? t[3])
      }
      for (const line of src.split('\n')) {
        const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
        if (h) push(h[2])
        if (out.length >= cap) break
      }
    }
  }
  walk(root)
  return out
}

/**
 * The pairs the model returns, as the map the config file and `terms()` speak.
 *
 * A REPEATED CANONICAL IS A UNION, not a replacement. Nothing in the schema
 * stops a model listing one term twice, and the obvious `map[c] = aliases`
 * silently kept only the last row — which on a real reply is the shorter one,
 * because a model that repeats a term is elaborating rather than restating. The
 * failure had exactly the shape this whole feature is against: aliases that were
 * proposed, accepted, and then gone with nothing saying so.
 */
export function toMap(terms) {
  /** @type {Record<string, string[]>} */
  const map = {}
  for (const row of Array.isArray(terms) ? terms : []) {
    const canonical = typeof row?.canonical === 'string' ? row.canonical.trim() : ''
    if (!canonical) continue
    const aliases = (Array.isArray(row.aliases) ? row.aliases : [])
      .filter((a) => typeof a === 'string' && a.trim())
      .map((a) => a.trim())
    // Case-insensitively unique, first spelling wins — `Widget` and `widget` are
    // one alias to `terms()`, which lowercases before it does anything else.
    const seen = new Map((map[canonical] || []).map((a) => [a.toLowerCase(), a]))
    for (const a of aliases) {
      const key = a.toLowerCase()
      if (key === canonical.toLowerCase() || seen.has(key)) continue
      seen.set(key, a)
    }
    if (!seen.size) continue
    map[canonical] = [...seen.values()]
  }
  return map
}

/**
 * Everything a canonical term claims, from every term, so one alias cannot be
 * claimed twice and no alias can also be a canonical.
 *
 * `setVocabulary` drops both silently — it cannot afford to throw in a reader's
 * browser — so they are resolved HERE, where dropping one is a line of output
 * rather than a mystery.
 */
export function dedupe(map, { warn = () => {} } = {}) {
  const canonicals = new Set(Object.keys(map).map((k) => k.toLowerCase()))
  const claimed = new Set()
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const [canonical, aliases] of Object.entries(map)) {
    const kept = []
    for (const alias of aliases) {
      const key = alias.toLowerCase()
      if (canonicals.has(key)) {
        warn(`dropped "${alias}" under "${canonical}" — it is a term of its own`)
        continue
      }
      if (claimed.has(key)) {
        warn(`dropped "${alias}" under "${canonical}" — already claimed by another term`)
        continue
      }
      claimed.add(key)
      kept.push(alias)
    }
    if (kept.length) out[canonical] = kept
  }
  return out
}

const SYSTEM = `You map a documentation site's own vocabulary onto the words its readers actually type.

You are given the product's name and every heading in the corpus. Return the terms a reader is most likely to ask about under a DIFFERENT name from the one the documentation uses.

- "canonical" is ONE TERM the documentation uses — a noun, a product name or a config key, spelled exactly as the headings spell it. Never a heading, never a phrase, never a sentence: "The panel" is the term "panel"; "The constraint is requests, not tokens" is not a term at all.
- "aliases" are the words READERS use instead: informal names, category words, and translations into every language named below. Give the translations even when you also give an English alias — a reader asking in another language is the case this is for.
- A product that is a plugin, a widget, an assistant and a chat has all four as aliases of its name, in each of those languages.
- Do not translate identifiers. A config key, a function name and a file path are the same in every language and belong in no alias list — for those, the aliases are the everyday words a reader would use instead of the key.
- Never list a word that is itself a canonical term in your answer, and never list one alias under two terms.
- Never list a word so general it appears in unrelated questions: "page", "error", "how", "settings" match everything and are worth nothing.
- Prefer few, load-bearing terms over many weak ones.`

/**
 * How many times a reply that would not parse is asked for again.
 *
 * `chat()` rotates past a bad shape when there is another candidate to rotate
 * to; here there is usually one model and often a local one, so there is not.
 * A small model answers this prompt correctly most of the time and not every
 * time — measured against `qwen3:8b`, which parsed on one run and not the next
 * with nothing changed but the language list. One retry turns that from a
 * failed command into a slower one.
 */
export const ATTEMPTS = 2

/** The one call. Returns the proposed map, or throws whatever the transport threw. */
export async function proposeVocabulary({ target, product, headings, languages, limit, signal, attempts = ATTEMPTS, onRetry = null }) {
  const user =
    `Product: ${product || '(not named — infer it from the headings)'}\n` +
    `Languages readers ask in: ${languages.join(', ')}\n` +
    `Return at most ${limit} terms.\n\n` +
    `Headings:\n${headings.map((h) => `- ${h}`).join('\n')}`

  let out = null
  let last = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (i) onRetry?.(last)
    out = await attempt()
    if (!out.parseError && out.toolCall) break
    last = out.parseError || 'no object'
  }
  if (out.parseError || !out.toolCall) {
    throw new Error(`the model did not answer in the requested shape (${last})`)
  }
  /**
   * THE LIMIT IS ENFORCED HERE, not merely asked for.
   *
   * It is in the prompt as well, and a small local model ignores it: `qwen3:8b`
   * answered a request for 12 terms with 20. A flag that describes what was
   * requested rather than what was written is a flag that does nothing, and the
   * number matters — this file becomes a system block on every lexical-only
   * turn.
   */
  return toMap((out.toolCall.args?.terms || []).slice(0, limit))

  async function attempt() {
    return chat({
    provider: target.provider,
    baseURL: target.baseURL,
    model: target.model,
    models: target.models,
    apiKey: target.apiKey,
    maxTokens: target.maxTokens,
    numCtx: target.numCtx,
    extraBody: target.extraBody,
    temperature: 0.2,
    tools: false,
    /**
     * THINKING OFF, explicitly.
     *
     * This is an extraction, not a decision: the answer is a list of words the
     * corpus already contains, and there is nothing for a model to reason its
     * way to. What reasoning does add is a `<think>` block in front of the JSON,
     * which on a local model is the difference between a parsed reply and
     * "could not read the response" — measured against `qwen3:8b`, which thinks
     * by default and failed every attempt until this line existed.
     */
    enableThink: false,
    schema: VOCABULARY_SCHEMA,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    signal,
    })
  }
}

const flag = (argv, name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const value = (argv, name, fallback = null) => {
  const f = flag(argv, name)
  if (!f) return fallback
  const eq = f.indexOf('=')
  return eq === -1 ? true : f.slice(eq + 1)
}

/**
 * @param {{docPilot: any, argv: string[], env: Record<string,string|undefined>, out?: string}} opts
 * @returns {Promise<number>} an exit code
 */
export async function runVocabulary({ docPilot, argv = [], env = {}, out = null }) {
  const say = (m) => console.log(m)
  const warn = (m) => console.error(`[docpilot] ${m}`)

  const { ROOT, DOCPILOT_DIR, VOCABULARY_OUT } = await import('../cli-context.js')
  const file = out || value(argv, 'out') || VOCABULARY_OUT
  const shown = path.relative(ROOT, file)
  const dry = Boolean(flag(argv, 'dry'))
  const replace = Boolean(flag(argv, 'replace'))
  const limit = Math.max(1, Number(value(argv, 'limit', DEFAULT_LIMIT)) || DEFAULT_LIMIT)

  /**
   * The languages to translate into.
   *
   * `i18n.locales` is what the site declared it serves, which is the best answer
   * available without asking. English is added because the corpus is usually in
   * it and a reader typing English informal names — "widget" for "DocPilot" — is
   * the case this command is most obviously for.
   */
  const declared = Object.keys(docPilot.i18n?.locales || {})
  const languages = String(value(argv, 'languages', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const langs = languages.length ? languages : [...new Set(['en', ...declared])]

  const target = nodeChatTarget(docPilot, env)
  if (target.searchOnly) {
    warn('chat is off (`chat: false`), so there is no model to propose a vocabulary.')
    warn('  Write `vocabulary` in the config file by hand, or turn chat back on for this run.')
    return 1
  }
  if (!target.model && !(target.models && target.models.length)) {
    warn(`no chat model resolved for "${target.id}" — see \`npx docpilot doctor\`.`)
    return 1
  }

  const docsDir = path.resolve(ROOT, docPilot.docsDir)
  const headings = harvestHeadings(docsDir)
  if (!headings.length) {
    warn(`no markdown headings under ${path.relative(ROOT, docsDir)} — nothing to read.`)
    return 1
  }

  say(`[docpilot] vocabulary`)
  say(`  corpus     ${path.relative(ROOT, docsDir)} — ${headings.length} heading(s)`)
  say(`  model      ${target.id} / ${target.model || '(pool)'}`)
  say(`  languages  ${langs.join(', ')}`)
  say('')

  let proposed
  try {
    proposed = await proposeVocabulary({
      target,
      product: docPilot.product,
      headings,
      languages: langs,
      limit,
      onRetry: (why) => say(`  the reply did not parse (${why}) — asking once more`),
    })
  } catch (e) {
    warn(`the model did not answer: ${e.message}`)
    return 1
  }

  // What the file already holds, kept unless `--replace` says otherwise: it has
  // been edited by hand and this command has no standing to undo that.
  let existing = {}
  if (fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      existing = (doc && typeof doc === 'object' && (doc.terms ?? doc)) || {}
    } catch (e) {
      warn(`${shown} is not readable JSON (${e.message}) — it will be replaced.`)
      existing = {}
    }
  }

  const merged = replace ? proposed : { ...proposed, ...existing }
  const clean = dedupe(merged, { warn: (m) => say(`  ${m}`) })
  assertVocabulary({ vocabulary: clean })

  const report = setVocabulary(clean)
  for (const s of report.skipped) say(`  skipped "${s.alias}" — ${s.why}`)

  const added = Object.keys(proposed).filter((k) => !(k in existing))
  const kept = Object.keys(existing).filter((k) => k in clean)
  say('')
  for (const [canonical, aliases] of Object.entries(clean)) {
    const mark = added.includes(canonical) ? '+' : ' '
    say(`  ${mark} ${canonical} — ${aliases.join(', ')}`)
  }
  say('')
  say(
    `  ${report.terms} term(s), ${report.aliases} alias(es) — ` +
      `${added.length} new, ${kept.length} kept from ${shown} — hash ${vocabularyHash()}`,
  )

  if (dry) {
    say('')
    say('  --dry: nothing written.')
    return 0
  }

  fs.mkdirSync(DOCPILOT_DIR, { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify({ version: 1, terms: clean }, null, 2)}\n`,
  )
  say(`  written to ${shown}`)
  say('')
  /**
   * THE LOOP, PRINTED, because nothing downstream can work it out.
   *
   * Every lexical score moves when this map does, and the index hash is over
   * chunk text — it cannot see a tokenizer change. `index` stamps `vocabHash`
   * into the manifest and `guardFor` compares it, so the stale guard IS reported
   * — but only after the next build, and only to whoever reads that build's
   * output. Saying it here is saying it to the person who just caused it.
   */
  say('  This map changes what every lexical score means, so the thresholds')
  say('  measured against the old one no longer apply:')
  say('')
  say('    npx docpilot index && npx docpilot calibrate --refresh && npx docpilot index')
  say('')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { settings } = await import('../cli-context.js')
  const { resolveDocPilot } = await import('../config.js')
  let env = process.env
  try {
    const { loadEnv } = await import('vitepress')
    env = { ...process.env, ...loadEnv('', process.cwd(), '') }
  } catch {
    /* vitepress is a peer dependency; a project without it gets the shell alone */
  }
  process.exit(await runVocabulary({ docPilot: resolveDocPilot(settings, env), argv: process.argv.slice(2), env }))
}
