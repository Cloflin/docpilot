/**
 * The four exit codes this CLI has, and the one shape an error takes.
 *
 * WHAT WAS WRONG. There were two codes and cancelling was one of them: Ctrl-C
 * and Ctrl-D on either of the package's prompts returned `0`, so a script could
 * not tell "the index was built" from "somebody changed their mind before it
 * started". Everything else was `1`, so a script could not tell a typo in a flag
 * from a provider that was down — and the first is fixed by editing a command
 * line while the second is fixed by waiting.
 *
 * WHY NOT `sysexits.h`. Sixteen codes describe a taxonomy of failures this CLI
 * does not have. `EX_DATAERR` and `EX_NOINPUT` would both be "the golden set is
 * wrong", and a scale nobody can assign consistently is a scale no script can
 * read. Four is what there is to say:
 *
 *   0    done.
 *   1    the work was attempted and it failed — the network, the config, a hard
 *        gate, `CALIBRATION FAILED`.
 *   2    the command line was wrong — an unknown command, flag, mode or value.
 *        Nothing was attempted.
 *   130  cancelled at a prompt. `128 + SIGINT`, the shell's own convention, and
 *        it covers Ctrl-D as well as Ctrl-C: both mean the reader did not
 *        answer, and for a script that is one outcome.
 *
 * THE SCALE IS DOCUMENTED in `docs/reference/cli.md`. Before this it was
 * promised nowhere, which is why changing it is a `minor` and not a `major`.
 */
export const OK = 0
export const FAILED = 1
export const USAGE = 2
export const CANCELLED = 130

/**
 * One prefix, one stream, and the stack behind a switch.
 *
 * `[docpilot] <message>` on stderr is what `import`, `feedback` and `vocabulary`
 * already wrote; the five entry modules wrote a two-blank-line `  FAIL  ` frame
 * instead, and four of them passed `e.stack` into it, so the ordinary failure —
 * a provider that refused — arrived as thirty lines of this package's own
 * internals with the sentence that matters at the top of them.
 *
 * The stack is not lost, it is asked for: `DOCPILOT_DEBUG=1`. That is the one
 * new lever this contract adds, and it is the reason the frame can go.
 */
export function printError(message, error = null, env = process.env) {
  // Some messages arrive already wearing the prefix — `parseLevelArg` throws
  // one, and callers pass `e.message` straight through. Prefixing that twice is
  // exactly the kind of rendering fault a single writer exists to prevent.
  const text = String(message ?? '')
  console.error(text.startsWith('[docpilot]') ? text : `[docpilot] ${text}`)
  if (env.DOCPILOT_DEBUG === '1' && error?.stack) console.error(error.stack)
}

/**
 * The code an error asks for, defaulting to `1`.
 *
 * A bad VALUE — `--level=hgih` — is a usage error under the scale above, but it
 * is caught in `parseLevelArg` rather than in the flag table, several frames
 * from any `process.exit`. Marking the throw is how the code survives the trip:
 * `e.usage = true` at the throw, `codeFor(e)` at the exit.
 */
export const codeFor = (error) => (error?.usage ? USAGE : FAILED)

/**
 * Is the progress line allowed to redraw itself?
 *
 * Seven places in this package rewrite their last line with a carriage return,
 * and none of them asked. Piped into a file or a CI log, `\r` produces one
 * enormous line holding every counter value the run ever had; `grep -rn isTTY
 * src/` returned nothing at all before this.
 *
 * STDERR, not stdout, because progress is diagnostics: a run whose report is
 * being piped somewhere still has a terminal attached to its stderr, and that
 * is exactly the case where redrawing is wanted.
 */
export const redraws = () => Boolean(process.stderr.isTTY)

/**
 * A progress counter that redraws under a terminal and writes a line in a log.
 *
 * `\r` was written unconditionally, to stdout, in seven places. Piped into a
 * file or a CI log that produces ONE line holding every value the counter ever
 * had, and on the two commands that also write a report to stdout it produced
 * that line in the middle of the report.
 *
 * @param at under a non-TTY, whether this tick is worth a whole line. Under a
 *   terminal it is ignored: the redraw is free because it overwrites itself.
 *   The callers that already throttle — `% 20`, one per batch — pass nothing.
 */
export const tick = (text, at = true) => {
  if (redraws()) process.stderr.write(`\r  ${text}`)
  else if (at) console.error(`  ${text}`)
}

/** The line that STAYS: it overwrites the ticks under a terminal, and stands alone without. */
export const tock = (text) => {
  if (redraws()) process.stderr.write(`\r  ${text}\n`)
  else console.error(`  ${text}`)
}
