/**
 * TOOLS THE SITE ADDS — engine-spec 038.
 *
 * One module for both halves, because both halves need the same answers: the
 * build asks whether a definition is valid (`toolProblems`), the turn asks what
 * the model may call and with which arguments (`providerParameters`,
 * `checkArgs`), and the panel asks what an action will send and how to run it
 * (`checkArgs`, `runTool`). Two copies of the argument check is how a form would
 * accept what the model was refused, or the other way round.
 *
 * Nothing here touches the DOM at import time. The two runners that need a page
 * — `href` and `event` — are built only where `window` exists, so the server and
 * the eval runner simply have no runner for them, which is what "an action runs
 * in the browser" means in code.
 */

/** The harness's own tools. A site tool cannot take one of these names. */
export const BUILTIN_TOOLS = new Set(['search_docs', 'fetch_section', 'expand_section', 'list_pages', 'answer'])

/**
 * TWELVE, because the built-ins are five and OpenAI's own guidance puts the
 * ceiling for choosing well at twenty tools at the start of a turn. Seventeen
 * leaves room under it rather than sitting on it.
 */
export const MAX_TOOLS = 12

/** Actions per answer. An answer that offers more is a menu, not a next step. */
export const MAX_ACTIONS = 3

/** A runner that has not answered in this long has failed, whatever it is doing. */
export const TOOL_TIMEOUT_MS = 10000

/**
 * What of a result the model is shown. A result is re-sent on every later step,
 * like every observation, so an unbounded one is paid for once per step — and
 * a page of JSON is rarely the part of a reply anyone needed.
 */
export const TOOL_RESULT_CHARS = 4000

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const TYPES = new Set(['string', 'number', 'integer', 'boolean'])
const FORMATS = new Set(['email', 'uri', 'date', 'multiline'])
const FIELD_KEYS = new Set(['type', 'description', 'enum', 'default', 'format', 'maxLength', 'minimum', 'maximum'])
const PLACEHOLDER = /\{([A-Za-z0-9_-]+)\}/g

/**
 * A URL template's scheme, authority and path — RFC 3986 appendix B, with `\`
 * read as `/`, because the WHATWG parser reads `/\host` as `//host` and the
 * template is checked as a browser will parse it.
 */
const URL_PARTS = /^(?:([^:/\\?#]+):)?(?:[/\\]{2}([^/\\?#]*))?([^?#]*)/
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i

/** No value, as `checkArgs` reads one: the strict schema's `null`, or an empty field. */
const absent = (v) => v === null || v === undefined || v === ''

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * ON `globalThis`, keyed by a registered symbol, because the panel can be loaded
 * twice over: the IIFE bundle a `<script>` tag brings carries its own copy of
 * this module, and so does every ESM entry. A registry in module scope would
 * give the site's `registerTool` call to whichever copy it happened to import,
 * and the panel would read the other one.
 */
const REGISTRY_KEY = Symbol.for('docpilot.tools')

function registry(): Map<string, (args: any, ctx: any) => unknown> {
  const g = globalThis as any
  if (!(g[REGISTRY_KEY] instanceof Map)) g[REGISTRY_KEY] = new Map()
  return g[REGISTRY_KEY]
}

/**
 * Run `name` with this handler — WebMCP's `execute`, by name. The definition
 * (description, parameters, `confirm`) stays in the config, where the build can
 * check it and the model can be told about it; this supplies only what the
 * config cannot carry to a browser, which is a function.
 *
 * @returns a function that removes this handler again
 */
export function registerTool(name: string, handler: (args: any, ctx: any) => unknown) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new TypeError(`registerTool: "${name}" is not a tool name`)
  if (typeof handler !== 'function') throw new TypeError(`registerTool: the handler for "${name}" is not a function`)
  registry().set(name, handler)
  return () => {
    if (registry().get(name) === handler) registry().delete(name)
  }
}

/** Test seam, and what a page that unmounts its own tools calls. */
export function unregisterTools() {
  registry().clear()
}

// ── definitions ──────────────────────────────────────────────────────────────

/** `plan_limits` → `Plan limits`. What the reader reads when the author named nothing. */
export function humanise(name: string) {
  const words = String(name).replace(/[_-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}

function normaliseParameters(p) {
  const out = { type: 'object', properties: {}, required: [] }
  if (!p || typeof p !== 'object') return out
  for (const [key, field] of Object.entries(p.properties || {})) {
    if (!field || typeof field !== 'object') continue
    const kept = {}
    for (const k of Object.keys(field)) if (FIELD_KEYS.has(k)) kept[k] = field[k]
    out.properties[key] = kept
  }
  out.required = Array.isArray(p.required) ? p.required.filter((k) => k in out.properties) : []
  return out
}

function declarative(run) {
  if (!run || typeof run !== 'object') return null
  if (typeof run.fetch === 'string') return { fetch: run.fetch, method: String(run.method || 'GET').toUpperCase() }
  if (typeof run.href === 'string') return { href: run.href }
  if (typeof run.event === 'string') return { event: run.event }
  return null
}

/**
 * The definitions in the shape every reader of them uses — an ordered array.
 *
 * `keepRun` keeps a function `run`, and only the server half asks for it: the
 * browser half is serialised into `themeConfig`, where a function would be
 * deleted silently — which is exactly the failure `toolProblems` stops the build
 * for, so by the time this runs for the browser there is none to drop.
 */
export function normaliseTools(raw, { keepRun = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw).map(([name, t]: [string, any]) => {
    const title = typeof t?.title === 'string' && t.title.trim() ? t.title.trim() : humanise(name)
    return {
      name,
      title,
      label: typeof t?.label === 'string' && t.label.trim() ? t.label.trim() : title,
      description: String(t?.description || '').trim(),
      parameters: normaliseParameters(t?.parameters),
      confirm: t?.confirm === 'form' ? 'form' : t?.confirm === true,
      run: typeof t?.run === 'function' ? (keepRun ? t.run : null) : declarative(t?.run),
    }
  })
}

// ── build-time refusals ──────────────────────────────────────────────────────

function fieldProblems(at, key, f) {
  const out = []
  const here = `${at}.parameters.properties.${key}`
  if (!f || typeof f !== 'object' || Array.isArray(f)) return [`${here} must be an object`]
  if (!TYPES.has(f.type)) {
    return [
      f.type === 'object' || f.type === 'array' || f.properties || f.items
        ? `${here}: nested objects and arrays are not supported yet — a parameter is a string, number, integer or boolean`
        : `${here}.type must be 'string', 'number', 'integer' or 'boolean'`,
    ]
  }
  for (const k of Object.keys(f)) {
    if (!FIELD_KEYS.has(k)) out.push(`${here}.${k} is not supported — a parameter takes ${[...FIELD_KEYS].join(', ')}`)
  }
  if (f.description != null && typeof f.description !== 'string') out.push(`${here}.description must be a string`)
  if (f.enum != null) {
    const ok =
      Array.isArray(f.enum) &&
      f.enum.length > 0 &&
      f.enum.every((v) => (f.type === 'string' ? typeof v === 'string' : f.type === 'boolean' ? typeof v === 'boolean' : typeof v === 'number'))
    if (!ok) out.push(`${here}.enum must be a non-empty list of ${f.type} values`)
  }
  if (f.format != null && (f.type !== 'string' || !FORMATS.has(f.format))) {
    out.push(`${here}.format must be one of ${[...FORMATS].join(', ')}, on a string`)
  }
  if (f.maxLength != null && (f.type !== 'string' || !Number.isInteger(f.maxLength) || f.maxLength < 1)) {
    out.push(`${here}.maxLength must be a positive integer, on a string`)
  }
  for (const k of ['minimum', 'maximum']) {
    if (f[k] != null && ((f.type !== 'number' && f.type !== 'integer') || typeof f[k] !== 'number')) {
      out.push(`${here}.${k} must be a number, on a number or an integer`)
    }
  }
  // A DEFAULT IS A VALUE THE PARAMETER ITSELF ACCEPTS, of its own type and not
  // one `coerce` would convert. `checkArgs` fills it into every call that left
  // the field empty, so a default the check refuses would fail each such call
  // with an error the model is told to fix and cannot.
  if (!absent(f.default)) {
    const own = f.type === 'integer' ? 'number' : f.type
    const c = typeof f.default === own ? coerce(f, f.default) : { error: `not of type ${f.type}` }
    if (c.error) out.push(`${here}.default is ${c.error}`)
  }
  return out
}

function parameterProblems(at, p) {
  if (p === undefined || p === null) return []
  if (typeof p !== 'object' || Array.isArray(p) || p.type !== 'object') {
    return [`${at}.parameters must be a JSON Schema object: {type: 'object', properties: {…}}`]
  }
  const props = p.properties ?? {}
  if (typeof props !== 'object' || Array.isArray(props)) return [`${at}.parameters.properties must be an object`]
  const out = []
  for (const [key, f] of Object.entries(props)) {
    if (!NAME_RE.test(key)) out.push(`${at}.parameters.properties: "${key}" is not a parameter name`)
    out.push(...fieldProblems(at, key, f))
  }
  if (p.required != null) {
    if (!Array.isArray(p.required)) out.push(`${at}.parameters.required must be a list of property names`)
    else for (const k of p.required) if (!(k in props)) out.push(`${at}.parameters.required names "${k}", which is not a property`)
  }
  return out
}

function runProblems(at, name, t, runtime) {
  const run = t.run
  const fn = !t.confirm
  if (run === undefined || run === null) return []
  if (typeof run === 'function') {
    if (runtime === 'server') return []
    return [
      `${at}.run is a function, and a static install serialises its config to JSON — the function would never reach the page. ` +
        `Register it in the browser with registerTool('${name}', handler), or use run: {fetch}, {href} or {event}.`,
    ]
  }
  if (typeof run !== 'object' || Array.isArray(run)) return [`${at}.run must be {fetch}, {href}, {event} or a function`]
  const kinds = ['fetch', 'href', 'event'].filter((k) => run[k] != null)
  if (kinds.length !== 1) return [`${at}.run names ${kinds.length ? kinds.join(' and ') : 'no runner'} — exactly one of fetch, href or event`]
  const kind = kinds[0]
  if (typeof run[kind] !== 'string' || !run[kind].trim()) return [`${at}.run.${kind} must be a non-empty string`]
  const out = []
  const method = String(run.method || 'GET').toUpperCase()
  if (run.method != null && kind !== 'fetch') out.push(`${at}.run.method belongs to fetch`)
  if (kind === 'fetch' && method !== 'GET' && method !== 'POST') out.push(`${at}.run.method must be 'GET' or 'POST'`)
  const props = (t.parameters && t.parameters.properties) || {}
  if (kind !== 'event') {
    for (const m of run[kind].matchAll(PLACEHOLDER)) {
      if (!(m[1] in props)) out.push(`${at}.run.${kind} uses {${m[1]}}, which is not a parameter`)
    }
    // The model writes the arguments, so a placeholder in the scheme or the host
    // lets it choose where the request goes — on the server, an internal address.
    // Encoding cannot help there: a host is made of the characters it keeps.
    const [, scheme = '', authority = ''] = URL_PARTS.exec(run[kind].replace(/[\t\n\r]/g, '').trim())
    const early = `${scheme}${authority}`.match(PLACEHOLDER)
    if (early) out.push(`${at}.run.${kind} puts ${early[0]} before the path — a placeholder may fill the path or the query, never the scheme or the host`)
  }
  /**
   * A FUNCTION TOOL RUNS WITHOUT THE READER, so it may only read. A POST is a
   * write by convention, a navigation leaves the page mid-turn, and an event
   * returns nothing the model could read — none of the three is a read, and
   * each belongs behind `confirm`.
   */
  if (fn && kind === 'fetch' && method !== 'GET') {
    out.push(`${at} runs a ${method} without the reader. A tool that changes something must set confirm: true or 'form'.`)
  }
  if (fn && kind !== 'fetch') {
    out.push(`${at}.run.${kind} cannot answer the model. Set confirm: true or 'form' to make it an action, or use run: {fetch} or registerTool.`)
  }
  if (fn && kind === 'fetch' && runtime === 'server' && !/^https?:\/\//i.test(run.fetch)) {
    out.push(`${at}.run.fetch is relative, and the server runs function tools with no page to resolve it against — write an absolute URL or a function.`)
  }
  return out
}

/**
 * Every reason the build must stop over `tools`, as sentences that name the
 * tool. Empty for `null` — the shipped value — and for a valid set.
 */
export function toolProblems(raw, { runtime = 'browser' } = {}) {
  if (raw === null || raw === undefined) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['tools must be an object whose keys are tool names']
  const out = []
  const names = Object.keys(raw)
  if (names.length > MAX_TOOLS) {
    out.push(`tools has ${names.length} tools; at most ${MAX_TOOLS} — with the five built-in ones, that is as many as a model chooses between well`)
  }
  for (const name of names) {
    const t = raw[name]
    const at = `tools.${name}`
    if (!NAME_RE.test(name)) {
      out.push(`${at}: a tool name is letters, digits, _ and -, starting with a letter, at most 64 characters`)
      continue
    }
    if (BUILTIN_TOOLS.has(name)) {
      out.push(`${at}: "${name}" is a built-in tool and cannot be replaced`)
      continue
    }
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      out.push(`${at} must be an object`)
      continue
    }
    if (typeof t.description !== 'string' || !t.description.trim()) {
      out.push(`${at}.description is required: the model chooses a tool by what it says`)
    } else if (t.description.length > 1024) {
      out.push(`${at}.description is ${t.description.length} characters; at most 1024`)
    }
    if (t.title != null && (typeof t.title !== 'string' || t.title.length > 60)) out.push(`${at}.title must be a string of at most 60 characters`)
    if (t.label != null && (typeof t.label !== 'string' || t.label.length > 40)) out.push(`${at}.label must be a string of at most 40 characters`)
    if (t.confirm != null && t.confirm !== false && t.confirm !== true && t.confirm !== 'form') {
      out.push(`${at}.confirm must be false, true or 'form'`)
    }
    out.push(...parameterProblems(at, t.parameters))
    out.push(...runProblems(at, name, t, runtime))
  }
  return out
}

// ── what the model is sent ───────────────────────────────────────────────────

/**
 * A tool's parameters in the STRICT shape — every property required, an
 * optional one nullable, nothing additional — because that is the one shape
 * every provider here enforces, OpenAI's strict mode included.
 *
 * `format` and the bounds become WORDS in the description rather than keywords:
 * which of them a strict schema may carry differs by provider and has moved
 * more than once, and a keyword one provider rejects is a 400 on every turn.
 * The code enforces them instead — `checkArgs`. A `default` is a word for the
 * same reason, and because it is the code that applies it: told the value, the
 * model can leave a field null knowing what that sends.
 */
export function providerParameters(def) {
  const props = def.parameters?.properties || {}
  const required = new Set(def.parameters?.required || [])
  const properties = {}
  for (const [key, f] of Object.entries(props) as Array<[string, any]>) {
    const optional = !required.has(key)
    const notes = []
    if (f.format && f.format !== 'multiline') notes.push(`format: ${f.format}`)
    if (f.maxLength) notes.push(`at most ${f.maxLength} characters`)
    if (f.minimum != null) notes.push(`at least ${f.minimum}`)
    if (f.maximum != null) notes.push(`at most ${f.maximum}`)
    if (!absent(f.default)) notes.push(`default: ${JSON.stringify(f.default)}`)
    if (optional) notes.push('null when not known')
    const p: any = { type: optional ? [f.type, 'null'] : f.type }
    if (Array.isArray(f.enum)) p.enum = optional ? [...f.enum, null] : [...f.enum]
    const description = [f.description, ...notes].filter(Boolean).join('; ')
    if (description) p.description = description
    properties[key] = p
  }
  return { type: 'object', properties, required: Object.keys(props), additionalProperties: false }
}

/** A function tool, as the loop step lists it beside the built-ins. */
export function siteToolSchema(def) {
  return { type: 'function', function: { name: def.name, description: def.description, parameters: providerParameters(def) } }
}

/** The answer's `actions` field: one branch per action, each with its own arguments. */
export function actionsSchema(actions) {
  return {
    type: 'array',
    description: 'Actions to offer the reader, or an empty list. Nothing runs until the reader chooses one.',
    items: {
      anyOf: actions.map((a) => ({
        type: 'object',
        properties: { tool: { type: 'string', enum: [a.name] }, args: providerParameters(a) },
        required: ['tool', 'args'],
        additionalProperties: false,
      })),
    },
  }
}

// ── the check every argument passes ──────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const NUMERIC = /^-?\d+(\.\d+)?$/

function coerce(f, v) {
  let value = v
  if (f.type === 'string') {
    if (typeof v === 'number' || typeof v === 'boolean') value = String(v)
    else if (typeof v !== 'string') return { error: 'not text' }
    if (f.maxLength && value.length > f.maxLength) return { error: `longer than ${f.maxLength} characters` }
    if (f.format === 'email' && !EMAIL.test(value)) return { error: 'not an email address' }
    if (f.format === 'date' && !DATE.test(value)) return { error: 'not a date (YYYY-MM-DD)' }
    if (f.format === 'uri') {
      try {
        if (!/^https?:$/.test(new URL(value).protocol)) return { error: 'not a web address' }
      } catch {
        return { error: 'not a web address' }
      }
    }
  } else if (f.type === 'number' || f.type === 'integer') {
    if (typeof v === 'string' && NUMERIC.test(v.trim())) value = Number(v.trim())
    else if (typeof v !== 'number' || !Number.isFinite(v)) return { error: 'not a number' }
    if (f.type === 'integer' && !Number.isInteger(value)) return { error: 'not a whole number' }
    if (f.minimum != null && value < f.minimum) return { error: `below ${f.minimum}` }
    if (f.maximum != null && value > f.maximum) return { error: `above ${f.maximum}` }
  } else if (f.type === 'boolean') {
    if (v === 'true' || v === 'false') value = v === 'true'
    else if (typeof v !== 'boolean') return { error: 'not true or false' }
  }
  if (Array.isArray(f.enum) && !f.enum.includes(value)) return { error: `not one of ${f.enum.join(', ')}` }
  return { value }
}

/**
 * The arguments as the site's own schema allows them — whoever wrote them, the
 * model or the reader.
 *
 * Unknown keys are dropped and `null` (the strict schema's "not known") or an
 * empty string means absent. A type is converted only where nothing is lost.
 * `partial` keeps a call whose REQUIRED values are missing: a form is where the
 * reader supplies them, so a form action with an empty email is still an action
 * worth offering, and its check runs again on what the reader sends.
 *
 * AN ABSENT VALUE TAKES THE PARAMETER'S `default`, and passes the same check a
 * given one does. Filled here, in the one check every argument passes, so the
 * runner, a button and a form all read one value: `validActions` hands the
 * panel this `value`, and a form's fields start from it.
 */
export function checkArgs(def, args, { partial = false } = {}) {
  const props = def.parameters?.properties || {}
  const required = new Set(def.parameters?.required || [])
  const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const value = {}
  const errors = {}
  for (const [key, f] of Object.entries(props) as Array<[string, any]>) {
    const v = absent(given[key]) ? f.default : given[key]
    if (absent(v)) {
      if (required.has(key) && !partial) errors[key] = 'required'
      continue
    }
    const c = coerce(f, v)
    if (c.error) errors[key] = c.error
    else value[key] = c.value
  }
  return { ok: Object.keys(errors).length === 0, value, errors }
}

/** The errors as one line the model can act on. */
export function describeErrors(errors) {
  return Object.entries(errors)
    .map(([k, why]) => `${k}: ${why}`)
    .join('; ')
}

// ── running one ──────────────────────────────────────────────────────────────

/**
 * `{name}` → the URL-encoded argument. Every placeholder is a parameter, and none
 * sits before the path — the build checked.
 *
 * A PATH SEGMENT THAT FILLS TO A DOT IS REFUSED, not encoded. `encodeURIComponent`
 * keeps `.` as it is, and `%2e` is no way out: the URL parser reads it as a dot
 * too, so `/api/orders/{id}` given `..` is `/api/` either way. Checked a segment
 * at a time, because an encoded value cannot contain the `/` that ends one.
 */
export function expandTemplate(template, value) {
  const t = String(template)
  const fill = (s) => s.replace(PLACEHOLDER, (_, k) => (value[k] == null ? '' : encodeURIComponent(String(value[k]))))
  for (const segment of URL_PARTS.exec(t)[3].split(/[/\\]/)) {
    if (segment.search(PLACEHOLDER) < 0) continue
    const filled = fill(segment).replace(/[\t\n\r]/g, '')
    if (DOT_SEGMENT.test(filled)) throw new Error(`${segment} cannot be "${filled}": a dot segment leaves the path the site wrote`)
  }
  return fill(t)
}

async function fetchRun(def, run, args, ctx) {
  const init: any = { method: run.method, headers: { accept: 'application/json, text/plain;q=0.9' }, signal: ctx.signal }
  if (run.method === 'POST') {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify({ tool: def.name, args, context: { question: ctx.question, page: ctx.page } })
  }
  const res = await fetch(expandTemplate(run.fetch, args), init)
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function hrefRun(run, args) {
  const target = new URL(expandTemplate(run.href, args), location.href)
  // Another host is another site: a new tab, and never with `window.opener`,
  // which would let that page navigate the one the reader came from.
  if (target.origin === location.origin) location.assign(target.href)
  else window.open(target.href, '_blank', 'noopener,noreferrer')
  return null
}

function eventRun(def, run, args, ctx) {
  window.dispatchEvent(
    new CustomEvent(run.event, { detail: { tool: def.name, args, context: { question: ctx.question, page: ctx.page } } }),
  )
  return null
}

/**
 * What runs this tool here, or null: a handler the page registered, then a
 * function in the config (Node only — the browser never has one), then the
 * declarative `run`. A handler wins over the config on purpose, so a site can
 * replace a `fetch` with code without editing the definition the build checked.
 */
export function runnerFor(def) {
  const registered = registry().get(def.name)
  if (registered) return registered
  if (typeof def.run === 'function') return def.run
  const run = def.run
  if (!run) return null
  if (run.fetch) return (args, ctx) => fetchRun(def, run, args, ctx)
  const page = typeof window !== 'undefined' && typeof location !== 'undefined'
  if (run.href) return page ? (args) => hrefRun(run, args) : null
  if (run.event) return page ? (args, ctx) => eventRun(def, run, args, ctx) : null
  return null
}

/**
 * Run it, bounded: by `timeoutMs` and by the caller's signal, whichever ends
 * first. Raced rather than merely signalled, because a handler is the site's
 * code and nothing obliges it to read a signal.
 */
export async function runTool(def, args, { question = '', page = '', signal = null, timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  const runner = runnerFor(def)
  if (!runner) throw new Error(`nothing runs ${def.name} here`)
  const timeout = AbortSignal.timeout(timeoutMs)
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout
  return await new Promise((resolve, reject) => {
    const stop = () => reject(merged.reason instanceof Error ? merged.reason : new Error('stopped'))
    if (merged.aborted) return stop()
    merged.addEventListener('abort', stop, { once: true })
    Promise.resolve()
      .then(() => runner(args, { question, page, signal: merged }))
      .then(resolve, reject)
      .finally(() => merged.removeEventListener('abort', stop))
  })
}

/**
 * WHAT A TURN MAY OFFER — the one filter both the harness and the prompt
 * disclosure read, so the panel never publishes a tool the turn would not send.
 *
 * A function tool needs a runner HERE. An action needs one in the browser — or,
 * on a server turn (`server`), only a declaration, because the page that runs
 * it is not here to ask. Null where there is nothing, which every prompt and
 * schema builder reads as "send what a site with no tools sends".
 */
export function siteFor(defs, { server = false } = {}) {
  const all = Array.isArray(defs) ? defs : []
  const tools = all.filter((t) => t.confirm === false && runnerFor(t))
  const actions = all.filter((t) => t.confirm && (server || runnerFor(t)))
  return tools.length || actions.length ? { tools, actions } : null
}

/** A result as the model reads it: text, cut at TOOL_RESULT_CHARS. */
export function resultText(v) {
  let s
  try {
    s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
  } catch {
    s = String(v)
  }
  return s.length > TOOL_RESULT_CHARS ? `${s.slice(0, TOOL_RESULT_CHARS)}…` : s
}

/** What an action's reply says to the reader, if it says anything: a string, or `message`. */
export function resultMessage(v) {
  const s = typeof v === 'string' ? v : typeof v?.message === 'string' ? v.message : ''
  return s.trim().slice(0, 300)
}

/** The page a tool is run from, where there is one. */
export const pageOf = () => (typeof location !== 'undefined' ? `${location.pathname}${location.search}` : '')

// ── the answer's actions ─────────────────────────────────────────────────────

/**
 * The actions an answer may keep: one of the site's, with arguments that pass
 * the check, once each, three at most. A button action needs every required
 * value — pressing it sends exactly what it says. A form action keeps whatever
 * passed and lets the reader supply the rest.
 */
export function validActions(raw, actions) {
  if (!Array.isArray(raw) || !actions?.length) return []
  const byName = new Map<string, any>(actions.map((a) => [a.name, a]))
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (out.length >= MAX_ACTIONS) break
    const def = byName.get(item?.tool)
    if (!def) continue
    const form = def.confirm === 'form'
    const checked = checkArgs(def, item.args, { partial: form })
    if (!checked.ok && !form) continue
    const key = `${def.name}|${JSON.stringify(checked.value)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ tool: def.name, args: checked.value })
  }
  return out
}
