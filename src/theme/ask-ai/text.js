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
 * Content terms.
 *
 * `.`, `#`, `/` and `-` are kept INSIDE tokens so that `Plugin.init` and
 * `/getting-started#roles` survive, and trimmed at the EDGES because prose ends
 * sentences constantly: without the trim, chunk text yields `editor.` while a
 * query yields `editor`, and the intersection misses on precisely the domain
 * nouns that dominate the query.
 */
export function terms(s) {
  return norm(s)
    .replace(/[^\p{L}\p{N}_$.#/-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[.#/-]+|[.#/-]+$/g, ''))
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

/** Estimated token count. chars / 3.6 fits English technical prose closely enough to chunk by. */
export function estTokens(s) {
  return Math.round(s.length / 3.6)
}
