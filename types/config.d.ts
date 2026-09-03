/**
 * The settings object — the one thing every entry point in this package is
 * about, and the reason these declarations are hand-written.
 *
 * `tsconfig.json` states the policy: type CHECKING, never compilation. `exports`
 * points straight at `./src/*.js`, so a build step would change the artifact
 * every consumer receives. Emitting declarations from the JSDoc would also need
 * `strict` on a tree that has shipped without it, and what came out would be
 * mostly `any` with the internals leaking through — worse documentation than
 * none. So the public surface is written once, by hand, and `npm run typecheck`
 * checks it against the code.
 */

/** Every provider adapter the package speaks. */
export type ProviderId =
  | 'ollama'
  | 'openai'
  | 'together'
  | 'fireworks'
  | 'mistral'
  | 'nebius'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'xai'
  | 'cerebras'
  | 'custom'
  | 'llamacpp'
  | 'gemini'
  | 'anthropic'

/**
 * One member of the answering chain — a provider, and optionally what to send it.
 *
 * The object form exists because a model id already contains slashes
 * (`meta-llama/Llama-3.3-70B-Instruct-Turbo`, `openrouter/free`), so
 * `'provider/model'` is a spelling nothing can parse unambiguously.
 */
export interface ChainMember {
  provider: ProviderId
  /**
   * What identifies this member, where the provider id does not.
   *
   * Two entries of one service — two gateways, two regions, two accounts — are
   * two members, and this is what tells them apart: it keys the proxy route
   * (`/ai/<name>/…`), the cooldown the transport learns, and the credential.
   * Omitted, it IS the provider id, which is what keeps every chain written
   * before this existed resolving to the same paths.
   *
   * It is rendered into a URL and matched exactly by your proxy, so it is
   * lowercase letters, digits and hyphens. Two members may not share one.
   */
  name?: string
  /** Omitted takes that provider's own default from the table. */
  model?: string | null
  /** That member's own ordered pool, walked before the next PROVIDER is tried. */
  models?: string[] | null
  /**
   * Where this member is — for `ollama`, `llamacpp` and `custom`, which name a
   * host you run rather than a service. It sets the address the proxy posts to
   * (the browser always calls your own origin), and it outranks the matching
   * environment variable.
   *
   * Naming it beside a branded provider STOPS THE BUILD. That service has an
   * address of its own, and rerouting it on the strength of one line is a
   * surprise; `custom` is the id for a host of your own that copied somebody's
   * API.
   */
  baseURL?: string | null
  /**
   * The NAME of the environment variable holding this member's key — never the
   * value, which in a config file is a value compiled into the client bundle.
   *
   * Omitted takes the provider's own variable from the table, which has exactly
   * one name per provider. This is what lets two members of one service carry
   * two credentials.
   */
  apiKeyEnv?: string
}

export interface ChatSettings {
  /**
   * `'auto'` — the default, and what an omitted key means — reads the
   * environment: the provider chain is walked in order and the first service a
   * key is set for answers. An id written down here is never overridden.
   *
   * See `CHAIN` in src/config.js for the order and the reasoning.
   */
  provider?: ProviderId | 'auto'
  /**
   * WHICH SERVICES MAY ANSWER, in order — the provider-level sibling of
   * `models`.
   *
   * `'auto'` — the shipped value — is every member of `CHAIN` this environment
   * selects, billed accounts before a provider's own free catalogue and a server
   * of your own last, walked in order until one answers. `false` is one provider
   * chosen once, which is what every deployment did before this key. An array is
   * your own set, in your order: an entry is a provider id, or an object saying
   * what to send that member.
   *
   * An environment holding ONE key selects one member either way, and a
   * one-member chain is the scalar configuration that has always shipped.
   *
   * IT FIRES ONLY WHERE `provider` IS ALSO `'auto'`. A provider you name is
   * never overridden, so naming one is how rotation is declined and `false` is
   * how it is declined without naming one. An explicit array is the exception —
   * a named provider LEADS it.
   *
   * `model` and `models` above reach the HEAD member only: a model name never
   * crosses providers.
   *
   * THE EMBED HALF DOES NOT ROTATE and cannot — two embedding models are two
   * vector spaces, and the manifest binds every reader's browser to the one the
   * index was built with.
   */
  chain?: 'auto' | false | Array<ProviderId | ChainMember>
  /**
   * Omit it and the PROVIDER's own default is used — every branded provider
   * carries one. Two do not: `openrouter`, where an unnamed model resolves to
   * the shipped free pool, and `custom`, which names a host rather than a
   * service and therefore stops the build, because the alternative is a 400 in
   * a reader's browser naming a model that appears nowhere in your config.
   */
  model?: string | null
  /**
   * The address of a server of your own, for the transports that name a host
   * instead of a service — `ollama`, `llamacpp` and `custom`.
   *
   * It outranks the matching environment variable (`OLLAMA_BASE_URL`,
   * `LLAMACPP_BASE_URL`, `CUSTOM_BASE_URL`), which sets the same address without
   * committing it to the config. For `ollama` it is where the BROWSER goes; for
   * the other two it is where your proxy posts, the browser reaching them
   * same-origin like everything else.
   *
   * Naming it beside a branded provider STOPS THE BUILD rather than being
   * ignored: that service carries its own endpoint, and overriding it is how a
   * request ends up at a URL nobody configured.
   */
  baseURL?: string | null
  /**
   * Prefer a server of your own — `custom`, `llamacpp`, `ollama` sort to the
   * FRONT of the ladder rather than the back, and an environment that selects
   * nothing falls through to a local Ollama rather than to OpenRouter's free
   * tier.
   *
   * It reorders; it never selects. A local server is still reached by its
   * address, because from inside a build a laptop running one and a CI box that
   * has never heard of one are the same environment — which is why naming no
   * provider stopped resolving to a local Ollama in the first place. Writing
   * this is not a guess; inferring it would be.
   */
  preferLocal?: boolean
  /**
   * An ORDERED fallback pool, tried in turn until one member answers — for
   * shared free tiers, where a 429 reports how many other people are asking
   * rather than anything about the model. Null on a provider that bills per
   * token: rotating there changes what a turn costs without being asked.
   */
  models?: string[] | null
  temperature?: number
  maxTokens?: number
  /** Sent only on the ollama transport; hosted providers size their own. */
  numCtx?: number
  /**
   * Fields merged into the body of every chat request, for the things one brand
   * understands and the transport does not — `openrouter` defaults to
   * `{provider: {require_parameters: true}}`, which is what makes it honour the
   * strict answer schema.
   *
   * PRESENCE decides, not truthiness: omit the key and the provider's own
   * fragment stands, write `null` and the plain body is posted, write an object
   * and it REPLACES the provider's rather than merging with it. Declaring it
   * `| null` is therefore not decoration — `null` is the only way to spell
   * "none", and without it here a documented decline would not compile.
   */
  extraBody?: Record<string, unknown> | null
  /**
   * How hard the model should think, in one provider-neutral word.
   *
   * `'auto'` — the default, and what an omitted key means — leaves it to
   * DocPilot, which asks on the answer and never on a search step. `false` never
   * asks; `true` is `'medium'`.
   *
   * THE LEVEL IS CLAMPED, not posted as written: no two services publish the
   * same vocabulary, so the word is ranked and the nearest one the configured
   * provider accepts is sent, ties going down. `npx docpilot doctor` prints the
   * substitution. See the capability matrix in the providers guide.
   */
  reasoning?: 'auto' | boolean | ReasoningLevel | ReasoningRequest
  /**
   * A soft ceiling on the ANSWER's length, where `maxTokens` is the hard one.
   * Accepted by two providers; naming it beside any other stops the build rather
   * than being dropped on the way out, and so does a word that is not one of
   * these three.
   */
  verbosity?: 'low' | 'medium' | 'high' | null
  /** Nucleus sampling, sent only when set. Not accepted by Anthropic. */
  topP?: number | null
  /**
   * The stronger form of the argument `temperature: 0.2` already makes. The
   * Anthropic Messages API has no such parameter, so setting it there stops the
   * build.
   */
  seed?: number | null
}

/**
 * The neutral effort scale — a union of real vocabularies rather than an
 * invention. Every service accepts a subset and no two subsets agree, which is
 * why what you write is clamped rather than forwarded.
 */
export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ReasoningRequest {
  /** Null leaves the depth to the service. */
  effort?: ReasoningLevel | 'auto' | null
  /**
   * A thinking budget in TOKENS, for the services that measure it that way
   * rather than in levels. Setting it on one that does not stops the build.
   */
  budgetTokens?: number | null
  /**
   * `false` asks the service to think without sending the trace back — a
   * different request from not thinking, and cheaper output on a panel that is
   * not showing the box. Two providers can spell it.
   */
  visible?: boolean
}

export interface EmbedSettings {
  provider?: ProviderId
  /**
   * Omit it and the PROVIDER's own default is used, then checked: `npx docpilot
   * index` asks the service which embedding models it serves and walks those
   * answers behind the configured name, writing whichever answered into the
   * manifest for the browser to read back.
   *
   * A name you DO write here is used as given — no catalogue is read, and a
   * wrong one fails loudly rather than being quietly replaced.
   *
   * Rotation is a BUILD decision either way: two embedding models are two vector
   * spaces, so a busy embedder at query time degrades retrieval to lexical-only
   * rather than switching.
   */
  model?: string
  baseURL?: string
  /**
   * What to do when the embedder above will not answer.
   *
   * Absent, `npx docpilot index` dies and there is no index — the right default,
   * because an index quietly missing its vectors is a site whose retrieval got
   * materially worse with nothing said. `'lexical'` prefers a vectorless index
   * to no index: BM25 over the chunk text alone, the same mode `embed: false`
   * declares, with `readiness` reporting it as a note rather than a failure.
   *
   * Opt-in, and the reason is the measurement: recall@8 0.97 → 0.41, and a
   * question asked in a language the corpus is not written in scores zero.
   *
   * A second EMBEDDER is deliberately not offered. The index and every query
   * must land in one vector space, so a second embedder is a second index — and
   * its address would have to reach every reader's browser.
   *
   * It describes what to do, not which embedder, so it rides on the automatic
   * one too: `embed: { fallback: 'lexical' }` is `'auto'` plus a fallback.
   */
  fallback?: 'lexical'
}

/**
 * `'auto'` follows the chat provider where that provider has an embeddings
 * endpoint, and falls back to a local one where it does not — Anthropic has
 * none at all, which is why the two halves are configured separately.
 *
 * `false` declares NO embedder: the index is built without vectors and
 * retrieval is BM25 alone. It is the documented spelling — `'none'` is the
 * accepted alias — and the union follows the house precedent of
 * `budget: false` three interfaces down. Omitting it here is what would make
 * the configuration `docs/reference/config.md` documents fail to compile.
 */
export type EmbedConfig = 'auto' | false | 'none' | EmbedSettings

/**
 * An object configures the model that answers. `false` declares that NOTHING
 * does — search-only mode: a question is scored against the index and answered
 * with the ranked passages themselves, each linked to its heading, and no model
 * is called on any turn.
 *
 * The same two spellings as `embed` above, for the same reason: `false` is
 * documented, `'none'` is the accepted alias. Paired with `embed: false` it is a
 * deployment that holds no provider key and makes no outbound request after the
 * page loads; paired with an embedder it is hybrid ranking with no prose.
 */
export type ChatConfig = ChatSettings | false | 'none'

/**
 * Three of these six were missing here for the whole life of the other three.
 *
 * `precomputed`, `answers` and `matchTau` shipped with the openers bake, are
 * resolved by `resolveSuggestions` and are documented in the config reference —
 * and were absent from the public surface, so a consumer writing TypeScript
 * could not set them without a cast.
 *
 * THE CONFORMANCE GATE COULD NOT HAVE CAUGHT IT. `DEFAULTS` is declared
 * `Required<DocPilotSettings>` and excess-property checking applies only to
 * fresh object literals, so a wider generated object stays assignable to a
 * narrower interface with optional keys — in both directions, forever. A
 * missing optional key is structurally invisible to `typecheck:dist`, which is
 * why rule 11f walks `DEFAULTS` against this file instead.
 */
/**
 * One opener the author answered themselves — engine-specs/017.
 *
 * `cite` is required and is a list of chunk ids (`guide/appearance#the-tokens`).
 * The build checks every one against the index it just wrote and drops the whole
 * answer if any is unknown, because prose with nothing in the corpus behind it
 * is the one artefact the bake refuses to ship.
 */
export interface AuthoredOpener {
  q: string
  answer: string
  cite: string[]
}

export interface SuggestionsSettings {
  /**
   * A string is a question the model answers. `{q, answer, cite}` is a question
   * the AUTHOR answered — the answer ships verbatim and no model is called for
   * it, at build time or in the browser.
   */
  questions?: (string | AuthoredOpener)[]
  /**
   * RESOLVED, not authored. `resolveSuggestions` lifts the written answers out
   * of `questions` onto this key so everything downstream keeps reading
   * `questions` as `string[]`. Writing it by hand is supported and re-validated,
   * which is what makes the resolver idempotent.
   */
  authored?: AuthoredOpener[]
  scoped?: boolean
  followUps?: boolean
  precomputed?: boolean
  answers?: boolean
  /** `false` retires the paraphrase test — `MATCH_NEVER`, engine-specs/009. */
  matchTau?: number | false
  /**
   * The same test in the VECTOR space, on the query the turn already bought —
   * engine-specs/017. `false` retires it and leaves the lexical pass alone.
   */
  matchCos?: number | false
  /** A baked answer is revealed progressively rather than placed whole. */
  reveal?: boolean
}

export interface QuoteSettings {
  fromAnswer?: boolean
  fromDocs?: boolean
}

export interface CitationsSettings {
  /**
   * A source row expands to the exact retrieved passage. Off by default: the row
   * is already a link, and this is a second layer over one.
   */
  passage?: boolean
  inCopy?: boolean
  pagesRead?: boolean
}

export interface ComposerSettings {
  editLastOnArrowUp?: boolean
  deepLink?: boolean
  /** The composer's text survives a reload, in `sessionStorage` — ui-specs/012. */
  draft?: boolean
}

/**
 * What a turn may SPEND, on a tier metered in requests rather than in tokens.
 *
 * `budget: false` — the union's other arm — is the whole block off: agentic
 * every turn, no budget line, and the tool probe restored to unconditional.
 */
export interface BudgetSettings {
  /**
   * `'auto'` collapses a turn to a single request only once a response has
   * actually reported a remaining count at or below `oneShotBelow`. A provider
   * that sends no rate-limit headers leaves the budget unknown and the turn
   * agentic, which is why this is safe to ship on for everyone else.
   */
  mode?: 'auto' | 'agentic' | 'one-shot'
  /** Answers left at or below which a turn costs one request. `-1` retires the rule. */
  oneShotBelow?: number
  /**
   * Rotate the pool only while the remaining count is above this — rotation
   * costs a request. `-1` retires the rule, and is what `budget: false` writes.
   */
  rotateAbove?: number
  /** How many follow-up requests may reassemble a reply the provider truncated — 0 to 3. */
  maxContinuations?: number
  /**
   * The muted line under the composer: how many answers are left today, and —
   * where the site declared `embed: false` — that it has no embedder. Off by
   * default, because on a shared key a browser's own count is not the account's.
   */
  showRemaining?: boolean
  /** The tool-detection call, which costs a request on every page load. */
  probe?: 'auto' | 'always' | 'never'
  /** Null learns the ceiling from response headers; a number counts locally instead. */
  dailyLimit?: number | null
}

export interface FeedbackSettings {
  send?: 'both' | 'up' | 'down' | 'none'
  comment?: boolean
  confirm?: boolean
}

export interface GuardSettings {
  /**
   * Whether a failing verdict ENDS the turn before the model is called. Every
   * value still SCORES every turn and records the result; only the refusal moves.
   *
   * `'dense-only'` — the default — refuses only where a dense channel scored it.
   * With no embedder the hybrid score collapses to lexical coverage alone, and
   * that is 0 for a reader asking in another language or calling the product by
   * a name the docs do not use: a refusal built on it says the corpus has
   * nothing when the truth is that the channel cannot tell. `'calibrated'`
   * refuses always. `'off'` never does.
   */
  mode?: 'dense-only' | 'calibrated' | 'off'
  /** Null keeps the calibrated value from the manifest. */
  tau?: number | null
  tauLexical?: number | null
  supportMinIdentifiers?: number
}

/**
 * The documentation's own name for things readers call by other names.
 *
 *     vocabulary: {DocPilot: ['widget', 'виджет', 'ассистент']}
 *
 * The key is the word the corpus uses; the array is the words readers use for
 * it. `terms()` rewrites one into the other over BOTH the index and the query,
 * so a reader who says `виджет` reaches a page that says `DocPilot`. It
 * rewrites and never adds, so an off-topic question padded with product nouns
 * still carries every off-domain term it came with.
 *
 * Null takes the sidecar `npx docpilot vocabulary` writes; `{}` is
 * declared-and-empty and takes nothing. Server-only: the browser reads it off
 * the manifest, which is what the index was built with.
 */
export type VocabularySettings = Record<string, string[]>

export interface ScopeSettings {
  enabled?: boolean
  /** Only `'all'`; a build-time default of `page` would narrow every first question. */
  default?: 'all'
  promptListLimit?: number
  /**
   * `'auto'` shows the filter once the corpus is long enough to need one; a
   * boolean decides it outright. The strings `'always'` and `'never'` were
   * declared here for two releases and never read — `switches.js` accepts
   * `['auto', true, false]` and the panel branches on `typeof mode === 'boolean'`.
   */
  filter?: 'auto' | boolean
  groupBySection?: boolean
}

export interface HistorySettings {
  enabled?: boolean
  maxConversations?: number
  exportThread?: boolean
  /** An unfinished turn is written down when the page goes away — ui-specs/012. */
  saveOnUnload?: boolean
}

export interface PromptSettings {
  show?: boolean
  allowAppend?: boolean
  appendMaxChars?: number
  override?: string | null
  extend?: string
}

/** The three placements a trigger can occupy, in document order. */
export type UiTrigger = 'nav' | 'screen' | 'fab'

/**
 * A word that stands for a list of placements.
 *
 * `'nav'` is both a placement and a word, and as a word it means the navbar
 * button AND its row in the mobile nav menu — which is what it has always
 * meant. Spell `['nav']` to get the desktop button on its own.
 */
export type UiTriggerWord = UiTrigger | 'both' | 'all' | 'none'

/** What an author writes. `resolveUi` turns it into `ResolvedUi`. */
export interface UiSettings {
  trigger?: UiTriggerWord | UiTrigger[]
  panel?: 'auto' | 'drawer' | 'popup'
  fabLabel?: boolean | string
  fabIcon?: boolean
  layout?: 'overlay' | 'push'
  prefetch?: 'hover' | 'idle' | false
  firstRunHint?: boolean
  /** The status line escalates at 8s and 25s while nothing arrives — ui-specs/012. */
  waitingEscalation?: boolean
  /**
   * Whether a turn outlives the panel it was asked in — ui-specs/010.
   *
   * `'notify'` runs it on and marks the trigger with a dot when it settles;
   * `'open'` runs it on and brings the panel back with the answer in place;
   * `false` abandons it on close, which is where this was before the setting.
   */
  background?: 'notify' | 'open' | false
  /**
   * The one word of attribution in the footnote — `DocPilot`, linked to the
   * project. On by default; `false` removes it.
   */
  credit?: boolean
  /**
   * Which colour scheme the panel wears — ui-specs/011.
   *
   * `'auto'` follows the page, which is what it has always done: the host's own
   * light/dark toggle where there is an adapter, `prefers-color-scheme` where
   * there is none. `'light'` and `'dark'` pin it against both. `'system'` is a
   * spelling of `'auto'` and resolves to it.
   */
  theme?: 'auto' | 'light' | 'dark' | 'system'
  /**
   * The panel's face, for a site the panel cannot inherit one from. A family
   * list — `'Inter, system-ui, sans-serif'` — or the name of the custom
   * property the site already keeps it in — `'--brand-font'`, which is wrapped
   * into `var(--brand-font)` for you. Unset, the panel wears the page's own
   * font: `--dp-font` is `inherit`.
   */
  font?: string | false | null
  /** The same, for the code blocks and the prompt disclosure. */
  fontMono?: string | false | null
}

/**
 * What every consumer actually reads — the build emits it, the client store
 * re-resolves it, and the three trigger instances render off the booleans.
 *
 * `trigger` is a LIST here and never a word: `'nav'` means two placements, so a
 * resolved value that was still the word would not be resolved. `panel` is never
 * `'auto'` for the same reason.
 */
export interface ResolvedUi {
  trigger: UiTrigger[]
  panel: 'drawer' | 'popup'
  showNavTrigger: boolean
  showScreen: boolean
  showFab: boolean
  fabLabel: boolean | string
  fabIcon: boolean
  layout: 'overlay' | 'push'
  prefetch: 'hover' | 'idle' | false
  firstRunHint: boolean
  waitingEscalation: boolean
  background: 'notify' | 'open' | false
  credit: boolean
  /**
   * The one key here that may still be `'auto'`, and the exception is the
   * point: `panel: 'auto'` names a shape the build can settle, this names a
   * SIGNAL that only exists in the reader's browser. `'system'` is gone by now.
   */
  theme: 'auto' | 'light' | 'dark'
  /** A CSS value, ready to write — a family list or a `var(--…)`. */
  font: string | null
  fontMono: string | null
}

/**
 * The four things about your site the panel cannot work out for itself.
 *
 * Every default is `null`, which means *nobody said* — a value here outranks the
 * host binding, and a binding outranks the neutral fallback. `search: false`
 * suppresses the affordance on a host whose binding supplies one.
 */
export interface HostSettings {
  base?: string | null
  ragBase?: string | null
  article?: string | null
  search?: string | false | null
  content?: string | null
}

export interface I18nSettings {
  translations?: Record<string, unknown>
  locales?: Record<string, { translations?: Record<string, unknown> }>
}

/** What you pass to `defineDocPilot`, and export by name for the CLI to read. */
export interface DocPilotSettings {
  enabled?: boolean
  product?: string | null
  docsDir?: string
  indexDir?: string | null
  evalDir?: string
  importDir?: string | null
  sources?: { allow: string[] } | null
  /**
   * Where the OpenAPI specs are, as paths from the project root: a directory, a
   * file, or a `*` in the FILE NAME. `null` is the default and means
   * `${docsDir}/public/openapi`, which is where they had to be before this key
   * existed.
   */
  openapi?: string[] | null
  chat?: ChatConfig
  embed?: EmbedConfig
  /**
   * How many excerpts the gate hands the model — the retriever's `GATE_K` under
   * its documented name, and the k every retrieval number in the eval report is
   * measured at.
   *
   * `null` is the DEFAULT and a legal authored value, meaning *nobody said*: the
   * k this corpus MEASURED stands — `docpilot tune` writes it to `tuning.json`,
   * `docpilot index` inlines it into the manifest, and the browser reads it back.
   * A number is the author overriding that by hand, clamped to the swept band
   * `1..12`, and stamped `source: 'config'` where the manifest's own provenance
   * would be.
   *
   * `| null` is therefore not decoration: `DEFAULTS` is
   * `Required<DocPilotSettings>` and the value it ships for this key is `null`.
   */
  topK?: number | null
  maxIterations?: number
  budget?: BudgetSettings | false
  suggestions?: (string | AuthoredOpener)[] | SuggestionsSettings
  quote?: QuoteSettings
  citations?: CitationsSettings
  composer?: ComposerSettings
  feedbackEndpoint?: string | null
  feedback?: FeedbackSettings
  guard?: GuardSettings
  vocabulary?: VocabularySettings | null
  scope?: ScopeSettings
  history?: HistorySettings
  prompt?: PromptSettings
  ui?: UiSettings
  host?: HostSettings
  i18n?: I18nSettings
}

/**
 * The client half — safe to compile into a bundle, because it carries no key and
 * no upstream host. `{enabled: false}` is the whole of the unconfigured shape.
 */
export interface DocPilotThemeConfig {
  enabled?: boolean
  /**
   * SEARCH-ONLY — no model is ever called, and the panel answers with the
   * passages themselves. Emitted as its own key rather than inferred from
   * `llm.provider === null`, for the same reason `embed.lexicalOnly` is: a mode
   * read off the absence of a value is a mode that turns itself on the first
   * time something else goes missing. `session.js` branches on it directly.
   */
  searchOnly?: boolean
  /**
   * `provider` is the ADAPTER id, never the brand — the browser is told how to
   * speak, not to whom. `extraBody` is the one brand-shaped thing that has to
   * cross, as a request-body fragment the adapter merges without reading it;
   * `rateLimited` says the service publishes a daily request ceiling.
   *
   * `freePool` is the narrower of the two facts and the only one anything
   * rations on: this deployment answers off the provider's OWN free catalogue,
   * so its allowance is counted in requests per day. `rateLimited` is true for a
   * funded key on the same service, which has no such ceiling — reading it as a
   * free tier is what dropped a paying site to one request per turn.
   */
  llm?: {
    provider?: ProviderId
    baseURL?: string
    model?: string
    extraBody?: Record<string, unknown> | null
    rateLimited?: boolean
    freePool?: boolean
  } & Record<string, unknown>
  /**
   * `lexicalOnly` is on BOTH arms, never absent: the browser branches on it to
   * decide whether to embed the question at all, and `JSON.stringify` — which
   * this object crosses on its way into the bundle — deletes an undefined key,
   * leaving the absence to be read as `false` by luck. The other three are null
   * on the declared arm for the same reason.
   */
  embed?: {
    provider?: ProviderId | null
    baseURL?: string | null
    model?: string | null
    lexicalOnly?: boolean
  }
  product?: string | null
  /**
   * Carried across verbatim from `DocPilotSettings.topK`, and null on all but a
   * site that set it: null lets the manifest's measured `GATE_K` through
   * untouched, a number overrides it, clamped `1..12`.
   *
   * Null here is not an absent opinion by accident — with no tuning in the
   * manifest either, the retriever resolves every lever to its module literal,
   * which is what every build shipped before `docpilot tune` existed.
   */
  topK?: number | null
  maxIterations?: number
  /** Always the resolved object, whichever arm of the union was configured. */
  budget?: BudgetSettings
  suggestions?: SuggestionsSettings
  quote?: QuoteSettings
  citations?: CitationsSettings
  composer?: ComposerSettings
  feedbackEndpoint?: string | null
  feedback?: FeedbackSettings
  guard?: GuardSettings
  /**
   * REMOVED at 1.0.0 — it was declared here and `themeDocPilot` never
   * emitted it. `vocabulary` is SERVER_ONLY: the map is folded into the
   * index at build time and the browser reads it from the manifest, so
   * there was never a value on this object to read. The precedent is
   * `suggestions`, which was declared-and-never-emitted for a release and
   * is the defect `defineDocPilot` was extracted to make impossible.
   */
  scope?: ScopeSettings
  history?: HistorySettings
  prompt?: PromptSettings
  /**
   * The resolved shape is what `themeDocPilot` emits and what every component
   * reads. `UiSettings` is admitted alongside it because a HAND-WRITTEN
   * themeConfig is a supported shape — `session.configure` and both components
   * run `resolveUi` over whatever they are given, precisely so that a project
   * that assembles this object itself does not have to resolve it first.
   */
  ui?: ResolvedUi | UiSettings
  host?: HostSettings
  i18n?: I18nSettings
}

export interface Readiness {
  ok: boolean
  missing: string[]
  notes: string[]
  hint?: string
}

export declare const DEFAULTS: Required<DocPilotSettings>
export declare const PROVIDER_IDS: readonly ProviderId[]
/**
 * The order `chat.provider: 'auto'` walks — providers that embed first, then
 * answering-only ones, then the self-hosted tail. `'ollama'` closes it and is
 * always available, so the walk cannot come back empty.
 */
export declare const CHAIN: readonly ProviderId[]
/** What one environment resolves to, and what was tried on the way. */
export declare function resolveChain(env?: Record<string, string | undefined>): {
  id: ProviderId
  tried: Array<{ id: ProviderId; envKey: string | null; found: boolean }>
}
/** One member of a resolved answer ladder, as `resolveChatChain` returns it. */
export interface ResolvedChainMember {
  id: ProviderId
  model: string | null
  models: string[] | null
  baseURL: string | null
  own: boolean
}
/**
 * Sorts provider ids into ladder tiers — billed accounts, then a provider's own
 * free catalogue, then a server of your own — keeping the given order inside
 * each tier. A model named in `chat` keeps its provider billed and flattens the
 * tiers back to the order passed in.
 */
export declare function ladderOrder(ids: ProviderId[], chat?: ChatSettings): ProviderId[]
/**
 * Which services may answer, in the order they are walked. Empty in search-only
 * mode, where nothing answers; one member for an environment holding one key,
 * which is the scalar configuration that has always shipped.
 */
export declare function resolveChatChain(
  docPilot: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): ResolvedChainMember[]
/** Keys deliberately withheld from the client half. */
export declare const SERVER_ONLY: readonly string[]
/** Keys the theme reads that `docPilot` deliberately does not carry. */
export declare const THEME_ONLY: readonly string[]

export declare function resolveDocPilot(
  settings?: DocPilotSettings,
  env?: Record<string, string | undefined>,
): Required<DocPilotSettings>
/**
 * The embed half, resolved. NOT `EmbedSettings`, which is what an author writes:
 * `lexicalOnly` is the discriminant every caller branches on — `themeDocPilot`
 * and `nodeEmbedTarget` both do — and it exists only on the way out.
 */
export interface ResolvedEmbed {
  provider: ProviderId | null
  model: string | null
  models?: string[] | null
  baseURL: string | null
  /** Whose name `model` is: the author's, or the provider table's. */
  modelAuto: boolean
  /** True on `embed: false` — the search runs on the lexical channel alone. */
  lexicalOnly?: boolean
  fallback: string | null
}

export declare function resolveEmbed(settings: DocPilotSettings): ResolvedEmbed
export declare function resolveSuggestions(settings: DocPilotSettings): SuggestionsSettings
export declare function readiness(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): Readiness
/**
 * The readiness note for an index built on thresholds nobody measured.
 *
 * Takes `manifest.guard` rather than a path, so the fs read stays in the command
 * and this stays runnable without a project on disk. Null when the guard was
 * measured — which is every case except `source: "provisional"`.
 */
export declare function provisionalGuardNote(
  guard: { source?: string; tau?: number } | null | undefined,
): string | null
export declare function themeDocPilot(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): DocPilotThemeConfig
/**
 * The credential for one provider, read out of `env`. Null when the id is
 * self-hosted (it takes no key) or when none of its environment variables is
 * set — so check the result before sending it.
 */
export declare function providerKey(
  env: Record<string, string | undefined>,
  provider: ProviderId,
): string | null
/**
 * The embed target as the INDEXER sees it: no proxy, so the real host, and the
 * key in hand.
 *
 * TWO ARMS. `embed: false` returns the lexical-only one — every field null with
 * `lexicalOnly: true` beside them, stated rather than omitted because the caller
 * destructures this without checking, and a `baseURL` there would name somewhere
 * the indexer COULD post when the point of the mode is that there is nothing it
 * should.
 */
export declare function nodeEmbedTarget(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
):
  | {
      lexicalOnly?: undefined
      /** The BRAND; `provider` beside it is the adapter that speaks to it. */
      id: ProviderId
      provider: ProviderId
      /**
       * Null for a provider the adapters cannot reach directly — Gemini, whose
       * compatible surface lives at `/v1beta/openai` while the adapter builds
       * `${baseURL}/v1/…`.
       */
      baseURL: string | null
      model: string | null
      models: string[] | null
      /**
       * Whose name `model` is — the author's, or the provider table's. A default
       * that ages may be walked past by the index build; a name somebody wrote may
       * not.
       */
      modelAuto: boolean
      apiKey: string | null
    }
  | {
      lexicalOnly: true
      id: null
      provider: null
      baseURL: null
      model: null
      models: null
      modelAuto: false
      apiKey: null
    }
/**
 * The chat half as a NODE tool sees it: the real host rather than `/ai`, and the
 * key in hand. `id` is the brand, `provider` the adapter that speaks to it.
 *
 * TWO ARMS, as `nodeEmbedTarget` has. `chat: false` / `chat: 'none'` resolves to
 * the search-only arm — every field null beside `searchOnly: true` — because a
 * `baseURL` there would name somewhere a CLI COULD post when the point of the
 * mode is that there is nothing it should. Discriminate on `searchOnly` before
 * dereferencing `id`, `provider` or `baseURL`.
 */
export declare function nodeChatTarget(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
):
  | {
      searchOnly?: undefined
      id: ProviderId
      provider: ProviderId
      /** Null for a provider no adapter can reach directly — Gemini. */
      baseURL: string | null
      model: string | null
      models: string[] | null
      apiKey: string | null
      maxTokens: number
      numCtx: number
      /**
       * Whose name `model` is — the author's, or the provider table's. `doctor`
       * reads it to tell "you named a model this server does not have" from
       * "our default is stale for your machine".
       */
      modelAuto: boolean
      /** A HOST that answers with whatever it loaded — llama-server. */
      modelPlaceholder: boolean
      extraBody: Record<string, unknown> | null
    }
  | {
      searchOnly: true
      id: null
      provider: null
      baseURL: null
      model: null
      models: null
      apiKey: null
      maxTokens: null
      numCtx: null
      modelAuto: false
      modelPlaceholder: false
      extraBody: null
    }
export declare function devProxy(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): Record<string, unknown>
export declare function logDocPilot(
  settings: Required<DocPilotSettings>,
  env: Record<string, string | undefined>,
  ready: Readiness,
): void

/**
 * ── The fifteen that were exported and never declared ────────────────────────
 *
 * Every one of these is reachable as `import {…} from '@cloflin/docpilot/config'`
 * and, until 1.0.0, every one of them type-errored on the way in. Nine are read
 * by `bin/docpilot.js`, `scripts/vercel-build.sh`'s doctor path or the eval
 * CLIs, so they were public in fact long before they were public in writing.
 *
 * They are declared, not hidden: marking them internal would need `stripInternal`
 * and a decision about what the CLI's own surface is, which is a larger question
 * than "does the declaration match the code".
 */

/** The capability table for a provider — what it can be asked for. */
export declare function capsOf(id: ProviderId): Record<string, unknown> | null

/** The author's neutral knobs, clamped to what one service accepts. */
export declare function resolveTuning(
  settings: DocPilotSettings,
  id?: ProviderId,
): Record<string, unknown>

/** The chat models a config names, in ask order. */
export declare function chatModels(settings: DocPilotSettings): string[] | null

/** The embed models a config names, in ask order. */
export declare function embedModels(settings: DocPilotSettings): string[] | null

/** Which provider's free pool backs this half, or null when none does. */
export declare function poolProviderOf(
  settings: DocPilotSettings,
  half: 'chat' | 'embed',
): ProviderId | null

/** `embed: false` / `embed: 'none'` — the lexical-only build. */
export declare function noEmbed(settings: DocPilotSettings): boolean

/** `chat: false` / `chat: 'none'` — the search-only panel. */
export declare function noChat(settings: DocPilotSettings): boolean

/** What the dev proxy promises the browser, for the readiness report. */
export declare function proxyContract(
  settings: DocPilotSettings,
  env?: Record<string, string | undefined>,
): Record<string, unknown>

/** Where the built index is written and read — `indexDir`, resolved. */
export declare function indexDirOf(settings: DocPilotSettings): string

/** The manifest inside it. */
export declare function manifestPathOf(settings: DocPilotSettings): string

/**
 * What the manifest on disk says about the index that is already there — or
 * null when there is none, which is not the same as an index built without
 * vectors. `vectors === null` is the strict test for that; a missing key is a
 * broken manifest.
 */
export declare function indexInfo(settings: DocPilotSettings): {
  embedModel: string | null
  chunkCount: number
  hash: string
  dims: number
  vectors: string | null
} | null

/**
 * Whether a provider has an embeddings endpoint at all. `'ollama'` always does;
 * every other answer is whether the provider table carries an `embedModel`, and
 * the five chat-only services — anthropic, groq, deepseek, xai, cerebras —
 * answer false.
 */
export declare function canEmbed(provider: ProviderId): boolean

/** The three legal `guard.mode` values. */
export declare const GUARD_MODES: readonly string[]

/** The three legal `chat.verbosity` values. */
export declare const VERBOSITY_LEVELS: readonly string[]

/** Throws when `guard` is inconsistent — a build-time check, not a runtime one. */
export declare function assertGuard(settings: DocPilotSettings): void

/** The shape an index directory name has to have. */
export declare const SLUG: RegExp

/** Throws when a term is both a canonical and an alias. */
export declare function assertVocabulary(settings: DocPilotSettings): void

/**
 * The chat half, resolved — the shape `resolveDocPilot` hands back, which is a
 * SUPERSET of what an author writes.
 *
 * Three fields exist only on the way out. `providerAuto` and `modelAuto` record
 * WHOSE name a value is, because the resolver is allowed to walk past its own
 * default and not past somebody's sentence; `searchOnly` is what `chat: false`
 * becomes, and every layer downstream reads that rather than inferring the mode
 * from `provider: null`. `chain` changes meaning too: an author writes
 * `'auto' | false | member[]` and reads back the resolved selection.
 */
export interface ResolvedChat extends Omit<ChatSettings, 'chain'> {
  chain: string | false | Array<ChainMember | ProviderId>
  providerAuto: boolean
  modelAuto: boolean
  searchOnly?: boolean
}

/**
 * Settings after `resolveDocPilot` — what `bin/docpilot.js` puts on the global
 * and every CLI command reads. Distinct from `DocPilotSettings`, which is what a
 * project WRITES: every key is present here, and the two halves that carry a
 * resolution have their own types above.
 */
export type ResolvedDocPilot = Omit<Required<DocPilotSettings>, 'chat' | 'embed'> & {
  chat: ResolvedChat
  embed: ResolvedEmbed | EmbedConfig
}
