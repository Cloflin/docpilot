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
const surfaceTokens = (s) =>
  norm(s)
    .replace(/[^\p{L}\p{N}_$.#/-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[.#/-]+|[.#/-]+$/g, ''))
    .filter(Boolean)

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
export const vocabularyHash = () => (VOCAB ? VOCAB.hash : null)

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
  return applyPhrases(surfaceTokens(s))
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .map(stemLite)
    .flatMap((t) => (VOCAB && VOCAB.tokens.get(t)) || [t])
    .filter((t) => t.length >= 2)
}

/** Estimated token count. chars / 3.6 fits English technical prose closely enough to chunk by. */
export function estTokens(s) {
  return Math.round(s.length / 3.6)
}
