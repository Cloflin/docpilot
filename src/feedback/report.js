/**
 * What the votes say, in markdown. PURE — the caller writes the file.
 *
 * The selection-bias warning is printed IN THE REPORT, not only in the guide.
 * Whoever reads this is deciding which questions to promote into the calibration
 * set, and the sample they are reading is not a sample of turns: it is a sample
 * of turns someone felt strongly enough about to press a thumb on, filtered
 * again by whichever verdicts `feedback.send` lets through. Promoting from a
 * purely negative sample moves tau toward refusing every reader, which is the
 * failure the stratified design in calibrate.js exists to prevent.
 */

/** A down-rate over one vote is noise, and it would sort to the top of the table. */
const MIN_VOTES = 3

const pct = (n) => `${Math.round(n * 100)}%`
const fmt = (v) => (v == null || v === '' ? '—' : String(v))

function table(headers, rows) {
  if (!rows.length) return '_Nothing to show._\n'
  const head = `| ${headers.join(' | ')} |`
  const rule = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map(fmt).join(' | ')} |`)
  return [head, rule, ...body].join('\n') + '\n'
}

function counts(candidates, pick) {
  const m = new Map()
  for (const c of candidates) {
    for (const [k, n] of Object.entries(pick(c) || {})) m.set(k, (m.get(k) || 0) + n)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

/**
 * @param {object[]} candidates output of aggregate()
 * @param {object} [meta] `{send, source, generatedAt}` — stamped by the caller
 */
export function renderReport(candidates, meta = {}) {
  const asked = candidates.reduce((n, c) => n + c.asked, 0)
  const up = candidates.reduce((n, c) => n + c.up, 0)
  const down = candidates.reduce((n, c) => n + c.down, 0)
  const voted = up + down
  const send = meta.send || 'both'

  const out = []
  out.push('# Reader feedback\n')
  out.push(
    [
      `- generated: ${fmt(meta.generatedAt)}`,
      `- source: ${fmt(meta.source)}`,
      `- feedback.send: \`${send}\``,
      `- distinct questions: ${candidates.length}`,
      `- records: ${asked}, votes: ${voted} (${up} up, ${down} down)`,
    ].join('\n') + '\n',
  )

  out.push('\n## How to read this\n')
  if (send === 'down') {
    out.push(
      '> **Only down-votes reached the endpoint.** Under `feedback.send: "down"` a\n' +
        '> thumb up is never transmitted, so the rate below has no denominator: it is\n' +
        '> not a satisfaction score, and every question in this file is one somebody\n' +
        '> complained about. Promoting these into `calibration.jsonl` as they stand\n' +
        '> biases tau toward refusing. Set `feedback.send: "both"` for a measurement.\n',
    )
  } else {
    out.push(
      '> These are votes, not turns. A reader who was satisfied usually presses\n' +
        '> nothing, so this is a sample of people who felt strongly — useful for\n' +
        '> finding failures, not for estimating how often the panel works. Every\n' +
        '> candidate is marked `needsReview` for that reason.\n',
    )
  }

  out.push('\n## Helpfulness\n')
  out.push(
    table(
      ['votes', 'up', 'down', 'down-rate'],
      [[voted, up, down, voted ? pct(down / voted) : '—']],
    ),
  )

  out.push('\n## Reasons\n')
  out.push(table(['reason', 'count'], counts(candidates, (c) => c.reasons)))

  out.push('\n## Refusal causes\n')
  out.push(table(['cause', 'count'], counts(candidates, (c) => c.refusals)))

  out.push(`\n## Worst questions (min ${MIN_VOTES} votes)\n`)
  const worst = candidates
    .filter((c) => c.voted >= MIN_VOTES && c.downRate != null)
    .sort((a, b) => b.downRate - a.downRate || b.voted - a.voted)
    .slice(0, 25)
    .map((c) => [
      c.id,
      c.question.length > 70 ? `${c.question.slice(0, 67)}…` : c.question,
      c.voted,
      pct(c.downRate),
      c.gate?.marginP50 ?? null,
      c.target,
      c.stratum || (c.stratumOptions?.length ? c.stratumOptions.join('/') : null),
    ])
  out.push(table(['id', 'question', 'votes', 'down', 'G−tau', 'target', 'stratum'], worst))
  const below = candidates.filter((c) => c.voted > 0 && c.voted < MIN_VOTES).length
  if (below) out.push(`\n_${below} question(s) with fewer than ${MIN_VOTES} votes are not listed._\n`)

  out.push('\n## Where the candidates go\n')
  const byTarget = new Map()
  for (const c of candidates) byTarget.set(c.target, (byTarget.get(c.target) || 0) + 1)
  out.push(
    table(
      ['target', 'candidates', 'what it means'],
      [
        ['calibration', byTarget.get('calibration') || 0, 'a threshold probe — needs a `stratum`'],
        ['golden', byTarget.get('golden') || 0, 'an answer-quality record — needs a `gold_answer`'],
        ['docs', byTarget.get('docs') || 0, 'a documentation defect, not a threshold one'],
        ['none', byTarget.get('none') || 0, 'not usable as a probe'],
      ],
    ),
  )

  const comments = candidates.filter((c) => c.comments.length)
  out.push('\n## What readers wrote\n')
  if (!comments.length) out.push('_No comments._\n')
  else {
    for (const c of comments.slice(0, 40)) {
      out.push(`\n**${c.id}** — ${c.question}\n`)
      for (const text of c.comments) out.push(`> ${text.replace(/\n/g, '\n> ')}\n`)
    }
  }

  return out.join('')
}

export {MIN_VOTES}
