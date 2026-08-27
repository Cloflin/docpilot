import {readFileSync, existsSync} from 'node:fs'
import path from 'node:path'

import {parseAllowlist} from './build/lib/sources.js'
// Pure data and pure functions — i18n.js imports no Vue, deliberately, so this
// Node-side module can validate the key table without pulling the theme in.
import {validateI18n, summariseI18n} from './theme/docpilot/i18n.js'
import {resolveUi} from './theme/docpilot/ui.js'
import {resolveFeedback} from './theme/docpilot/feedback.js'
// ui-specs/009 — the switches behind rule 11. Same terms as `ui.js`: no imports
// of their own, so the build and the browser can both call them.
import {
    resolveQuote,
    resolveCitations,
    resolveComposer,
    resolveScope,
    resolveHistory,
    resolveSuggestions,
    resolveBudget,
} from './theme/docpilot/switches.js'
// The adapters, for their PATHS only — `providerFor(...).chatUrl('/ai')` is the
// URL the browser posts to, so `proxyContract` reads it from here instead of
// keeping a second, silently drifting copy. The module imports nothing and
// touches the network only when a request function is called.
import {providerFor} from './theme/docpilot/providers.js'
// The free tier, as a pool. Imported for its LISTS and its one predicate — the
// module fetches nothing unless `fetchFreePool` is called, which nothing here
// does: a config file is read synchronously, and a build that reached for the
// network to decide what a default means would be a build that fails offline.
import {isAutoModel, FREE_CHAT, FREE_EMBED} from './theme/docpilot/openrouter.js'

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
 * almost never have one and Anthropic has never had one. OpenRouter is the
 * counter-example worth naming, because this file used to assert the opposite:
 * it serves `/v1/embeddings` and publishes its own catalogue of embedding
 * models.
 *
 * `chatModel` is the same statement about the ANSWERING half, and it exists so
 * that naming a provider is a complete instruction. `chat.model` used to have
 * one shipped value — Ollama's `qwen3:8b` — which is a statement about one
 * service and nothing else, so `resolveChat` deliberately dropped it the moment
 * an author named a different provider and `assertChat` then stopped the build.
 * That was correct and it made `chat: {provider: 'openai'}` an incomplete
 * sentence for no reason anyone could act on: the service has an obvious default
 * and this table is where a per-provider default belongs. Null where a POOL
 * stands behind the provider instead (`openrouter`) or where only the author can
 * know (`custom`).
 *
 * BOTH NAMES ARE DEFAULTS, NOT GUARANTEES — catalogues change, and free tiers
 * change weekly. A wrong one fails loudly on the first request rather than
 * silently at runtime, so verify against the provider's current list when you
 * switch. `npx docpilot doctor --models` is the check that does not need a
 * reader to hit it first.
 */
const openaiCompatible = (upstream, envKeys, extra = {}) => ({
    adapter: 'openai',
    upstream,
    directBase: upstream,
    envKeys,
    rewrite: (path) => path.replace(/^\/ai/, ''),
    header: (k) => ({authorization: `Bearer ${k}`}),
    chatModel: null,
    embedModel: null,
    ...extra,
})

const PROVIDERS = {
    // ── chat and embeddings: one provider is enough ──────────────────────────
    openai: openaiCompatible('https://api.openai.com', ['OPENAI_API_KEY'], {
        chatModel: 'gpt-4o-mini',
        embedModel: 'text-embedding-3-small',
    }),
    together: openaiCompatible('https://api.together.xyz', ['TOGETHER_API_KEY'], {
        chatModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        embedModel: 'BAAI/bge-large-en-v1.5',
    }),
    fireworks: openaiCompatible('https://api.fireworks.ai/inference', ['FIREWORKS_API_KEY'], {
        chatModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        embedModel: 'nomic-ai/nomic-embed-text-v1.5',
    }),
    mistral: openaiCompatible('https://api.mistral.ai', ['MISTRAL_API_KEY'], {
        chatModel: 'mistral-small-latest',
        embedModel: 'mistral-embed',
    }),
    nebius: openaiCompatible('https://api.studio.nebius.com', ['NEBIUS_API_KEY'], {
        chatModel: 'meta-llama/Llama-3.3-70B-Instruct',
        embedModel: 'BAAI/bge-en-icl',
    }),

    /**
     * OpenRouter, and it covers BOTH halves — which is a correction, not a
     * feature. This entry carried no `embedModel` and a comment saying the
     * service "routes chat completions and has no embeddings endpoint"; it
     * serves `/v1/embeddings` and publishes a catalogue of 32 embedding models
     * at `/v1/embeddings/models`. The comment was true when it was written and
     * silently wrong afterwards, which cost every OpenRouter user a second
     * provider they did not need.
     *
     * `freePool` is the part that is new. Both halves may be left unnamed, and
     * an unnamed half resolves to an ordered list of free ids rather than to one
     * default — see openrouter.js for why a shared free tier is a pool rather
     * than a model, and why only the chat half may rotate at runtime.
     *
     * `extraBody` is the brand-specific fragment the CLIENT merges into the
     * request body, and it lives here because this file is where brands are
     * known and the adapter is deliberately brand-agnostic. What it says is
     * `require_parameters`: route this request only to an upstream that actually
     * honours `response_format`. Without it OpenRouter drops the strict
     * json_schema in silence and picks whichever upstream is cheapest, and six
     * of the ten free chat models measured against this corpus then answered the
     * FINAL call with prose. llm.js reads a well-formed response as a completed
     * request, so the request is spent, the parse fails, and the reader is shown
     * `not-answerable` for a question the model in fact answered.
     *
     * `rateLimited` says this service publishes a daily REQUEST ceiling — 50 on
     * the free tier, counted in requests and not in tokens. It is what tells the
     * browser there is a budget worth counting and a line worth showing; every
     * other provider here bills per token, where a request count means nothing.
     */
    openrouter: openaiCompatible('https://openrouter.ai/api', ['OPENROUTER_API_KEY'], {
        // Null on BOTH halves, and that is the pool speaking rather than an
        // omission — see `freePool` below and `chatModels`.
        chatModel: null,
        embedModel: FREE_EMBED[0],
        freePool: {chat: FREE_CHAT, embed: FREE_EMBED},
        extraBody: {provider: {require_parameters: true}},
        rateLimited: true,
    }),

    // ── chat only ────────────────────────────────────────────────────────────
    deepseek: openaiCompatible('https://api.deepseek.com', ['DEEPSEEK_API_KEY'], {
        chatModel: 'deepseek-chat',
    }),
    groq: openaiCompatible('https://api.groq.com/openai', ['GROQ_API_KEY'], {
        chatModel: 'llama-3.3-70b-versatile',
    }),
    xai: openaiCompatible('https://api.x.ai', ['XAI_API_KEY'], {
        chatModel: 'grok-4',
    }),
    cerebras: openaiCompatible('https://api.cerebras.ai', ['CEREBRAS_API_KEY'], {
        chatModel: 'llama-3.3-70b',
    }),

    // The escape hatch. Assumed to embed, because a self-hosted vLLM or a
    // gateway usually serves both; set embedModel to what it actually offers.
    //
    // `chatModel` stays null: this entry is a HOST, not a service, so there is
    // no catalogue to have a default in. Naming one would be this file guessing
    // what somebody else's gateway loaded.
    custom: openaiCompatible('http://localhost:8000', ['CUSTOM_API_KEY'], {
        embedModel: 'BAAI/bge-m3',
        baseUrlEnv: 'CUSTOM_BASE_URL',
    }),

    /**
     * llama.cpp's own server — `llama-server`, which speaks the OpenAI-compatible
     * API on :8080 and serves whatever weights it was started with.
     *
     * `chatModel: 'local'` is not a catalogue id and is not pretending to be
     * one. llama-server ignores the field and answers with the loaded model, so
     * the string exists only to satisfy `assertChat`, which is right to demand
     * that SOMETHING be named — a config where the model is silently absent is
     * the failure that check exists for.
     *
     * `LLAMACPP_BASE_URL` is what puts this in the chain, because a local server
     * has no key to be detected by. See `resolveChain`.
     */
    llamacpp: openaiCompatible('http://localhost:8080', ['LLAMACPP_API_KEY'], {
        chatModel: 'local',
        embedModel: 'local',
        baseUrlEnv: 'LLAMACPP_BASE_URL',
        keyless: true,
    }),

    // ── the two that are not plain OpenAI clones ─────────────────────────────
    gemini: openaiCompatible('https://generativelanguage.googleapis.com', ['GEMINI_API_KEY'], {
        rewrite: (path) => path.replace(/^\/ai\/v1/, '/v1beta/openai'),
        directBase: null,
        chatModel: 'gemini-2.5-flash',
        embedModel: 'text-embedding-004',
    }),
    anthropic: {
        adapter: 'anthropic',
        upstream: 'https://api.anthropic.com',
        directBase: 'https://api.anthropic.com',
        envKeys: ['ANTHROPIC_API_KEY'],
        rewrite: (path) => path.replace(/^\/ai/, ''),
        header: (k) => ({'x-api-key': k, 'anthropic-version': '2023-06-01'}),
        chatModel: 'claude-sonnet-4-6',
        embedModel: null,
    },
}

export const PROVIDER_IDS = ['ollama', ...Object.keys(PROVIDERS)]

const LOCAL_BASE_URL = 'http://localhost:11434'
const LOCAL_EMBED_MODEL = 'bge-m3'
/**
 * What SELECTS the local Ollama, now that it is no longer the terminal member of
 * the chain.
 *
 * It used to need nothing: `ollama` closed `CHAIN`, was keyless, and therefore
 * always matched — which is what made it unreachable-by-default in the common
 * case and unavoidable in the rare one. A laptop with Ollama running and a CI box
 * with nothing installed resolved identically, and only the first of them worked.
 *
 * So it is selected the way `llamacpp` is: by ADDRESS, because a local server has
 * no credential to be found by, and because the same variable then answers the
 * second question — `http://gpu.internal:11434` and requests go there. Setting it
 * to the standard `http://localhost:11434` is how you say "the usual one".
 */
const OLLAMA_BASE_URL_ENV = 'OLLAMA_BASE_URL'

/**
 * Ollama's own default model — the value `DEFAULTS.chat.model` used to carry.
 *
 * It moved here for the reason `chatModel` exists on every other provider: it is
 * a statement about ONE service, and as a global default it was inherited by
 * every provider an author named. Ollama is not in `PROVIDERS` — it is the
 * keyless local case the whole file treats separately — so its two names are
 * constants rather than a table row.
 */
const LOCAL_CHAT_MODEL = 'qwen3:8b'

/**
 * The two localhost entries can be somewhere else, and the environment is where
 * that is said.
 *
 * `custom` and `llamacpp` name a PORT, not a service, so `http://localhost:8000`
 * is a placeholder in a way `https://api.openai.com` is not. Left as a literal
 * they were unmovable: `targetOf` rewrites every hosted provider's base to the
 * same-origin `/ai`, so `chat.baseURL` beside a hosted provider is ignored, and
 * the proxy at the other end of that `/ai` reads `hosted.upstream` — which was
 * this file's constant and nothing else. The only way to point llama.cpp at a
 * GPU box was to edit the package.
 *
 * `null` for `directBase` is preserved rather than overridden: Gemini has no
 * directly-callable base at all, and a value here would tell a Node tool to post
 * where nothing answers.
 */
const upstreamOf = (hosted, env = {}) =>
    (hosted?.baseUrlEnv && env[hosted.baseUrlEnv]) || hosted?.upstream

const directBaseOf = (hosted, env = {}) =>
    hosted?.directBase == null
        ? hosted?.directBase
        : (hosted.baseUrlEnv && env[hosted.baseUrlEnv]) || hosted.directBase

/**
 * THE PROVIDER CHAIN — what `chat.provider: 'auto'` walks, in order.
 *
 * The whole of "install the package, put a key in the environment, done". Before
 * it, `keyOf(env, id)` was the only relationship between the environment and a
 * provider and it ran one way only: from a provider the author had already named
 * to the name of the variable holding its key. Nothing ever asked the opposite
 * question — WHICH provider does this environment have a key for — so a project
 * with `OPENAI_API_KEY` set and no `chat` block resolved to the shipped default,
 * a local Ollama, and every question died on a connection refused to a service
 * nobody installed. The key was read, found, and ignored.
 *
 * EMBEDDING-CAPABLE PROVIDERS COME FIRST, and that is the whole of the ordering
 * argument rather than a ranking of answer quality. One key covering both halves
 * is the difference between a working install and a second decision: a chat
 * provider with no embeddings endpoint sends `embed: 'auto'` to OpenRouter's
 * free pool (see `resolveEmbed`), which needs a SECOND key and posts the text of
 * the whole corpus to a third party at build time. `readiness` says so out loud,
 * and a default that has to be explained in a warning is the wrong default.
 *
 * THE TAIL IS LOCAL AND HAS NO KEY TO BE FOUND BY. `llamacpp` is selected by
 * `LLAMACPP_BASE_URL` — naming where the server is, is the only way to say you
 * have one — and `ollama` is the terminal case: no key anywhere means the
 * shipped configuration, which is exactly what every build did before this
 * existed. So an environment with nothing in it resolves precisely as it always
 * has, and only an environment carrying a key changes its answer.
 *
 * NO NETWORK, EVER. A config file is read synchronously at build time, and a
 * resolver that reached out to decide what a default means is a build that fails
 * offline and answers differently on two machines. Whether the chosen provider
 * is actually reachable is `readiness`'s question and `doctor`'s, both of which
 * report rather than guess.
 */
export const CHAIN = [
    // ── one key covers chat and retrieval ────────────────────────────────────
    'openai',
    'gemini',
    'mistral',
    'together',
    'fireworks',
    'nebius',
    // Free, and needs no model named on either half — but metered in REQUESTS
    // (50 a day, shared by every reader of the site), so it sits behind the
    // providers whose allowance is the account's rather than the tier's.
    'openrouter',
    // ── answering only: `embed: 'auto'` borrows OpenRouter's free pool ───────
    'anthropic',
    'groq',
    'deepseek',
    'xai',
    'cerebras',
    // ── self-hosted, each selected by its ADDRESS ───────────────────────────
    'custom',
    'llamacpp',
    'ollama',
]

/**
 * Where the walk lands when NO member matched — an environment with no key and
 * no local address in it.
 *
 * It used to be the local Ollama, because `ollama` closed the list and needed
 * nothing to be selected by. That is the shipped configuration and it is the
 * wrong thing to arrive at by falling through: from inside a build there is no
 * way to tell a laptop running Ollama from a CI box that has never heard of it,
 * so the majority of the projects that reached the end of the chain got a
 * connection refused to a service nobody installed, per question, with the
 * config file naming neither the service nor the port.
 *
 * OpenRouter is what a fall-through should reach instead, and the reason is that
 * it is the one member whose remaining setup is a single free key: no model to
 * choose on either half — the free pool answers both — no card, and both halves
 * covered. So the failure this produces is one legible instruction rather than a
 * silent outage, `readiness` prints it on the first build, and the panel is one
 * variable away from working.
 *
 * It is NOT a second entry in the list. The chain is what an environment
 * SELECTS; this is what happens when it selects nothing, and OpenRouter's own
 * place at position 7 is where it is chosen on its merits, with a key.
 */
const CHAIN_FALLBACK = 'openrouter'

/** The env var that selects a chain member — a key, or an address. */
function chainKeyNameOf(id, env) {
    const hosted = hostedOf(id)
    // Ollama is the one member with no entry in `PROVIDERS`: it is the keyless
    // local case the whole file treats separately.
    if (!hosted) return OLLAMA_BASE_URL_ENV
    // A keyless local server is selected by WHERE it is, not by a credential.
    if (hosted.keyless) return hosted.baseUrlEnv || null
    return hosted.envKeys.find((name) => env[name]) || hosted.envKeys[0] || null
}

/** Whether this environment selects `id` — a key for it, or an address for it. */
function chainHas(id, env) {
    const hosted = hostedOf(id)
    if (!hosted) return Boolean(env[OLLAMA_BASE_URL_ENV])
    if (hosted.keyless) return Boolean(hosted.baseUrlEnv && env[hosted.baseUrlEnv])
    return Boolean(keyOf(env, id))
}

/**
 * Which provider this environment resolves to, and what was tried on the way.
 *
 * `tried` is carried rather than recomputed by every caller because three of
 * them need the same list and would drift: `logDocPilot` prints it at startup,
 * `readiness` turns an empty environment into one actionable sentence, and
 * `doctor` shows it without a build.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{id: string, tried: Array<{id: string, envKey: string|null, found: boolean}>}}
 */
export function resolveChain(env = {}) {
    const tried = CHAIN.map((id) => ({
        id,
        envKey: chainKeyNameOf(id, env),
        found: chainHas(id, env),
    }))
    // Nothing matching is a REAL outcome now — an empty environment is exactly
    // that — so the fallback below is the answer rather than a guard against an
    // impossible case. See `CHAIN_FALLBACK` for why it is OpenRouter.
    return {id: tried.find((t) => t.found)?.id || CHAIN_FALLBACK, tried}
}

/**
 * Where `embed: 'auto'` goes when the chat provider cannot embed.
 *
 * Chosen because it is the one provider in this file whose embedding half costs
 * nothing and needs no second decision: an unnamed model there resolves to the
 * free pool, the indexer walks that pool, and the winner is written into the
 * manifest. Any other choice would have to name a model and a price.
 */
const EMBED_FALLBACK = 'openrouter'

const hostedOf = (id) => PROVIDERS[id] || null

const canEmbed = (id) => (id === 'ollama' ? true : Boolean(PROVIDERS[id]?.embedModel))

/**
 * The provider's own embedding model, from the table — Ollama's lives in a
 * constant because Ollama has no table row.
 *
 * One function rather than the ternary it replaces in three places: the two arms
 * of `resolveEmbed` and `assertEmbed`'s message all had to agree about what a
 * provider's default embedder is called, and three copies of a lookup is three
 * places for it to stop agreeing.
 */
const embedModelOf = (id) => (id === 'ollama' ? LOCAL_EMBED_MODEL : hostedOf(id)?.embedModel ?? null)

/**
 * The ordered list of models a half falls back through when the author named
 * none — null for every provider that has no such list, which is every provider
 * but one.
 */
const freePoolFor = (id, half) => hostedOf(id)?.freePool?.[half] || null

/**
 * The chat pool for this configuration, or null when a model was named.
 *
 * Exported because three callers need the same answer and a second copy of the
 * rule would drift: the browser gets it through `themeDocPilot`, the indexer
 * and `docpilot import` get it through `nodeChatTarget`, and `doctor` prints it.
 */
export function chatModels(docPilot) {
    // An author's own list wins, and it wins even beside a named `model`: the
    // pair reads as "this one, and these if it is busy", which is the shape a
    // paid primary with free understudies wants.
    if (ownChatModels(docPilot)) return [...docPilot.chat.models]
    return isAutoModel(docPilot.chat.model) ? freePoolFor(docPilot.chat.provider, 'chat') : null
}

/** An author's own ordered list, written down in `chat.models`. */
const ownChatModels = (docPilot) =>
    Array.isArray(docPilot.chat.models) && docPilot.chat.models.length > 0

/**
 * Whether the answering half runs on the PROVIDER'S OWN free pool — the one
 * question that decides whether there is a daily REQUEST ceiling to ration
 * against.
 *
 * It exists because `rateLimited` was being read for this and cannot answer it.
 * That flag says the service publishes limits, and it sits on the provider entry
 * — so `chat: {provider: 'openrouter', model: 'anthropic/claude-sonnet-4'}` on a
 * funded key, which has no 50-a-day cap of any kind, read as metered: the browser
 * seeded a 50-request ceiling, counted local requests against it, and silently
 * dropped a PAYING deployment to one request per turn after 35 questions. The
 * feature meant to keep a free tier usable was rationing the people funding it.
 *
 * An author's own `chat.models` is NOT the free pool, however many free ids
 * happen to be in it. The list is theirs, it may be paid, and the request ceiling
 * this flag stands for belongs to the provider's free catalogue rather than to
 * the fact that a list exists.
 */
function freeChatPool(docPilot) {
    if (ownChatModels(docPilot)) return false
    return Boolean(chatModels(docPilot))
}

/**
 * The embed pool — read by the INDEXER and by nothing in the browser.
 *
 * Two embedding models are two vector spaces, so the choice is made once, when
 * the index is built, and written into the manifest. A reader's browser does not
 * get to reconsider it: a query vector from a different free model would score
 * noise against those chunks, which is worse than the lexical-only mode a
 * missing embedder already falls back to.
 */
export function embedModels(docPilot) {
    const e = resolveEmbed(docPilot)
    return isAutoModel(e.model) ? freePoolFor(e.provider, 'embed') : null
}

/**
 * Whether this half is served by a provider that publishes a free catalogue —
 * the only case in which comparing a configured list against one means anything.
 *
 * `chatModels` returns an author's own `chat.models` for ANY provider, so a
 * caller that reads it as "a free pool" will happily check a list of OpenAI
 * models against OpenRouter's catalogue and report every one of them retired.
 */
export function poolProviderOf(docPilot, half) {
    const id = half === 'embed' ? resolveEmbed(docPilot).provider : docPilot.chat.provider
    return freePoolFor(id, half) ? id : null
}

// The catalogue URLs are openrouter.js's to publish; `doctor --models` imports
// `fetchFreePool` from there and needs no second name for them here.

/**
 * The no-embed spelling, in one place rather than re-matched by every caller.
 *
 * `false` is canonical — the union shape `budget: false` already sets for a
 * whole block switched off in one word — and `'none'` is the alias people write
 * anyway. Exported because the INDEXER has to have the answer several steps
 * before it would otherwise ask for a target: a build that resolved an embedder
 * first and then decided not to use it is a build that can still fail on a
 * missing key it was never going to send.
 */
export const noEmbed = (docPilot) => docPilot.embed === false || docPilot.embed === 'none'

/**
 * The embedder, resolved.
 *
 * `embed: 'auto'` — the default, and the reason a single-provider setup needs no
 * second decision: the chat provider embeds too, with its own model, and where
 * it cannot (Anthropic, DeepSeek, Groq …) the free OpenRouter pool below stands
 * in for it. Any object is an explicit split, for when that borrow is not
 * wanted — an internal corpus that may not leave, a self-hosted embedder — or
 * when the chat key is scoped to chat models only.
 *
 * `embed: false` is the third option, and it is a DECLARATION rather than a
 * failure: no embedder, no vectors in the index, retrieval by BM25 over the
 * chunk text alone. It exists because a corpus that may not be sent anywhere,
 * or a site with no embedding service it can reach, is better served by a mode
 * it chose than by the same retrieval arriving as an unexplained outage. The
 * numbers stay here as the warning they always were — dropping the embedder was
 * measured on this corpus: recall@8 0.97 → 0.41, retrieval F1 0.35 → 0.18, and
 * 11 of 44 answerable questions refused outright, and the lexical channel scores
 * zero for a question asked in a language the corpus is not written in.
 * Reproduce with `npx docpilot eval --gate-only --lexical`.
 */
export function resolveEmbed(docPilot) {
    const raw = docPilot.embed

    /**
     * `fallback` is lifted out BEFORE the arms, and that is what makes
     * `embed: {fallback: 'lexical'}` mean "the automatic embedder, with a
     * fallback" rather than an object with no provider in it.
     *
     * It is not a statement about WHICH embedder — it is what to do when that
     * one refuses — so it must not decide which arm runs. Left in place it would
     * take the object arm below and return a provider of `undefined`, which
     * `assertProviders` then reports as a broken config for a key the author
     * used correctly.
     *
     * The only accepted value is `'lexical'`. A second EMBEDDER as a fallback is
     * deliberately not offered: the index and every query must land in one
     * vector space, so a second embedder is a second index, and the address of
     * it would have to reach every reader's browser. `'lexical'` needs no
     * address, because there is nothing left to call.
     */
    const fallback = raw && typeof raw === 'object' && raw.fallback === 'lexical' ? 'lexical' : null
    let e = raw
    if (raw && typeof raw === 'object' && 'fallback' in raw) {
        const rest = {...raw}
        delete rest.fallback
        // An object that was ONLY a fallback is the automatic embedder plus a
        // fallback, so it falls through to the resolution below rather than
        // describing an embedder nobody named.
        e = Object.keys(rest).length ? rest : 'auto'
    }

    // Every key stated and every absent one an EXPLICIT null, for the reason
    // written out on the object arm below: this value is JSON round-tripped into
    // themeConfig, `JSON.stringify` deletes an undefined key, and session.js
    // then fills the hole from its own defaults. `lexicalOnly` is the flag every
    // other layer reads; `manifest.vectors === null` is the index's half of the
    // same statement.
    if (noEmbed(docPilot)) {
        return {
            provider: null,
            model: null,
            baseURL: null,
            auto: false,
            modelAuto: false,
            lexicalOnly: true,
            fallback: null,
        }
    }

    if (e && typeof e === 'object') {
        // NORMALISED, not returned verbatim — and the difference is a whole
        // deployment. `embed: {provider: 'openrouter'}` leaves `model`
        // `undefined`; `themeDocPilot` copies that into the client object;
        // VitePress serialises themeConfig with JSON.stringify, which DELETES an
        // undefined key; and session.js then fills the hole from its own
        // defaults with Ollama's `bge-m3`. The browser ends up certain it embeds
        // with a model no part of this configuration named, disagrees with the
        // manifest on every turn, and runs lexical-only for the life of the
        // deployment with nothing failing anywhere. An explicit `null` survives
        // the round trip; `undefined` does not.
        //
        // AND AN UNNAMED MODEL IS FILLED FROM THE PROVIDER TABLE, exactly as
        // `resolveChat` fills `chatModel`. `embed: {provider: 'openai'}` used to
        // be a build-stopping error while `chat: {provider: 'openai'}` was a
        // complete sentence — one asymmetry, no reason behind it, and the
        // service has an obvious default sitting in the same table row. A pooled
        // provider still resolves to null, because there the pool is the answer.
        const named = isAutoModel(e.model) ? null : e.model
        return {
            ...e,
            model: named ?? (freePoolFor(e.provider, 'embed') ? null : embedModelOf(e.provider)),
            // WHOSE NAME THIS IS. An author's is a sentence; the table's is a
            // default that ages, and the indexer is allowed to walk past a
            // default when the provider's own catalogue disagrees with it.
            modelAuto: named == null,
            fallback,
        }
    }

    const id = docPilot.chat.provider

    /**
     * A chat provider with no embeddings endpoint is no longer a dead end.
     *
     * It used to be a build-stopping error telling the author to pick a
     * different chat provider or stand up a second one — which is the correct
     * DIAGNOSIS and the wrong DEFAULT. Anthropic, DeepSeek, Groq, xAI and
     * Cerebras are the providers people actually choose for the answering half,
     * and every one of them made a working config file into a five-minute
     * detour over a decision with an obvious answer: OpenRouter's free embed
     * pool, which costs nothing and names nothing, exactly as it already does
     * for an unnamed OpenRouter of either half.
     *
     * `borrowed` records who we came from — nothing downstream needs it to
     * WORK, and `readiness` and `logDocPilot` need it to say out loud that the
     * corpus is being embedded by a provider the author did not name. It is
     * read by Node only; `themeDocPilot` copies `provider`, `baseURL` and
     * `model`, so it never reaches the page.
     *
     * Not conditional on the key being present, on purpose: `resolveEmbed`
     * takes no `env`, and a resolver that changed its answer with the
     * environment would give a CI box without `OPENROUTER_API_KEY` a different
     * configuration than the laptop that built the index. The missing key is
     * `readiness`'s to report, on the same terms as any other missing key.
     */
    if (!canEmbed(id)) {
        return {
            provider: EMBED_FALLBACK,
            // Null for the same reason it is null for an unnamed OpenRouter:
            // which free embedder answered is a fact about the minute the index
            // was built, and the manifest is where that fact is recorded.
            model: null,
            baseURL: PROVIDERS[EMBED_FALLBACK].directBase,
            auto: true,
            // The pool is the answer here, so there is no configured name for
            // discovery to walk past — but the flag is stated rather than left
            // undefined, because the indexer branches on it and a key that is
            // absent on one arm of a union is a key read by luck.
            modelAuto: true,
            borrowed: id,
            // NOT `EMBED_FALLBACK`, which is the provider borrowed a few lines
            // up when the chat half cannot embed. This is the author's answer to
            // "and if that one refuses too".
            fallback,
        }
    }

    return {
        provider: id,
        // A POOLED provider names nothing here, on purpose. Which free embedder
        // was reachable is a fact about the minute the index was built, and the
        // manifest is where that fact is recorded — naming one now would put a
        // second, older answer in the config for the browser to disagree with.
        model: freePoolFor(id, 'embed') ? null : embedModelOf(id),
        // The chat provider's host, not just its name. `auto` means "the same
        // provider as chat", and a provider is where it is served from as much as
        // what it is called — a hosted one supplies its own `directBase` and this
        // value is ignored, but a self-hosted Ollama at `http://gpu:11434` was
        // having its embeddings sent to localhost while its chat went to the GPU
        // box. Retrieval either fails outright or, worse, the index gets built by
        // a different server than the one that answers against it.
        baseURL: docPilot.chat.baseURL || LOCAL_BASE_URL,
        auto: true,
        // Nobody named this model — it came out of the provider table, which is
        // a default that ages. The indexer may walk past it if the provider's own
        // catalogue disagrees; an author's name it may not.
        modelAuto: true,
        fallback,
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
    // The EMBED half only. An index build has no opinion about which model
    // answers questions, and refusing to build one over that is a failure in the
    // wrong place — see `assertChat`.
    assertEmbed(docPilot)
    const embed = resolveEmbed(docPilot)

    // No target, said in the shape the caller already destructures rather than
    // as a null the caller would have to remember to check. A `baseURL` here
    // would be somewhere the indexer COULD post, and the point of this mode is
    // that there is nothing it should post: the embedding pass is skipped and
    // the manifest records `vectors: null`.
    if (embed.lexicalOnly) {
        return {
            lexicalOnly: true,
            id: null,
            provider: null,
            baseURL: null,
            model: null,
            models: null,
            modelAuto: false,
            apiKey: null,
        }
    }

    const hosted = hostedOf(embed.provider)
    return {
        id: embed.provider,
        provider: hosted ? hosted.adapter : 'ollama',
        baseURL: hosted ? directBaseOf(hosted, env) : embed.baseURL || LOCAL_BASE_URL,
        model: embed.model,
        // Null unless the author left the model to the provider. The indexer
        // walks this in order and writes the winner into the manifest.
        models: embedModels(docPilot),
        /**
         * WHOSE NAME `model` IS — the author's, or the provider table's.
         *
         * The indexer needs the difference and cannot see it from the name: both
         * arrive as the same string. A name the author wrote is a sentence and is
         * used as given; a name the table supplied is a default that ages, so it
         * becomes the HEAD of a pool with the provider's own catalogue behind it.
         * See `discoverEmbedModels` in src/build/lib/embed-discovery.js.
         */
        modelAuto: Boolean(embed.modelAuto),
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
        baseURL: hosted ? directBaseOf(hosted, env) : docPilot.chat.baseURL || LOCAL_BASE_URL,
        model: docPilot.chat.model,
        models: chatModels(docPilot),
        apiKey: keyOf(env, docPilot.chat.provider),
        maxTokens: docPilot.chat.maxTokens,
        numCtx: docPilot.chat.numCtx,
        // The same body fragment the browser gets — and the same override —
        // for the same reason: without `require_parameters` OpenRouter may route
        // `docpilot import`'s annotation pass to an upstream that ignores the
        // strict schema, and a CLI that silently annotates worse than the panel
        // does is a difference nobody would think to look for. An author who
        // declines it in `chat.extraBody` declines it in both places, because a
        // site whose panel and whose CLI post different bodies is the same
        // difference from the other direction.
        extraBody: extraBodyOf(docPilot.chat.extraBody, hosted),
    }
}

/**
 * The request-body fragment, with the author's word last.
 *
 * `require_parameters` defaults ON and that is not a neutral default: it narrows
 * OpenRouter's routing to upstreams that actually honour `response_format`, so
 * it changes WHICH model answers and can turn a request that would have been
 * served into "no provider available". It is on because the alternative is the
 * silent schema drop measured on this corpus — six of ten free chat models
 * answering the final call with prose, every one of those requests spent and
 * thrown away. But a behaviour change an author cannot decline is a decision
 * taken on their behalf, and this is the seam where they take it back.
 *
 * PRESENCE decides, not truthiness. `chat: {extraBody: null}` posts the plain
 * body the adapter would have built on its own; an object replaces the
 * provider's fragment outright rather than merging with it, because a merge
 * would leave `require_parameters` in place with no way to spell its removal.
 * `undefined` — which is also what an omitted key and a JSON round trip both
 * produce — means the author said nothing, and the provider default stands.
 */
const extraBodyOf = (own, hosted) => (own !== undefined ? own || null : hosted?.extraBody || null)

/** A configured half — chat or embed — as the client half sees it. */
function targetOf({provider, baseURL, extraBody}) {
    const hosted = hostedOf(provider)
    return {
        // The client knows adapters, not brands: gemini and openrouter ARE the
        // openai adapter, differing by host, model and key — none of which the
        // browser sees, because all three arrive through the same `/ai`.
        provider: hosted ? hosted.adapter : 'ollama',
        baseURL: hosted ? '/ai' : baseURL || LOCAL_BASE_URL,
        // The two brand facts that have to survive the trip anyway, carried as
        // DATA so the rule above holds. `extraBody` is a body fragment the
        // adapter merges without reading; `rateLimited` is a boolean the panel
        // reads. Neither names the brand, so a client that branches on either is
        // still branching on a capability rather than on who is serving it — and
        // the alternative, an adapter with an `if (provider === 'openrouter')`
        // in it, is a second place the provider table would have to be kept.
        //
        // Null rather than undefined, deliberately: this object is serialised
        // into every page by JSON.stringify, which DELETES an undefined key, and
        // session.js then fills the hole from its own defaults. The whole of
        // that failure is recorded on `resolveEmbed` above. `extraBodyOf` is
        // where the author's own fragment, or their explicit null, outranks the
        // provider's.
        extraBody: extraBodyOf(extraBody, hosted),
        rateLimited: Boolean(hosted?.rateLimited),
    }
}

/**
 * The empty-state questions — UI-SPEC §13, and the two behaviours beside them.
 *
 * THE RESOLVER MOVED — ui-specs/009. It lives in `theme/docpilot/switches.js`
 * now, because `suggestions` became a union (`string[]` or an object carrying
 * `questions`, `scoped` and `followUps`) and the browser has to be able to
 * resolve a hand-written themeConfig for itself, exactly as it does for `ui` and
 * `feedback`. A resolver reachable only from Node cannot do that. It is
 * re-exported from here so the public entry point keeps its name.
 *
 * An ARRAY OF STRINGS is still legal and still means the same thing, and the
 * questions are still deliberately not `{label, question}` pairs: the row
 * submits on activation, so a label that differs from the question means the
 * reader watches a question they did not read appear in the thread.
 */
export {resolveSuggestions} from './theme/docpilot/switches.js'

/** The client half: safe to compile into the bundle, carries no credential. */
export function themeDocPilot(docPilot, env = {}) {
    assertProviders(docPilot)
    const chat = targetOf(docPilot.chat)
    const embedCfg = resolveEmbed(docPilot)
    // NOT `targetOf` when there is no embedder, and the structure says so rather
    // than a comment alone: `targetOf` reads a provider it does not recognise as
    // the local one, so a null provider comes back as an Ollama at
    // localhost:11434 — a deployment that declared no embedder would spend every
    // question on a connection refused to a service nobody installed.
    const embed = embedCfg.lexicalOnly ? null : targetOf(embedCfg)
    return {
        enabled: docPilot.enabled,
        llm: {
            provider: chat.provider,
            baseURL: chat.baseURL,
            model: docPilot.chat.model,
            /**
             * The pool, when the author named no model — an ORDERED list the
             * transport walks until one member answers. Null everywhere else,
             * and null is what `chat()` treats as "no rotation", so every other
             * provider posts the request it always did.
             *
             * A BAKED list rather than a live one, for two reasons that point
             * the same way. This object is inlined into every page's hydration
             * payload, and a reader's browser reaching out to a third party to
             * ask which models are free is a request the site owner did not
             * agree to serve. And a list fetched at build time would make the
             * build's output depend on the minute it ran.
             *
             * The list ages, and `npx docpilot doctor` is where that is caught:
             * it reads the live catalogue and names any shipped id the service
             * has retired. `chat.models` is the override for an author who wants
             * their own order.
             */
            models: chatModels(docPilot),
            temperature: docPilot.chat.temperature,
            maxTokens: docPilot.chat.maxTokens,
            numCtx: docPilot.chat.numCtx,
            // Named here rather than spread, on the same terms as every other
            // key in this block: `targetOf` answers for the EMBED half too, and
            // a request-body fragment meant for chat completions has no business
            // being posted to an embeddings endpoint.
            extraBody: chat.extraBody,
            rateLimited: chat.rateLimited,
            // What `rateLimited` was being mistaken for, stated precisely: this
            // deployment answers off the provider's own FREE pool, so its
            // allowance is counted in requests per day and there is a budget
            // worth rationing. `rateLimited` stays what it always said — the
            // service publishes limits at all — and the two are only ever equal
            // by accident. See `freeChatPool` for the deployment that made the
            // difference expensive.
            freePool: freeChatPool(docPilot),
        },
        // `lexicalOnly` on BOTH arms, because the key has to exist either way:
        // session.js branches on `cfg.embed.lexicalOnly` to decide whether to
        // embed the question at all, and an omitted key is an undefined one that
        // JSON.stringify deletes on the way into themeConfig — leaving the
        // browser to read the absence as "not chosen" only by luck.
        //
        // THE INDEX GETS A VOTE, and it is the second half of `embed.fallback`.
        // A vectorless index under a named embedder means the fallback fired;
        // without this the browser would spend a request embedding every
        // question and the retriever would then drop the vector on the floor,
        // paying per turn for a channel that cannot score. It also lights the
        // panel's own "no embedding model" line, which is the reader's only
        // signal that this is not the retrieval the site usually gives.
        // `indexInfo` returns null with no index on disk, so nothing here
        // changes for a build that has not run the indexer yet.
        embed: embedCfg.lexicalOnly || lexicalIndex(docPilot)
            ? {provider: null, baseURL: null, model: null, lexicalOnly: true}
            : {
                  provider: embed.provider,
                  baseURL: embed.baseURL,
                  model: embedCfg.model,
                  lexicalOnly: false,
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
        // Resolved rather than spread, since ui-specs/009 put two new keys in
        // each: a spread carries a typo straight through to the browser, and the
        // build is where the author is looking. Both resolvers are idempotent.
        scope: resolveScope(docPilot),
        history: resolveHistory(docPilot),
        // Was missing, and its absence is why `docPilot.suggestions` looked like a
        // setting that did nothing: DocPilot.vue has read `config.suggestions` with
        // a built-in fallback since it shipped, and UI-SPEC §13 has documented
        // the key — but nothing ever put it in the object the client receives,
        // so the fallback was the only branch that could ever run.
        suggestions: resolveSuggestions(docPilot),
        // ── the switches — ui-specs/009 ─────────────────────────────────────
        // Every reader-visible action this panel performs is removable, and rule
        // 11 in the suite asserts that each of these keys is both read by the
        // theme and written down in docs/reference/config.md.
        quote: resolveQuote(docPilot),
        citations: resolveCitations(docPilot),
        composer: resolveComposer(docPilot),
        // Resolved here for the same reason and on the same terms — and this one
        // has a second job: `budget` is a union whose off form is the single
        // word `false`, and the browser must receive the finished object either
        // way. `resolveBudget` is idempotent, so the client's own second pass
        // over this changes nothing.
        budget: resolveBudget(docPilot),
        prompt: {...docPilot.prompt},
        // RESOLVED here, and resolved again in the browser — `resolveUi` is
        // idempotent for exactly this. The build is where a bad value should be
        // reported, because that is where the author is looking; the client
        // repeats the call because `session.configure` also receives the
        // `{enabled: false}` payload, which carries no `ui` at all.
        ui: resolveUi(docPilot),
        // Spread rather than resolved: every value here is a plain string the
        // author either wrote or did not, and the layering that gives it meaning
        // — author, then binding, then default — can only happen in the browser,
        // where the binding exists. `hostConfig()` is where it happens.
        host: {...docPilot.host},
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
    // Most specific first, and kept that way even though `route` now anchors
    // each key: the order is what the reader compares against `proxyContract`,
    // which is prefix-matched by whatever the owner builds from it.
    //
    // The paths are asked of the adapter rather than written as the bare `/ai`
    // prefix they used to be. Vite matched by prefix and this route attaches the
    // owner's API key on the way out — so `/ai` proxied EVERYTHING under it with
    // that key attached, and `vitepress dev --host` puts that on the LAN.
    // `proxyContract` already warns production about exactly this ("a prefix
    // match on /ai would proxy anything under it"); dev deserves the same shape,
    // which is why `route` builds an anchored key rather than a bare string.
    const embedId = resolveEmbed(docPilot).provider
    const embedHosted = hostedOf(embedId)
    route(
        routes,
        embedHosted ? providerFor(embedHosted.adapter).embedUrl('/ai') : '/ai/v1/embeddings',
        embedId,
        env,
    )
    const chatId = docPilot.chat.provider
    const chatHosted = hostedOf(chatId)
    if (chatHosted) route(routes, providerFor(chatHosted.adapter).chatUrl('/ai'), chatId, env)
    return Object.keys(routes).length ? routes : undefined
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * One proxied path, keyed so it matches THAT path and nothing under it.
 *
 * Vite's matcher is `context[0] === '^' && new RegExp(context).test(url) ||
 * url.startsWith(context)`, against the raw `req.url`. A plain string key is
 * therefore a prefix, and this route attaches the owner's API key on the way
 * out — so `/ai/v1/messages` as a string also proxied
 * `/ai/v1/messages/../../v1/models`, with that key on it. The leading `^`
 * switches Vite to a regexp and the `$` closes the prefix; the optional query
 * group is there so a provider that starts appending one does not silently stop
 * being proxied. `proxyContract` asks production for the same thing in words
 * ("match these paths EXACTLY").
 */
function route(routes, path, providerId, env) {
    const hosted = hostedOf(providerId)
    if (!hosted) return // a local provider is called directly, with no proxy
    const key = keyOf(env, providerId)
    routes[`^${escapeRe(path)}(?:\\?.*)?$`] = {
        target: upstreamOf(hosted, env),
        changeOrigin: true,
        rewrite: hosted.rewrite,
        configure(proxy) {
            proxy.on('proxyReq', (proxyReq) => {
                // Exactly what `proxyContract` requires of a production proxy,
                // done here too. `http-proxy` forwards what the browser sent
                // unless told otherwise, so an `authorization:` from the LAN
                // reached `api.anthropic.com` alongside the owner's `x-api-key`,
                // and a docs origin behind SSO handed its session `Cookie` to
                // the provider. Stripped before the key check, because the route
                // exists without a key and "we had nothing to add" is no reason
                // to pass somebody else's credentials upstream.
                proxyReq.removeHeader('authorization')
                proxyReq.removeHeader('x-api-key')
                proxyReq.removeHeader('cookie')
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
            upstream: upstreamOf(hosted, env),
            rewrite: hosted.rewrite(p),
            header,
            envKey: keyNameOf(env, id) || null,
            // A server you started rather than an account you have. Without
            // this the contract reads `NO KEY — none set` beside a self-hosted
            // llama.cpp, which sends the reader looking for a credential the
            // service does not check.
            keyless: Boolean(hosted.keyless),
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
        // `vectors` is carried because it is the ONE signal that an index has no
        // vector space to score against — the name of the blob, or null. `dims`
        // is a consequence and not a statement, so a caller reading `dims === 0`
        // as the mode would call a half-written manifest a deliberate choice.
        //
        // No reader below may treat a MISSING key as a vectorless index: that
        // manifest is one `loadIndex` would fetch `${base}/undefined` for, and
        // answering it with "rebuild without vectors" is a diagnosis of the
        // wrong fault. So "was it built without vectors" is asked strictly
        // (`=== null`) and "does it carry a blob" is asked for a name — an
        // absent key answers no to both, which is the only honest pair of
        // answers about a manifest nothing wrote.
        return {
            embedModel: m.embedModel,
            chunkCount: m.chunkCount,
            hash: m.hash,
            dims: m.dims,
            vectors: m.vectors,
        }
    } catch {
        return null
    }
}

/**
 * Does the index on disk have a vector space at all?
 *
 * A statement about the INDEX, deliberately, and not about the config — which is
 * why it does not consult `embed.fallback`. Whatever the settings say, a
 * vectorless index is one the browser cannot score a query against, so embedding
 * the question spends a request to produce a number that is then dropped. The
 * `=== null` is strict for the reason `indexInfo` gives above: a manifest with
 * no `vectors` key at all is a broken manifest, not a declared mode.
 *
 * `null` — no index yet — is not vectorless. It is unknown, and the build that
 * has never run the indexer must emit exactly what it emitted before.
 */
function lexicalIndex(docPilot) {
    return indexInfo(docPilot)?.vectors === null
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
    assertChat(docPilot)
    assertEmbed(docPilot)
}

/**
 * The chat half, alone.
 *
 * Split out because `nodeEmbedTarget` was asserting both, and `npx docpilot
 * index` does not call a chat model — so a missing `chat.model` stopped the
 * INDEXER, which is the wrong layer to hear about it and the wrong run to lose.
 * The build still refuses that configuration; it refuses it where the panel is
 * being assembled.
 */
function assertChat(docPilot) {
    assertKnown('chat', docPilot.chat.provider)

    // A provider named with no model behind it. Legal where a pool answers the
    // question — see `chat.models` — and a build-stopping omission everywhere
    // else, because the alternative is a 400 in the reader's browser naming a
    // model that appears nowhere in the config file. This became reachable the
    // day `resolveChat` stopped handing Ollama's default to other providers.
    if (!docPilot.chat.model && !chatModels(docPilot)) {
        throw new Error(
            `[docpilot] chat.model is not set for "${docPilot.chat.provider}", and that\n` +
                '  provider has no free pool to fall back through. Name the model —\n' +
                `    chat: {provider: '${docPilot.chat.provider}', model: '…'}\n` +
                '  — or give it your own ordered pool with chat.models.',
        )
    }
}

/** The embed half, alone — everything `docpilot index` needs to be true. */
function assertEmbed(docPilot) {
    const embed = resolveEmbed(docPilot)

    // Nothing to be true. `assertKnown` below would be handed a null provider,
    // decide it is not one this build knows, and stop the build with the list of
    // providers to pick from — advice for a mistake nobody made, on the one
    // configuration that deliberately names no embedder at all.
    if (embed.lexicalOnly) return

    assertKnown('embed', embed.provider)

    // A provider that embeds is a complete configuration, named model or not:
    // its own default is in the table, a pool stands behind the one provider
    // that has one, and `npx docpilot index` asks the service itself when
    // neither is right. What is left below is the provider that cannot embed
    // at all.
    if (canEmbed(embed.provider)) return

    /**
     * Two arms used to stand here and both are gone.
     *
     * `if (embed.auto)` — a chat provider with no embeddings endpoint — became
     * unreachable when `resolveEmbed` started borrowing OpenRouter's free pool
     * rather than raising. And `embed.model is not set for X, which does have an
     * embeddings endpoint` became unreachable when the object arm of
     * `resolveEmbed` began filling an unnamed model from the provider table, the
     * way `resolveChat` fills `chatModel`: there is no longer a way to reach this
     * function with an embed-capable provider and no name behind it.
     *
     * What remains is an EXPLICIT `embed: {provider: …}` naming a service that
     * answers but does not retrieve — a sentence the author wrote, which this
     * package will not quietly rewrite into a third party's.
     */
    throw new Error(
        `[docpilot] embed.provider "${embed.provider}" has no embeddings endpoint — it can\n` +
            `  answer, not retrieve. Point embed at a service that can: ${EMBEDDERS()}\n` +
            `  — or drop the setting entirely: embed: 'auto' falls through to\n` +
            `  ${EMBED_FALLBACK}'s free pool, which costs nothing and names nothing.\n` +
            '  Then rebuild the index with `npx docpilot index`.',
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

function describe(cfg, env, pool = null) {
    const hosted = hostedOf(cfg.provider)
    const route = hosted ? `/ai → ${upstreamOf(hosted, env)}` : cfg.baseURL || LOCAL_BASE_URL
    const name = keyNameOf(env, cfg.provider)
    // `hosted.keyless` reads as "no key needed" on the same terms Ollama does —
    // it is a server you started, not an account you have. Printing `NO KEY —
    // set LLAMACPP_API_KEY` there names a fault that is not one and a variable
    // that fixes nothing.
    const key =
        !hosted || hosted.keyless
            ? 'no key needed'
            : name
              ? `key ${name}`
              : `NO KEY — set ${hosted.envKeys[0]}`
    // A pooled half has no single name to print, and printing `null` reads as a
    // bug. Say what it is instead: the size of the list and its head.
    const what = cfg.model
        ? `${cfg.provider}/${cfg.model}`
        : pool?.length
          ? `${cfg.provider}/auto — ${pool.length} free, ${pool[0]} first`
          : `${cfg.provider}/(no model)`
    return `${what.padEnd(28)} ${route.padEnd(46)} ${key}`
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

    // WHO CHOSE THE PROVIDER, and only when it was not the author.
    //
    // A configuration whose answering half was decided by an environment
    // variable is one where the config file does not contain the answer, so the
    // build log has to. Silent for every project that names its provider, which
    // is the same silence rule the `ui`, `histry` and `i18n` lines below follow:
    // a line restating what is already written down is noise in the one block
    // anyone reads.
    if (docPilot.chat.providerAuto) {
        const {tried} = resolveChain(env)
        const marks = tried
            .map((t) => `${t.id} ${t.found ? '✓' : '—'}`)
            .join(' · ')
        console.log(`[docpilot] chain  auto → ${docPilot.chat.provider}`)
        console.log(`[docpilot]        ${marks}`)
    }

    const embed = resolveEmbed(docPilot)
    console.log(`[docpilot] chat   ${describe(docPilot.chat, env, chatModels(docPilot))}`)
    if (embed.lexicalOnly) {
        // `describe` would print a provider, a route and a key check for a half
        // that has none of the three, and a reader debugging retrieval on this
        // site needs the mode named in the line they are already reading.
        console.log(
            '[docpilot] embed  none — embed: false, retrieval is lexical-only (BM25 over the chunk text)',
        )
    } else {
        // `(auto)` alone would be a lie in the borrowed case: it reads as "the
        // same provider as chat", which is exactly what this one is not.
        const autoNote = embed.borrowed
            ? `   (auto — ${embed.borrowed} cannot embed, borrowed from ${embed.provider})`
            : embed.auto
              ? '   (auto)'
              : ''
        console.log(`[docpilot] embed  ${describe(embed, env, embedModels(docPilot))}${autoNote}`)
    }

    const idx = indexInfo(docPilot)
    if (!idx) {
        console.log('[docpilot] index  none on disk — run `npx docpilot index`')
    } else {
        // `!embed.model` is the pooled case: the config named nothing, the
        // index named the winner, and the browser follows the index. There is
        // no second opinion to disagree with.
        const mismatch =
            !embed.model || idx.embedModel === embed.model
                ? ''
                : `  ← MISMATCH with embed.model "${embed.model}": retrieval will be lexical-only`
        // `null · 0d` is what a vectorless manifest prints through the ordinary
        // line, and it reads as a broken build rather than as the mode it is.
        const built = idx.vectors === null ? 'no vectors' : `${idx.embedModel} · ${idx.dims}d`
        console.log(
            `[docpilot] index  ${built} · ${idx.chunkCount} chunks · ${idx.hash}${mismatch}`,
        )
    }

    // Printing a bare number here would name a value nobody chose: the default
    // is null, and null resolves in the browser against the manifest's swept
    // levers. The line has to say WHICH of the two layers is in force, because
    // that is the whole question an operator reads it to answer — a k they set
    // by hand, or the one `docpilot tune` measured on this corpus.
    const topK = typeof docPilot.topK === 'number' ? `${docPilot.topK} (config)` : 'tuned (manifest)'
    console.log(
        `[docpilot] turn   topK ${topK} · maxIterations ${docPilot.maxIterations} · ` +
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
    // `.questions`, not `.length`: `resolveSuggestions` returned an array until
    // the union landed and returns `{questions, scoped, followUps}` now, so this
    // line read `undefined` off an object and printed "built-in suggestions" for
    // every build — including the ones that had configured their own.
    const sugg = resolveSuggestions(docPilot)
    const n = sugg.questions.length
    console.log(
        `[docpilot] empty  ${n ? `${n} configured suggestion${n === 1 ? '' : 's'}` : 'built-in suggestions'}`,
    )
    // Same silence rule as i18n below: the shipped pair is what almost every
    // build has, and a line restating it is noise. Printed the moment either
    // half is chosen, because "the FAB did not appear" is otherwise debugged
    // against a build log that never mentions the setting.
    const ui = resolveUi(docPilot)
    if (Object.keys(DEFAULTS.ui).some((k) => docPilot.ui?.[k] !== DEFAULTS.ui[k])) {
        // The floating button's own composition is named only when it IS on the
        // page: "no label" printed under a navbar trigger describes a control
        // that does not exist.
        const fab = ui.trigger.includes('fab')
            ? ` · ${[ui.fabIcon ? 'icon' : null, ui.fabLabel === false ? null : 'label'].filter(Boolean).join(' + ')}`
            : ''
        // The placements spelled out rather than the array's own `toString`.
        // `nav,screen,fab` is a line somebody has to decode; and "no trigger" is
        // the one state worth naming in words, because a build log that said
        // ` trigger` with nothing before it reads as a bug in the log.
        const where = ui.trigger.length ? `${ui.trigger.join(' + ')} trigger` : 'no trigger'
        console.log(
            `[docpilot] ui     ${where} · ${ui.panel} panel` +
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
        /**
         * `'auto'` — the environment decides, by walking `CHAIN`.
         *
         * It used to be `'ollama'`, which was the right shipped value in a world
         * where nothing read the environment: a local server needs no key, so it
         * was the only provider that could be a default at all. The cost was that
         * `OPENAI_API_KEY` in a project's `.env.local` did nothing — `keyOf` only
         * ever asked "what is the key for the provider we already chose" — and the
         * panel spent every question on a connection refused to localhost.
         *
         * The old behaviour is what an EMPTY environment still resolves to, so a
         * build with no key anywhere is unchanged. Write `provider: 'ollama'` to
         * pin it whatever the environment carries.
         */
        provider: 'auto',
        /**
         * Null — the PROVIDER's default, from the provider table, once one is
         * chosen. `qwen3:8b` lived here and was a statement about Ollama being
         * inherited by every other service; it is `LOCAL_CHAT_MODEL` now, beside
         * the other Ollama constant. `resolveChat` carries the reasoning.
         */
        model: null,
        /**
         * WHERE the provider is, for the ones that are somewhere of your own.
         *
         * It has been read since the first release — by `targetOf`, by
         * `nodeChatTarget`, by `resolveEmbed` deciding where an automatic
         * embedder lives — and it has never been in this object, so rule 11b
         * could not see it and nothing wrote it down. A setting nobody can find
         * is the defect that rule exists to catch, and it caught this one only
         * once `OLLAMA_BASE_URL` gave it a second way in.
         *
         * `null` means "the provider's own address": the table's `upstream` for
         * a hosted service, `OLLAMA_BASE_URL` or `http://localhost:11434` for a
         * local Ollama. IGNORED for a hosted provider, which the browser reaches
         * through the same-origin `/ai` — move one of those with the provider's
         * own `*_BASE_URL` variable instead.
         */
        baseURL: null,
        /**
         * An ORDERED fallback pool, tried in turn until one member answers.
         *
         * Null for every provider that bills per token, because rotation there
         * changes what a turn costs without being asked. It exists for shared
         * free tiers — OpenRouter's, today — where a 429 is a statement about
         * how many other people are asking rather than about the model, and
         * where naming one free id buys a panel that works until it does not.
         *
         * Left null with `provider: 'openrouter'` and no `model`, the shipped
         * free pool is used. Set it to pin your own order; set `model` beside it
         * for a primary with understudies.
         */
        models: null,
        temperature: 0.2,
        maxTokens: 2048,
        // Ollama's server default context is 4096 tokens, and a primed turn plus
        // one tool call already exceeds it — past that llama.cpp shifts the
        // window and drops the system block off the front, which surfaces as an
        // unexplained refusal. Sent only on the ollama transport.
        numCtx: 8192,
    },
    /**
     * Who embeds the corpus, and whether anyone does.
     *
     * A UNION of three, like `budget` below and `suggestions` under it, and
     * passed through rather than merged for the same reason — see
     * `resolveDocPilot`. `'auto'` is the chat provider, or OpenRouter's free
     * embedding pool where the chat provider has no embeddings endpoint. An
     * object is the explicit split: `{provider, model, baseURL}`.
     *
     * `false` — `'none'` spells the same thing — is no embedder at all. The
     * index is built without vectors and retrieval is BM25 over the chunk text,
     * which is a real mode and a measurably worse one: recall@8 0.97 → 0.41 on
     * this corpus, retrieval F1 0.35 → 0.18, 11 of 44 answerable questions
     * refused outright, and zero score for a question asked in a language the
     * corpus is not written in. It is for a corpus that may not be sent to an
     * embedding service and for a site that cannot reach one; anywhere else the
     * numbers above are the argument against it. `resolveEmbed` carries the
     * rest of the reasoning.
     */
    embed: 'auto',
    /**
     * How many excerpts the gate hands the model — the retriever's `GATE_K`
     * under its documented name, and the k every retrieval number in the eval
     * report is measured at.
     *
     * null, not a number, and the change matters: this key was documented from
     * the first release and READ BY NOTHING. The gate's k was the literal in
     * retriever.js, so the 12 that used to sit here was never in force, and the
     * 5 that used to sit in session.js's own defaults never was either. null now
     * means "use what this corpus measured" — `docpilot tune` writes tuning.json,
     * `docpilot index` inlines it into the manifest, and session.js lets it
     * through untouched. A number is the author overriding that by hand, clamped
     * to the swept band 1..12 and stamped `source: 'config'` in the manifest's
     * place, exactly as a hand-set `guard.tau` is.
     *
     * So a site that already sets this key starts getting the effect the
     * reference always promised it. That is the intended fix and it is still a
     * behaviour change on upgrade.
     */
    topK: null,
    maxIterations: 2,
    /**
     * What a turn is allowed to SPEND, on a tier that is metered in requests.
     *
     * `maxIterations` above is the token argument; this is the request one, and
     * they are different scarcities. OpenRouter's free tier caps at 50 requests
     * a day while the models behind it offer 128k-512k of context, so a turn
     * costing three or four requests — the tool probe, the loop, the forced
     * final call — gives a reader about fourteen questions before the panel
     * starts reporting an outage that is not one.
     *
     * A UNION, like `suggestions`: `budget: false` is the whole block off in one
     * word, and it is passed through rather than merged for exactly that reason
     * — see `resolveDocPilot`. Stated here in the RESOLVED shape so rule 11b can
     * see every leaf.
     *
     * `mode: 'auto'` does nothing until there is a budget the package can
     * DEFEND, which is two questions rather than one: a daily allowance has to
     * exist to be rationed — `dailyLimit` written down here, or a chat half
     * running on the provider's own free pool — and the number describing it has
     * to be daily, which a header count is trusted to be only when its reset is
     * ten minutes or more out. `x-ratelimit-remaining` alone answers neither:
     * every gateway in front of a self-hosted model publishes it for a
     * PER-MINUTE window, and a funded key on a metered provider publishes it for
     * an allowance with no daily ceiling at all. `budget.js` owns the predicate;
     * the reasoning behind each value lives with the resolver, in
     * `src/theme/docpilot/switches.js`.
     */
    budget: {
        mode: 'auto',
        oneShotBelow: 15,
        rotateAbove: 6,
        maxContinuations: 1,
        // OFF, and it is the one switch inside the panel that is: on a public
        // docs site every reader draws on one key, so the count a browser can
        // compute is not the count the account has. Turned on it states the
        // remaining requests AND, where the site declared `embed: false`, that
        // there is no embedder — one muted line about what the next question is
        // limited to. See switches.js for the whole of the reasoning.
        showRemaining: false,
        probe: 'auto',
        dailyLimit: null,
    },
    /**
     * A UNION — ui-specs/009. `suggestions: ['One?', 'Two?']` is still legal and
     * still means the same thing; the object form adds the two behaviours beside
     * the questions. Stated here in the resolved shape so rule 11b can see every
     * leaf, and replaced WHOLE by `resolveDocPilot` rather than merged, because
     * an array merged into an object is neither.
     *
     * `scoped` is what an empty panel offers when the scope is not `all`: the
     * pages in the scope, as rows. It generates no text. `followUps` is off —
     * see switches.js, where the reason is a measurement rather than a taste.
     */
    suggestions: {questions: [], scoped: true, followUps: false},
    /**
     * Quoting a passage — ui-specs/007 for the mechanism, 009 for the switches.
     *
     * `fromDocs` extends the selection popover to the host's own article. Off:
     * it paints a control on somebody else's prose, and a reader selecting a
     * command in order to copy it must not meet a button every time.
     */
    quote: {fromAnswer: true, fromDocs: false},
    /**
     * What a citation is worth to a reader who wants to check it — ui-specs/009.
     *
     * NOT `sources`, which is taken above by the origin allowlist. `passage`
     * expands a source row to the exact retrieved chunk, which is already in the
     * browser; `inCopy` appends the source list to a copied answer, so a `[1]`
     * pasted into a ticket arrives with something behind it.
     *
     * `passage` is off: the source row is already a link, and a chevron on every
     * row of every answer is a second layer over one. The project that wants
     * checking a source to be a normal step of reading turns it on.
     */
    citations: {passage: false, inCopy: true, pagesRead: false},
    /**
     * Two composer affordances — ui-specs/009. `editLastOnArrowUp` is ChatGPT's
     * own behaviour and readline's before it; `deepLink` reads `?dp-ask=` into
     * the composer and deliberately does not submit it.
     */
    composer: {editLastOnArrowUp: true, deepLink: true},
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
    feedback: {send: 'both', comment: true, confirm: true},
    guard: {mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3},
    scope: {enabled: true, default: 'all', promptListLimit: 12, filter: 'auto', groupBySection: true},
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
    history: {enabled: true, maxConversations: 20, exportThread: true},
    prompt: {show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: ''},
    /**
     * Where the button lives, what shape the panel takes, and what the floating
     * button is made of.
     *
     * `trigger` is a LIST and a bare word is shorthand for one, so a site can
     * have the navbar button, the mobile menu row and the floating button at
     * once: `['nav', 'fab']`, or `'both'` for all three. `'nav'` on its own
     * still means the navbar button AND its mobile row, which is what it has
     * always meant.
     *
     * `panel: 'auto'` follows the trigger — a list with `fab` in it opens the
     * floating popup, a list without one opens the full-height drawer. Both
     * crossed pairs are legal and are carried out in silence. `fabLabel` / `fabIcon` describe the floating
     * placement only: `true` takes the shipped words through i18n, a string
     * takes those words verbatim, `false` drops that half. See
     * `font` / `fontMono` are the one pair here that reaches the STYLESHEET
     * rather than a component: `session.configure` writes them onto `<html>`
     * as `--dp-font` and `--dp-font-mono`, which is the only layer that
     * outranks a host adapter's own mapping.
     *
     * `src/theme/docpilot/ui.js` for the resolver and ui-specs/005 for why;
     * this is the only place the shipped set is stated.
     */
    ui: {
        trigger: 'nav',
        panel: 'auto',
        fabLabel: true,
        fabIcon: true,
        layout: 'overlay',
        prefetch: 'hover',
        firstRunHint: false,
        /**
         * The panel wears the page's own font and ships none of its own —
         * `--dp-font` is `inherit`. These two are for the site whose face the
         * panel cannot inherit: a family list, or the name of the custom
         * property the site already keeps it in. Null means nobody said.
         */
        font: null,
        fontMono: null,
    },
    /**
     * The site the panel is mounted on — the four things it cannot infer.
     *
     * EVERY VALUE HERE IS NULL, and that is the design rather than an omission.
     * Null means "nobody said", which has to stay distinguishable from a value
     * the author chose — `article: 'main'` as a DEFAULT would silently outrank
     * the `.vp-doc, main` that the VitePress binding supplies, and the
     * selection-to-quote offer would stop appearing on half the pages of a
     * VitePress site with nothing to explain why.
     *
     * Host-specific values belong to the host binding
     * (`src/theme/docpilot/host-vitepress.js`); the neutral fallbacks belong to
     * `hostConfig()` in `src/theme/docpilot/host.js`, which is the one place the
     * three layers are resolved: what the author wrote here, then what the
     * binding supplies, then the neutral value.
     *
     *   base      the site's base path — `/docs/` for a site served in a
     *             subdirectory. Neutral `/`. Applied at exactly two egress
     *             points, the index fetch and `router.go`, and nowhere else:
     *             manifest paths and citation hrefs are base-less everywhere,
     *             which is what lets `isKnownPath` compare them literally.
     *   ragBase   where the built index is served from. Derived as `${base}rag`,
     *             which is what a static host does with `public/rag`. Set it
     *             when the index lives somewhere else.
     *   article   the host's article element. Bounds the selection-to-quote
     *             offer: a selection outside it is not a passage of
     *             documentation, and offering to ask about a sidebar link is a
     *             control that makes no sense. Neutral `main`.
     *   search    the host's own search button, which the panel's degraded and
     *             error states offer as the alternative. There is no neutral
     *             value — no site has a standard search selector — so without
     *             one from either layer THE AFFORDANCE IS NOT RENDERED. A button
     *             that clicks nothing is worse than no button. `false` says so
     *             explicitly, for a host whose binding supplies one and whose
     *             author does not want it.
     *   content   the focus target of last resort when the panel closes and the
     *             element that opened it has gone with a route change. Neutral
     *             `main`.
     */
    host: {
        base: null,
        ragBase: null,
        article: null,
        search: null,
        content: null,
    },
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

/**
 * Settings the THEME reads that `docPilot` deliberately does not carry.
 *
 * The mirror of `SERVER_ONLY`, and it exists for the same reason that one does:
 * "nothing can set this" is a decision, and a key nobody remembered to emit
 * looks identical from here. ui-specs/009's rule 11a walks every
 * `config.<group>.<key>` read anywhere under `src/theme/` and requires it to
 * resolve — against this list, which is the whole set of allowed exceptions.
 *
 * The list stayed short on purpose. When it first ran, rule 11a turned up a
 * fourth entry — `llm.think` — that had no writer in any code path and always
 * resolved to `true`. That one was deleted rather than added here, which is the
 * outcome this rule is for.
 */
export const THEME_ONLY = [
    /**
     * The offline eval runner builds its own `llm` object to drive the SAME
     * harness the panel does, and is allowed to configure things a documentation
     * site is not: how long one step may take, and whether the model it is
     * measuring can think at all.
     */
    'llm.stepTimeoutMs',
    'llm.thinkSupported',
    /**
     * A self-hosted endpoint on a private network, written by hand into
     * themeConfig. `themeDocPilot` must never emit it and never will:
     * themeConfig is compiled into the client bundle, so a key written there is
     * a key published. In production the panel calls a same-origin path and the
     * proxy attaches the credential.
     */
    'llm.apiKey',
    'embed.apiKey',
]

/** Settings with defaults filled in. Nested objects merge; `embed` does not. */
/**
 * `chat`, merged — and the one place the environment gets to answer a question
 * about the configuration.
 *
 * TWO THINGS ARE RESOLVED HERE and they used to be one omission each.
 *
 * THE PROVIDER. `'auto'` — which is also what an omitted `chat` block means —
 * walks `CHAIN` and takes the first member this environment carries a key for.
 * An id the author wrote down always wins; the environment is consulted only
 * where nobody said. See `resolveChain` for the order and for why it never
 * touches the network.
 *
 * THE MODEL. `chat.model` used to have one shipped value, `qwen3:8b`, which is a
 * statement about Ollama and about nothing else — so a blind merge posted that
 * name to OpenRouter for an author who wrote `chat: {provider: 'openrouter'}`,
 * and the guard against it was to drop the name and let `assertChat` stop the
 * build. Correct, and a dead end: `chat: {provider: 'openai'}` is a complete
 * sentence in every reader's head and was a build failure here. The per-provider
 * default now lives in the provider table beside `embedModel`, where a statement
 * about a service belongs, so naming a provider names a model too — and naming
 * NEITHER, which is the whole zero-config path, resolves both from the one key
 * in the environment.
 *
 * The null case is unchanged and still reachable: `openrouter` and `custom` name
 * no `chatModel`, because a pool answers for the first and only the author can
 * answer for the second.
 */
/**
 * `baseURL` is in the parameter type and not in `DEFAULTS.chat`, which is not an
 * oversight being papered over: it is read by `targetOf`, `nodeChatTarget` and
 * `resolveEmbed` and has never had a shipped value, because there is no address
 * that is right for every provider. Naming it here is what lets this function
 * resolve one.
 *
 * @param {{provider?: string, model?: string|null, models?: string[]|null,
 *   temperature?: number, maxTokens?: number, numCtx?: number,
 *   baseURL?: string|null, extraBody?: object|null}} [chat]
 * @param {Record<string, string|undefined>} [env]
 */
function resolveChat(chat = {}, env = {}) {
    const named = {...DEFAULTS.chat, ...chat}
    /**
     * WHETHER THE ENVIRONMENT CHOSE, recorded because the resolved value cannot
     * say. `provider: 'openai'` written by an author and `provider: 'auto'`
     * resolved against `OPENAI_API_KEY` are the same string here and are not the
     * same decision — one is worth printing the chain for at startup and the
     * other is noise. It is deliberately NOT in `DEFAULTS`: nothing can set it,
     * it is an output of this function, and `themeDocPilot` names the keys it
     * emits one by one, so it never reaches the browser.
     */
    const providerAuto = !named.provider || named.provider === 'auto'
    const provider = providerAuto ? resolveChain(env).id : named.provider
    const merged = {
        ...named,
        providerAuto,
        provider,
        /**
         * WHERE the local Ollama is, from the same variable that selects it.
         *
         * Every hosted provider gets its address from the provider table and,
         * for the two self-hosted entries, from `baseUrlEnv` through
         * `upstreamOf`. Ollama has no table row — it is the keyless local case
         * this file handles separately — so the same courtesy is extended by
         * hand, and extended to an EXPLICIT `provider: 'ollama'` too: a project
         * that pinned the local one still deserves to move it without editing
         * code. The author's own `chat.baseURL` outranks it, as everywhere else.
         *
         * Stated in the literal rather than assigned below, so the key is part
         * of the object's shape on every branch: it is read by `targetOf`,
         * `nodeChatTarget` and `resolveEmbed`, none of which should have to ask
         * whether it happens to be there.
         */
        baseURL:
            named.baseURL ||
            (provider === 'ollama' ? env[OLLAMA_BASE_URL_ENV] || LOCAL_BASE_URL : named.baseURL),
    }
    // `model: 'auto'` is a spelling openrouter.js advertises, and a spelling that
    // is recognised but never STRIPPED is worse than one that is not recognised
    // at all: `chatModels` read it as "you choose" and the transport read it as a
    // model id, so the pool was resolved correctly and then `auto` was posted at
    // the head of it. Normalise once, here, and every reader downstream sees the
    // same null the omitted case produces.
    if (isAutoModel(merged.model)) merged.model = null
    // The provider's own default, and only where the author named nothing. A
    // pooled provider keeps the null it just normalised to — `chatModels` reads
    // that as "you choose" and walks the free pool, which is the answer there.
    if (merged.model == null) {
        merged.model =
            merged.provider === 'ollama' ? LOCAL_CHAT_MODEL : hostedOf(merged.provider)?.chatModel ?? null
    }
    return merged
}

export function resolveDocPilot(settings = {}, env = {}) {
    return {
        ...DEFAULTS,
        ...settings,
        // The one resolver that reads the environment. Every other value in this
        // object is the author's or this file's; `chat.provider` may also be the
        // deployment's, which is what makes an install with nothing but a key in
        // `.env.local` a working install.
        chat: resolveChat(settings.chat, env),
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
        // Merged the same way, but only when there is an object to merge. This
        // one is a union whose off form is `false`, and `{...DEFAULTS.budget,
        // ...false}` spreads to nothing: the author would write one word to
        // switch the block off and be handed the shipped block back, with
        // nothing anywhere saying so. Anything else that is not an object — the
        // `budget: 'off'` somebody will write — passes through untouched, so the
        // complaint comes from `resolveBudget`, in one voice, where the other
        // budget complaints come from.
        //
        // AN ARRAY IS NOT AN OBJECT HERE, whatever `typeof` says. `budget: []`
        // took the merge arm, `{...DEFAULTS.budget, ...[]}` yielded the shipped
        // block, and the author's mistake was answered with silence — the exact
        // failure the paragraph above says this arrangement exists to prevent.
        // `resolveBudget` has had an `Array.isArray` guard the whole time and
        // nothing could reach it from here.
        budget:
            settings.budget && typeof settings.budget === 'object' && !Array.isArray(settings.budget)
                ? {...DEFAULTS.budget, ...settings.budget}
                : (settings.budget ?? DEFAULTS.budget),
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
    /**
     * ONE ENTRY PER PROVIDER, not per half.
     *
     * The two halves are usually the same service — `embed: 'auto'` follows chat
     * wherever chat can embed — so a missing key produced the identical sentence
     * twice, with the identical fix under each, and the reader counting "2 things
     * to set up" for one variable. It became the common case the moment an empty
     * environment started resolving both halves to OpenRouter's free tier.
     */
    const halvesOf = new Map()
    for (const [half, id] of [['chat', docPilot.chat.provider], ['embed', embed.provider]]) {
        const hosted = hostedOf(id)
        if (!hosted) continue // ollama needs no key
        // A self-hosted server on a port of your own. It is in `PROVIDERS`
        // because it speaks a hosted provider's API and is reached through the
        // same `/ai`, not because it has an account behind it — so demanding a
        // credential here is a missing entry for a fault that does not exist,
        // and one the author cannot fix.
        if (hosted.keyless) continue
        if (keyOf(env, id)) continue
        if (!halvesOf.has(id)) halvesOf.set(id, [])
        halvesOf.get(id).push(half)
    }
    for (const [id, halves] of halvesOf) {
        const hosted = hostedOf(id)
        missing.push({
            what: `${halves.join(' and ')}: "${id}" needs a key and none is set`,
            fix: `export ${hosted.envKeys[0]}=… (or put it in .env.local and pass loadEnv('', process.cwd(), '') to defineDocPilot)`,
        })
    }

    /**
     * A NOTE beside the missing key above, saying WHY the configuration names a
     * provider the config file never mentions.
     *
     * `provider: 'auto'` reaching `CHAIN_FALLBACK` means the environment selected
     * nothing at all, and "chat and embed: openrouter needs a key" on its own
     * reads as a setting somebody made and then broke. What it actually is is the
     * fall-through, and the useful half of saying so is what it costs to finish:
     * one free key, no model to choose, both halves covered.
     */
    if (docPilot.chat.providerAuto && docPilot.chat.provider === CHAIN_FALLBACK && !keyOf(env, CHAIN_FALLBACK)) {
        notes.push(
            "chat.provider is 'auto' and no provider key was found in the environment, so both " +
                `halves fell through to ${CHAIN_FALLBACK} — its free tier needs no model named on ` +
                'either side and no card, so one free key finishes the install. Any other key ' +
                'is chosen ahead of it: ' +
                `${resolveChain(env).tried.filter((t) => t.envKey && t.id !== CHAIN_FALLBACK).map((t) => t.envKey).join(', ')}. ` +
                `${OLLAMA_BASE_URL_ENV} selects a local Ollama, and chat: {provider: 'ollama'} pins ` +
                'it whatever the environment holds.',
        )
    }

    /**
     * A NOTE, because nothing is missing — the author asked for this and the
     * panel answers. What the config file cannot show them is the size of what
     * they gave up, so the measurement is quoted here: this block prints on the
     * build, which is where the decision is still cheap to reverse.
     *
     * The cross-language sentence is separate because it is a different
     * failure. The lexical channel does not merely degrade for a question asked
     * in another language than the corpus — it scores zero, so a site with
     * readers in one language and documentation in another has no retrieval at
     * all rather than a weaker one.
     */
    if (embed.lexicalOnly) {
        notes.push(
            'embed: false — there is no embedder, so retrieval is BM25 over the chunk text ' +
                'alone. Measured once, on a 1191-chunk corpus: recall@8 0.97 → 0.41, ' +
                'retrieval F1 0.35 → 0.18, and 11 of 44 answerable questions refused outright. ' +
                'A question asked in a language the corpus is not written in scores zero. ' +
                'Reproduce with `npx docpilot eval --gate-only --lexical`.',
        )
    }

    /**
     * A NOTE, not a `missing` — the configuration works — and it is here because
     * the alternative is a default nobody was told about.
     *
     * `embed: 'auto'` beside a chat provider that cannot embed now resolves to
     * OpenRouter's free pool, which means every chunk of the corpus is posted to
     * a service that appears nowhere in the author's config file. That is a fine
     * default and a poor secret: an internal docs site may not be allowed to
     * send its text to a third party at all, and the place to find that out is
     * the first build, not an audit.
     */
    if (embed.borrowed) {
        notes.push(
            `embed: 'auto' — "${embed.borrowed}" has no embeddings endpoint, so the index is ` +
                `built with ${embed.provider}'s free embedding pool. The whole corpus is sent ` +
                'there at build time (questions still go to ' +
                `"${docPilot.chat.provider}"). Name an embedder explicitly to keep it elsewhere.`,
        )
    }

    const embedPool = embedModels(docPilot)
    const idx = indexInfo(docPilot)
    if (!idx) {
        missing.push({
            what: `no index at ${indexDirOf(docPilot)}`,
            fix: 'npx docpilot index',
        })
    } else if (embed.lexicalOnly && idx.vectors) {
        /**
         * A note, not a `missing`: retrieval is exactly what was declared and
         * every question is answered. What is wrong is the weight — the browser
         * fetches whatever `manifest.vectors` names, so the whole quantised blob
         * is downloaded by every reader and no part of this configuration ever
         * scores against it. Bandwidth, not behaviour, which is why it does not
         * switch the panel off.
         */
        notes.push(
            `the index at ${indexDirOf(docPilot)} still carries vectors ("${idx.embedModel}", ` +
                `${idx.dims}d) and this configuration never queries them — every reader ` +
                'downloads that blob and none of it is read. `npx docpilot index` rebuilds it ' +
                'without them.',
        )
    } else if (!embed.lexicalOnly && idx.vectors === null) {
        /**
         * The same disagreement from the other side, and this one IS fatal to
         * the deployment's intent rather than to its answers.
         *
         * A configured embedder means a key, a bill or a self-hosted service,
         * and the browser embedding every question against an index that has no
         * vector space to score it in — so the site pays for semantic retrieval
         * on every turn and gets BM25. It fails silently because lexical-only is
         * a working mode: nothing errors, the answers are merely worse than the
         * ones being paid for.
         */
        /**
         * UNLESS THE SITE SAID WHAT TO DO ABOUT IT. `embed.fallback: 'lexical'`
         * is the author answering this question in advance: an embedder was
         * configured, it refused, and a vectorless index was preferred to no
         * index. That is a note — the deployment is running exactly the mode it
         * declared for this case — and it carries the size of what was given up,
         * because the reason it happened was somebody else's free tier being
         * busy and nothing about this site changed to cause it.
         */
        if (embed.fallback === 'lexical') {
            notes.push(
                `the index at ${indexDirOf(docPilot)} was built WITHOUT VECTORS — the embedder ` +
                    `"${embed.provider}" refused and \`embed.fallback: 'lexical'\` took over. ` +
                    'Retrieval is BM25 over the chunk text alone. Measured once, on a ' +
                    '1191-chunk corpus: recall@8 0.97 → 0.41, retrieval F1 0.35 → 0.18, and ' +
                    '11 of 44 answerable questions refused outright. A question asked in a ' +
                    'language the corpus is not written in scores zero. Rebuild with ' +
                    '`npx docpilot index` once the embedder is answering again.',
            )
        } else {
            missing.push({
                what:
                    `the index at ${indexDirOf(docPilot)} was built without vectors, but ` +
                    `embed names "${embed.provider}" — every question would be embedded and ` +
                    'nothing would be scored against it',
                fix:
                    'npx docpilot index   (or set `embed: false` to declare lexical-only ' +
                    "retrieval, or `embed: {fallback: 'lexical'}` to allow it when the " +
                    'embedder refuses)',
            })
        }
    } else if (embed.model && idx.embedModel !== embed.model) {
        // Not fatal to the build, but fatal to retrieval: a query scored
        // against a foreign vector space is not a worse answer, it is no
        // answer, and the calibrated gate starts refusing answerable questions.
        missing.push({
            what: `the index was built with "${idx.embedModel}" but embed.model is "${embed.model}"`,
            fix: 'npx docpilot index   (or change embed.model back to the one that built it)',
        })
    } else if (!embed.model && embedPool?.length && !embedPool.includes(idx.embedModel)) {
        /**
         * The pooled half's version of the same disagreement, and it needed
         * saying the moment `embed: 'auto'` started borrowing a pool.
         *
         * "The config names nothing, so the index names the winner and the
         * browser follows it" is only sound while the index was built by THIS
         * provider. Switch `chat.provider` from ollama to anthropic and the
         * embedder silently becomes OpenRouter's pool — while the manifest on
         * disk still says `bge-m3`, which the browser then dutifully posts to
         * OpenRouter. That is a 404 per question and lexical-only retrieval for
         * the life of the deployment, with nothing failing anywhere.
         */
        missing.push({
            what:
                `the index was built with "${idx.embedModel}", which is not in ` +
                `${embed.provider}'s free embedding pool — the browser would ask ` +
                `${embed.provider} for a model it does not serve`,
            fix: 'npx docpilot index',
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
