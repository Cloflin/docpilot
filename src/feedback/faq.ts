/**
 * The questions readers actually ask, ranked — and grouped the way the panel
 * would group them.
 *
 * PURE, on the same terms as `aggregate.js`: no fs, no network, no clock. The
 * caller stamps time and writes files.
 *
 * WHAT THIS IS FOR. `suggestions.questions` is the panel's first impression, and
 * until now it was three guesses. `docpilot feedback pull` already turns votes
 * into candidates carrying `asked` — a frequency — so the raw material for a
 * better three has been on disk all along with nothing reading it for this
 * purpose.
 *
 * THE CLUSTERING IS NOT A CONVENIENCE. It uses `similarity` — the identical
 * symmetric coverage the panel matches a paraphrase with, at the site's own
 * `matchTau` — so a cluster here is exactly the set of questions ONE opener
 * would catch at runtime. An author who takes a cluster head gets the coverage
 * this report predicted, rather than a plausible-looking grouping that the
 * runtime then disagrees with.
 *
 * IT PROPOSES AND NEVER WRITES. `cli.js` states the rule for `pull` and it holds
 * here with more force, not less: these three strings are shown to every reader
 * who opens the panel, and a sample drawn only from people who pressed a thumb
 * is not a sample of what people ask.
 */

import { similarity } from '../theme/docpilot/openers.js'
import { normalise } from '../theme/docpilot/text.js'

/**
 * A question worth proposing has been asked more than once, was answered rather
 * than refused, and did not draw complaints.
 *
 * The last one is the least obvious and the most important: `downRate` at or
 * above a third is a question the corpus handles BADLY, and promoting it to the
 * empty state would put the site's weakest answer where every reader's first
 * click lands. It belongs in the docs-rag `corpus` mode instead, which is what
 * `pull` already files it under.
 */
export const MIN_ASKED = 2
export const MAX_DOWN_RATE = 0.34

export function eligible(c) {
  if ((c.asked ?? 0) < MIN_ASKED) return false
  if (c.downRate != null && c.downRate >= MAX_DOWN_RATE) return false
  return !(c.refusals && topOf(c.refusals) && topOf(c.refusals) !== 'none')
}

/** The modal key of a `{key: count}` tally, or null when it is empty. */
export function topOf(tally) {
  const rows: Array<[string, number]> = Object.entries(tally || {}) as Array<[string, number]>
  rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return rows.length ? rows[0][0] : null
}

/**
 * Group what one opener would catch, then rank by how many readers it would
 * catch it for.
 *
 * The head of a cluster is its most-asked member VERBATIM, never a synthesis:
 * an opener is copy a reader reads and then submits, so a generated paraphrase
 * would put a question nobody typed into the panel and then into the thread.
 *
 * Ranked by summed `asked`, tie-broken by `sessions` — breadth over enthusiasm.
 * One reader asking the same thing forty times is a support conversation, not a
 * frequently asked question.
 */
export function clusterQuestions(candidates, { df = null, matchTau = 0.65 }: {df?: any; matchTau?: number} = {}) {
  const pool = candidates.filter(eligible).sort((a, b) => (b.asked ?? 0) - (a.asked ?? 0))
  const clusters = []
  for (const c of pool) {
    const near = matchTau <= 1 ? clusters.find((cl) => similarity(cl.head.question, c.question, df) >= matchTau) : null
    if (near) {
      near.members.push(c)
      near.asked += c.asked ?? 0
      near.sessions += c.sessions ?? 0
      continue
    }
    clusters.push({
      head: c,
      members: [c],
      asked: c.asked ?? 0,
      sessions: c.sessions ?? 0,
    })
  }
  return clusters.sort((a, b) => b.asked - a.asked || b.sessions - a.sessions)
}

/**
 * Which proposals the site already shows, and which openers no reader has ever
 * asked for.
 *
 * The second half is the one an author cannot get anywhere else. A configured
 * opener with no traffic is either a question nobody has, or — far more often —
 * a question the panel refuses, so the readers who clicked it learned not to.
 * Either way it is occupying one of three slots.
 */
export function against(clusters, configured, { df = null, matchTau = 0.65 }: {df?: any; matchTau?: number} = {}) {
  const keys = new Set(configured.map(normalise))
  const rows = clusters.map((cl) => ({
    ...cl,
    configured:
      keys.has(normalise(cl.head.question)) ||
      (matchTau <= 1 && configured.some((q) => similarity(q, cl.head.question, df) >= matchTau)),
  }))
  const unasked = configured.filter(
    (q) =>
      !clusters.some(
        (cl) =>
          normalise(cl.head.question) === normalise(q) ||
          (matchTau <= 1 && similarity(q, cl.head.question, df) >= matchTau),
      ),
  )
  return { rows, unasked }
}

const pct = (v) => (v == null ? '   —' : `${Math.round(v * 100)}%`.padStart(4))

/** The report, and the paste-able block at the end of it. */
export function renderFaqReport(clusters, { configured, unasked, send, source, generatedAt, limit = 3 }) {
  const total = clusters.reduce((a, c) => a + c.asked, 0)
  const out = [
    '# The questions readers ask',
    '',
    `Source: \`${source}\` · ${generatedAt}`,
    '',
    '> **This is a sample of VOTED turns, not of questions.** A record exists only',
    '> where a reader used the feedback controls, so a question that everybody',
    '> understood and nobody voted on is invisible here. Read the counts as',
    '> "of the people who said something", never as "of the people who asked".',
    ...(send === 'down'
      ? [
          '>',
          '> `feedback.send` is `"down"` on this project, so this sample is complaints',
          '> only. Every rate below has no denominator.',
        ]
      : []),
    '',
    `${clusters.length} cluster(s) from ${total} asking(s).`,
    '',
    '| asked | sessions | down | question | |',
    '|---:|---:|---:|---|---|',
  ]
  for (const c of clusters) {
    out.push(
      `| ${c.asked} | ${c.sessions} | ${pct(c.head.downRate)} | ${c.head.question.replace(/\|/g, '\\|')} | ` +
        `${c.configured ? 'already configured' : 'new'} |`,
    )
  }
  if (unasked.length) {
    out.push(
      '',
      '## Configured, and never asked',
      '',
      'Either nobody has this question, or — far more often — the panel refuses it',
      'and the readers who clicked it learned not to. `npx docpilot index` prints',
      'which of your openers the gate refuses.',
      '',
      ...unasked.map((q) => `- ${q}`),
    )
  }
  for (const c of clusters.filter((x) => x.members.length > 1)) {
    out.push(
      '',
      `### ${c.head.question}`,
      '',
      'One opener would catch all of these, at this site’s `suggestions.matchTau`:',
      '',
      ...c.members.map((m) => `- ${m.question} — asked ${m.asked}`),
    )
  }
  out.push(
    '',
    '## Paste-able',
    '',
    '```js',
    'suggestions: {',
    '  questions: [',
    ...clusters.slice(0, limit).map((c) => `    ${JSON.stringify(c.head.question)},`),
    '  ],',
    '}',
    '```',
    '',
    'Then `npx docpilot index`, which resolves them against the corpus and names',
    'the ones it refuses. **Read them first.** These are the panel’s first',
    'impression, and this sample is biased by construction.',
    '',
  )
  return out.join('\n')
}
