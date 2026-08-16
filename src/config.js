import {readFileSync, existsSync} from 'node:fs'
import path from 'node:path'

import {parseAllowlist} from './build/lib/sources.js'
// Pure data and pure functions — i18n.js imports no Vue, deliberately, so this
// Node-side module can validate the key table without pulling the theme in.
import {validateI18n, summariseI18n} from './theme/docpilot/i18n.js'
import {resolveUi} from './theme/docpilot/ui.js'
import {resolveFeedback} from './theme/docpilot/feedback.js'
// The adapters, for their PATHS only — `providerFor(...).chatUrl('/ai')` is the
// URL the browser posts to, so `proxyContract` reads it from here instead of
// keeping a second, silently drifting copy. The module imports nothing and
// touches the network only when a request function is called.
import {providerFor} from './theme/docpilot/providers.js'

/**
 * DocPilot plumbing. NO SETTINGS LIVE HERE — the `docPilot` object in ./config.mjs is
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
 * fails loudly on the first chunk of `npx docpilot index`, not silently at
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
 * questions refused outright. Reproduce with `npx docpilot eval --gate-only
 * --lexical`.
 */
export function resolveEmbed(docPilot) {
    const e = docPilot.embed
    if (e && typeof e === 'object') return e

    const id = docPilot.chat.provider
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
export function nodeEmbedTarget(docPilot, env = {}) {
    assertProviders(docPilot)
    const embed = resolveEmbed(docPilot)
    const hosted = hostedOf(embed.provider)
    return {
        id: embed.provider,
        provider: hosted ? hosted.adapter : 'ollama',
        baseURL: hosted ? hosted.directBase : embed.baseURL || LOCAL_BASE_URL,
        model: embed.model,
        apiKey: keyOf(env, embed.provider),
    }
}

/**
 * The chat target as a NODE TOOL sees it — the sibling of the one above.
 *
 * Same rule, same shape, different half: no `/ai` proxy exists outside the
 * browser, so the real host is named and the key travels with it. `docpilot
 * import` is the first caller; it runs the annotation pass against the model the
 * site is already configured for, rather than inventing a second place to say
 * which model this project uses.
 */
export function nodeChatTarget(docPilot, env = {}) {
    assertProviders(docPilot)
    const hosted = hostedOf(docPilot.chat.provider)
    return {
        id: docPilot.chat.provider,
        provider: hosted ? hosted.adapter : 'ollama',
        baseURL: hosted ? hosted.directBase : docPilot.chat.baseURL || LOCAL_BASE_URL,
        model: docPilot.chat.model,
        apiKey: keyOf(env, docPilot.chat.provider),
        maxTokens: docPilot.chat.maxTokens,
        numCtx: docPilot.chat.numCtx,
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
 * DEFAULT_SUGGESTIONS in DocPilot.vue, which is what "fall back to the built-in
 * three" means at runtime. There is no `null` and no `false` — an empty array
 * and an absent key behave identically, so there is nothing to remember.
 *
 * Normalisation rather than a throw. A bad entry here is a typo in copy, and
 * failing a docs build over one is out of proportion when the fallback is three
 * working questions. Every drop is named on stdout, because the alternative is
 * a reader seeing two rows where three were configured and nobody knowing why.
 */
const SUGGESTION_LIMIT = 3

export function resolveSuggestions(docPilot, warn = console.warn) {
    const raw = docPilot.suggestions
    if (raw == null) return []
    if (!Array.isArray(raw)) {
        warn(`[docpilot] suggestions must be an array of strings, got ${typeof raw} — using the built-in three`)
        return []
    }

    const clean = []
    for (const [i, entry] of raw.entries()) {
        if (typeof entry !== 'string') {
            warn(`[docpilot] suggestions[${i}] is ${typeof entry}, not a string — dropped`)
            continue
        }
        const q = entry.trim().replace(/\s+/g, ' ')
        if (!q) {
            warn(`[docpilot] suggestions[${i}] is empty — dropped`)
            continue
        }
        if (clean.includes(q)) {
            warn(`[docpilot] suggestions[${i}] repeats an earlier one — dropped`)
            continue
        }
        clean.push(q)
    }

    // No silent cap. The component slices at three; saying so here is the
    // difference between a design decision and a bug the author cannot see.
    if (clean.length > SUGGESTION_LIMIT) {
        warn(
            `[docpilot] ${clean.length} suggestions configured, ${SUGGESTION_LIMIT} shown — ` +
                `dropping: ${clean.slice(SUGGESTION_LIMIT).map((q) => `"${q}"`).join(', ')}`,
        )
    }
    return clean.slice(0, SUGGESTION_LIMIT)
}

/** The client half: safe to compile into the bundle, carries no credential. */
export function themeDocPilot(docPilot, env = {}) {
    assertProviders(docPilot)
    const chat = targetOf(docPilot.chat)
    const embedCfg = resolveEmbed(docPilot)
    const embed = targetOf(embedCfg)
    return {
        enabled: docPilot.enabled,
        llm: {
            provider: chat.provider,
            baseURL: chat.baseURL,
            model: docPilot.chat.model,
            temperature: docPilot.chat.temperature,
            maxTokens: docPilot.chat.maxTokens,
            numCtx: docPilot.chat.numCtx,
        },
        embed: {
            provider: embed.provider,
            baseURL: embed.baseURL,
            model: embedCfg.model,
        },
        topK: docPilot.topK,
        maxIterations: docPilot.maxIterations,
        product: docPilot.product,
        // These three were read by session.js from the day it shipped and were
        // never emitted, which is the same defect the `suggestions` note below
        // records: a documented knob whose only reachable value was its default.
        // `guard` overrides the calibrated thresholds in the manifest, `scope`
        // switches the picker off, `feedbackEndpoint` turns a vote into a POST.
        feedbackEndpoint: docPilot.feedbackEndpoint,
        // RESOLVED here and resolved again in the browser, on the same terms as
        // `ui`: the build is where a bad enum should be reported, because that
        // is where the author is looking, and `resolveFeedback` is idempotent so
        // the client's second pass changes nothing.
        feedback: resolveFeedback(docPilot),
        guard: {...docPilot.guard},
        scope: {...docPilot.scope},
        history: {...docPilot.history},
        // Was missing, and its absence is why `docPilot.suggestions` looked like a
        // setting that did nothing: DocPilot.vue has read `config.suggestions` with
        // a built-in fallback since it shipped, and UI-SPEC §13 has documented
        // the key — but nothing ever put it in the object the client receives,
        // so the fallback was the only branch that could ever run.
        suggestions: resolveSuggestions(docPilot),
        prompt: {...docPilot.prompt},
        // RESOLVED here, and resolved again in the browser — `resolveUi` is
        // idempotent for exactly this. The build is where a bad value should be
        // reported, because that is where the author is looking; the client
        // repeats the call because `session.configure` also receives the
        // `{enabled: false}` payload, which carries no `ui` at all.
        ui: resolveUi(docPilot),
        // Validated here, MERGED in the browser. themeConfig is inlined into
        // every page's hydration payload, so merging server-side would ship the
        // whole default tree — eighty UI strings plus eighteen languages of
        // reply copy — on every page. Only the delta crosses.
        i18n: validateI18n(docPilot.i18n),
    }
}

/**
 * The server half: the key is attached here, in Node, and never reaches the
 * page. `vitepress preview` has no proxy — a built site expects nginx in front.
 */
export function devProxy(docPilot, env = {}) {
    assertProviders(docPilot)
    const routes = {}
    // Most specific first. Vite matches proxy keys by prefix in insertion order,
    // so the embeddings route has to be declared before the catch-all `/ai` or a
    // split setup would send both halves to the chat provider.
    route(routes, '/ai/v1/embeddings', resolveEmbed(docPilot).provider, env)
    route(routes, '/ai', docPilot.chat.provider, env)
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
 * What a PRODUCTION reverse proxy has to do, stated rather than templated.
 *
 * `devProxy` covers `vitepress dev` and nothing else: a built site is static
 * files, `vitepress preview` has no proxy, and `/ai/*` 404s the moment the panel
 * asks a question. That is the point in a deployment where it stops working and
 * nothing says why, so `docpilot doctor --proxy` prints this.
 *
 * A shipped `nginx.conf` was the obvious alternative and is worse: it would be
 * right about the two paths and wrong about TLS termination, the resolver, the
 * process manager and the variable names, and a template that is 80% wrong is
 * harder to debug than a contract that is 100% short. These four facts are the
 * whole of what this package knows.
 *
 * The key VALUE never appears — only the name of the variable holding it.
 */
export function proxyContract(docPilot, env = {}) {
    assertProviders(docPilot)
    const embed = resolveEmbed(docPilot)
    const routes = []
    // Most specific first, exactly as in `devProxy`: a proxy matching by prefix
    // in declaration order would otherwise send embeddings to the chat provider.
    //
    // The paths are ASKED OF THE ADAPTER rather than written out here, because a
    // second copy of them drifts: written out, this printed
    // `/ai/v1/chat/completions` for Anthropic, whose adapter posts to
    // `/ai/v1/messages` — an exact-match proxy built to the contract 404s every
    // question, in production, on a provider the README lists as supported.
    for (const [half, id] of [
        ['embed', embed.provider],
        ['chat', docPilot.chat.provider],
    ]) {
        const hosted = hostedOf(id)
        if (!hosted) continue
        const adapter = providerFor(hosted.adapter)
        const p = half === 'embed' ? adapter.embedUrl('/ai') : adapter.chatUrl('/ai')
        const header = Object.keys(hosted.header('x'))[0]
        routes.push({
            path: p,
            provider: id,
            upstream: hosted.upstream,
            rewrite: hosted.rewrite(p),
            header,
            envKey: keyNameOf(env, id) || null,
        })
    }
    const notes = [
        'match these paths EXACTLY — a prefix match on /ai would proxy anything under it',
        'strip any client Authorization, x-api-key and Cookie before forwarding',
        'disable response buffering: the answer is streamed as server-sent events',
        'rate-limit by IP and set a request body ceiling — this endpoint spends money',
    ]
    if (routes.length) notes.push('allow only your own origin: the browser calls this same-origin')
    return {routes, notes}
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
export function indexDirOf(docPilot) {
    return docPilot.indexDir || path.join(docPilot.docsDir, 'public', 'rag')
}

export function manifestPathOf(docPilot) {
    return path.resolve(indexDirOf(docPilot), 'manifest.json')
}

function indexInfo(docPilot) {
    try {
        const m = JSON.parse(readFileSync(manifestPathOf(docPilot), 'utf8'))
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
        `[docpilot] ${half}.provider "${id}" is not a provider this build knows.\n` +
            `  Pick one of: ${PROVIDER_IDS.join(', ')}\n` +
            '  — or add it to PROVIDERS in @cloflin/docpilot/src/config.js. Anything that\n' +
            '  copied the OpenAI API is one line: openaiCompatible(host, [KEY_ENV_VAR]).',
    )
}

/**
 * Both failures here are silent at runtime — a misspelled id becomes a local
 * Ollama nobody is running, and a chat-only service answers a question and 404s
 * a vector — so they stop the build instead. A config file is read at build
 * time; that is the only moment anyone is looking.
 */
function assertProviders(docPilot) {
    assertKnown('chat', docPilot.chat.provider)

    const embed = resolveEmbed(docPilot)
    assertKnown('embed', embed.provider)

    if (canEmbed(embed.provider) && embed.model) return

    // Under `auto` the chat provider was asked to do both and cannot. Say which
    // of the two ways out applies rather than name the failure abstractly.
    if (embed.auto) {
        throw new Error(
            `[docpilot] embed: 'auto' follows chat.provider "${embed.provider}", which has no\n` +
                '  embeddings endpoint — it answers, it does not retrieve. Either pick a chat\n' +
                `  provider that does both (${EMBEDDERS()}), or split the two:\n` +
                "    embed: {provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434'}\n" +
                '  then rebuild the index with `npx docpilot index`.',
        )
    }

    throw new Error(
        `[docpilot] embed.provider "${embed.provider}" has no embeddings endpoint — it can\n` +
            `  answer, not retrieve. Point embed at a service that can: ${EMBEDDERS()}\n` +
            '  — then rebuild the index with `npx docpilot index`.',
    )
}

function keyNameOf(env, id) {
    const hosted = hostedOf(id)
    if (!hosted) return null
    return hosted.envKeys.find((name) => env[name]) || null
}

function promptSummary(docPilot) {
    const p = docPilot.prompt || {}
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
export function logDocPilot(docPilot, env = {}, ready = null) {
    if (!docPilot.enabled) {
        console.log('[docpilot] disabled by configuration')
        return
    }
    if (ready && !ready.ok) {
        console.warn(`\n[docpilot] the panel is OFF — ${ready.missing.length} thing${ready.missing.length === 1 ? '' : 's'} to set up:\n`)
        for (const m of ready.missing) console.warn(`  · ${m.what}\n      ${m.fix}`)
        for (const n of ready.notes) console.warn(`  · ${n}`)
        console.warn(`\n  The site builds and every other feature is untouched. ${ready.hint}\n`)
        return
    }
    assertProviders(docPilot)

    const embed = resolveEmbed(docPilot)
    console.log(`[docpilot] chat   ${describe(docPilot.chat, env)}`)
    console.log(`[docpilot] embed  ${describe(embed, env)}${embed.auto ? '   (auto)' : ''}`)

    const idx = indexInfo(docPilot)
    if (!idx) {
        console.log('[docpilot] index  none on disk — run `npx docpilot index`')
    } else {
        const mismatch =
            idx.embedModel === embed.model
                ? ''
                : `  ← MISMATCH with embed.model "${embed.model}": retrieval will be lexical-only`
        console.log(
            `[docpilot] index  ${idx.embedModel} · ${idx.dims}d · ${idx.chunkCount} chunks · ${idx.hash}${mismatch}`,
        )
    }

    console.log(
        `[docpilot] turn   topK ${docPilot.topK} · maxIterations ${docPilot.maxIterations} · ` +
            `temperature ${docPilot.chat.temperature}`,
    )
    console.log(`[docpilot] prompt ${promptSummary(docPilot)}`)
    // Printed only when something is configured: a line reading "0 origins" on
    // every build of every project that imports nothing is noise, and noise in
    // this block is what stops the six lines that matter from being read.
    const {entries} = parseAllowlist(docPilot.sources)
    if (docPilot.importDir || entries.length) {
        const origins = entries.length
            ? `${entries.length} allowed origin${entries.length === 1 ? '' : 's'}`
            : 'NO allowed origin — every `source:` will fail the build'
        console.log(`[docpilot] import ${docPilot.importDir || 'docs only'} · ${origins}`)
    }
    // Which of the two sources is in force. The whole point of the key is that
    // the built-in three stop being invisible defaults nobody chose.
    const sugg = resolveSuggestions(docPilot)
    console.log(
        `[docpilot] empty  ${sugg.length ? `${sugg.length} configured suggestion${sugg.length === 1 ? '' : 's'}` : 'built-in suggestions'}`,
    )
    // Same silence rule as i18n below: the shipped pair is what almost every
    // build has, and a line restating it is noise. Printed the moment either
    // half is chosen, because "the FAB did not appear" is otherwise debugged
    // against a build log that never mentions the setting.
    const ui = resolveUi(docPilot)
    if (Object.keys(DEFAULTS.ui).some((k) => docPilot.ui?.[k] !== DEFAULTS.ui[k])) {
        // The floating button's own composition is named only when it IS the
        // floating button: "no label" printed under a navbar trigger describes
        // a control that is not on the page.
        const fab =
            ui.trigger === 'fab'
                ? ` · ${[ui.fabIcon ? 'icon' : null, ui.fabLabel === false ? null : 'label'].filter(Boolean).join(' + ')}`
                : ''
        console.log(
            `[docpilot] ui     ${ui.trigger} trigger · ${ui.panel} panel` +
                `${docPilot.ui?.panel === 'auto' ? '   (auto)' : ''}${fab}`,
        )
    }
    // Same silence rule again. Loud when the archive is off, because "off" also
    // means "cleared on the reader's next visit", and a site that turned it off
    // for a privacy review should see that stated in its own build log.
    if (
        docPilot.history.enabled !== DEFAULTS.history.enabled ||
        docPilot.history.maxConversations !== DEFAULTS.history.maxConversations
    ) {
        console.log(
            `[docpilot] histry ${
                docPilot.history.enabled
                    ? `${docPilot.history.maxConversations} conversations kept on the reader's device`
                    : 'off — stored conversations are cleared on the next visit'
            }`,
        )
    }
    // Silent when nothing is overridden, because that is the common case and a
    // line saying "0 locales" on every build is noise in the one block anyone
    // reads. Loud about a dropped key, because a typo in a key path is
    // otherwise indistinguishable from an override that simply did nothing.
    const i18n = summariseI18n(validateI18n(docPilot.i18n, () => {}))
    if (i18n) console.log(`[docpilot] i18n   ${i18n}`)
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
    /**
     * What this documentation is about, in the reader's words — "Acme Editor".
     *
     * The one brand-shaped string this package has. It reaches the instruction
     * (`You answer questions about …`), the composer placeholder, and the
     * assistant's own introduction when someone says hello. Null renders as
     * "this documentation" in every one of them, which is correct and dull.
     *
     * Deliberately NOT part of `i18n`: two locales disagreeing about a product's
     * name is a defect with no upside, and this value also reaches the system
     * message, which is build-time and untranslatable by design.
     */
    product: null,
    /** Where the VitePress site lives, relative to the project root. */
    docsDir: 'docs',
    /** Defaults to `${docsDir}/public/rag`. Set it only if you moved the index. */
    indexDir: null,
    /** Golden set, calibration set and reports. A statement about YOUR corpus. */
    evalDir: 'docpilot',
    /**
     * A second corpus root, for pages that are indexed but not published.
     *
     * Null — off — because walking an unexpected directory of someone else's
     * repository is a surprise, and a project with nothing to import needs no
     * second root. Set it to a directory OUTSIDE `docsDir` and VitePress never
     * sees it: no route is built, nothing enters the sidebar, the sitemap or
     * llms.txt, and the copy cannot compete with the original in search. What
     * those pages get instead is a mandatory frontmatter `source:`, which is the
     * only address their citation can point at.
     */
    importDir: null,
    /**
     * The origins a page may name in `source:`. `{allow: ['https://example.com']}`,
     * optionally narrowed by path: `'https://example.com/docs'` admits that page
     * and everything under it, at a segment boundary, and nothing else.
     *
     * Null means no page may declare a source at all, which is the right default
     * for a project that imports nothing. This is a security boundary, not a
     * convenience: the value travels into `manifest.pages[].origin` and out as an
     * `href` in the answer panel, so markdown is never trusted with a scheme.
     */
    sources: null,
    chat: {
        provider: 'ollama',
        model: 'qwen3:8b',
        temperature: 0.2,
        maxTokens: 2048,
        // Ollama's server default context is 4096 tokens, and a primed turn plus
        // one tool call already exceeds it — past that llama.cpp shifts the
        // window and drops the system block off the front, which surfaces as an
        // unexplained refusal. Sent only on the ollama transport.
        numCtx: 8192,
    },
    embed: 'auto',
    topK: 12,
    maxIterations: 2,
    suggestions: [],
    /** Where a thumbs-up/down POSTs. Null keeps every vote in localStorage. */
    feedbackEndpoint: null,
    /**
     * WHICH votes leave the device, and whether the reader may write a sentence.
     *
     *   send: 'both' | 'down' | 'up' | 'none'
     *
     * Two keys for one concept, because `feedbackEndpoint` shipped first and a
     * bare `feedbackEndpoint: '/feedback'` has to keep working. The endpoint is
     * WHERE; this is WHAT and WHETHER.
     *
     * `both` because a table of complaints is not a measurement. Helpfulness
     * needs a denominator, and `npx docpilot feedback report` says so in its own
     * output when it does not have one: probes drawn from down-votes alone are a
     * purely negative sample, and calibrating a threshold against one moves the
     * gate toward refusing. An owner who wants only complaints sets `'down'`.
     *
     * `comment: false` removes the textarea and keeps the reason buttons. The
     * text a reader types is redacted and capped in feedback.js — that ceiling
     * is not a setting, for the same reason history.js's byte ceiling is not.
     */
    feedback: {send: 'both', comment: true},
    guard: {mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3},
    scope: {enabled: true, default: 'all', promptListLimit: 12},
    /**
     * The reader's own conversations, kept on their device.
     *
     * ON by default, because the failure it fixes is a silent one: a reader who
     * reloads the page — or follows a citation into a new tab — loses a thread
     * they were mid-way through, and the panel then shows no sign that anything
     * was ever there. The thread used to live in sessionStorage, which made that
     * loss invisible; localStorage makes it recoverable.
     *
     * What is stored is questions and answers, on a machine that may be shared,
     * so `enabled: false` does not merely stop recording — `session.configure`
     * also CLEARS what is already stored, on the same rule `prompt.show: false`
     * already applies to the reader's own instruction. A site that turns this
     * off leaves nothing behind on the next visit.
     *
     * 20 is the list the switcher can show: it scrolls inside the panel, and an
     * archive longer than two screens is one nobody browses. A byte ceiling
     * applies underneath it and is deliberately NOT a setting — localStorage is
     * ~5MB per ORIGIN and this panel is a guest on someone else's docs site, so
     * no author should have to reason about its share. See history.js.
     */
    history: {enabled: true, maxConversations: 20},
    prompt: {show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: ''},
    /**
     * Where the button lives, what shape the panel takes, and what the floating
     * button is made of.
     *
     * `panel: 'auto'` follows the trigger — `nav` opens the full-height drawer,
     * `fab` opens the floating popup. Both crossed pairs are legal and are
     * carried out in silence. `fabLabel` / `fabIcon` describe the floating
     * placement only: `true` takes the shipped words through i18n, a string
     * takes those words verbatim, `false` drops that half. See
     * `src/theme/docpilot/ui.js` for the resolver and ui-specs/005 for why;
     * this is the only place the shipped set is stated.
     */
    ui: {trigger: 'nav', panel: 'auto', fabLabel: true, fabIcon: true},
    /**
     * Reader-facing copy, replaced string by string.
     *
     * `{translations, locales}` — the inside of VitePress's own local-search
     * i18n, so their example transfers unchanged. See `src/theme/docpilot/i18n.js`
     * for the key table, the two selectors and the fallback chain.
     */
    i18n: {translations: {}, locales: {}},
}

/**
 * Keys that are DELIBERATELY absent from the client half.
 *
 * Named rather than implied, because "the browser never receives this" is a
 * decision and the alternative — a key that simply nobody remembered to emit —
 * looks identical from here. `themeDocPilot` completeness is asserted against this
 * list in the test suite, so a new setting either reaches the panel or is
 * written down here as not reaching it.
 */
export const SERVER_ONLY = ['docsDir', 'indexDir', 'evalDir', 'importDir', 'sources']

/** Settings with defaults filled in. Nested objects merge; `embed` does not. */
export function resolveDocPilot(settings = {}, env = {}) {
    return {
        ...DEFAULTS,
        ...settings,
        chat: {...DEFAULTS.chat, ...(settings.chat || {})},
        // `embed` is a union — the string 'auto' or an object — so a spread
        // would turn 'auto' into an object of numbered characters.
        embed: settings.embed ?? DEFAULTS.embed,
        // Assigned whole, never merged. A half-merged allowlist is an allowlist
        // whose contents nobody wrote: `{...DEFAULTS.sources, ...settings.sources}`
        // would silently keep a key the author deleted, and this is the object
        // that decides which origins may become a link in the answer panel.
        sources: settings.sources ?? DEFAULTS.sources,
        guard: {...DEFAULTS.guard, ...(settings.guard || {})},
        scope: {...DEFAULTS.scope, ...(settings.scope || {})},
        history: {...DEFAULTS.history, ...(settings.history || {})},
        // Merged, NOT resolved — same split as `ui` below. A flat pair of
        // scalars, so one level is all there is to lose.
        feedback: {...DEFAULTS.feedback, ...(settings.feedback || {})},
        prompt: {...DEFAULTS.prompt, ...(settings.prompt || {})},
        // Merged, NOT resolved: `'auto'` survives this function. Resolution
        // belongs to whoever emits — `themeDocPilot` — because the resolved shape
        // is a different object from the settings one, and a merger that
        // returned it would leave `resolveDocPilot(resolveDocPilot(x))` meaningless.
        ui: {...DEFAULTS.ui, ...(settings.ui || {})},
        // The one key that genuinely wants a DEEP merge, because its whole
        // purpose is partial: overriding one string must keep the other eighty,
        // and a one-level spread would replace `translations` wholesale the
        // moment a project also set `locales`.
        i18n: {
            translations: {...DEFAULTS.i18n.translations, ...(settings.i18n?.translations || {})},
            locales: {...DEFAULTS.i18n.locales, ...(settings.i18n?.locales || {})},
        },
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
export function readiness(docPilot, env = {}) {
    const missing = []
    const notes = []

    if (!docPilot.enabled) {
        return {ok: false, disabled: true, missing: [], notes: [], hint: 'Set `enabled: true` to turn it back on.'}
    }

    try {
        assertProviders(docPilot)
    } catch (e) {
        missing.push({
            what: 'the chat or embedding provider cannot be used as configured',
            fix: String(e.message || e).split('\n').join('\n      '),
        })
        // Every check below reads a resolved provider, so there is nothing
        // further worth saying until this one is fixed.
        return {ok: false, missing, notes, hint: 'See https://github.com/cloflin/docpilot#providers'}
    }

    const embed = resolveEmbed(docPilot)
    for (const [half, id] of [['chat', docPilot.chat.provider], ['embed', embed.provider]]) {
        const hosted = hostedOf(id)
        if (!hosted) continue // ollama needs no key
        if (keyOf(env, id)) continue
        missing.push({
            what: `${half}: "${id}" needs a key and none is set`,
            fix: `export ${hosted.envKeys[0]}=… (or put it in .env.local and pass loadEnv('', process.cwd(), '') to defineDocPilot)`,
        })
    }

    const idx = indexInfo(docPilot)
    if (!idx) {
        missing.push({
            what: `no index at ${indexDirOf(docPilot)}`,
            fix: 'npx docpilot index',
        })
    } else if (idx.embedModel !== embed.model) {
        // Not fatal to the build, but fatal to retrieval: a query scored
        // against a foreign vector space is not a worse answer, it is no
        // answer, and the calibrated gate starts refusing answerable questions.
        missing.push({
            what: `the index was built with "${idx.embedModel}" but embed.model is "${embed.model}"`,
            fix: 'npx docpilot index   (or change embed.model back to the one that built it)',
        })
    }

    // A malformed allowlist is a `missing`, not a note: `docpilot index` calls
    // `die()` on it, so the next index build fails and the panel keeps serving
    // whatever is already on disk. Reporting it here is the difference between
    // finding out now and finding out on the deploy.
    const {errors: sourceErrors} = parseAllowlist(docPilot.sources)
    if (sourceErrors.length) {
        missing.push({
            what: 'docPilot.sources cannot be parsed as an allowlist',
            fix: sourceErrors.join('\n      '),
        })
    }

    // A note rather than a `missing`: nothing is imported, every published page
    // still answers, and an empty or absent import root is the normal state for
    // a project that has not started importing yet.
    if (docPilot.importDir && !existsSync(path.resolve(docPilot.importDir))) {
        notes.push(
            `importDir "${docPilot.importDir}" does not exist — nothing will be imported. ` +
                'Create it, or drop the setting.',
        )
    }

    if (docPilot.prompt.override) {
        notes.push(
            'a prompt override is configured — re-run `npx docpilot calibrate`, ' +
                'because the gate thresholds were measured against the shipped instruction',
        )
    }

    return {
        ok: missing.length === 0,
        missing,
        notes,
        hint: 'Run `npx docpilot doctor` to re-check without a full build.',
    }
}
