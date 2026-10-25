/**
 * `npx docpilot` with no command, in a terminal — the home screen.
 * engine-spec 030.
 *
 * The `status` picture, then a menu of what to run, with the `next` rule's
 * answer first and Enter on it. Every entry runs the REAL command, as a child
 * of this process with the terminal handed over, so a command reached from
 * here behaves exactly as it does typed: its own questions, its own progress,
 * its own exit code — which becomes this one's.
 *
 * ONLY IN A TERMINAL. The launcher sends a pipe, CI and `--help` to the
 * global help, exactly as before; a menu nobody can see is a hang.
 */
import { spawn } from 'node:child_process'

import { CANCELLED, FAILED, OK, printError } from './cli-exit.js'
import { select, ui } from './cli-ui.js'
import { collectStatus, renderStatus } from './cli-status.js'

/**
 * WHAT THE MENU OFFERS, keyed by command name.
 *
 * An entry is shown only when its command is in the launcher's `COMMANDS`, so
 * a command that does not exist yet is never offered and a new one plugs in
 * with one line here — `improve: [{ argv: ['improve'], hint: '…' }]` the day
 * it lands. `when` hides an entry the project cannot use: `serve` and
 * `monitor` mean nothing under the browser runtime.
 */
export const HOME_ACTIONS: Record<string, Array<{ argv: string[]; hint: string; when?: (status: any) => boolean }>> = {
  index: [{ argv: ['index'], hint: 'rebuild the retrieval index from the docs' }],
  calibrate: [{ argv: ['calibrate'], hint: 'measure the refusal thresholds — embeds the probe set' }],
  lint: [{ argv: ['lint'], hint: 'check the golden set against the index — free' }],
  eval: [
    { argv: ['eval', '--gate-only'], hint: 'retrieval and the gate only — no model, free' },
    { argv: ['eval'], hint: 'the whole golden set, with the model answering' },
  ],
  // engine-spec 035: the loop's next step once a report exists — the plan, and
  // the dev-split run it reads.
  improve: [
    { argv: ['eval', '--split=dev', '--quiet'], hint: 'the dev half of the golden set — what improve diagnoses', when: (s) => Boolean(s.evalSets?.golden) },
    { argv: ['improve'], hint: 'the edits the last report asks for — free, no model', when: (s) => Boolean(s.lastEval) },
  ],
  doctor: [{ argv: ['doctor'], hint: 'check the configuration without a build' }],
  serve: [{ argv: ['serve'], hint: 'run the turn on this machine', when: (s) => s.project.runtime === 'server' }],
  monitor: [
    { argv: ['monitor'], hint: 'watch the running server', when: (s) => s.project.runtime === 'server' || s.server.configured },
  ],
}

/**
 * The menu for one status: the next step (and its `then`) first, then the
 * registry in its order, each command line once, and a way out last.
 *
 * @param commands the launcher's `COMMANDS` — the only list of what exists.
 */
export function homeChoices(status, commands: string[]) {
  const seen = new Set<string>()
  const out: Array<{ label: string; value: string[] | null; hint: string }> = []
  const hintFor = (argv) =>
    Object.values(HOME_ACTIONS)
      .flat()
      .find((a) => a.argv.join(' ') === argv.join(' '))?.hint
  const add = (argv, hint) => {
    const label = argv.join(' ')
    if (seen.has(label) || !commands.includes(argv[0])) return
    seen.add(label)
    out.push({ label, value: argv, hint })
  }
  if (status.next) {
    add(status.next.argv, `next — ${hintFor(status.next.argv) ?? status.next.why}`)
    for (const t of status.next.then) add(t.argv, `then — ${hintFor(t.argv) ?? t.why}`)
  }
  for (const [command, actions] of Object.entries(HOME_ACTIONS)) {
    if (!commands.includes(command)) continue
    for (const a of actions) if (!a.when || a.when(status)) add(a.argv, a.hint)
  }
  out.push({ label: 'quit', value: null, hint: '' })
  return out
}

/**
 * The chosen command, run as `node bin/docpilot.js <argv…>` with this
 * terminal. SIGINT is ignored HERE while it runs: Ctrl-C reaches the whole
 * foreground group, the child answers for both of us, and a parent that died
 * first would hand the shell back with a child still writing to it.
 */
function runChild(bin: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const ignore = () => {}
    process.on('SIGINT', ignore)
    const child = spawn(process.execPath, [bin, ...argv], { stdio: 'inherit' })
    const done = (code: number) => {
      process.off('SIGINT', ignore)
      resolve(code)
    }
    child.on('error', () => done(FAILED))
    child.on('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? CANCELLED : FAILED)))
  })
}

export async function runHome({
  docPilot,
  env = process.env,
  configPath = null,
  commands,
  bin,
  stdin = process.stdin,
  stdout = process.stdout,
}: {
  docPilot: any
  env?: Record<string, string | undefined>
  configPath?: string | null
  commands: string[]
  bin: string
  stdin?: any
  stdout?: any
}): Promise<number> {
  let status
  try {
    status = await collectStatus({ docPilot, configPath, env })
  } catch (e) {
    printError(e?.message || String(e), e, env)
    return FAILED
  }
  stdout.write(`${renderStatus(status, ui(stdout, env)).join('\n')}\n`)
  const argv = await select({ message: 'Run', choices: homeChoices(status, commands), stdin, stdout, env })
  if (!argv) return OK
  stdout.write('\n')
  return runChild(bin, argv)
}
