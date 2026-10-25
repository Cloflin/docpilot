/**
 * The turn log — engine-spec 028 §3, format `docpilot.turn/1`.
 *
 * ONE LINE PER TURN, ONE FILE PER DAY, and that layout is the contract the
 * readers are built on: `docpilot traffic`, `docpilot dataset` and `docpilot
 * feedback` take a directory of these and need nothing else. A day per file is
 * what makes retention a `readdir` and an `unlink` rather than a rewrite.
 *
 * WHAT IS NEVER WRITTEN: an IP, a user agent, a cookie, a key. The record is
 * built in `turn.ts` from the redacted question and the turn's own results; this
 * file adds nothing it was not handed, and so cannot add any of those either.
 *
 * Appends are synchronous on purpose. A turn record is a few kilobytes written
 * after the reader already has their answer, and an async append that a process
 * exit can outrun is the silent drop this format exists to end.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface TurnLogOptions {
  /** A directory; files are `turns-YYYY-MM-DD.jsonl` (UTC). */
  dir?: string | null
  /** Or a sink of your own — a queue, a database. Called with the record object. */
  write?: ((record: any) => void | Promise<void>) | null
  /** Keep the final prompt (`messages`) on each record — what SFT trains on. Off by default. */
  prompts?: boolean
  /** Delete day files older than this many days. Null keeps everything. */
  retentionDays?: number | null
}

const DAY = /^turns-(\d{4}-\d{2}-\d{2})\.jsonl$/

export const dayFile = (dir, at = new Date()) =>
  path.join(dir, `turns-${at.toISOString().slice(0, 10)}.jsonl`)

/** Delete day files older than `days`. Returns the names removed. */
export function prune(dir, days, now = new Date()) {
  if (!dir || !Number.isFinite(days) || days <= 0 || !fs.existsSync(dir)) return []
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10)
  const removed = []
  for (const name of fs.readdirSync(dir)) {
    const m = DAY.exec(name)
    if (m && m[1] < cutoff) {
      fs.unlinkSync(path.join(dir, name))
      removed.push(name)
    }
  }
  return removed
}

/**
 * A sink, or null when nothing was configured. A failing sink is reported once
 * per process and never fails the turn: the reader's answer is not the log's to
 * lose.
 */
export function createTurnLog(options: TurnLogOptions | null | undefined) {
  if (!options || (!options.dir && !options.write)) return null
  const { dir = null, write = null, retentionDays = null } = options
  if (dir) fs.mkdirSync(dir, { recursive: true })
  let lastPrunedDay = null
  let warned = false
  const warn = (e) => {
    if (warned) return
    warned = true
    // eslint-disable-next-line no-console
    console.error(`[docpilot] the turn log could not be written: ${e?.message || e}`)
  }
  return {
    prompts: Boolean(options.prompts),
    record(record) {
      try {
        if (write) {
          const pending = write(record)
          if (pending && typeof pending.catch === 'function') pending.catch(warn)
        }
        if (dir) {
          const now = new Date()
          fs.appendFileSync(dayFile(dir, now), JSON.stringify(record) + '\n')
          const today = now.toISOString().slice(0, 10)
          if (retentionDays && lastPrunedDay !== today) {
            lastPrunedDay = today
            prune(dir, retentionDays, now)
          }
        }
      } catch (e) {
        warn(e)
      }
    },
  }
}
