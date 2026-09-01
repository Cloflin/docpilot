/**
 * Shared text normalisation and tokenisation.
 *
 * Single source of truth for the build (scripts/) and the runtime (theme/):
 * the evidence gate's lexical coverage L and the df.json shipped with the index
 * MUST be produced by the identical tokenizer, or the gate measures itself
 * against a vocabulary it cannot reproduce. RAG-SPEC 3.4.3.
 */

/**
 * Function words for English, Russian and Ukrainian.
 *
 * Language independence is achieved by union, never by detection: the product
 * is asked questions in at least three languages and a detector would be one
 * more thing that can be wrong before the gate has even run.
 */
export const STOP = new Set([
  // English
  'a', 'об', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'each', 'for', 'from',
  'get', 'give', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'like', 'make', 'may', 'me',
  'more', 'most', 'much', 'must', 'my', 'need', 'no', 'not', 'now', 'of', 'on',
  'once', 'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'please',
  'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'up', 'use', 'used', 'using', 'very', 'want', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
  // Russian
  'без', 'бы', 'был', 'была', 'были', 'было', 'быть', 'в', 'вам', 'вас', 'весь',
  'во', 'вот', 'все', 'всех', 'вы', 'где', 'да', 'для', 'до', 'его', 'ее', 'если',
  'есть', 'еще', 'же', 'за', 'здесь', 'и', 'из', 'или', 'им', 'их', 'к', 'как',
  'какой', 'когда', 'кто', 'ли', 'меня', 'мне', 'много', 'мой', 'мы', 'на', 'над',
  'надо', 'наш', 'не', 'него', 'нее', 'нет', 'ни', 'них', 'но', 'ну', 'о', 'об',
  'один', 'она', 'они', 'оно', 'от', 'по', 'под', 'после', 'при', 'про', 'с',
  'свой', 'себя', 'так', 'также', 'там', 'те', 'тем', 'то', 'тоже', 'только',
  'том', 'ты', 'у', 'уже', 'чем', 'что', 'чтобы', 'эта', 'эти', 'это', 'этот', 'я',
  // Ukrainian
  'але', 'був', 'була', 'було', 'бути', 'вже', 'він', 'вона', 'вони', 'все',
  'да', 'для', 'до', 'з', 'за', 'із', 'коли', 'ми', 'на', 'наш', 'не', 'ні',
  'один', 'от', 'при', 'та', 'так', 'також', 'ти', 'тільки', 'у', 'це', 'цей',
  'що', 'щоб', 'як', 'який',
])

/**
 * NFKC + removal of format characters (Cf), then lowercase.
 *
 * This is the defence against zero-width and format-character evasion. It does
 * NOT fold homoglyphs — Cyrillic "о" (U+043E) survives NFKC unchanged. At
 * runtime that direction is harmless (a homoglyph query simply fails to match,
 * i.e. more refusal, never less); at build time it is caught by the injection
 * lint's mixed-script rule.
 */
export function norm(s) {
  return String(s).normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase()
}

/**
 * `norm`, plus collapsed whitespace and no trailing punctuation.
 *
 * The KEY a question is looked up by, wherever two typings of the same question
 * have to land on one thing: the feedback aggregator groups readers' questions
 * with it, the indexer stamps `qnorm` on a baked opener with it, and the panel
 * matches against that stamp with it. It lived in `feedback/aggregate.js` and
 * moved here when the second caller appeared — three copies of a key function is
 * how two of them silently stop agreeing.
 *
 * NOT `terms()` below: that stems, and stemming would merge "rotating keys" with
 * "rotate key" — a distinction the corpus itself makes, and the question a
 * reviewer reads back is the one that was typed.
 *
 * Built ON `norm` rather than beside it, which is the one behaviour change the
 * move carries: the feedback key now folds NFKC and drops format characters
 * before grouping. Two spellings of a question that differ only by a zero-width
 * joiner were two candidates and are now one, which is what a reviewer counting
 * "how many people asked this" meant in the first place.
 */
export function normalise(question) {
  return norm(question ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?!.,;:\s]+$/u, '')
}

/**
 * The fingerprint of a question list — the staleness guard for a baked bundle.
 *
 * DERIVED, never carried. `docpilot index` resolves the config and hashes the
 * openers it is about to bake; the panel resolves the same config and hashes it
 * again before trusting what was baked. A bundle whose `configHash` disagrees
 * was baked for questions that are no longer configured, so the panel ignores it
 * and the turn runs the way it ran before this feature existed.
 *
 * The alternative — computing it once in Node and shipping it beside the
 * questions — puts the answer in two places and makes the config resolver
 * non-idempotent, which rule 11a forbids. Derived from `questions`, there is no
 * second place to forget.
 *
 * IT LIVES HERE because both readers are here: `switches.js` states that it
 * takes no imports and none may be added, and this module is already the one
 * thing the build and the runtime share by design.
 *
 * FNV-1a in two lanes, not sha256: `node:crypto` does not exist in a browser and
 * `crypto.subtle` is async, and this runs in both, synchronously. A fingerprint
 * is the whole job — it separates two lists and defends nothing. The second lane
 * folds from the far end so that reordering the same strings moves the value,
 * which matters because the panel shows the first `SUGGESTION_LIMIT` and the
 * bake bakes the same ones.
 *
 * Hashes the NORMALISED question, because that is the key an entry is looked up
 * by: an edit `normalise` erases — a doubled space, a trailing question mark —
 * correctly leaves a bundle that still matches valid.
 */
export function questionsHash(questions) {
  let a = 0x811c9dc5
  let b = 0x811c9dc5
  const text = (questions || []).map((q) => normalise(q)).join('\u0000')
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0
    b = Math.imul(b ^ text.charCodeAt(text.length - 1 - i), 0x01000193) >>> 0
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12)
}

/**
 * SUFFIX STRIPPING, and the narrowest version of it that pays for itself.
 *
 * The lexical channel matched surface forms and nothing else, which is a
 * different quality of failure in a language with cases than in one without.
 * `конфигурации` and `конфигурацию` are the same word to every reader who types
 * one of them and two unrelated tokens to BM25; the only thing standing between
 * them was `fuzzy: 0.2` at weight 0.45, which is an edit-distance accident rather
 * than a rule and misses as often as it lands. English pays a smaller version of
 * the same bill on plurals. The cost matters most exactly where there is nothing
 * to fall back on: with no embedder there is no dense channel to find the
 * document the inflection hid.
 *
 * A SUFFIX LIST, NOT A STEMMER. No Porter, no Snowball, no morphology: one pass,
 * longest match, minimum stem length, never recursive. Real stemmers earn their
 * complexity on prose corpora; this one runs over technical documentation whose
 * load-bearing tokens are identifiers, and the failure mode of an aggressive
 * stemmer there is conflating two API names.
 *
 * THREE GUARDS, and each closes a way this could do harm:
 *
 *   · ANYTHING THAT LOOKS LIKE AN IDENTIFIER IS RETURNED UNTOUCHED — a token
 *     carrying a digit, `.`, `/`, `#`, `_`, `$` or `-`. `plugin.init`, `v2`,
 *     `/getting-started`, `max_tokens` are names, and a name with its tail
 *     removed is a different name. This also means the compound tokens
 *     `indexTokens` emits pass through as they are; only the WORD parts it
 *     splits out are stemmed, which is what keeps the two sides symmetric.
 *   · SHORT TOKENS ARE LEFT ALONE. Under five characters there is not enough
 *     word left to be confident the tail is inflection rather than the stem.
 *   · A STRIP THAT WOULD LEAVE LESS THAN THREE CHARACTERS DOES NOT HAPPEN.
 *
 * SYMMETRY IS THE WHOLE SAFETY ARGUMENT. This runs inside `terms()`, which is
 * the single tokenizer for `df.json`, the gate's L, `admissible()` and
 * MiniSearch's query side — so index and query are stemmed by the same code by
 * construction, and a symmetric strip can only ever ADD matches. It cannot
 * silently lose a document; it can only conflate two, which is what the guards
 * above bound and what a sweep measures.
 *
 * WHAT IT OWES. Ranking feeds `lexIds`, `lexIds` feeds L, and L is half of G —
 * so this changes the gate's input distribution and `tau` was calibrated against
 * the old one. RAG-SPEC 5.6 wants a recalibration pass, and nothing in the build
 * can detect that it is due: `guardFor` compares the index hash, and the index
 * hash is over chunk TEXT, which this does not touch. It is process, not
 * machinery — `npx docpilot index && npx docpilot calibrate --refresh && npx
 * docpilot index`.
 *
 * The lists themselves are the part to sweep, not to argue about. They are
 * inflectional endings only — nothing derivational, so `-ство`, `-ность`,
 * `-tion` and `-ment` are deliberately absent: those change what a word IS, and
 * conflating `configure` with `configuration` is the conflation this corpus can
 * least afford.
 */
const RU_SUFFIXES = [
  // Longest first: the list is scanned in order and the first match wins, so
  // `-ями` has to be seen before `-ми` and `-ах` before `-х`.
  'иями', 'ями', 'ами', 'иях', 'ях', 'ах', 'ов', 'ев', 'ів', 'ей',
  'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ых', 'их', 'ую', 'юю', 'ая', 'яя',
  'ое', 'ее', 'ый', 'ий', 'ій', 'ой', 'ем', 'ом', 'ам', 'ям',
  'ть', 'ся',
  'а', 'я', 'ы', 'и', 'і', 'у', 'ю', 'е', 'є', 'о', 'ь', 'й',
]
const CYRILLIC = /[Ѐ-ӿ]/
const VOWELS = 'аеиоуыэюяієї'
/** One strip, or the token back unchanged. */
const stripRu = (t) => {
  for (const suf of RU_SUFFIXES) {
    if (t.length - suf.length >= 3 && t.endsWith(suf)) return t.slice(0, -suf.length)
  }
  return t
}

export function stemLite(t) {
  // An identifier, a route, a version — a NAME. Never touched.
  if (t.length < 5 || /[\d./#_$-]/.test(t)) return t

  if (CYRILLIC.test(t)) {
    /**
     * REPEATED, up to three times, and the repetition is what makes families
     * meet rather than merely move.
     *
     * Russian endings stack: `моделью` is `модель` plus `ю`, so one strip leaves
     * `модель` — one step behind the `модел` that `модели` reaches, and the two
     * forms of one word still miss each other. `конфигураций` is the same shape
     * through `й`. Iterating also makes the function IDEMPOTENT, which a single
     * pass was not, and non-idempotence in a tokenizer is the kind of thing that
     * is fine until something applies it twice.
     *
     * Bounded at three, and every strip still has to leave three characters, so
     * the walk cannot eat a word.
     */
    let out = t
    for (let i = 0; i < 3; i++) {
      const next = stripRu(out)
      if (next === out) break
      out = next
    }
    /**
     * A doubled final consonant, collapsed — the residue of a stripped verbal
     * noun. `налаштування` reduces to `налаштуванн` while `налаштувань`
     * reduces to `налаштуван`, and the two are the same word. Consonants only:
     * a doubled vowel is not this pattern.
     */
    if (out.length > 3 && out.at(-1) === out.at(-2) && !VOWELS.includes(out.at(-1))) {
      out = out.slice(0, -1)
    }
    return out
  }

  /**
   * English, and PLURALS ONLY.
   *
   * `-ing` and `-ed` were built, measured and dropped. They do not do the job
   * they look like they do: the base form keeps its `e`, so `configured` reduces
   * to `configur` while `configure` stays as it is — a third token rather than a
   * shared one — and `running` reaches `runn`, which `run` never does. What they
   * did reliably was collide, on exactly the pairs this corpus cannot afford:
   * `index` with `indexing` and `bill` with `billing`, which are an artefact and
   * a process, and both are things this documentation is about. A rule that
   * misses the unification it was added for and lands the conflation it was
   * warned about is not a close call.
   *
   * Plurals unify cleanly, because the singular IS the stem.
   */
  if (t.endsWith('sses')) return t.slice(0, -2)
  if (t.endsWith('ies') && t.length >= 5) return `${t.slice(0, -3)}y`
  // `indexes`, `patches`, `classes` — the `-es` that follows a sibilant. Without
  // it, stripping the bare `s` leaves `indexe`, which no singular reaches.
  if (/(x|ch|sh|z|s)es$/.test(t)) return t.slice(0, -2)
  if (t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1)
  return t
}

/**
 * Surface tokens — the split, before stop words and before stemming.
 *
 * `.`, `#`, `/` and `-` are kept INSIDE tokens so that `Plugin.init` and
 * `/getting-started#roles` survive, and trimmed at the EDGES because prose ends
 * sentences constantly: without the trim, chunk text yields `editor.` while a
 * query yields `editor`, and the intersection misses on precisely the domain
 * nouns that dominate the query.
 *
 * Split out because the vocabulary below has to see this stream twice — once to
 * compile a declared phrase into it, once to match one in it — and a second copy
 * of the character class is a second thing to keep in step.
 */
const rawTokens = (s) =>
  String(s)
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\p{L}\p{N}_$.#/-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[.#/-]+|[.#/-]+$/g, ''))
    .filter(Boolean)

const surfaceTokens = (s) => rawTokens(s).map((t) => t.toLowerCase())

/**
 * ── IDENTIFIER PARTS ─────────────────────────────────────────────────────────
 *
 * `docPilot.sources.allow` is ONE token, and a reader who types "sources allow"
 * finds nothing. `getUserName` is one token, and "user name" finds nothing. In
 * technical documentation the identifier is the most common thing a reader
 * searches for and the least likely thing they spell exactly the way the code
 * does.
 *
 * So a token that LOOKS like an identifier also contributes its parts. The whole
 * token is kept — an exact query must not lose weight to its own fragments —
 * and the parts are appended, which is why order does not matter here: every
 * consumer of `terms()` treats the result as a bag.
 *
 * WHAT COUNTS AS AN IDENTIFIER is deliberately narrow, because a false positive
 * costs precision on every page. A token qualifies only if it carries a
 * separator INSIDE it, or an internal capital — `built-in` and `getUserName`
 * qualify, `documentation` does not, and a sentence of ordinary prose
 * contributes nothing.
 *
 * THIS IS WHY `rawTokens` EXISTS. The camel boundary is a case boundary, and
 * `norm` lowercases; by the time `surfaceTokens` has run, `getUserName` is
 * `getusername` and the boundary is gone. Both functions are the same scanner
 * called twice rather than two scanners — the distinction this file's header
 * insists on, and the one the gate depends on.
 *
 * OFF BY DEFAULT. It moves every lexical score, every `df.json` entry and the
 * gate's lexical coverage L, so it is a build-time decision stamped into the
 * manifest and folded into `vocabularyHash` — which means an index built with it
 * and a calibration measured without it disagree, loudly, through the guard that
 * already exists.
 */
const HAS_SEPARATOR = /[._/-]/
const HAS_INNER_CAPITAL = /\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/u

const splitCamel = (t) =>
  t
    // No lookbehind: it is still the newest thing in this expression's syntax and
    // the two-group form says the same thing everywhere.
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(' ')

/**
 * The parts of every identifier-shaped token in `s`, lowercased.
 *
 * A part equal to the whole token is dropped: `foo-` trimmed to `foo` has one
 * part and it is itself, and emitting it would double that token's term
 * frequency for no reason.
 */
export function identifierParts(s) {
  const out = []
  for (const t of rawTokens(s)) {
    if (!HAS_SEPARATOR.test(t) && !HAS_INNER_CAPITAL.test(t)) continue
    const whole = t.toLowerCase()
    for (const chunk of t.split(/[._/-]+/)) {
      if (!chunk) continue
      for (const part of splitCamel(chunk)) {
        const p = part.toLowerCase()
        if (p && p !== whole) out.push(p)
      }
    }
  }
  return out
}

/**
 * ── THE VOCABULARY ───────────────────────────────────────────────────────────
 *
 * THE READER NAMES THE PRODUCT; THE DOCUMENTATION NAMES IT TOO, AND THE TWO ARE
 * RARELY THE SAME WORD. A plugin that is also an assistant, a chat and a widget
 * has four names before anybody translates one, and the lexical channel knows
 * only the one the docs happened to use. `L = 0` follows, and the gate then
 * refuses a question about the product BEFORE any model is asked — which is the
 * failure `session.js` already names in a comment and this map is the answer to.
 *
 * IT REWRITES, IT NEVER ADDS. What Q sees is the question with the reader's word
 * replaced by the documentation's, exactly as if they had typed the second one.
 * Nothing is removed either, which is what keeps `gate.js`'s sign intact: an
 * off-topic question padded with product nouns still carries every off-domain
 * term it came with, so L cannot saturate on a rewrite.
 *
 * TWO PASSES, ONE MAP, and the split is inflection:
 *
 *   · the PHRASE pass runs over the surface stream, longest match at each
 *     position, so a declared `ии чат` becomes the canonical before anything is
 *     stemmed and a multi-word name is reachable at all;
 *   · the TOKEN pass runs after stemming, so `виджеты` and `виджета` reach the
 *     same canonical as the `виджет` the phrase pass already took.
 *
 * SYMMETRY IS AGAIN THE SAFETY ARGUMENT, and it is the reason this is module
 * state rather than a parameter: `terms()` is called from `df.json`'s build,
 * from MiniSearch's tokenizer and from the gate, and a call site that missed the
 * argument would index one vocabulary and query another. Install it once, before
 * anything tokenises — `assembleIndex` in the browser, the indexer in the build.
 *
 * WHAT IT OWES, in the same words `stemLite` owes it: this changes the gate's
 * input distribution and `tau` was calibrated against the old one. The index
 * hash is over chunk TEXT and does not move, so `vocabularyHash()` goes into the
 * manifest beside it and `guardFor` reads that instead.
 *
 * @type {{
 *   terms: Record<string, string[]>,
 *   phrases: Map<string, string[]>,
 *   tokens: Map<string, string[]>,
 *   maxPhrase: number,
 *   signature: string,
 *   hash: string,
 * } | null}
 */
let VOCAB = null

/** FNV-1a, 32-bit. Shared with `promptHash`, which hashes different text with it. */
export function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Whether `terms()` also emits the parts of an identifier.
 *
 * A BUILD-TIME DECISION, carried in the manifest, exactly like the vocabulary
 * above it and for the identical reason: `df.json` is produced by this tokenizer
 * and the gate scores against that `df.json`, so a browser tokenizing one way
 * against an index built the other measures itself against a vocabulary it
 * cannot reproduce. RAG-SPEC 3.4.3.
 */
let SPLIT_IDENTIFIERS = false

/**
 * Install the tokenizer's build-time configuration, or clear it with `null`.
 *
 * Absent on every index built before the key existed, which reads as off — the
 * behaviour those indexes were built with.
 *
 * @param {{ splitIdentifiers?: boolean }|null|undefined} cfg
 */
export function setTokenizer(cfg) {
  SPLIT_IDENTIFIERS = !!cfg?.splitIdentifiers
}

/** The tokenizer's configuration, for the manifest that has to carry it back. */
export const tokenizerConfig = () => ({ splitIdentifiers: SPLIT_IDENTIFIERS })

/** The stemmed content tokens of one declared string — the token pass's output. */
const stemmedTokens = (surface) =>
  surface.filter((t) => t.length >= 2 && !STOP.has(t)).map(stemLite).filter((t) => t.length >= 2)

/**
 * Install the map, or clear it with `null`.
 *
 * IT REPORTS AND NEVER THROWS. The browser reads this out of a manifest the
 * build already validated, and an exception here would take the panel down over
 * a bad line in somebody's vocabulary file. The build is where a rejected entry
 * is somebody's mistake to hear about, so the skipped list is returned rather
 * than swallowed — `assertVocabulary` in config.js is what raises it.
 *
 * @param {Record<string, string[]>|null|undefined} map
 * @returns {{terms: number, aliases: number, skipped: Array<{alias: string, why: string}>}}
 */
export function setVocabulary(map) {
  const report = { terms: 0, aliases: 0, skipped: [] }
  if (!map || typeof map !== 'object' || !Object.keys(map).length) {
    VOCAB = null
    return report
  }
  const phrases = new Map()
  const tokens = new Map()
  // A canonical may not also be an alias: the token pass would then rewrite what
  // the phrase pass just wrote and the map would have a cycle in it.
  const canonicalKeys = new Set()
  for (const canonical of Object.keys(map)) {
    const key = surfaceTokens(canonical).join(' ')
    if (key) canonicalKeys.add(key)
  }
  let maxPhrase = 0
  const parts = []
  for (const canonical of Object.keys(map).sort()) {
    const surface = surfaceTokens(canonical)
    const stemmed = stemmedTokens(surface)
    if (!surface.length || !stemmed.length) {
      report.skipped.push({ alias: canonical, why: 'the canonical term has no content tokens' })
      continue
    }
    const aliases = Array.isArray(map[canonical]) ? map[canonical] : []
    const kept = []
    for (const alias of aliases) {
      if (typeof alias !== 'string' || !alias.trim()) {
        report.skipped.push({ alias: String(alias), why: `not a string, under "${canonical}"` })
        continue
      }
      const a = surfaceTokens(alias)
      const phraseKey = a.join(' ')
      if (!phraseKey) {
        report.skipped.push({ alias, why: `no content tokens, under "${canonical}"` })
        continue
      }
      if (canonicalKeys.has(phraseKey)) {
        report.skipped.push({ alias, why: `it is also a canonical term, under "${canonical}"` })
        continue
      }
      if (phrases.has(phraseKey)) {
        report.skipped.push({ alias, why: `already claimed by another term, under "${canonical}"` })
        continue
      }
      phrases.set(phraseKey, surface)
      maxPhrase = Math.max(maxPhrase, a.length)
      if (a.length === 1) {
        const stem = stemLite(a[0])
        if (stem.length >= 2 && !tokens.has(stem)) tokens.set(stem, stemmed)
      }
      kept.push(phraseKey)
      report.aliases++
    }
    if (!kept.length) continue
    report.terms++
    parts.push(`${surface.join(' ')}=${kept.sort().join(',')}`)
  }
  if (!parts.length) {
    VOCAB = null
    return report
  }
  const signature = parts.join(';')
  VOCAB = { terms: map, phrases, tokens, maxPhrase, signature, hash: fnv1a32(signature) }
  return report
}

/** The declared pairs, for the block the model reads. Null when nothing is installed. */
export const vocabularyTerms = () => (VOCAB ? VOCAB.terms : null)

/**
 * A stable string over what is installed — sorted both ways, so two builds of
 * one map agree and a reordered file is not a change.
 */
export const vocabularySignature = () => (VOCAB ? VOCAB.signature : '')

/** Null when nothing is installed, so a manifest without a vocabulary carries no field. */
/**
 * THE IDENTITY OF THE TOKENIZER, not only of the vocabulary — and the name is
 * kept because the value it is compared against is `calibration.json`'s
 * `vocabHash`, a key consumers have committed.
 *
 * A calibration is a measurement of THIS tokenizer against THIS corpus. The
 * vocabulary was the only thing that could change it; identifier splitting is
 * the second, and it changes it far more. Folding the flag in here is what makes
 * `guardFor`'s existing stale-calibration warning fire on it, instead of a
 * second guard that would have to be remembered.
 */
export const vocabularyHash = () => {
  const v = VOCAB ? VOCAB.hash : null
  if (!SPLIT_IDENTIFIERS) return v
  return `${v || 'none'}+split`
}

/** Longest declared phrase first at each position, so `ии чат` beats `чат`. */
function applyPhrases(toks) {
  if (!VOCAB || !VOCAB.phrases.size) return toks
  const out = []
  for (let i = 0; i < toks.length; ) {
    let taken = 0
    for (let n = Math.min(VOCAB.maxPhrase, toks.length - i); n >= 1; n--) {
      const rep = VOCAB.phrases.get(toks.slice(i, i + n).join(' '))
      if (rep) {
        out.push(...rep)
        taken = n
        break
      }
    }
    if (!taken) out.push(toks[i])
    i += taken || 1
  }
  return out
}

/**
 * Content terms.
 *
 * STOP WORDS ARE FILTERED BEFORE STEMMING, on the surface form. The list is
 * hand-written in three languages and every entry in it is a word somebody
 * typed; matching it against a stem would mean maintaining a stemmed copy of it
 * and keeping the two in step. The length filter runs on both sides, because a
 * strip can take a token under the floor.
 *
 * The phrase pass runs BEFORE the stop filter on purpose: a name a reader writes
 * can hold a function word — `the panel`, `ии чат` — and filtering first would
 * take the phrase apart before it could be recognised.
 */
export function terms(s) {
  const base = applyPhrases(surfaceTokens(s))
  // Appended, never interleaved, and after the phrase pass: a declared phrase is
  // matched on the surface stream, and splitting an identifier inside it first
  // would take the phrase apart before it could be recognised.
  const all = SPLIT_IDENTIFIERS ? [...base, ...identifierParts(s)] : base
  return all
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .map(stemLite)
    .flatMap((t) => (VOCAB && VOCAB.tokens.get(t)) || [t])
    .filter((t) => t.length >= 2)
}

/** Estimated token count. chars / 3.6 fits English technical prose closely enough to chunk by. */
export function estTokens(s) {
  return Math.round(s.length / 3.6)
}
