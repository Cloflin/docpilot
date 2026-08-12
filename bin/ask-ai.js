#!/usr/bin/env node
/**
 * `npx ask-ai <command>` — the half of this package that is not a web page.
 *
 * The panel cannot work without an index, and an index cannot be trusted
 * without an evaluation, so both ship in the same package as the panel. Split
 * across two installs they drift: the index gets rebuilt with a different
 * embedding model, or the gate keeps thresholds measured against a corpus that
 * has since doubled, and nothing says so until a reader is told the docs do not
 * cover something they do.
 *
 * Every command resolves its settings the same way the VitePress build does —
 * by importing the project's own config — so there is no second place to state
 * which model embeds, where the docs live, or which key to use.
 */
import { pathToFileURL } from 'node:url'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

const COMMANDS = ['index', 'eval', 'calibrate', 'doctor', 'init']

const [, , cmd, ...rest] = process.argv

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
  ask-ai <command>

    index       build the retrieval index from your docs
    calibrate   measure the refusal thresholds against your corpus
    eval        run the golden set and write a report
    doctor      check the configuration without a full build
    init        scaffold .env.example, an eval set, and the config snippet

  Every command reads .vitepress/config.mjs for its settings.
`)
  process.exit(0)
}

if (!COMMANDS.includes(cmd)) {
  console.error(`[ask-ai] unknown command "${cmd}". One of: ${COMMANDS.join(', ')}`)
  process.exit(1)
}

/**
 * Load the consumer's VitePress config and find the Ask AI settings in it.
 *
 * A named `askAI` export is the documented contract, because the default
 * export is the whole VitePress config and digging the settings back out of it
 * means depending on where the user happened to put them.
 */
async function loadSettings() {
  const candidates = [
    'docs/.vitepress/config.mjs',
    'docs/.vitepress/config.js',
    '.vitepress/config.mjs',
    '.vitepress/config.js',
  ]
  const found = candidates.find((c) => existsSync(path.resolve(c)))
  if (!found) {
    console.error(
      '[ask-ai] no VitePress config found. Looked for:\n  ' +
        candidates.join('\n  ') +
        '\n\n  Run this from your project root.',
    )
    process.exit(1)
  }
  const mod = await import(pathToFileURL(path.resolve(found)).href)
  if (!mod.askAI) {
    console.error(
      `[ask-ai] ${found} has no \`askAI\` export.\n\n` +
        '  Export the settings you pass to defineAskAI so the CLI and the build\n' +
        '  read the same object:\n\n' +
        "    export const askAI = { chat: { … }, embed: { … } }\n" +
        '    const ai = defineAskAI(askAI, loadEnv(\'\', process.cwd(), \'\'))\n',
    )
    process.exit(1)
  }
  return { settings: mod.askAI, configPath: found }
}

const { resolveAskAI, readiness, indexDirOf } = await import('../src/config.js')

if (cmd === 'init') {
  const envExample = new URL('../.env.example', import.meta.url)
  const target = path.resolve('.env.example')
  if (existsSync(target)) {
    console.log('[ask-ai] .env.example already exists — leaving it alone')
  } else {
    writeFileSync(target, readFileSync(envExample, 'utf8'))
    console.log('[ask-ai] wrote .env.example')
  }
  console.log(`
  Next:
    1. cp .env.example .env.local  and fill in one key
    2. add the plugin to .vitepress/config.mjs — see the README
    3. npx ask-ai index
    4. npx ask-ai calibrate
`)
  process.exit(0)
}

/**
 * Read the environment the way the BUILD reads it, not the way a shell does.
 *
 * `doctor` reporting a key as missing because it lives in `.env.local` — where
 * every VitePress project is told to put it, and where the build finds it — is
 * a false alarm from the one command whose entire job is to not raise one.
 * vitepress is a peer dependency, so it resolves from the project this is being
 * run in; a project without it is not a project this CLI has anything to say to.
 */
async function loadEnvironment() {
  try {
    const { loadEnv } = await import('vitepress')
    return { ...process.env, ...loadEnv('', process.cwd(), '') }
  } catch {
    return process.env
  }
}

const { settings, configPath } = await loadSettings()
const env = await loadEnvironment()
const resolved = resolveAskAI(settings, env)

if (cmd === 'doctor') {
  const ready = readiness(resolved, env)
  console.log(`[ask-ai] config    ${configPath}`)
  console.log(`[ask-ai] docs      ${resolved.docsDir}`)
  console.log(`[ask-ai] index     ${indexDirOf(resolved)}`)
  if (ready.ok) {
    console.log('[ask-ai] ready     yes — the panel will render')
    for (const n of ready.notes) console.log(`  · ${n}`)
    process.exit(0)
  }
  console.log(`[ask-ai] ready     NO — ${ready.missing.length} to fix\n`)
  for (const m of ready.missing) console.log(`  · ${m.what}\n      ${m.fix}`)
  for (const n of ready.notes) console.log(`  · ${n}`)
  // Exit 1 so CI can gate on it. The BUILD never fails for these; `doctor` is
  // the opt-in place to turn the same facts into a failure.
  process.exit(1)
}

const ENTRY = { index: '../src/build/build-rag-index.js', eval: '../src/eval/run.js', calibrate: '../src/eval/calibrate.js' }
process.argv = [process.argv[0], process.argv[1], ...rest]
globalThis.__ASK_AI_SETTINGS__ = resolved
await import(ENTRY[cmd])
