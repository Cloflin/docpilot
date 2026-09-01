/**
 * The pure half of the embedder question — everything `npx docpilot index` has
 * to KNOW before it can ask, with nothing that needs a terminal or a network.
 *
 * WHY THIS FILE EXISTS. The machinery that picks an embedder has been complete
 * for a while and is entirely silent. `CHAIN` walks the providers and takes the
 * first one the environment carries a key or an address for; `resolveChain`
 * already returns the whole walk, member by member, with the variable that
 * selected each; `loadEnvironment` in bin/docpilot.js reads `.env.local` the way
 * the build reads it; `canEmbed` knows which of those providers has an
 * embeddings endpoint at all. Every ingredient of "you have an OpenAI key, so
 * this index will be built with OpenAI" was already computed — and never said.
 *
 * So a reader who put `OPENAI_API_KEY` in `.env.local` was not told it was being
 * used, and a reader who put nothing anywhere was not told that the Ollama on
 * their own machine would do. This turns that resolution into a LIST: what the
 * config file says, what the environment offers, what is running locally, and
 * the lexical-only build that needs none of them.
 *
 * IT DECIDES; bin/docpilot.js ASKS. The same split `src/cli-init.ts` documents
 * for the placement questions, and for the same reason: `bin/` owns stdin, and
 * a decision that needs a TTY to be tested is a decision nothing tests.
 *
 * NO NETWORK HERE. Liveness is somebody else's answer — `probeEmbedEndpoint` in
 * src/build/lib/embed-discovery.js — and it arrives as the `probed` option. This
 * file stays synchronous and pure so the whole table can be asserted against a
 * fake environment.
 */
import path from 'node:path'

import {
    canEmbed,
    indexDirOf,
    nodeEmbedTarget,
    resolveChain,
    resolveDocPilot,
    PROVIDER_IDS,
} from './config.js'

/**
 * The providers a live probe may speak for, and the only ones it is allowed to.
 *
 * `probeEmbedEndpoint` sends a REAL embedding request. On a metered service that
 * is a billed call, and on OpenRouter's free tier it is one of fifty in a day —
 * spent to answer a question the presence of a key already answers. So a hosted
 * provider is offered on the strength of its key and nothing else, and the probe
 * is reserved for the three entries that have no key to be found by: a local
 * server is either running or it is not, and offering an Ollama that nobody
 * started is worse than not offering one.
 *
 * Which is also the case this whole file was asked for: nothing configured
 * anywhere, so propose the Ollama that is already on the machine.
 */
export const PROBEABLE = ['ollama', 'custom', 'llamacpp']

/** `nvidia/nemotron-3-embed-1b:free` → `nvidia-nemotron-3-embed-1b-free`. */
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()

/**
 * What a choice resolves to, or null when the combination is not one.
 *
 * `nodeEmbedTarget` asserts before it resolves, which is what makes it the right
 * reader here rather than `resolveEmbed`: `embed: {provider: 'anthropic'}` is a
 * build-stopping error, and a list that offered it would be offering a build
 * that cannot run. A candidate that throws is simply not a candidate.
 */
function describe(base, embed, env) {
    try {
        return nodeEmbedTarget({ ...base, embed }, env)
    } catch {
        return null
    }
}

/** The model a choice will actually embed with — or the head of its pool. */
const modelOf = (target) => target?.model || target?.models?.[0] || null

/** A server on the reader's own machine, so an address rather than a credential. */
const isLocal = (id) => PROBEABLE.includes(id)

/**
 * Can this choice actually run, right now, in this environment?
 *
 * The distinction the list was missing and needed most. With nothing configured
 * anywhere `CHAIN` ends at its fallback — OpenRouter — and that is the shipped
 * answer whether or not a key for it exists, so the first row of an empty
 * project named a provider the build would 401 on. Offering it silently is the
 * same silence this file was written to end, one layer further in.
 */
const readyOf = (target) =>
    Boolean(target?.lexicalOnly || target?.apiKey || isLocal(target?.id))

/**
 * One line naming a choice, in the words a reader can check against their own
 * files: the provider, the model, and — for a local server — where it is.
 */
function labelOf(target) {
    if (!target || target.lexicalOnly) return 'lexical only — no embedder'
    const model = modelOf(target) || '(the provider picks)'
    const where =
        target.id === 'ollama' || target.id === 'custom' || target.id === 'llamacpp'
            ? `  @ ${target.baseURL}`
            : ''
    return `${target.id} / ${model}${where}`
}

/**
 * What makes two choices the same choice.
 *
 * The config file naming OpenAI and `OPENAI_API_KEY` sitting in `.env.local` are
 * one option presented twice, and a numbered list with the same answer at 1 and
 * 3 is a list that makes a reader doubt they understood the question. Compared
 * on the RESOLVED target rather than on what was written, because `embed: 'auto'`
 * and `embed: {provider: 'openai'}` are the same build.
 */
const signatureOf = (target) =>
    target?.lexicalOnly ? 'lexical' : `${target?.id}::${tagless(modelOf(target))}::${target?.baseURL}`

/**
 * `bge-m3` and `bge-m3:latest` are one model, and Ollama answers to both.
 *
 * Which matters exactly here: the table's default for Ollama is the bare name,
 * `/api/tags` returns the tagged one, and without this the list offered the same
 * embedder twice — once because the environment names the server, once because
 * the server said what it had pulled. Two rows, one build, and a reader left
 * wondering which of them is the real one.
 *
 * Only a trailing `:latest` is stripped. `qwen3-embedding:q8_0` is a different
 * set of weights and belongs on its own row.
 */
const tagless = (model) => (model ? String(model).replace(/:latest$/, '') : model)

/**
 * Where an OVERRIDE writes its index, which is never on top of the current one
 * by default.
 *
 * The index is bound to the embedder that built it, and rebuilding it at the
 * current path with a different one leaves the deployed panel reading an index
 * its own config does not describe. How badly that shows depends on what the
 * config says, which is the part worth knowing:
 *
 *   · The config NAMES a model — `embedderMatchesIndex` in session.js compares
 *     it with `manifest.embedModel`, logs the mismatch and drops retrieval to
 *     lexical-only. Loud, and the panel is still degraded.
 *   · The config leaves the model unnamed — a pool, or `embed: 'auto'` — and
 *     there is nothing to compare. The only remaining check is vector WIDTH, so
 *     two different models of the same width score queries against a foreign
 *     vector space and NOTHING reports it.
 *
 * A separate directory is the same move docs/.vitepress/config.mjs already makes
 * for its local builds — `rag-${DOCPILOT_EMBED_MODEL}` — and it leaves the
 * shipped index where the deployed site can still read it.
 */
export function overrideIndexDir(base, target) {
    const dir = indexDirOf(base).replace(/[\\/]+$/, '')
    const name = slug(`${target?.id ?? 'lexical'}-${modelOf(target) ?? ''}`)
    return `${dir}-${name}`
}

/**
 * THE LIST — the config file's answer first, then the environment's, then what
 * is running locally, then the build that needs none of them.
 *
 * `settings` is the AUTHOR's object and not the resolved one, deliberately:
 * "there is no `embed` key in config.mjs" and "`embed` is written there as
 * `'auto'`" are different sentences to a reader even though they resolve
 * identically, and the first entry says which one it is.
 *
 * @param {object} settings  the `docPilot` export, as written
 * @param {Record<string, string|undefined>} env  the environment the build reads
 * @param {{probed?: Array<{id: string, model?: string|null, baseURL?: string|null}>}} [opts]
 *   what a live probe found — see `PROBEABLE` for why the list is short
 */
export function embedChoices(settings = {}, env = {}, { probed = [] } = {}) {
    const base = resolveDocPilot(settings, env)
    const out = []
    const seen = new Map()

    const add = (choice) => {
        const target = describe(base, choice.embed, env)
        if (!target) return
        const key = signatureOf(target)
        const already = seen.get(key)
        if (already) {
            // Not a second row — a second REASON on the row that is already
            // there. "The config names OpenAI" and "OPENAI_API_KEY is set" are
            // both worth knowing and they are one option, and the reader who has
            // to check their own files wants the variable's NAME.
            if (choice.envKey && !already.envKey) {
                already.envKey = choice.envKey
                already.hint = `${already.hint} (${choice.envKey})`
            }
            if (choice.source === 'local' && !already.probed) {
                already.probed = true
                already.hint = `${already.hint} — answered a probe`
            }
            return
        }
        const ready = readyOf(target)
        const entry = {
            ...choice,
            target,
            ready,
            label: labelOf(target),
            model: modelOf(target),
            provider: target.id,
            indexDir: overrideIndexDir(base, target),
            // Said on the row rather than left for the build to discover on its
            // first chunk, which is where it used to surface as a 401.
            hint: ready ? choice.hint : `${choice.hint} — NO KEY for it here, this build would fail`,
        }
        seen.set(key, entry)
        out.push(entry)
    }

    // ── 1. what the config file says, whatever it says ──────────────────────
    // Always first and always the default answer, so pressing Enter changes
    // nothing — which is the only honest default for a question asked on every
    // build.
    add({
        key: 'config',
        source: 'config',
        embed: 'embed' in settings ? settings.embed : 'auto',
        hint:
            'embed' in settings
                ? 'as written in your config'
                : 'no `embed` in your config — resolved from the environment',
    })

    // ── 2. every provider the environment carries a key or an address for ───
    // `resolveChain` is the walk `chat.provider: 'auto'` already performs, and
    // reading it here rather than re-deriving it is what keeps the offer and the
    // resolution the same answer.
    for (const t of resolveChain(env).tried) {
        if (!t.found || !canEmbed(t.id)) continue
        /**
         * OLLAMA CARRIES ITS ADDRESS, and nothing else here has to.
         *
         * `OLLAMA_BASE_URL` both SELECTS ollama in the chain and says where it
         * is — but `nodeEmbedTarget` reads `embed.baseURL || LOCAL_BASE_URL` for
         * a provider with no table row and never consults the variable, which is
         * the trap docs/.vitepress/config.mjs writes out in full where it names
         * `embed.baseURL` explicitly. Left off, this row would offer a localhost
         * that the environment has just said is somewhere else.
         */
        add({
            key: t.id,
            source: 'env',
            embed:
                t.id === 'ollama' && env[t.envKey]
                    ? { provider: t.id, baseURL: env[t.envKey] }
                    : { provider: t.id },
            envKey: t.envKey,
            hint: `${t.envKey} is set in your environment`,
        })
    }

    // ── 3. what answered a probe, having named itself nowhere ───────────────
    // The case with nothing configured at all: an Ollama on the machine, found
    // by asking it. `model` comes from the probe when it has one, because for
    // these three the table's name is this package guessing what somebody else
    // loaded.
    for (const p of probed) {
        if (!PROBEABLE.includes(p.id)) continue
        const embed = {
            provider: p.id,
            ...(p.model ? { model: p.model } : null),
            ...(p.baseURL ? { baseURL: p.baseURL } : null),
        }
        add({
            key: `probe:${p.id}`,
            source: 'local',
            embed,
            probed: true,
            hint: 'running locally, answered a probe — no API requests, no key',
        })
    }

    // ── 4. no embedder at all ───────────────────────────────────────────────
    // Last, and never dropped: it is the one build that needs nothing, and on a
    // machine with no key and no local server it is the only one that works.
    add({
        key: 'lexical',
        source: 'lexical',
        embed: false,
        hint: 'BM25 only — zero requests, weaker retrieval',
    })

    return out
}

/**
 * `--embed-provider=openai --embed-model=text-embedding-3-large`, and the two
 * that go with them.
 *
 * PASS-THROUGH BY DEFAULT, which is the difference from `parseUiFlags`. `index`
 * has flags of its own — `--dry`, `--no-embed`, `--html-dir=` — that this parser
 * has no business knowing about, so anything unrecognised is handed back in
 * `rest` untouched. Only a misspelling of one of OURS is an error, because
 * `--embed-provdier=openai` silently building with the config's embedder is
 * exactly the failure this whole file exists to end.
 */
export function parseEmbedFlags(argv = []) {
    const out = { embed: null, indexDir: null, yes: false, rest: [], unknown: [] }
    const named = {}
    for (const arg of argv) {
        if (arg === '--yes' || arg === '-y') {
            out.yes = true
            continue
        }
        const m = /^--(embed-provider|embed-model|embed-base-url|index-dir)=(.*)$/.exec(arg)
        if (m) {
            named[m[1]] = m[2]
            continue
        }
        // Ours if it is spelled like ours, and then it is wrong rather than
        // somebody else's.
        if (/^--(embed-|index-dir)/.test(arg)) {
            out.unknown.push(arg)
            continue
        }
        out.rest.push(arg)
    }

    if (named['index-dir']) out.indexDir = named['index-dir']

    const provider = named['embed-provider']
    if (provider != null) {
        if (provider === 'false' || provider === 'none' || provider === 'lexical') {
            out.embed = false
        } else if (!PROVIDER_IDS.includes(provider)) {
            out.unknown.push(`--embed-provider=${provider}`)
        } else if (!canEmbed(provider)) {
            out.unknown.push(`--embed-provider=${provider}`)
        } else {
            out.embed = { provider }
            if (named['embed-model']) out.embed.model = named['embed-model']
            if (named['embed-base-url']) out.embed.baseURL = named['embed-base-url']
        }
    } else if (named['embed-model'] || named['embed-base-url']) {
        // A model with no provider is not a sentence: it would be read against
        // whatever the config happened to name, which is the drift this command
        // is being taught to prevent.
        out.unknown.push('--embed-model / --embed-base-url need --embed-provider')
    }

    return out
}

/**
 * THE RESOLVED FACTS, not the shorthand — what the index about to be written was
 * actually built with.
 *
 * `embed: 'auto'` and `embed: {provider: 'ollama'}` are complete settings and
 * incomplete RECORDS. `'auto'` re-resolves against whatever environment reads
 * it, so pasting it into a config would reproduce this build only on this
 * machine; an unnamed model is filled from the provider table, so the config
 * agrees with the index until that default changes underneath it. And an
 * unnamed model is precisely the case `embedderMatchesIndex` cannot check —
 * with no name on the config side there is nothing to compare — so naming it
 * here is what makes the mismatch detectable at all. Provider, model, and for a
 * local server the address.
 *
 * `embed: false` stays `false`: there is nothing to resolve, and that is the
 * whole of what it says.
 */
function concreteEmbed(choice) {
    if (choice.embed === false) return false
    const written = choice.embed && typeof choice.embed === 'object' ? choice.embed : {}
    const baseURL =
        written.baseURL || (isLocal(choice.provider) ? choice.target?.baseURL : null) || null
    return {
        provider: choice.provider,
        ...(choice.model ? { model: choice.model } : null),
        ...(baseURL ? { baseURL } : null),
    }
}

/** `{provider: 'ollama', model: 'bge-m3'}` as the lines you paste. */
function embedLiteral(embed) {
    if (embed === false) return ['    embed: false,']
    if (typeof embed === 'string') return [`    embed: '${embed}',`]
    const rows = Object.entries(embed).map(([k, v]) => `      ${k}: '${v}',`)
    return ['    embed: {', ...rows, '    },']
}

/**
 * What the reader has to paste for the runtime to agree with the index they are
 * about to build.
 *
 * The same contract `uiSnippet` states for the placement questions, and here it
 * is load-bearing rather than polite: the browser reads `docPilot.embed` out of
 * themeConfig, the index carries the model that built it, and a build that
 * changed one without the other is a deployment that runs lexical-only forever
 * with nothing failing anywhere. So the override is a two-part instruction and
 * this prints both parts — the embedder AND the directory it was written to.
 */
export function embedOverrideSnippet(choice, configPath, indexDir, currentDir) {
    const where = configPath ? `the \`docPilot\` settings in ${configPath}` : 'your `docPilot` settings'
    const dir = path.posix.normalize(String(indexDir).split(path.sep).join('/'))
    // `indexDir` is only half of the instruction when the index moved. Writing
    // it anyway when it did NOT move would tell a reader to pin the default,
    // which is a line their config does not need and a line that then ages.
    const moved = indexDir !== currentDir
    return [
        '  This build does NOT match your config. For the panel to read the index',
        `  it is about to write, ${where} have to say the same thing:`,
        '',
        ...embedLiteral(concreteEmbed(choice)),
        ...(moved ? [`    indexDir: '${dir}',`] : []),
        '',
        '  docpilot does not edit your config, so this one is yours to paste.',
        ...(moved
            ? [
                  '  Leave it unpasted and the deployed site keeps reading the index it',
                  '  already has — which is the safe outcome, not a broken one.',
              ]
            : [
                  '  This run OVERWRITES the index the deployed site reads, so unpasted',
                  '  it is a panel embedding queries with one model against an index',
                  '  built by another: lexical-only at best, and unreported when the',
                  '  config names no model to compare against.',
              ]),
    ].join('\n')
}

/**
 * The flags that pick this choice, spelled out.
 *
 * Shared with `doctor --embed` rather than formatted at the printer, because an
 * agent reading that output runs the line verbatim and a line that drops a field
 * runs a DIFFERENT build. The address is the field that matters: a local server
 * has no table row, so `nodeEmbedTarget` reads `embed.baseURL` and falls back to
 * localhost — `--embed-provider=ollama` alone would send a reader who named
 * `http://gpu.internal:11434` back to their own machine.
 */
export function indexCommandFor(choice) {
    // `none` names no model and no address, but it still WRITES — a lexical
    // rebuild at the current path replaces a vector index with one that has no
    // vectors — so it falls through to the directory rule below like any other
    // override rather than returning early past it.
    const parts =
        choice.provider == null ? ['--embed-provider=none'] : [`--embed-provider=${choice.provider}`]
    if (choice.provider != null && choice.model) parts.push(`--embed-model=${choice.model}`)
    if (choice.provider != null && isLocal(choice.provider) && choice.target?.baseURL) {
        parts.push(`--embed-base-url=${choice.target.baseURL}`)
    }
    /**
     * AN OVERRIDE CARRIES ITS OWN DIRECTORY, and this is the reason the field is
     * on the choice at all.
     *
     * `doctor --embed` prints these lines to be run verbatim — by a person, and
     * increasingly by an agent. A line that changed the embedder and left the
     * path alone would rebuild the index the deployed site reads with a model
     * its config does not name — lexical-only at best, and silent when the
     * config names no model for `embedderMatchesIndex` to compare against. The
     * interactive path defaults to the same separate directory; this is that
     * default, written down.
     */
    if (choice.source !== 'config') parts.push(`--index-dir=${choice.indexDir}`)
    return parts.join(' ')
}

/**
 * The question, built from the list. One question, because the second one is
 * only worth asking once the first has been answered against the config.
 *
 * `hints` is keyed by the option STRING, which is what `askOne` in
 * bin/docpilot.js indexes it by — the same shape `UI_QUESTIONS` carries, so the
 * asker did not have to learn a second one.
 */
export function embedQuestion(choices) {
    const options = choices.map((c) => c.label)
    const hints = {}
    for (const c of choices) hints[c.label] = c.hint
    return {
        key: 'embed',
        label: 'Which embedder should build this index?',
        options,
        hints,
        default: options[0],
    }
}

/**
 * Where to write an index built with something other than what the config names.
 *
 * Asked ONLY on an override, and defaulting to the separate directory for the
 * reason `overrideIndexDir` gives: overwriting is the answer that can break a
 * deployed site in silence, so it is available and it is not the default.
 */
export function indexDirQuestion(choice, currentDir) {
    const separate = `write to ${choice.indexDir}`
    const overwrite = `overwrite ${currentDir}`
    return {
        key: 'indexDir',
        label: 'This is not the embedder your config names. Where should the index go?',
        options: [separate, overwrite],
        hints: {
            [separate]: 'leaves the current index alone; needs two lines pasted into your config',
            [overwrite]: 'replaces the index the deployed site reads — only if you are changing the config too',
        },
        default: separate,
    }
}
