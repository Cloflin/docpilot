/**
 * How long the reader has been looking at a word that has not changed —
 * ui-specs/012.
 *
 * THE PROBLEM. `statusLabel` is a pure function of the phase, and a phase does
 * not move while a provider accepts the connection and then says nothing. The
 * step timeout is 120 seconds (`harness.js`), so the panel could hold somebody
 * in front of a motionless "Thinking" for two minutes with no way to tell it
 * apart from a panel that had crashed. The models that stream reasoning give
 * them a ticking counter through `thoughtLabel`; the ones that do not — most of
 * them — give them nothing.
 *
 * WHY A MODULE AND NOT A `computed`. The decision is arithmetic on two numbers
 * and one boolean, and arithmetic in this package is testable in Node — the same
 * arrangement `gate.js` and `budget.js` have. The component's job is to turn the
 * key this returns into a string.
 *
 * THE TWO NUMBERS. Nielsen's oldest usable limits: one second keeps thought
 * unbroken, and TEN SECONDS is the limit of attention on a dialogue — past it
 * people switch tasks and have to be told the system is still theirs. So the
 * first step lands before ten, and far enough after the send that the label is
 * not churning under a reader who just pressed the button: eight. The second is
 * not about attention but about abnormality — no healthy provider's time to
 * first byte reaches half a minute, and at twenty-five seconds there is still a
 * minute and a half in which the turn may yet succeed.
 *
 * THERE IS NO THIRD STEP, and the reason is a rule rather than a budget. A third
 * could only say what is wrong — which needs telemetry this package does not
 * have — or what will happen next, and it must not say that. The temptation is
 * "trying another model", because the ladder often is about to do exactly that;
 * but a chain with one member never rotates, a named model flattens the tiers,
 * and a self-hosted Ollama has nowhere to go. One sentence that is false on
 * three shipped configurations is worse than a vaguer one true on all of them.
 * This is the discipline the three `disclaimer` variants are held to.
 *
 * WHICH IS ALSO WHY `quiet` IS A PARAMETER. The escalation runs only while the
 * newest turn has neither answer text nor reasoning — so the second step's
 * "the answer has not started yet" is not an observation that could be wrong,
 * it is the condition under which the string is reachable at all. The moment
 * anything paints, the label has stopped being the reader's only signal and this
 * returns null.
 */

/** Before ten seconds, which is where attention on a dialogue runs out. */
export const STILL_WORKING_MS = 8000

/** Roughly three times the first, and well inside the 120 s step timeout. */
export const TAKING_A_WHILE_MS = 25000

/**
 * The dictionary key the status line should use, or `null` for "say what the
 * phase says".
 *
 * @param {{elapsedMs: number, quiet: boolean, escalate: boolean}} at
 * @returns {'status.takingAWhile'|'status.stillWorking'|null}
 */
export function waitingKey(at) {
  const { elapsedMs, quiet, escalate } = at || {}
  if (!escalate || !quiet) return null
  const ms = Number(elapsedMs)
  if (!Number.isFinite(ms)) return null
  if (ms >= TAKING_A_WHILE_MS) return 'status.takingAWhile'
  if (ms >= STILL_WORKING_MS) return 'status.stillWorking'
  return null
}
