/**
 * Golden-set size tiers — one file, six nested pools.
 *
 * The only subsetting the eval had was `--limit=N`, a head-slice of
 * golden.jsonl. That measures whatever the author happened to write first: the
 * "quick" run and the full run disagree about which questions matter, and
 * neither number explains the other. A tier inverts it — a record declares the
 * pool it ENTERS at, every larger pool contains every smaller one, so
 * `--level=low` is a true subset of `--level=max` and a smoke regression is a
 * regression in the full set too.
 *
 * The two defaults are what let this land on a golden file that already exists
 * without moving a single number:
 *
 *   - a record with no `level` reads as `high`, because `high` is DEFINED as
 *     roughly the set that exists today (~60 records). A legacy file therefore
 *     scores identically under `--level=high` and under no flag at all, and
 *     nobody has to backfill 60 records to keep their history.
 *   - a run with no `--level` is `ultra`, i.e. everything, which is exactly what
 *     every run did before this module existed.
 *
 * Pure by contract: no fs, no process, no env. run.js, lint-golden.js,
 * answer-bench.js and tune.js all import it, and the four have to agree on
 * membership down to the record — a report is only comparable to another report
 * of the same pool.
 */

/**
 * Smallest pool first. The ORDER is the semantics — every question this module
 * answers is a comparison of two positions in this array — so a name may be
 * appended but never reordered: moving one would silently re-tier every record
 * already authored against it.
 */
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** What an absent `level` means. See the header: legacy files must not move. */
export const DEFAULT_RECORD_LEVEL = 'high'

/** What an absent `--level` means: the whole set, today's behaviour. */
export const DEFAULT_RUN_LEVEL = 'ultra'

/** Position in `LEVELS`, or -1 for anything that is not one of the six. */
export function levelRank(level) {
  return LEVELS.indexOf(level)
}

/**
 * The tier at which a record ENTERS the pool.
 *
 * `??`, not `||`: only an ABSENT field defaults. An authored `level` reaches the
 * caller unchanged whatever it says, including a typo or an empty string, so
 * `docpilot lint` can name it instead of this file quietly rewriting it to
 * `high` and hiding the mistake in a passing run.
 *
 * The field is written once, at authoring time, and never re-tiered downward:
 * moving a question from `high` to `low` changes what a smoke run measures
 * without changing a single answer, and the two sides of that commit stop being
 * comparable. The set grows at the top.
 */
export function recordLevel(rec) {
  return rec?.level ?? DEFAULT_RECORD_LEVEL
}

/**
 * The records a run at `runLevel` scores — cumulative, so `--level=medium` runs
 * low + medium.
 *
 * A record whose `level` is none of the six ranks -1 and so falls into EVERY
 * pool, the smoke one included. That is deliberate in both directions: `ultra`
 * has to mean everything, so a typo may never delete a record from a run, and
 * surfacing the stray in the fastest pool is what gets it noticed. Turning it
 * into an error is `docpilot lint`'s job, not the filter's.
 */
export function filterByLevel(records, runLevel) {
  // Through the parser, so a caller that skipped it cannot hand us `--levl=high`
  // fallout and get a silently empty pool back.
  const ceiling = levelRank(parseLevelArg(runLevel))
  return records.filter((r) => levelRank(recordLevel(r)) <= ceiling)
}

/**
 * `--level=<x>` → a run level, or a throw.
 *
 * Validated rather than defaulted, because the failure mode of a typo is silent:
 * an unrecognised value that fell through to `ultra` would print "N of M
 * records" for a pool nobody asked for, and the author would read the resulting
 * report as the level they thought they ran.
 */
export function parseLevelArg(raw) {
  // `undefined` is "no flag at all"; `''` is a bare `--level=`, or a shell that
  // ate the value. Both mean the caller expressed no preference.
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return DEFAULT_RUN_LEVEL
  if (levelRank(v) < 0) {
    const e: Error & { usage?: boolean } = new Error(
      `[docpilot] unknown level "${raw}"\n` +
        `    smallest to largest: ${LEVELS.join(', ')}\n` +
        `    levels are cumulative — --level=medium runs low + medium\n` +
        `    omit --level to run the whole set (${DEFAULT_RUN_LEVEL})`,
    )
    // A bad value is a USAGE error, and the exit that catches this is four
    // frames away — see `codeFor` in src/cli-exit.js.
    e.usage = true
    throw e
  }
  return v
}

/**
 * Per-tier counts and the pool size each tier yields — the one number lint's
 * summary and run's header both print, so they cannot drift apart.
 *
 * `cumulative` is not a running sum of `count` alone: it is exactly
 * `filterByLevel(records, level).length`, which is the number the run goes on to
 * score. The two differ only for a malformed set, where records with an
 * unrecognised level sit in every pool (see `filterByLevel`) and are reported
 * once more under `unknown` so lint can point at them.
 *
 * @returns {{levels: Array<{level: string, count: number, cumulative: number}>,
 *            unknown: number, total: number}}
 */
export function levelHistogram(records) {
  const rows = LEVELS.map((level) => ({ level, count: 0, cumulative: 0 }))
  let unknown = 0
  for (const r of records) {
    const rank = levelRank(recordLevel(r))
    if (rank < 0) unknown++
    else rows[rank].count++
  }
  let running = unknown
  for (const row of rows) {
    running += row.count
    row.cumulative = running
  }
  return { levels: rows, unknown, total: records.length }
}
