/**
 * `docpilot traffic report` — what the turn log says to do next.
 *
 * PURE. `trafficStats` measures, `renderTrafficReport` writes markdown, and
 * `trafficReport` is the two together. The caller loads the index (df, pages,
 * chunk paths) and stamps the time.
 *
 * EVERY RAG SECTION ENDS IN A COMMAND. A table of failures with no next step is
 * a table somebody reads once. Each of the six sections below names the docpilot
 * command that acts on it — `index`, `calibrate`, `eval` or `vocabulary`.
 */

import {inline} from '../feedback/report.js'
import {clusterTurns, type Cluster, type DfDoc} from './cluster.js'
import {OUTCOMES, CONTENT_FAILURES, INFRA, failed, verdictOf, pageOfId, termList, type Turn, type Malformed} from './turns.js'

export interface ReportContext {
  df?: DfDoc | null
  /** `manifest.pages` — `[{path, title}]`, for the never-retrieved section. */
  pages?: Array<{path: string; title?: string}> | null
  /** chunk id → page path, from the shards. */
  paths?: Map<string, string> | null
  malformed?: Malformed[]
  duplicates?: number
  feedback?: {rows: number; joined: number; orphans: number} | null
  source?: string
  generatedAt?: string
  since?: string | null
  /** Rows per table. */
  limit?: number
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d
const share = (a: number, b: number) => (b ? round(a / b) : null)
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`)
// Reader text, one line, with markdown structure and control bytes escaped —
// the same rule `feedback-latest.md` uses (see `inline`).
const esc = (s: string) => inline(String(s ?? '').replace(/\s+/g, ' ').trim())

function tally<T>(rows: T[], key: (r: T) => string | null | undefined) {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = key(r)
    if (k == null) continue
    m.set(k, (m.get(k) || 0) + 1)
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

export function quantile(values: number[], q: number): number | null {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return null
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

const nums = (turns: Turn[], f: (t: Turn) => any) =>
  turns.map(f).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

/** Surface word for each stem, so the report shows what readers typed. */
function surfaceOf(questions: string[]) {
  const counts = new Map<string, Map<string, number>>()
  for (const q of questions) {
    for (const w of String(q).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) || []) {
      const st = termList(w)
      if (st.length !== 1) continue
      const m = counts.get(st[0]) || new Map()
      m.set(w, (m.get(w) || 0) + 1)
      counts.set(st[0], m)
    }
  }
  return (stem: string) => {
    const m = counts.get(stem)
    if (!m) return stem
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }
}

/** Question terms frequent in failed turns and absent from the index's df. */
export function vocabularyMisses(turns: Turn[], df: DfDoc | null, {minTurns = 2} = {}) {
  if (!df?.df) return null
  const bad = turns.filter(failed)
  const good = turns.filter((t) => t.outcome === 'answer' && verdictOf(t) !== 'down')
  const freq = new Map<string, {failed: number; ok: number; example: string}>()
  for (const t of bad) {
    for (const term of new Set(termList(t.question))) {
      if ((df.df[term] ?? 0) > 0) continue
      const e = freq.get(term) || {failed: 0, ok: 0, example: t.question}
      e.failed++
      freq.set(term, e)
    }
  }
  for (const t of good) for (const term of new Set(termList(t.question))) if (freq.has(term)) freq.get(term).ok++
  const surface = surfaceOf(bad.map((t) => t.question))
  return [...freq.entries()]
    .filter(([, e]) => e.failed >= minTurns)
    .map(([term, e]) => ({term, word: surface(term), failed: e.failed, answered: e.ok, example: e.example}))
    .sort((a, b) => b.failed - a.failed || a.term.localeCompare(b.term))
}

export function trafficStats(turns: Turn[], ctx: ReportContext = {}) {
  const limit = ctx.limit ?? 15
  const sorted = [...turns].sort((a, b) => a.at.localeCompare(b.at))
  const answered = turns.filter((t) => t.outcome === 'answer')
  const voted = turns.filter((t) => verdictOf(t))

  // Volume by day.
  const days = new Map<string, {turns: number; answer: number; failed: number}>()
  for (const t of sorted) {
    const d = t.at.slice(0, 10)
    const e = days.get(d) || {turns: 0, answer: 0, failed: 0}
    e.turns++
    if (t.outcome === 'answer') e.answer++
    if (failed(t)) e.failed++
    days.set(d, e)
  }

  // Answer quality.
  const support = nums(answered, (t) => t.support)
  const usage = turns.map((t) => t.usage || {})
  const promptTokens = usage.reduce((a, u) => a + (u.promptTokens || 0), 0)
  const quality = {
    answered: answered.length,
    zeroCitations: share(answered.filter((t) => !(t.citations || []).length).length, answered.length),
    tentative: share(answered.filter((t) => t.tentative === true).length, answered.length),
    support: support.length
      ? {
          n: support.length,
          p10: quantile(support, 0.1),
          p50: quantile(support, 0.5),
          p90: quantile(support, 0.9),
          below05: share(support.filter((s) => s < 0.5).length, support.length),
        }
      : null,
    confidence: tally(answered, (t) => (t.confidence == null ? null : String(t.confidence))),
    iterations: {p50: quantile(nums(answered, (t) => t.iterations), 0.5), max: quantile(nums(answered, (t) => t.iterations), 1)},
    requests: {p50: quantile(nums(turns, (t) => t.requests), 0.5), p95: quantile(nums(turns, (t) => t.requests), 0.95)},
    latencyMs: {p50: quantile(nums(turns, (t) => t.latencyMs), 0.5), p95: quantile(nums(turns, (t) => t.latencyMs), 0.95)},
    tokens: {
      prompt: promptTokens,
      output: usage.reduce((a, u) => a + (u.outputTokens || 0), 0),
      cached: usage.reduce((a, u) => a + (u.cachedTokens || 0), 0),
      cachedShare: share(usage.reduce((a, u) => a + (u.cachedTokens || 0), 0), promptTokens),
    },
  }

  // Feedback per outcome.
  const feedback = {
    voted: voted.length,
    up: voted.filter((t) => verdictOf(t) === 'up').length,
    down: voted.filter((t) => verdictOf(t) === 'down').length,
    byOutcome: OUTCOMES.map((o) => {
      const v = voted.filter((t) => t.outcome === o)
      const up = v.filter((t) => verdictOf(t) === 'up').length
      return {outcome: o, voted: v.length, up, down: v.length - up, downRate: share(v.length - up, v.length)}
    }).filter((r) => r.voted),
    reasons: tally(
      voted.flatMap((t) => (verdictOf(t) === 'down' ? t.feedback.reasons : [])),
      (r) => r,
    ),
  }

  // (1) Content gaps.
  const gaps: Cluster[] = clusterTurns(turns.filter(failed), {df: ctx.df, paths: ctx.paths})

  // (2) Vocabulary misses.
  const vocabulary = vocabularyMisses(turns, ctx.df ?? null)

  // (3) Retrieved but not cited — answered turns only: a refused turn cites nothing by construction.
  const pageRows = new Map<string, {retrieved: number; cited: number}>()
  for (const t of answered) {
    const r = new Set((t.retrievedIds || []).map((id) => pageOfId(id, ctx.paths)))
    const c = new Set((t.citations || []).map((id) => pageOfId(id, ctx.paths)))
    for (const p of r) {
      const e = pageRows.get(p) || {retrieved: 0, cited: 0}
      e.retrieved++
      if (c.has(p)) e.cited++
      pageRows.set(p, e)
    }
  }
  const uncited = [...pageRows.entries()]
    .map(([page, e]) => ({page, ...e, citedShare: share(e.cited, e.retrieved)}))
    .filter((r) => r.retrieved >= 3 && r.citedShare <= 0.2)
    .sort((a, b) => b.retrieved - a.retrieved || a.page.localeCompare(b.page))

  // (4) Never retrieved.
  const everRetrieved = new Set(turns.flatMap((t) => (t.retrievedIds || []).map((id) => pageOfId(id, ctx.paths))))
  const neverRetrieved = ctx.pages
    ? ctx.pages.filter((p) => !everRetrieved.has(p.path)).map((p) => ({page: p.path, title: p.title || ''}))
    : null

  // (5) Language.
  const langs = [...new Set(turns.map((t) => t.lang || 'unknown'))].map((lang) => {
    const ts = turns.filter((t) => (t.lang || 'unknown') === lang && !INFRA.includes(t.outcome))
    return {
      lang,
      turns: ts.length,
      failed: share(ts.filter(failed).length, ts.length),
      refused: share(ts.filter((t) => t.outcome === 'refused').length, ts.length),
    }
  }).sort((a, b) => b.turns - a.turns || a.lang.localeCompare(b.lang))

  // (6) Prompt / index / model drift. The MODEL is part of the key because a
  // deployment that swaps one local model for another changes the answers as
  // much as a prompt edit does, and the record names the model that answered.
  const drift = new Map<string, Turn[]>()
  for (const t of sorted) {
    const k = `${t.promptHash || '—'}\u0000${t.indexHash || '—'}\u0000${t.model || '—'}`
    drift.set(k, [...(drift.get(k) || []), t])
  }
  const driftRows = [...drift.entries()].map(([k, ts]) => {
    const [promptHash, indexHash, model] = k.split('\u0000')
    const v = ts.filter((t) => verdictOf(t))
    const lat = ts.map((t) => t.latencyMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
    const ans = ts.filter((t) => t.outcome === 'answer')
    return {
      promptHash,
      indexHash,
      model,
      latencyP50: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null,
      turns: ts.length,
      first: ts[0].at.slice(0, 10),
      last: ts[ts.length - 1].at.slice(0, 10),
      answer: share(ans.length, ts.length),
      refused: share(ts.filter((t) => CONTENT_FAILURES.includes(t.outcome)).length, ts.length),
      downRate: share(v.filter((t) => verdictOf(t) === 'down').length, v.length),
      zeroCitations: share(ans.filter((t) => !(t.citations || []).length).length, ans.length),
    }
  }).sort((a, b) => a.first.localeCompare(b.first))

  return {
    source: ctx.source ?? null,
    generatedAt: ctx.generatedAt ?? null,
    since: ctx.since ?? null,
    turns: turns.length,
    malformed: ctx.malformed?.length ?? 0,
    malformedSample: (ctx.malformed || []).slice(0, 5),
    duplicates: ctx.duplicates ?? 0,
    feedbackJoin: ctx.feedback ?? null,
    window: sorted.length ? {first: sorted[0].at, last: sorted[sorted.length - 1].at} : null,
    days: [...days.entries()].map(([day, e]) => ({day, ...e})),
    outcomes: tally(turns, (t) => t.outcome),
    refusals: tally(turns, (t) => t.refusal ?? null),
    langs: tally(turns, (t) => t.lang || 'unknown'),
    scopes: tally(turns, (t) => t.scope?.kind || 'all'),
    quality,
    feedback,
    gaps: gaps.slice(0, limit).map((c) => ({
      id: c.id,
      count: c.count,
      head: c.head,
      outcomes: tally(c.turns, (t) => (verdictOf(t) === 'down' ? `${t.outcome}/down` : t.outcome)),
      closest: c.closest,
      questions: [...new Set(c.turns.map((t) => t.question))].slice(0, 5),
    })),
    gapCount: gaps.length,
    vocabulary: vocabulary && vocabulary.slice(0, limit),
    uncited: uncited.slice(0, limit),
    neverRetrieved,
    languages: langs,
    drift: driftRows,
  }
}

export type TrafficStats = ReturnType<typeof trafficStats>

const kv = (o: Record<string, number>, total: number) =>
  Object.entries(o).map(([k, n]) => `| ${esc(k)} | ${n} | ${pct(share(n, total))} |`)

export function renderTrafficReport(s: TrafficStats): string {
  const out: string[] = ['# Traffic', '']
  out.push(
    `Source: \`${s.source ?? 'turn log'}\`${s.generatedAt ? ` · ${s.generatedAt}` : ''}` +
      (s.since ? ` · since ${s.since}` : ''),
    '',
    `${s.turns} turn(s)` +
      (s.window ? `, ${s.window.first.slice(0, 10)} → ${s.window.last.slice(0, 10)}` : '') +
      `. ${s.malformed} malformed row(s) skipped, ${s.duplicates} duplicate messageId(s) collapsed.`,
  )
  if (s.malformedSample.length) {
    out.push('', 'First malformed rows:', '', ...s.malformedSample.map((m) => `- line ${m.line ?? '?'}: ${m.why}`))
  }
  if (s.feedbackJoin) {
    out.push(
      '',
      `Feedback: ${s.feedbackJoin.rows} row(s), joined to ${s.feedbackJoin.joined} turn(s); ` +
        `${s.feedbackJoin.orphans} vote(s) name a messageId this log does not have (another window, or a browser-runtime turn).`,
    )
  }
  if (!s.turns) {
    out.push('', 'Nothing to report.', '')
    return out.join('\n')
  }

  out.push('', '## Volume by day', '', '| day | turns | answered | failed |', '|---|---:|---:|---:|')
  for (const d of s.days) out.push(`| ${d.day} | ${d.turns} | ${d.answer} | ${d.failed} |`)

  out.push('', '## Outcomes', '', '| outcome | turns | share |', '|---|---:|---:|', ...kv(s.outcomes, s.turns))
  if (Object.keys(s.refusals).length) {
    out.push('', '### Refusal causes', '', '| cause | turns | share |', '|---|---:|---:|', ...kv(s.refusals, s.turns))
  }
  out.push('', '### Languages', '', '| lang | turns | share |', '|---|---:|---:|', ...kv(s.langs, s.turns))
  out.push('', '### Scope', '', '| scope | turns | share |', '|---|---:|---:|', ...kv(s.scopes, s.turns))

  const q = s.quality
  out.push(
    '',
    '## Answer quality',
    '',
    `Of ${q.answered} answered turn(s):`,
    '',
    `- no citation at all: ${pct(q.zeroCitations)}`,
    `- tentative: ${pct(q.tentative)}`,
    `- support: ${
      q.support
        ? `p10 ${q.support.p10} · p50 ${q.support.p50} · p90 ${q.support.p90} · below 0.5 ${pct(q.support.below05)} (n=${q.support.n})`
        : 'not recorded'
    }`,
    `- confidence: ${Object.entries(q.confidence).map(([k, n]) => `${k} ${n}`).join(' · ') || 'not recorded'}`,
    `- iterations: p50 ${q.iterations.p50 ?? '—'} · max ${q.iterations.max ?? '—'}`,
    `- model requests per turn: p50 ${q.requests.p50 ?? '—'} · p95 ${q.requests.p95 ?? '—'}`,
    `- latency: p50 ${q.latencyMs.p50 ?? '—'} ms · p95 ${q.latencyMs.p95 ?? '—'} ms`,
    `- tokens: ${q.tokens.prompt} prompt · ${q.tokens.output} output · ${pct(q.tokens.cachedShare)} of prompt tokens cached`,
  )

  const f = s.feedback
  out.push('', '## Feedback', '')
  if (!f.voted) out.push('No turn in this window was voted on. Pass `--feedback` with your export to join votes.')
  else {
    out.push(
      `${f.voted} voted turn(s): ${f.up} up, ${f.down} down.`,
      '',
      '| outcome | voted | up | down | down rate |',
      '|---|---:|---:|---:|---:|',
      ...f.byOutcome.map((r) => `| ${r.outcome} | ${r.voted} | ${r.up} | ${r.down} | ${pct(r.downRate)} |`),
    )
    if (Object.keys(f.reasons).length) {
      out.push('', 'Top reasons on down votes: ' + Object.entries(f.reasons).map(([k, n]) => `${esc(k)} ${n}`).join(' · '))
    }
  }

  // ── RAG improvement ──
  out.push('', '## 1. Content gaps', '')
  if (!s.gaps.length) out.push('No refused, not-answerable or down-voted turn in this window.')
  else {
    out.push(
      `${s.gapCount} cluster(s) of refused, not-answerable or down-voted questions, largest first.`,
      '',
      '| cluster | turns | question | outcomes | closest pages retrieved |',
      '|---|---:|---|---|---|',
      ...s.gaps.map(
        (g) =>
          `| ${g.id} | ${g.count} | ${esc(g.head)} | ${Object.entries(g.outcomes).map(([k, n]) => `${k} ${n}`).join(', ')} | ` +
          `${g.closest.map((c) => `\`${c.page}\` (${c.count})`).join(', ') || 'nothing retrieved'} |`,
      ),
      '',
      '**Next:** write a page, or extend the closest one, for each cluster at the top. Then',
      '`npx docpilot index`, `npx docpilot traffic candidates` to turn these questions into',
      'golden candidates, and `npx docpilot eval` once a person has written their answers.',
    )
  }

  out.push('', '## 2. Vocabulary misses', '')
  if (!s.vocabulary) out.push('No index df was available, so absent terms cannot be told from present ones. Build the index (`npx docpilot index`) and run this again.')
  else if (!s.vocabulary.length) out.push('No term absent from the index appears in two or more failed turns.')
  else {
    out.push(
      'Words readers used in failed turns that the index has in no chunk at all. The lexical',
      'channel cannot match them, whatever the page says.',
      '',
      '| word | failed turns | answered turns | example |',
      '|---|---:|---:|---|',
      ...s.vocabulary.map((v) => `| ${esc(v.word)} | ${v.failed} | ${v.answered} | ${esc(v.example)} |`),
      '',
      '**Next:** if the docs name the same thing with another word, alias it — the key is the',
      'docs’ word, the array is the readers’:',
      '',
      '```js',
      'vocabulary: {',
      `  '<the docs’ word>': [${s.vocabulary.slice(0, 4).map((v) => JSON.stringify(v.word)).join(', ')}],`,
      '}',
      '```',
      '',
      '`npx docpilot vocabulary` proposes these from the corpus. Then `npx docpilot index` and',
      '`npx docpilot calibrate` — an alias moves lexical coverage, and the threshold was',
      'measured without it. A word with no docs equivalent is a content gap (section 1).',
    )
  }

  out.push('', '## 3. Retrieved, rarely cited', '')
  if (!s.uncited.length) out.push('No page was retrieved for three or more answered turns and cited in at most a fifth of them.')
  else {
    out.push(
      '| page | retrieved | cited | cited share |',
      '|---|---:|---:|---:|',
      ...s.uncited.map((u) => `| \`${u.page}\` | ${u.retrieved} | ${u.cited} | ${pct(u.citedShare)} |`),
      '',
      '**Next:** the retriever finds these pages and the model does not use them — usually a',
      'chunk whose heading promises more than its text holds, or a short section merged into',
      'its neighbour. Fix the headings or split the section, then `npx docpilot index` and',
      '`npx docpilot eval`.',
    )
  }

  out.push('', '## 4. Never retrieved', '')
  if (!s.neverRetrieved) out.push('No manifest was available, so the page list is unknown. Run `npx docpilot index` first.')
  else if (!s.neverRetrieved.length) out.push('Every indexed page was retrieved at least once.')
  else {
    out.push(
      `${s.neverRetrieved.length} indexed page(s) no turn in this window retrieved` +
        (s.turns < 200 ? ` — with ${s.turns} turns, read this as a hint, not a verdict:` : ':'),
      '',
      ...s.neverRetrieved.slice(0, 40).map((p) => `- \`${p.page}\`${p.title ? ` — ${esc(p.title)}` : ''}`),
      ...(s.neverRetrieved.length > 40 ? [`- … ${s.neverRetrieved.length - 40} more`] : []),
      '',
      '**Next:** either nobody asks about these, or readers ask in words the page does not',
      'use. Check the second with `npx docpilot vocabulary`; a page nobody needs is index',
      'weight — drop it from the docs and `npx docpilot index`.',
    )
  }

  out.push(
    '',
    '## 5. Language',
    '',
    '| lang | turns | failed | refused |',
    '|---|---:|---:|---:|',
    ...s.languages.map((l) => `| ${esc(l.lang)} | ${l.turns} | ${pct(l.failed)} | ${pct(l.refused)} |`),
  )
  const base = s.languages[0]
  const worse = s.languages.filter((l) => l !== base && l.turns >= 5 && (l.failed ?? 0) > (base?.failed ?? 0) + 0.15)
  out.push(
    '',
    worse.length
      ? `**${worse.map((l) => l.lang).join(', ')} fail${worse.length === 1 ? 's' : ''} well above ${base.lang}.** The gate threshold is per corpus AND per language ` +
          '(engine-spec 019): a question in another language than the docs scores lower lexical coverage. ' +
          'Add calibration probes in that language and `npx docpilot calibrate`, alias the words with `npx docpilot vocabulary`, ' +
          'or keep `guard.mode` `off` for that site.'
      : '**Next:** nothing stands out. If a language grows, re-run this and `npx docpilot calibrate` with probes in it.',
  )

  out.push(
    '',
    '## 6. Prompt, index and model drift',
    '',
    '| promptHash | indexHash | model | turns | from | to | answered | refused | down rate | no citation | latency p50 |',
    '|---|---|---|---:|---|---|---:|---:|---:|---:|---:|',
    ...s.drift.map(
      (d) =>
        `| \`${d.promptHash}\` | \`${d.indexHash}\` | \`${d.model}\` | ${d.turns} | ${d.first} | ${d.last} | ${pct(d.answer)} | ` +
        `${pct(d.refused)} | ${pct(d.downRate)} | ${pct(d.zeroCitations)} | ${d.latencyP50 == null ? '—' : `${(d.latencyP50 / 1000).toFixed(1)} s`} |`,
    ),
    '',
    s.drift.length > 1
      ? '**Next:** each row is one prompt on one index with one model. Traffic changes with the week, so a move here is a hint — confirm it with `npx docpilot eval` on both versions against the same golden set.'
      : '**Next:** one prompt on one index in this window. After the next prompt or index change, this table is how you see whether it helped.',
    '',
  )
  return out.join('\n')
}

/** Measure and render. */
export function trafficReport(turns: Turn[], ctx: ReportContext = {}) {
  const stats = trafficStats(turns, ctx)
  return {stats, markdown: renderTrafficReport(stats)}
}
