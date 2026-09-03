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

/**
 * One question whose answer is a PATH, and so cannot be a list of options.
 *
 * `askOne` returns a member of `q.options`, which is the right shape for every
 * question this CLI had until the skills grew somewhere to be installed: "which
 * directory?" has no option list, and pushing free text through a fixed-option
 * prompt would have meant a prompt that rejects the only answer it can be
 * given. A sibling here rather than a second module, because it is the same
 * contract — empty takes the default, one retry, then the default — and the
 * whole point of this file is that the two commands that ask share it.
 */
export async function askPath(rl, q) {
  const suffix = q.default ? `  [${q.default}]` : ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = (await rl.question(`\n  ${q.label}${suffix}\n  > `)).trim()
    if (!raw) return q.default ?? null
    // A path is almost anything, so the only thing worth refusing is the answer
    // that is not one: a bare flag, which means the reader is answering a
    // different question than the one on screen.
    if (!raw.startsWith('-')) return raw
    console.log('  That looks like a flag rather than a directory.')
  }
  return q.default ?? null
}

/** Re-exported so a caller of `askOne` needs one import, not two. */
export { CANCELLED } from './cli-exit.js'
