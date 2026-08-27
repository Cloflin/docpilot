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
   * Omit it and the PROVIDER's own default is used — every branded provider
   * carries one. Two do not: `openrouter`, where an unnamed model resolves to
   * the shipped free pool, and `custom`, which names a host rather than a
   * service and therefore stops the build, because the alternative is a 400 in
   * a reader's browser naming a model that appears nowhere in your config.
   */
  model?: string
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

export interface SuggestionsSettings {
  questions?: string[]
  scoped?: boolean
  followUps?: boolean
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
  mode?: 'calibrated' | 'off'
  /** Null keeps the calibrated value from the manifest. */
  tau?: number | null
  tauLexical?: number | null
  supportMinIdentifiers?: number
}

export interface ScopeSettings {
  enabled?: boolean
  /** Only `'all'`; a build-time default of `page` would narrow every first question. */
  default?: 'all'
  promptListLimit?: number
  filter?: 'auto' | 'always' | 'never'
  groupBySection?: boolean
}

export interface HistorySettings {
  enabled?: boolean
  maxConversations?: number
  exportThread?: boolean
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
  chat?: ChatSettings
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
  suggestions?: string[] | SuggestionsSettings
  quote?: QuoteSettings
  citations?: CitationsSettings
  composer?: ComposerSettings
  feedbackEndpoint?: string | null
  feedback?: FeedbackSettings
  guard?: GuardSettings
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
/** Keys deliberately withheld from the client half. */
export declare const SERVER_ONLY: readonly string[]
/** Keys the theme reads that `docPilot` deliberately does not carry. */
export declare const THEME_ONLY: readonly string[]

export declare function resolveDocPilot(
  settings?: DocPilotSettings,
  env?: Record<string, string | undefined>,
): Required<DocPilotSettings>
export declare function resolveEmbed(settings: DocPilotSettings): EmbedSettings
export declare function resolveSuggestions(settings: DocPilotSettings): SuggestionsSettings
export declare function readiness(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): Readiness
export declare function themeDocPilot(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): DocPilotThemeConfig
export declare function providerKey(provider: ProviderId): string
export declare function nodeEmbedTarget(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): {
  provider: ProviderId
  baseURL: string
  model: string
  models: string[] | null
  /**
   * Whose name `model` is — the author's, or the provider table's. A default
   * that ages may be walked past by the index build; a name somebody wrote may
   * not.
   */
  modelAuto: boolean
  apiKey?: string
}
/**
 * The chat half as a NODE tool sees it: the real host rather than `/ai`, and the
 * key in hand. `id` is the brand, `provider` the adapter that speaks to it.
 */
export declare function nodeChatTarget(
  settings: Required<DocPilotSettings>,
  env?: Record<string, string | undefined>,
): {
  id: ProviderId
  provider: ProviderId
  baseURL: string | null
  model: string | null
  models: string[] | null
  apiKey: string | null
  maxTokens?: number
  numCtx?: number
  extraBody?: Record<string, unknown> | null
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
