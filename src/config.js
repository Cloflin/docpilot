import {readFileSync} from 'node:fs'
import path from 'node:path'

/**
 * Ask AI plumbing. NO SETTINGS LIVE HERE — the `askAI` object in ./config.mjs is
 * the one anyone edits, and every function below takes it as an argument.
 *
 * What this file owns is the part that is the same whatever you choose: where
 * each provider lives, which environment variable carries its key, how a request
 * is rewritten on the way out, and which of the three resolved views a caller
 * needs — the client half, the dev proxy, or the direct Node target the indexer
 * uses. Keys are read here and never returned to anything client-bound.
 */
/**
 * `embedModel` is the service's own embedding model — what `embed: 'auto'`
 * picks so that ONE provider covers both halves. Absent means the service ships
 * no embeddings endpoint at all, which is the majority: inference-only hosts
 * almost never have one, OpenRouter routes chat and nothing else, and Anthropic
 * has never had one.
 *
 * These names are defaults, not guarantees — catalogues change. A wrong one
 * fails loudly on the first chunk of `npm run rag:index`, not silently at
 * runtime, so verify against the provider's current list when you switch.
 */
const openaiCompatible = (upstream, envKeys, extra = {}) => ({
    adapter: 'openai',
    upstream,
    directBase: upstream,
    envKeys,
    rewrite: (path) => path.replace(/^\/ai/, ''),
    header: (k) => ({authorization: `Bearer ${k}`}),
    embedModel: null,
    ...extra,
})

const PROVIDERS = {
    // ── chat and embeddings: one provider is enough ──────────────────────────
    openai: openaiCompatible('https://api.openai.com', ['OPENAI_API_KEY'], {
        embedModel: 'text-embedding-3-small',
    }),
    together: openaiCompatible('https://api.together.xyz', ['TOGETHER_API_KEY'], {
        embedModel: 'BAAI/bge-large-en-v1.5',
    }),
    fireworks: openaiCompatible('https://api.fireworks.ai/inference', ['FIREWORKS_API_KEY'], {
        embedModel: 'nomic-ai/nomic-embed-text-v1.5',
    }),
    mistral: openaiCompatible('https://api.mistral.ai', ['MISTRAL_API_KEY'], {
        embedModel: 'mistral-embed',
    }),
    nebius: openaiCompatible('https://api.studio.nebius.com', ['NEBIUS_API_KEY'], {
        embedModel: 'BAAI/bge-en-icl',
    }),

    // ── chat only ────────────────────────────────────────────────────────────
    // OpenRouter is here, not above: it routes chat completions and has no
    // embeddings endpoint. Choosing it as the single provider hits the same wall
    // that took the panel down.
    openrouter: openaiCompatible('https://openrouter.ai/api', ['OPENROUTER_API_KEY']),
    deepseek: openaiCompatible('https://api.deepseek.com', ['DEEPSEEK_API_KEY']),
    groq: openaiCompatible('https://api.groq.com/openai', ['GROQ_API_KEY']),
    xai: openaiCompatible('https://api.x.ai', ['XAI_API_KEY']),
    cerebras: openaiCompatible('https://api.cerebras.ai', ['CEREBRAS_API_KEY']),

    // The escape hatch. Assumed to embed, because a self-hosted vLLM or a
    // gateway usually serves both; set embedModel to what it actually offers.
    custom: openaiCompatible('http://localhost:8000', ['CUSTOM_API_KEY'], {
        embedModel: 'BAAI/bge-m3',
    }),

    // ── the two that are not plain OpenAI clones ─────────────────────────────
    gemini: openaiCompatible('https://generativelanguage.googleapis.com', ['GEMINI_API_KEY'], {
        rewrite: (path) => path.replace(/^\/ai\/v1/, '/v1beta/openai'),
        directBase: null,
        embedModel: 'text-embedding-004',
    }),
    anthropic: {
        adapter: 'anthropic',
        upstream: 'https://api.anthropic.com',
        directBase: 'https://api.anthropic.com',
        envKeys: ['ANTHROPIC_API_KEY'],
        rewrite: (path) => path.replace(/^\/ai/, ''),
        header: (k) => ({'x-api-key': k, 'anthropic-version': '2023-06-01'}),
        embedModel: null,
    },
}

export const PROVIDER_IDS = ['ollama', ...Object.keys(PROVIDERS)]

const LOCAL_BASE_URL = 'http://localhost:11434'
const LOCAL_EMBED_MODEL = 'bge-m3'

const hostedOf = (id) => PROVIDERS[id] || null

const canEmbed = (id) => (id === 'ollama' ? true : Boolean(PROVIDERS[id]?.embedModel))

/**
 * The embedder, resolved.
 *
 * `embed: 'auto'` — the default, and the reason a single-provider setup needs no
 * second decision: the chat provider embeds too, with its own model. Any object
 * is an explicit split, for when the chat provider cannot embed (Anthropic,
 * DeepSeek, Groq, OpenRouter …) or when its key is scoped to chat models only.
 *
 * There is no third option. Dropping the embedder was measured on this corpus:
 * recall@8 0.97 → 0.41, retrieval F1 0.35 → 0.18, and 11 of 44 answerable
 * questions refused outright. Reproduce with `npm run rag:eval -- --gate-only
 * --lexical`.
 */
export function resolveEmbed(askAI) {
    const e = askAI.embed
    if (e && typeof e === 'object') return e

    const id = askAI.chat.provider
    return {
        provider: id,
        model: id === 'ollama' ? LOCAL_EMBED_MODEL : PROVIDERS[id]?.embedModel,
        baseURL: LOCAL_BASE_URL,
        auto: true,
    }
}

function keyOf(env, id) {
    const hosted = hostedOf(id)
    if (!hosted) return null
    for (const name of hosted.envKeys) if (env[name]) return env[name]
    return null
}

export function providerKey(env, id) {
    return keyOf(env, id)
}

/**
 * The embed target as the INDEXER sees it: no proxy, so the real host, and the
 * key in hand. `baseURL` comes back null for a provider the adapters cannot
 * reach directly — Gemini, whose compatible surface lives at `/v1beta/openai`
 * while the adapter builds `${baseURL}/v1/…`. The `/ai` rewrite hides that in
 * the browser; a Node tool has nothing to hide it with.
 */
export function nodeEmbedTarget(askAI, env = {}) {
    assertProviders(askAI)
    const embed = resolveEmbed(askAI)
    const hosted = hostedOf(embed.provider)
    return {
        id: embed.provider,
        provider: hosted ? hosted.adapter : 'ollama',
        baseURL: hosted ? hosted.directBase : embed.baseURL || LOCAL_BASE_URL,
        model: embed.model,
        apiKey: keyOf(env, embed.provider),
    }
}

/** A configured half — chat or embed — as the client half sees it. */
function targetOf({provider, baseURL}) {
    const hosted = hostedOf(provider)
    return {
        // The client knows adapters, not brands: gemini and openrouter ARE the
        // openai adapter, differing by host, model and key — none of which the
        // browser sees, because all three arrive through the same `/ai`.
        provider: hosted ? hosted.adapter : 'ollama',
        baseURL: hosted ? '/ai' : baseURL || LOCAL_BASE_URL,
    }
}

/**
 * The empty-state questions — UI-SPEC §13.
 *
 * An ARRAY OF STRINGS, and deliberately not an array of objects. A `{label,
 * question}` pair was the obvious richer shape and is refused: the row submits
 * on activation, so a label that differs from the question means the reader
 * watches a question they did not read appear in the thread. The row is already
 * truncated to one line by CSS, which is the problem `label` would have solved.
 *
 * Empty is the meaningful default, not a placeholder: it hands the slot back to
 * DEFAULT_SUGGESTIONS in AskAi.vue, which is what "fall back to the built-in
 * three" means at runtime. There is no `null` and no `false` — an empty array
 * and an absent key behave identically, so there is nothing to remember.
 *
 * Normalisation rather than a throw. A bad entry here is a typo in copy, and
 * failing a docs build over one is out of proportion when the fallback is three
 * working questions. Every drop is named on stdout, because the alternative is
 * a reader seeing two rows where three were configured and nobody knowing why.
 */
const SUGGESTION_LIMIT = 3

export function resolveSuggestions(askAI, warn = console.warn) {
    const raw = askAI.suggestions
    if (raw == null) return []
    if (!Array.isArray(raw)) {
        warn(`[ask-ai] suggestions must be an array of strings, got ${typeof raw} — using the built-in three`)
        return []
    }

    const clean = []
    for (const [i, entry] of raw.entries()) {
        if (typeof entry !== 'string') {
            warn(`[ask-ai] suggestions[${i}] is ${typeof entry}, not a string — dropped`)
            continue
        }
        const q = entry.trim().replace(/\s+/g, ' ')
        if (!q) {
            warn(`[ask-ai] suggestions[${i}] is empty — dropped`)
            continue
        }
        if (clean.includes(q)) {
            warn(`[ask-ai] suggestions[${i}] repeats an earlier one — dropped`)
            continue
        }
        clean.push(q)
    }

    // No silent cap. The component slices at three; saying so here is the
    // difference between a design decision and a bug the author cannot see.
    if (clean.length > SUGGESTION_LIMIT) {
        warn(
            `[ask-ai] ${clean.length} suggestions configured, ${SUGGESTION_LIMIT} shown — ` +
                `dropping: ${clean.slice(SUGGESTION_LIMIT).map((q) => `"${q}"`).join(', ')}`,
        )
    }
    return clean.slice(0, SUGGESTION_LIMIT)
}

/** The client half: safe to compile into the bundle, carries no credential. */
export function themeAskAI(askAI, env = {}) {
    assertProviders(askAI)
    const chat = targetOf(askAI.chat)
    const embedCfg = resolveEmbed(askAI)
    const embed = targetOf(embedCfg)
    return {
        enabled: askAI.enabled,
        llm: {
            provider: chat.provider,
            baseURL: chat.baseURL,
            model: askAI.chat.model,
            temperature: askAI.chat.temperature,
        },
        embed: {
            provider: embed.provider,
            baseURL: embed.baseURL,
            model: embedCfg.model,
        },
        topK: askAI.topK,
        maxIterations: askAI.maxIterations,
        // Was missing, and its absence is why `askAI.suggestions` looked like a
        // setting that did nothing: AskAi.vue has read `config.suggestions` with
        // a built-in fallback since it shipped, and UI-SPEC §13 has documented
        // the key — but nothing ever put it in the object the client receives,
        // so the fallback was the only branch that could ever run.
        suggestions: resolveSuggestions(askAI),
        prompt: {...askAI.prompt},
    }
}

/**
 * The server half: the key is attached here, in Node, and never reaches the
 * page. `vitepress preview` has no proxy — a built site expects nginx in front.
 */
export function devProxy(askAI, env = {}) {
    assertProviders(askAI)
    const routes = {}
    // Most specific first. Vite matches proxy keys by prefix in insertion order,
    // so the embeddings route has to be declared before the catch-all `/ai` or a
    // split setup would send both halves to the chat provider.
    route(routes, '/ai/v1/embeddings', resolveEmbed(askAI).provider, env)
    route(routes, '/ai', askAI.chat.provider, env)
    return Object.keys(routes).length ? routes : undefined
}

function route(routes, path, providerId, env) {
    const hosted = hostedOf(providerId)
    if (!hosted) return // a local provider is called directly, with no proxy
    const key = keyOf(env, providerId)
    routes[path] = {
        target: hosted.upstream,
        changeOrigin: true,
        rewrite: hosted.rewrite,
        configure(proxy) {
            proxy.on('proxyReq', (proxyReq) => {
                if (!key) return
                for (const [name, value] of Object.entries(hosted.header(key))) {
                    proxyReq.setHeader(name, value)
                }
            })
        },
    }
}

/**
 * Where the built index lives, resolved against the CONSUMER's project rather
 * than this package.
 *
 * `new URL(..., import.meta.url)` is what this line used to be, back when the
 * code sat inside the site it served. In a package that resolves inside
 * node_modules, which is both wrong and silently wrong: `indexInfo()` returns
 * null, the startup line reads "none on disk", and the advice is to run an
 * indexer that has in fact already run.
 */
export function indexDirOf(askAI) {
    return askAI.indexDir || path.join(askAI.docsDir, 'public', 'rag')
}

export function manifestPathOf(askAI) {
    return path.resolve(indexDirOf(askAI), 'manifest.json')
}

function indexInfo(askAI) {
    try {
        const m = JSON.parse(readFileSync(manifestPathOf(askAI), 'utf8'))
        return {embedModel: m.embedModel, chunkCount: m.chunkCount, hash: m.hash, dims: m.dims}
    } catch {
        return null
    }
}

/**
 * Both failures here are silent at runtime — a misspelled id becomes a local
 * Ollama nobody is running, and a chat-only service answers a question and 404s
 * a vector — so they stop the build instead. A config file is read at build
 * time; that is the only moment anyone is looking.
 */
const EMBEDDERS = () => ['ollama', ...Object.keys(PROVIDERS).filter((id) => canEmbed(id))].join(' / ')

function assertKnown(half, id) {
    if (id === 'ollama' || PROVIDERS[id]) return
    throw new Error(
        `[ask-ai] ${half}.provider "${id}" is not a provider this build knows.\n` +
            `  Pick one of: ${PROVIDER_IDS.join(', ')}\n` +
            '  — or add it to PROVIDERS in docs/.vitepress/ask-ai.config.mjs. Anything that\n' +
            '  copied the OpenAI API is one line: openaiCompatible(host, [KEY_ENV_VAR]).',
    )
}

/**
 * Both failures here are silent at runtime — a misspelled id becomes a local
 * Ollama nobody is running, and a chat-only service answers a question and 404s
 * a vector — so they stop the build instead. A config file is read at build
 * time; that is the only moment anyone is looking.
 */
function assertProviders(askAI) {
    assertKnown('chat', askAI.chat.provider)

    const embed = resolveEmbed(askAI)
    assertKnown('embed', embed.provider)

    if (canEmbed(embed.provider) && embed.model) return

    // Under `auto` the chat provider was asked to do both and cannot. Say which
    // of the two ways out applies rather than name the failure abstractly.
    if (embed.auto) {
        throw new Error(
            `[ask-ai] embed: 'auto' follows chat.provider "${embed.provider}", which has no\n` +
                '  embeddings endpoint — it answers, it does not retrieve. Either pick a chat\n' +
                `  provider that does both (${EMBEDDERS()}), or split the two:\n` +
                "    embed: {provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434'}\n" +
                '  then rebuild the index with `npm run rag:index`.',
        )
    }

    throw new Error(
        `[ask-ai] embed.provider "${embed.provider}" has no embeddings endpoint — it can\n` +
            `  answer, not retrieve. Point embed at a service that can: ${EMBEDDERS()}\n` +
            '  — then rebuild the index with `npm run rag:index`.',
    )
}

function keyNameOf(env, id) {
    const hosted = hostedOf(id)
    if (!hosted) return null
    return hosted.envKeys.find((name) => env[name]) || null
}

function promptSummary(askAI) {
    const p = askAI.prompt || {}
    const chars = (s) => `${String(s).trim().length} chars`
    const base = p.override?.trim() ? `OVERRIDE (${chars(p.override)})` : 'shipped'
    const extend = p.extend?.trim() ? ` + extend (${chars(p.extend)})` : ''
    const disclosure = p.show ? (p.allowAppend ? 'shown, reader may append' : 'shown') : 'hidden'
    return `${base}${extend} · disclosure ${disclosure}`
}

function describe(cfg, env) {
    const hosted = hostedOf(cfg.provider)
    const route = hosted ? `/ai → ${hosted.upstream}` : cfg.baseURL || LOCAL_BASE_URL
    const name = keyNameOf(env, cfg.provider)
    const key = !hosted ? 'no key needed' : name ? `key ${name}` : `NO KEY — set ${hosted.envKeys[0]}`
    return `${`${cfg.provider}/${cfg.model}`.padEnd(28)} ${route.padEnd(46)} ${key}`
}

/**
 * What this build will actually do, printed once at startup. The settings are
 * spread over a config file, an index on disk and a key in the environment, and
 * every way they can disagree is silent at runtime — so the resolved answer is
 * stated where anyone starting the server will read it. No key value is ever
 * printed, only the name of the variable it came from.
 */
/**
 * One startup block, and the only place the reader of a build log learns what
 * was actually resolved.
 *
 * `ready` is optional so the function keeps working for a caller that has not
 * computed readiness — but when it is present and failing, this prints the
 * whole of the unconfigured story and returns. Nothing throws: `npm install`
 * must not be able to break a docs build that was fine a minute ago, which is
 * the single rule the unconfigured path is designed around.
 */
export function logAskAI(askAI, env = {}, ready = null) {
    if (!askAI.enabled) {
        console.log('[ask-ai] disabled by configuration')
        return
    }
    if (ready && !ready.ok) {
        console.warn(`\n[ask-ai] the panel is OFF — ${ready.missing.length} thing${ready.missing.length === 1 ? '' : 's'} to set up:\n`)
        for (const m of ready.missing) console.warn(`  · ${m.what}\n      ${m.fix}`)
        for (const n of ready.notes) console.warn(`  · ${n}`)
        console.warn(`\n  The site builds and every other feature is untouched. ${ready.hint}\n`)
        return
    }
    assertProviders(askAI)

    const embed = resolveEmbed(askAI)
    console.log(`[ask-ai] chat   ${describe(askAI.chat, env)}`)
    console.log(`[ask-ai] embed  ${describe(embed, env)}${embed.auto ? '   (auto)' : ''}`)

    const idx = indexInfo(askAI)
    if (!idx) {
        console.log('[ask-ai] index  none on disk — run `npm run rag:index`')
    } else {
        const mismatch =
            idx.embedModel === embed.model
                ? ''
                : `  ← MISMATCH with embed.model "${embed.model}": retrieval will be lexical-only`
        console.log(
            `[ask-ai] index  ${idx.embedModel} · ${idx.dims}d · ${idx.chunkCount} chunks · ${idx.hash}${mismatch}`,
        )
    }

    console.log(
        `[ask-ai] turn   topK ${askAI.topK} · maxIterations ${askAI.maxIterations} · ` +
            `temperature ${askAI.chat.temperature}`,
    )
    console.log(`[ask-ai] prompt ${promptSummary(askAI)}`)
    // Which of the two sources is in force. The whole point of the key is that
    // the built-in three stop being invisible defaults nobody chose.
    const sugg = resolveSuggestions(askAI)
    console.log(
        `[ask-ai] empty  ${sugg.length ? `${sugg.length} configured suggestion${sugg.length === 1 ? '' : 's'}` : 'built-in suggestions'}`,
    )
}

/**
 * Defaults, and the one place a setting's shipped value is stated.
 *
 * `maxIterations: 2` is measured, not chosen: the host primes the turn with the
 * gate's own excerpts, and `buildMessages` re-sends every accumulated
 * observation on every step, so the cost of a turn grows with the square of its
 * steps rather than with the evidence in it. At 2, with num_ctx 8192: 5.9k
 * prompt tokens and 0.7k output per turn. The project this was extracted from
 * shipped 20 against a comment arguing for 2, and the tail of that — twenty
 * steps of quadratic re-send against an 8192-token window — is the context
 * being silently shifted out from under the system block.
 *
 * `prompt.show: false` because the disclosure publishes the instruction
 * verbatim, and a project should opt into that having read what it says.
 */
export const DEFAULTS = {
    enabled: true,
    /** Where the VitePress site lives, relative to the project root. */
    docsDir: 'docs',
    /** Defaults to `${docsDir}/public/rag`. Set it only if you moved the index. */
    indexDir: null,
    chat: {provider: 'ollama', model: 'qwen3:8b', temperature: 0.2},
    embed: 'auto',
    topK: 12,
    maxIterations: 2,
    suggestions: [],
    prompt: {show: false, allowAppend: false, override: null, extend: ''},
}

/** Settings with defaults filled in. Nested objects merge; `embed` does not. */
export function resolveAskAI(settings = {}, env = {}) {
    return {
        ...DEFAULTS,
        ...settings,
        chat: {...DEFAULTS.chat, ...(settings.chat || {})},
        // `embed` is a union — the string 'auto' or an object — so a spread
        // would turn 'auto' into an object of numbered characters.
        embed: settings.embed ?? DEFAULTS.embed,
        prompt: {...DEFAULTS.prompt, ...(settings.prompt || {})},
    }
}

/**
 * Is this installation actually able to answer a question? — the whole of the
 * "installed via npm into a project with an empty .env" behaviour.
 *
 * IT NEVER THROWS, AND THAT IS THE POINT. `assertProviders` stops a build over
 * a misspelled provider, which is right for a project that has configured this
 * on purpose and wrong for the first `npm install`: a dependency that can fail
 * someone else's docs build the moment it lands is a dependency they remove.
 * So the build proceeds, the panel is switched off, and one block on stdout
 * says what is missing and the command that fixes it.
 *
 * Three classes of missing, deliberately separated, because they have three
 * different fixes and reporting them as one "not configured" teaches nobody
 * anything:
 *   · a provider id that does not exist, or a chat-only service asked to embed
 *   · a hosted provider with no key in the environment
 *   · no index on disk — the one that a correct configuration still hits, and
 *     the only one whose fix is a command rather than an edit
 */
export function readiness(askAI, env = {}) {
    const missing = []
    const notes = []

    if (!askAI.enabled) {
        return {ok: false, disabled: true, missing: [], notes: [], hint: 'Set `enabled: true` to turn it back on.'}
    }

    try {
        assertProviders(askAI)
    } catch (e) {
        missing.push({
            what: 'the chat or embedding provider cannot be used as configured',
            fix: String(e.message || e).split('\n').join('\n      '),
        })
        // Every check below reads a resolved provider, so there is nothing
        // further worth saying until this one is fixed.
        return {ok: false, missing, notes, hint: 'See https://github.com/stripo/vitepress-plugin-ask-ai#providers'}
    }

    const embed = resolveEmbed(askAI)
    for (const [half, id] of [['chat', askAI.chat.provider], ['embed', embed.provider]]) {
        const hosted = hostedOf(id)
        if (!hosted) continue // ollama needs no key
        if (keyOf(env, id)) continue
        missing.push({
            what: `${half}: "${id}" needs a key and none is set`,
            fix: `export ${hosted.envKeys[0]}=… (or put it in .env.local and pass loadEnv('', process.cwd(), '') to defineAskAI)`,
        })
    }

    const idx = indexInfo(askAI)
    if (!idx) {
        missing.push({
            what: `no index at ${indexDirOf(askAI)}`,
            fix: 'npx ask-ai index',
        })
    } else if (idx.embedModel !== embed.model) {
        // Not fatal to the build, but fatal to retrieval: a query scored
        // against a foreign vector space is not a worse answer, it is no
        // answer, and the calibrated gate starts refusing answerable questions.
        missing.push({
            what: `the index was built with "${idx.embedModel}" but embed.model is "${embed.model}"`,
            fix: 'npx ask-ai index   (or change embed.model back to the one that built it)',
        })
    }

    if (askAI.prompt.override) {
        notes.push(
            'a prompt override is configured — re-run `npx ask-ai calibrate`, ' +
                'because the gate thresholds were measured against the shipped instruction',
        )
    }

    return {
        ok: missing.length === 0,
        missing,
        notes,
        hint: 'Run `npx ask-ai doctor` to re-check without a full build.',
    }
}
