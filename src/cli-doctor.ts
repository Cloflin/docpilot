/**
 * `docpilot doctor` — the command whose whole job is to explain a configuration
 * without building anything with it.
 *
 * WHY IT IS HERE AND NOT IN `bin/docpilot.js`. It was 428 lines of the
 * launcher, which made it the largest thing in this package living outside
 * TypeScript, outside the `run*` contract that `import.ts:328-330` writes down,
 * and outside the flag check every other command runs: `flagErrors('doctor',
 * ['--bogus'])` has always returned a complete message naming `--proxy
 * --embed --models`, and nobody printed it, so a typed `--proxyy` produced not
 * one line of output about itself and the command exited on project readiness
 * instead of on what it had been asked to do.
 *
 * THE CONTRACT TAKES TWO EXTRA FIELDS, and both are facts the launcher holds
 * that no callee can re-derive:
 *
 *   · `configPath` — the file the settings came from. `doctor` prints it on its
 *     first line, and a command that went looking for it a second time would be
 *     free to answer differently from the launcher that loaded it.
 *   · `settings` — the settings BEFORE `resolveDocPilot`. `embedChoices`
 *     resolves them itself against each candidate embedder, so handing it an
 *     already-resolved object would show every choice through the first one.
 *
 * IT RETURNS A CODE AND NEVER EXITS, for the reason the contract gives: a
 * function that ends the process cannot be unit-tested, and this one has a
 * `--json` shape and three network-touching flags worth testing.
 */
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import {
  readiness,
  provisionalGuardNote,
  indexDirOf,
  proxyContract,
  chatModels,
  embedModels,
  poolProviderOf,
  resolveChain,
  resolveChatChain,
  nodeChatTarget,
  resolveEmbed,
  resolveTuning,
  capsOf,
} from './config.js'
import { embedChoices, indexCommandFor } from './embed-choices.js'
import { probeEmbedEndpoint, probeLocalEmbedders } from './build/lib/embed-discovery.js'
import { inspectChatTarget } from './build/lib/chat-preflight.js'
import { providerFor } from './theme/docpilot/providers.js'
import { toolSchemas } from './theme/docpilot/llm.js'
import { flagErrors, flagGiven } from './cli-flags.js'

/**
 * @param {{docPilot: any, settings: any, argv: string[], env: Record<string,string|undefined>, configPath: string|null}} opts
 * @returns {Promise<number>} an exit code
 */
/**
 * ONE REQUEST, ASKING ONLY WHETHER IT WOULD BE ROUTED.
 *
 * The body is built by the ADAPTER, from the same arguments the transport
 * passes — `extraBody` carries OpenRouter's `provider.require_parameters`, and
 * `tuning` carries whatever `chat.reasoning` resolved to — so what goes out here
 * differs from a real turn's request only in its messages and its ceiling. That
 * is the whole point: a probe that sends a simpler body proves nothing about the
 * body the panel sends.
 *
 * Never throws. A doctor that dies on an unreachable host reports nothing about
 * the twelve things it had already checked.
 */
async function probeBody(adapter, target, model, extra) {
  const body = {
    ...adapter.body({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      streaming: false,
      maxTokens: 1,
      tuning: target.tuning,
      extraBody: target.extraBody,
      tools: null,
      schemaBody: null,
      continuing: false,
      ...extra,
    }),
    // Whatever the adapter's own ceiling field was, one token is all this needs
    // — the answer is the STATUS, and a refusal arrives before generation.
    stream: false,
  }
  try {
    const res = await fetch(adapter.chatUrl(target.baseURL), {
      method: 'POST',
      headers: adapter.headers(target.apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    if (res.ok) return { ok: true }
    const text = await res.text().catch(() => '')
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      /* an HTML error page — the sentence is whatever text holds */
    }
    const said = String(payload?.error?.message || payload?.message || text || '').trim()
    const step = payload?.error?.metadata?.failed_routing_step || ''
    const kind =
      step === 'Filter by Parameters' || /requested parameters|unsupported[_ ]parameter/i.test(said)
        ? 'params'
        : step === 'Filter by Guardrails' || /zdr|data policy|guardrail/i.test(said)
          ? 'policy'
          : null
    return { ok: false, status: res.status, kind, reason: said.split('\n')[0].slice(0, 200) }
  } catch (e) {
    return { ok: false, status: 0, kind: null, reason: String(e?.message || e) }
  }
}

export async function runDoctor({ docPilot, settings = {}, argv = [], env = {} as Record<string, string | undefined>, configPath = null }) {
  /**
   * THE CHECK THIS COMMAND NEVER RAN.
   *
   * `flagErrors` has known `doctor`'s three flags since the table was written.
   * The command read `rest.includes('--proxy')` instead, so `--proxyy` was not
   * a flag it had, was not a flag it refused, and was not a flag it mentioned:
   * it ran the bare report and exited on readiness. Usage errors are `2`.
   */
  const [bad] = flagErrors('doctor', argv)
  if (bad) {
    console.error(`[docpilot] ${bad}`)
    return 2
  }
  const given = (name) => flagGiven('doctor', argv, name.replace(/^--/, ''))

  const ready = readiness(docPilot, env)

  /**
   * One column for every value, so the block reads as a table rather than as a
   * list of sentences that happen to start alike.
   *
   * `[docpilot] ` plus a ten-wide label lands every value at column 21, which is
   * what `PAD` is — the continuation lines are indented to the column their
   * parent's value starts at, not to a count somebody typed. Held by hand, it
   * drifted: `chat` and `embed` were padded to nine and printed one column short
   * of `config`, `index` and `ready`, which is close enough to read as a
   * rendering fault rather than as two labels of different lengths.
   */
  /**
   * `--json` — THE WHOLE OF STDOUT IS ONE OBJECT.
   *
   * `docs/reference/cli.md` documents this command as a CI gate and it answered
   * only in prose, so gating on it meant grepping a report whose wording is not
   * a contract. Under the flag every `say` becomes a no-op and the object below
   * is the only thing on stdout; the diagnosis still goes to stderr, so
   * `doctor --json | jq .ready` shows the report to the operator and the answer
   * to the script.
   *
   * The EXIT CODE is unchanged, deliberately: `ready` in the object and the
   * code are the same verdict, and two ways to read one answer is one way for
   * them to disagree.
   */
  const json = given('--json')
  const say = (label, value) => {
    if (!json) console.log(`[docpilot] ${label.padEnd(10)}${value}`)
  }
  /** The same row, on the stream a refusal belongs on. */
  const err = (label, value) => {
    if (!json) console.error(`[docpilot] ${label.padEnd(10)}${value}`)
  }
  /**
   * The continuation lines. Under `--json` they are the same no-op `say` is:
   * every one of them is a detail of a row, and the object carries the facts.
   */
  const line = (text) => {
    if (!json) console.log(text)
  }
  const PAD = ' '.repeat(21)

  say('config', configPath || 'none — shipped defaults + your environment')
  say('docs', docPilot.docsDir)
  say('index', indexDirOf(docPilot))

  /**
   * The one readiness note that lives in a built artefact rather than in the
   * config — so the fs read is here and the judgement is in `config.js`, where
   * it can be run without a project on disk. See `provisionalGuardNote`.
   */
  {
    const manifest = path.resolve(indexDirOf(docPilot), 'manifest.json')
    if (existsSync(manifest)) {
      let note = null
      try {
        note = provisionalGuardNote(JSON.parse(readFileSync(manifest, 'utf8')).guard)
      } catch {
        // An unreadable manifest is the build's fault to report, not this
        // line's to guess at. Every other check still runs.
      }
      if (note) ready.notes.push(note)
    }
  }

  /**
   * THE CHAIN, and this is the one command where it is printed unconditionally.
   *
   * The build log stays quiet about it when a provider is named, because a line
   * restating the config file is noise in a block people read at every start.
   * `doctor` is the opposite: it is run precisely when the question is "why is
   * it talking to THAT", and the answer — which variables are set and which
   * member of the chain they select — is not visible anywhere else. The key
   * VALUE is never printed, only the name of the variable.
   */
  {
    const { tried } = resolveChain(env)
    const chosen = docPilot.chat.provider
    /**
     * THE ROTATION ORDER, which is the question this command is run to answer
     * once `chat.chain` can name more than one service. `←` becomes an ordinal
     * so the order is readable at a glance; a single-member chain prints the
     * bare arrow it always did, because an ordinal on a list of one is noise.
     */
    const chain = resolveChatChain(docPilot, env)
    const at = new Map(chain.map((m, i) => [m.id, i + 1]))
    const many = chain.length > 1
    say(
      'chain',
      many
        ? `${docPilot.chat.providerAuto ? 'auto' : chosen} → ${chain.length} will answer, in order`
        : docPilot.chat.providerAuto
          ? `auto → ${chosen}`
          : `${chosen} (named in config)`,
    )
    for (const t of tried) {
      const mark = t.found ? '✓' : '·'
      const n = at.get(t.id)
      // `←` on a row that nothing selected would read as a contradiction — the
      // dot says "not set" and the arrow says "this one". Name it instead: that
      // row is where the walk LANDED rather than what it matched.
      const here = !n
        ? ''
        : many
          ? ` ← ${n}`
          : t.found
            ? ' ←'
            : ' ←  nothing matched — fall-through'
      line(
        `${PAD}${mark} ${t.id.padEnd(12)}${(t.envKey || 'no key needed').padEnd(22)}${here}`.trimEnd(),
      )
    }
    /**
     * A member a key selected and the chain did not take, and WHY — a silent
     * drop is exactly the "why is it not talking to that" this block exists to
     * answer.
     *
     * There are two reasons and they want different sentences. Since 1.4.0
     * `chat.chain` ships `false`, so the ordinary one is that nobody asked for a
     * walk: every key but the head's is simply not in the set, which is not a
     * fault and is fixed by writing `chain: 'auto'`. The other is the one this
     * line was written for — the chain WAS being built and `resolveChatChain`
     * dropped a member because there is nothing to send it. Printing the second
     * sentence for the first case reads as a defect in a provider that has a
     * perfectly good default.
     */
    const walking = Array.isArray(docPilot.chat.chain) || (docPilot.chat.chain === 'auto' && docPilot.chat.providerAuto)
    for (const t of tried) {
      if (t.found && !at.has(t.id)) {
        line(
          `${PAD}  ${''.padEnd(12)}${''.padEnd(22)}${
            walking ? 'skipped — no model and no pool' : "not asked — chat.chain is false; write 'auto' to walk it"
          }`,
        )
      }
    }
  }

  /**
   * WHAT THIS SERVICE WILL ACTUALLY DO WITH YOUR KNOBS.
   *
   * A capability matrix is worth nothing if reading it means opening the source,
   * and the one fact nobody can get anywhere else is the WIRE NAME each setting
   * turns into — `chat.maxTokens` is `options.num_predict` on Ollama and
   * `max_completion_tokens` on GPT-5, and an author debugging a request they can
   * see in a network tab has no way to connect it back to what they wrote.
   *
   * Read from the same two records the transport translates from — the adapter's
   * `supports` and the brand's `caps` — so this cannot drift from the behaviour
   * it describes. No network, no flag, and it NEVER changes the exit code: a
   * knob this provider ignores is news, not a broken configuration.
   */
  try {
    const adapter = providerFor(nodeChatTarget(docPilot, env).provider)
    const caps = capsOf(docPilot.chat.provider) || {}
    const tuning = resolveTuning(docPilot)
    const chat = docPilot.chat
    line('')
    say('knobs', `${docPilot.chat.provider} · ${adapter.id} adapter`)

    const wire = (knob, value, field) => {
      if (value == null) return
      if (field) line(`${PAD}✓ ${knob.padEnd(12)}${String(value).padEnd(9)}→ ${field}`)
      else line(`${PAD}· ${knob.padEnd(12)}${String(value).padEnd(9)}NOT honoured by ${docPilot.chat.provider}`)
    }

    // Reasoning first, and it prints even at its default, because "what does
    // 'auto' do here" is the question this whole feature raises.
    if (tuning.style === 'none') {
      line(`${PAD}· reasoning   ${String(chat.reasoning === false ? 'false' : 'auto').padEnd(9)}${caps.mandatory ? `${docPilot.chat.provider} cannot turn reasoning off` : 'not offered by this provider'}`)
    } else {
      const asked = chat.reasoning && typeof chat.reasoning === 'object' ? chat.reasoning.effort : null
      const shown = chat.reasoning === false ? 'false' : (asked ?? 'auto')
      const field = {effort: 'reasoning_effort', unified: 'reasoning:{}', thinking: 'thinking', think: 'think'}[tuning.style]
      const moved = asked && tuning.effort && tuning.effort !== asked ? `  CLAMPED to '${tuning.effort}' — ${docPilot.chat.provider} has no '${asked}'` : ''
      /**
       * `'auto'` WRITES NOTHING, and saying otherwise is what this line used to
       * do. The adapter emits a reasoning field only when the record asks for
       * something — an effort, a budget, or `off` — so an unset `chat.reasoning`
       * puts no such key on the wire at all. Printing `→ reasoning:{}` for it
       * described the one configuration that is guaranteed NOT to narrow
       * OpenRouter's routing as though it were the one that does.
       */
      const writes = Boolean(tuning.effort || tuning.off || tuning.budgetTokens != null)
      if (!writes) {
        line(`${PAD}· ${'reasoning'.padEnd(12)}${String(shown).padEnd(9)}no reasoning field is sent`)
      } else {
        line(`${PAD}✓ ${'reasoning'.padEnd(12)}${String(shown).padEnd(9)}→ ${field}${moved}`)
      }
    }

    wire('temperature', chat.temperature, caps.temperature === false ? null : adapter.supports?.temperature)
    wire('maxTokens', chat.maxTokens, adapter.supports?.maxTokens)
    wire('numCtx', chat.numCtx, adapter.supports?.numCtx)
    wire('verbosity', chat.verbosity, tuning.verbosity != null ? adapter.supports?.verbosity : null)
    wire('topP', chat.topP, tuning.topP != null ? adapter.supports?.topP : null)
    wire('seed', chat.seed, tuning.seed != null ? adapter.supports?.seed : null)

    // The ceiling field is model-docPilot, so it is the one line that can differ
    // between two models on the SAME provider — and the one that turns every
    // request into a 400 when it is wrong.
    if (adapter.id !== 'ollama' && adapter.id !== 'anthropic' && chat.model) {
      const field = /(^|\/)(o[1-9](\b|-)|gpt-5|codex-mini)/i.test(chat.model) ? 'max_completion_tokens' : 'max_tokens'
      if (field !== 'max_tokens') line(`${PAD}  ${chat.model} takes ${field}, not max_tokens`)
    }

    if (caps.unknown) {
      line(`${PAD}! ${docPilot.chat.provider} names a host, not a service — DocPilot cannot know what`)
      line(`${PAD}  your gateway accepts, so every knob above is sent as written`)
    } else if (caps.modelDependent && tuning.style !== 'none') {
      line(`${PAD}! support varies by model here — a level is sent and the service decides`)
    }
    /**
     * The interaction nobody would predict, and the one that turns an answerable
     * question into "no provider available" on a thin free pool.
     *
     * `tuning.effort` WAS THE CONDITION and it was the wrong one. `off` is a
     * reasoning parameter too — `chat.reasoning: false` puts `{enabled: false}`
     * on the wire, which is a field an endpoint either publishes or does not,
     * and `require_parameters` filters on its presence rather than its value. So
     * the deployed configuration that spent every first request of every turn on
     * a 404 was exactly the one this line stayed silent for. `budgetTokens` is
     * the third spelling and was missed the same way.
     */
    const asksReasoning = tuning.style !== 'none' && (tuning.effort || tuning.off || tuning.budgetTokens != null)
    if (asksReasoning && docPilot.chat.extraBody?.provider?.require_parameters !== false) {
      line(`${PAD}! reasoning + provider.require_parameters narrows routing a second time`)
      if (tuning.off) {
        line(`${PAD}  reasoning: false SENDS a parameter — leave it unset to send none`)
      }
    }

    /**
     * THE BLOCK ABOVE IS THE HEAD'S, and on a chain it is one member's answer to
     * a question the reader asked about the deployment. Every member clamps the
     * same neutral vocabulary to its own service, so a knob this one honours can
     * be dropped by the next — and a knob nobody can see dropped is the
     * "documented setting whose only reachable value is its default" defect,
     * arriving one level up.
     *
     * One line per member that differs, and nothing at all when they agree.
     */
    const chain = resolveChatChain(docPilot, env)
    if (chain.length > 1) {
      const shown = ['effort', 'verbosity', 'topP', 'seed', 'budgetTokens']
      for (const m of chain.slice(1)) {
        const t = resolveTuning(docPilot, m.id)
        const dropped = shown.filter((k) => tuning[k] != null && t[k] == null)
        const off = t.style === 'none' && tuning.style !== 'none'
        if (!dropped.length && !off) continue
        const what = [...dropped, ...(off ? ['reasoning'] : [])].join(', ')
        line(`${PAD}  ${m.id.padEnd(12)}drops ${what}`)
      }
    }
  } catch (e) {
    /**
     * A CONFIGURATION THE RESOLVER REFUSES IS A FINDING, NOT A CRASH.
     *
     * `nodeChatTarget` throws on a provider it cannot resolve, and it was
     * called bare — above the readiness branch, so a bad `chat.provider` ended
     * this command in a stack trace. The command whose entire job is to explain
     * a broken configuration was the thing that broke on one, and it broke
     * BEFORE printing the readiness block that would have named the fault.
     *
     * So it is caught, printed as a row like every other finding, and the rest
     * of the diagnosis runs. The exit code is still `readiness`'s to decide.
     */
    line('')
    // The resolver's own message already wears the prefix; a row that carried
    // it twice would read as a rendering fault rather than as a finding.
    say('knobs', `cannot resolve this provider — ${e.message.replace(/^\[docpilot\] /, '')}`)
    line(`${PAD}the readiness block below says what is missing`)
    if (env.DOCPILOT_DEBUG === '1') console.error(e.stack)
  }

  /**
   * `--proxy` prints the contract a production reverse proxy has to satisfy.
   *
   * The dev server gets `/ai/*` for free from the Vite plugin; a BUILT site does
   * not, and `vitepress preview` has no proxy at all — which is the point in the
   * deployment where the panel stops working and nothing says why. Printing the
   * resolved routes beats shipping one deployment's nginx.conf as a template:
   * the paths, the upstreams and the header name are facts of this
   * configuration, and the TLS termination and the process manager are not.
   *
   * The KEY is never printed. Only the name of the variable carrying it.
   */
  if (given('--proxy')) {
    const contract = proxyContract(docPilot, env)
    line('')
    for (const r of contract.routes) {
      say('proxy', r.path)
      line(`${PAD}→ ${r.upstream}${r.rewrite}`)
      const cred = r.keyless ? 'no key needed' : r.envKey ? `<${r.envKey}>` : 'NO KEY — none set'
      line(`${PAD}${r.header}: ${cred}`)
      if (r.local) line(`${PAD}! LOCAL ADDRESS — a deployed proxy cannot reach it`)
    }
    /**
     * The members with NO route — a local Ollama, which the browser calls at its
     * own address. Printed under their own label because a five-member chain
     * showing four routes and no account of the fifth reads as a bug here.
     */
    for (const d of contract.direct) {
      say('direct', `${d.provider} → ${d.baseURL}`)
      line(`${PAD}! the browser calls this itself — no proxy route, and none possible`)
    }
    if (contract.routes.length) {
      for (const n of contract.notes) line(`  · ${n}`)
    } else {
      // Printing four rules for a proxy that does not exist reads as four things
      // left undone.
      say('proxy', 'none needed — every provider is called directly')
    }
    line('')
  }
  /**
   * `--embed` — the same list `npx docpilot index` asks from, printed instead of
   * asked.
   *
   * It exists because the asking half needs a terminal and the reader who most
   * needs the answer often has not got one: an agent driving this package, a CI
   * log, a reader who wants to see the options before committing to a build. So
   * the choices are a report here and a prompt there, out of one function.
   *
   * IT TOUCHES THE NETWORK, and only localhost. `probeLocalEmbedders` asks the
   * Ollama on this machine whether it is running, which is free and which no
   * amount of reading config files can answer. No hosted provider is contacted
   * and no metered request is spent — that is `--models`.
   */
  if (given('--embed')) {
    const choices = embedChoices(settings, env, { probed: await probeLocalEmbedders(env) })
    line('')
    choices.forEach((c, i) => {
      // The cross is the whole point of the row it is on: with nothing in the
      // environment the chain still ends at its shipped fallback, and a list
      // that offered that without saying it would 401 is the same silence this
      // flag was added to end.
      say('embed', `${i + 1}. ${c.label}${c.ready ? '' : '   ✗ cannot run here'}`)
      line(`${PAD}${c.hint}`)
      // The command that takes this answer, spelled out — an agent reading this
      // should not have to infer the flags from the label.
      line(`${PAD}npx docpilot index ${indexCommandFor(c)}`)
    })
    if (!choices.some((c) => c.ready && c.source !== 'lexical')) {
      line('')
      line(`${PAD}Nothing here can embed. Either put a provider key in .env.local, or`)
      line(`${PAD}run \`ollama serve\` and \`ollama pull bge-m3\` and ask again.`)
    }
    line('')
  }

  /**
   * `--models` is the only thing in this command that reaches a THIRD PARTY —
   * `--embed` above touches the network too, but never past localhost — and it
   * is a flag rather than a default for that reason: `doctor` runs in CI, and
   * a check that fails when a third party is slow is a check that gets removed.
   *
   * What it answers is the one question a baked list cannot answer for itself —
   * whether the free ids this package shipped with are still being served. They
   * are retired weekly. A pool whose members have all been retired fails in the
   * least legible way available: every model 404s in turn and the reader is told
   * the last one's name.
   */
  if (given('--models')) {
    const { fetchFreePool } = await import('./theme/docpilot/openrouter.js')
    line('')
    for (const [half, shipped] of [
      ['chat', chatModels(docPilot)],
      ['embed', embedModels(docPilot)],
    ]) {
      if (!shipped?.length) continue
      // Only where a catalogue exists to be asked. `chatModels` also returns an
      // author's own list on a provider that publishes nothing, and checking a
      // list of OpenAI ids against OpenRouter's catalogue reports every one of
      // them retired.
      const provider = poolProviderOf(docPilot, half)
      if (!provider) {
        say(half, `${shipped.length} model(s), no catalogue to check them against`)
        continue
      }
      // `fallback: false`: the merged list contains the baked one by
      // construction, so asking "which of ours is gone" of it always answers
      // "none" — the check would be a check that cannot fail.
      const live = await fetchFreePool(half, { fallback: false })
      if (!live) {
        say(half, `${provider}'s catalogue is unreachable — cannot check`)
        continue
      }
      const gone = shipped.filter((m) => !live.includes(m))
      const fresh = live.filter((m) => !shipped.includes(m))
      say(half, `${shipped.length} in the pool, ${live.length} free upstream`)
      if (gone.length) line(`${PAD}RETIRED: ${gone.join(', ')}`)
      if (fresh.length) line(`${PAD}new upstream: ${fresh.slice(0, 6).join(', ')}`)
      if (!gone.length && !fresh.length) line(`${PAD}the shipped pool matches the catalogue`)
    }

    /**
     * THE NAMED MODEL, checked against the service's own list.
     *
     * The pool check above answers "are the free ids we shipped still served",
     * which was the only question worth asking while `chat.model` had one
     * shipped value. Every provider carries its own default now, and a default
     * ages exactly the way a free id does — `gpt-4o-mini` is a name in a table
     * in this package, not a promise from OpenAI. The failure it produces is a
     * 404 naming a model that appears nowhere in the reader's config, which is
     * the same illegible failure the pool check exists to prevent.
     *
     * Asked of `/v1/models` — or Ollama's `/api/tags`, which lists what has been
     * PULLED, the honest local equivalent — through the adapter, so there is no
     * second copy of a path here. Every failure is reported as a failure to
     * check rather than as a verdict: a catalogue that is unreachable, a key
     * that is not set, a provider with no directly-callable base (Gemini serves
     * its compatible surface under a rewrite the browser's `/ai` hides and a
     * Node tool has nothing to hide it with).
     */
    const target = nodeChatTarget(docPilot, env)
    if (!target.models?.length && target.model) {
      const adapter = providerFor(target.provider)
      const url = adapter.modelsUrl?.(target.baseURL)
      const hosted = target.id !== 'ollama'
      if (!target.baseURL || !url) {
        say('model', `${target.model} — ${target.id} publishes no list this can read`)
      } else if (hosted && !target.apiKey) {
        say('model', `${target.model} — no key set, cannot ask ${target.id}`)
      } else {
        /**
         * ONE PROBE, IN ONE PLACE. This block used to hold its own `fetch`,
         * its own error handling and its own idea of what a missing model
         * means, and it got local servers wrong in both directions: it judged
         * llama.cpp's placeholder against a catalogue it is not in, and it
         * advised an Ollama user to "upgrade the package" when the thing to do
         * is pull the model. `inspectChatTarget` answers all of it and never
         * throws — see src/build/lib/chat-preflight.js for why it may not.
         */
        const seen = await inspectChatTarget(target)
        const extra = []
        if (seen.capabilities) {
          extra.push(`tools ${seen.capabilities.tools ? 'yes' : 'no'}`)
          extra.push(`thinking ${seen.capabilities.thinking ? 'yes' : 'no'}`)
        }
        if (seen.contextLength) extra.push(`ctx ${seen.contextLength}`)

        if (seen.verdict === 'placeholder') {
          // Not a failure and not a name to fix: this service answers with the
          // weights it was started with, whatever the config says.
          say('model', `${target.id} serves whatever it loaded${seen.loaded ? ` — ${seen.loaded}` : ''}`)
          line(`${PAD}chat.model is a placeholder here and is ignored${extra.length ? ` · ${extra.join(' · ')}` : ''}`)
        } else if (seen.verdict === 'served') {
          say('model', `${target.model} — ${hosted ? `served by ${target.id}` : `pulled by ${target.id}`}`)
          if (extra.length) line(`${PAD}${extra.join(' · ')}`)
        } else if (seen.verdict === 'not-served') {
          const n = seen.serves.length
          say('model', `${target.model} — NOT ${hosted ? `in ${target.id}'s list of ${n}` : `pulled by ${target.id} (${n} available)`}`)
          // The ACTIONABLE line, and it differs by service. Nothing an author
          // types fixes a local server that has not downloaded the weights.
          if (hosted) line(`${PAD}name one in chat.model, or upgrade the package`)
          else if (target.modelAuto) line(`${PAD}${target.id} pull ${target.model}   — or name one you have in chat.model`)
          else line(`${PAD}${target.id} pull ${target.model}`)
        } else if (seen.serves === null) {
          say('model', `${target.model} — cannot reach ${target.id}`)
        } else {
          say('model', `${target.model} — ${target.id} returned no list`)
        }
      }
    }

    /**
     * ── AND THE ONE QUESTION A CATALOGUE CANNOT ANSWER: WILL IT TAKE THIS BODY?
     *
     * Everything above compares NAMES against a list. `openai/gpt-4o-mini` is in
     * OpenRouter's catalogue, so every check above it prints "served by
     * openrouter" — and every request the panel actually makes to it answers
     * 404, because the catalogue lists the model and routing decides on the
     * endpoint. Two faults measured live on this package's own deployment, both
     * invisible to a listing:
     *
     *   · the body named `reasoning` (from `chat.reasoning`) and no endpoint for
     *     this model publishes that parameter — `Filter by Parameters`;
     *   · the ACCOUNT's ZDR / data-policy settings excluded every endpoint the
     *     model has — `Filter by Guardrails`, fixable only at
     *     openrouter.ai/settings/privacy.
     *
     * So this posts the two bodies the panel really sends — a tool-calling loop
     * step, and the forced final answer with its strict `response_format` — and
     * reports what came back. THROUGH THE ADAPTER, so there is no second copy of
     * the body shape here: the thing under test is precisely that this package's
     * own request is acceptable, and a hand-written approximation would test a
     * request nobody makes.
     *
     * `max_tokens: 1` and no streaming: this is asking whether the request is
     * ROUTABLE, not what the model would say. A refusal arrives before any
     * tokens are generated, so the probe costs a request and almost nothing else.
     */
    if (target.baseURL && (target.id === 'ollama' || target.apiKey)) {
      const adapter = providerFor(target.provider)
      const candidates = [target.model, ...(target.models || [])].filter(
        (m, i, all) => m && all.indexOf(m) === i,
      )
      if (candidates.length && adapter.chatUrl) {
        line('')
        for (const model of candidates) {
          for (const [shape, extra] of [
            ['search step', { tools: toolSchemas(null), enableThink: false }],
            [
              'final answer',
              {
                schemaBody: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    citations: { type: 'array', items: { type: 'string' } },
                    confidence: { type: 'number' },
                  },
                  required: ['text', 'citations', 'confidence'],
                  additionalProperties: false,
                },
                enableThink: true,
              },
            ],
          ]) {
            const outcome = await probeBody(adapter, target, model, extra)
            const label = `${model} · ${shape}`
            if (outcome.ok) say('body', `${label} — accepted`)
            else {
              say('body', `${label} — ${outcome.status} ${outcome.kind || 'refused'}`)
              if (outcome.reason) line(`${PAD}${outcome.reason}`)
              if (outcome.kind === 'params') {
                line(`${PAD}the panel retries this smaller at runtime; unset chat.reasoning to avoid it`)
              } else if (outcome.kind === 'policy') {
                line(`${PAD}an ACCOUNT setting, not a config one — openrouter.ai/settings/privacy`)
              }
            }
          }
        }
      }
    }

    /**
     * DOES THE CHAT PROVIDER EMBED AFTER ALL?
     *
     * `PROVIDERS` carries `embedModel: null` for anthropic, groq, deepseek, xAI
     * and cerebras, and that is a claim rather than a law: the same table
     * asserted for months that OpenRouter ships no embeddings endpoint, which
     * was true when it was written and silently wrong afterwards. The cost of
     * the claim going stale is paid every build — `embed: 'auto'` borrows
     * OpenRouter's free pool, so the deployment needs a SECOND key and posts the
     * text of the whole corpus to a third party.
     *
     * So it is checked, here, where checking is free. It cannot be acted on
     * automatically: the proxy that carries `/ai/v1/embeddings` is written from
     * `resolveEmbed()` at config time, synchronously, with no network — so a
     * build that decided mid-flight to embed somewhere else would leave every
     * reader's query vector posted to the wrong upstream. This reports; the
     * author writes the one line.
     *
     * Silent when the endpoint does not answer, which is the expected case and
     * the one nobody needs told. Skipped outright for an adapter with no
     * embeddings path at all — Anthropic — because there is nowhere to knock.
     */
    const embedNow = resolveEmbed(docPilot)
    if (embedNow.borrowed && target.baseURL) {
      const adapter = providerFor(target.provider)
      const url = adapter.embedUrl?.(target.baseURL)
      const probe = adapter.embedUrl && url ? await probeEmbedEndpoint(target) : null
      if (probe) {
        say('embed?', `${target.id} answers ${url.replace(target.baseURL, '')} after all — ${probe}`)
        line(`${PAD}embed: {provider: '${target.id}'} drops the borrowed ${embedNow.provider} key`)
      }
    }
    line('')
  }

  /**
   * THE OBJECT, when `--json` was given — and it is the WHOLE of stdout.
   *
   * The keys are the rows above, named the way the rows are: nothing here is a
   * second computation, and `ready` is the same `readiness()` the exit code is
   * taken from. Every value is a fact of the configuration; no key holds a
   * secret, which is the same rule the prose obeys — variable NAMES, never
   * values.
   */
  if (json) {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(
      JSON.stringify(
        {
          version,
          configPath,
          docsDir: docPilot.docsDir,
          indexDir: indexDirOf(docPilot),
          chat: {
            provider: docPilot.chat.provider,
            model: docPilot.chat.model ?? null,
            providerAuto: Boolean(docPilot.chat.providerAuto),
            chain: resolveChatChain(docPilot, env).map((m) => m.id),
          },
          embed: (() => {
            const e = resolveEmbed(docPilot)
            return { provider: e.provider ?? null, borrowed: Boolean(e.borrowed) }
          })(),
          ready: ready.ok,
          missing: ready.missing.map((m) => ({ what: m.what, fix: m.fix })),
          notes: ready.notes,
        },
        null,
        2,
      ),
    )
  }

  if (ready.ok) {
    say('ready', 'yes — the panel will render')
    for (const n of ready.notes) line(`  · ${n}`)
    return 0
  }
  /**
   * THE VERDICT THAT IS NOT THE PRODUCT.
   *
   * Everything above went to stdout because it is what the reader asked for; a
   * refusal is diagnostics, and clig.dev's rule for diagnostics is stderr. It
   * matters here in particular: `docs/reference/cli.md` documents this command
   * as a CI gate, and a gate whose failure text lands in the same stream as its
   * report cannot be piped to `jq` on the way past.
   */
  err('ready', `NO — ${ready.missing.length} to fix\n`)
  if (!json) {
    for (const m of ready.missing) console.error(`  · ${m.what}\n      ${m.fix}`)
    for (const n of ready.notes) console.error(`  · ${n}`)
  }
  // Exit 1 so CI can gate on it. The BUILD never fails for these; `doctor` is
  // the opt-in place to turn the same facts into a failure.
  return 1
}
