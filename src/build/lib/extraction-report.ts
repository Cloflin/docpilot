/**
 * What an HTML run kept, dropped and skipped, per source — engine-spec 043, D-13.
 *
 * A silent extraction reads as "it took everything". `docpilot import` prints
 * this table after every run, and `index --html-dir` prints it in a later plan,
 * so a person sees the size of the loss before the corpus changes. It is
 * human-readable only in this phase; a JSON form waits for a consumer.
 *
 * Counts are plain digits from `String(n)`: no locale grouping, so the same run
 * prints the same table on every machine. `kept` and `dropped` are Unicode code
 * points of NFC, whitespace-collapsed text (see `extractDocument`).
 */

import { printable } from './terminal.js'

/**
 * Skipped pages listed by name per source. A report is something a person reads,
 * so the table names the first few and counts the rest; the complete list is in
 * the warnings (engine-spec 043).
 */
export const MAX_REPORTED_SKIPS = 10

/** The reason prefix `extractDocument` gives a page with nothing in it. */
const EMPTY_REASON = 'near-empty'

export interface ExtractionRow {
  source: string
  pages: number
  kept: number
  dropped: number
  empty: number
  linkFailures: number
  skipped: { id: string; reason: string }[]
}

/** The part of an `ExtractResult` a row reads. */
interface ResultLike {
  ok: boolean
  reason?: string
  report?: { keptChars?: number; droppedChars?: number; linksDegraded?: number }
}

/** One source's row from the results of its pages. */
export function rowFromResults(source: string, items: { id: string; result: ResultLike }[]): ExtractionRow {
  const row: ExtractionRow = { source, pages: 0, kept: 0, dropped: 0, empty: 0, linkFailures: 0, skipped: [] }
  for (const { id, result } of items) {
    row.kept += result.report?.keptChars || 0
    row.dropped += result.report?.droppedChars || 0
    row.linkFailures += result.report?.linksDegraded || 0
    if (result.ok) {
      row.pages++
      continue
    }
    const reason = result.reason || 'skipped'
    if (reason.startsWith(EMPTY_REASON)) row.empty++
    row.skipped.push({ id, reason })
  }
  return row
}

const COLUMNS = ['pages', 'kept', 'dropped', 'empty', 'link failures'] as const

/** The table as printable lines: a header, one row per source, then the skipped pages. */
export function formatExtractionReport(rows: ExtractionRow[]): string[] {
  const cells = rows.map((r) => [
    printable(r.source),
    ...[r.pages, r.kept, r.dropped, r.empty, r.linkFailures].map((n) => String(n)),
  ])
  const header = ['source', ...COLUMNS]
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (c: string[]) =>
    c.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join('  ')

  const out = [line(header), ...cells.map(line)]
  for (const row of rows) {
    for (const s of row.skipped.slice(0, MAX_REPORTED_SKIPS)) {
      out.push(`  skipped ${printable(s.id)}: ${printable(s.reason)}`)
    }
    const more = row.skipped.length - MAX_REPORTED_SKIPS
    if (more > 0) out.push(`  …and ${more} more`)
  }
  return out
}
