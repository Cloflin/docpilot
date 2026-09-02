/**
 * One question at a terminal, and the two ways a reader can decline to answer.
 *
 * A module of its own because two commands ask: `init` asks where the panel
 * goes, `index` asks which embedder to build with, and while both prompts lived
 * in `bin/docpilot.js` they shared this by being in the same file. `init` has
 * moved into `src/` under the `run*` contract; a helper that stayed behind
 * would have become two copies of a loop whose whole point is that it gives up
 * after one retry.
 *
 * NOTHING IS RESOLVED AT MODULE SCOPE HERE. That is the property that lets a
 * launcher import it before it has loaded a config — see the note on
 * `src/cli-env.ts`, which exists for the same reason.
 */

/**
 * One question, answered by number or by name, empty for the default.
 *
 * Garbage is re-asked ONCE and then takes the default rather than looping: a
 * prompt that will not let go is worse than a wrong-but-stated placement, which
 * is two words in a config file to change.
 */
export async function askOne(rl, q) {
  const list = q.options
    .map((o, i) => `    ${i + 1}. ${o}${o === q.default ? '  (default)' : ''}  — ${q.hints[o]}`)
    .join('\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = (await rl.question(`\n  ${q.label}\n${list}\n  > `)).trim()
    if (!raw) return q.default
    const byNumber = /^\d+$/.test(raw) ? q.options[Number(raw) - 1] : undefined
    if (byNumber) return byNumber
    if (q.options.includes(raw)) return raw
    console.log(`  "${raw}" is not one of them — ${q.options.join(', ')}.`)
  }
  return q.default
}

/** Re-exported so a caller of `askOne` needs one import, not two. */
export { CANCELLED } from './cli-exit.js'
