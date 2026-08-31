/**
 * Feedback record — RAG-SPEC 8.
 *
 * No telemetry. Without a thumb, nothing leaves the device — and with one, what
 * leaves is decided by `feedback.send`, which the site owner sets and the reader
 * is told about in the panel's own disclaimer.
 *
 * A down-vote may carry REASONS and a SENTENCE the reader typed. Both arrive as
 * an amendment: the thumb posts immediately (a reader who closes the tab has
 * still been heard), the form posts a second time under the same `messageId`
 * with the revision raised. The receiver upserts on `messageId` and keeps the
 * higher revision — see docs/guide/production.md for the contract.
 *
 * THE COMMENT IS REDACTED HERE, and here is the only place it can be. credentials.js
 * names "into any feedback report" as one of the four directions a pasted secret
 * travels, and this module is the one that closes it. `record()` is the single
 * choke point for both the local store and the network, so a comment cannot
 * reach either without passing this line.
 */

import {redactSecrets} from './credentials.js'

const KEY = 'docpilot:feedback'
const CAP = 200
const PATHS_CAP = 20

/**
 * Mirrors `prompt.appendMaxChars` in value and deliberately NOT in
 * configurability. How much of themselves a reader can write into a record that
 * leaves their device is a property of this package, not a decision each site
 * makes — the same rule history.js applies to its byte ceiling.
 */
export const COMMENT_MAX = 500

/** Which verdicts reach the endpoint, per `feedback.send`. */
const SENDS = {none: [], down: ['down'], up: ['up'], both: ['up', 'down']}

export const FEEDBACK_SENDS = Object.keys(SENDS)
/**
 * `confirm` — ui-specs/009. Submitting used to write to the polite region and
 * return focus to the thumb, and nothing else: a sighted reader saw the form
 * vanish, which is indistinguishable from closing it unsent. The line that
 * replaces it has to be true under all four `send` modes, which is the same
 * discipline the three `disclaimer` variants keep.
 */
export const FEEDBACK_DEFAULTS = {send: 'both', comment: true, confirm: true}

/**
 * `docPilot` is whatever object carries a `feedback` key — raw settings,
 * resolved settings, or the client half — so one call site's shape is every
 * call site's shape. Injectable `err` and idempotence follow `resolveUi`, and
 * for the same reasons: this resolves during a docs build, where a typo in a
 * cosmetic setting must not be able to fail one, and the build emits the
 * resolved object under the same key for the browser to resolve again.
 */
export function resolveFeedback(docPilot, err = console.error) {
  const cfg = docPilot?.feedback || {}
  let send = cfg.send ?? FEEDBACK_DEFAULTS.send
  if (!FEEDBACK_SENDS.includes(send)) {
    err(
      `[docpilot] feedback.send only accepts ${FEEDBACK_SENDS.map((v) => `"${v}"`).join(', ')} — ` +
        `using "${FEEDBACK_DEFAULTS.send}"`,
      cfg.send,
    )
    send = FEEDBACK_DEFAULTS.send
  }
  return {send, comment: cfg.comment !== false, confirm: cfg.confirm !== false}
}

/**
 * Resolved per call rather than captured at module load, so this module
 * survives SSR and is testable without a global — the same seam
 * `createHistory({local, session, now})` opens for the archive.
 */
function storageOf(storage) {
  return storage || (typeof localStorage === 'undefined' ? null : localStorage)
}

function read(storage) {
  try {
    const raw = storageOf(storage)?.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function write(list, storage) {
  try {
    storageOf(storage)?.setItem(KEY, JSON.stringify(list.slice(-CAP)))
  } catch {
    /* quota or private mode — the vote is simply not persisted */
  }
}

/**
 * @param {Record<string, any>} entry
 * @param {object} [o]
 * @param {string|null} [o.feedbackEndpoint]
 * @param {string} [o.send]
 * @param {boolean} [o.debug]
 * @param {Storage} [o.storage] injected in tests; resolved per call otherwise
 * @param {typeof fetch} [o.fetchImpl] ditto
 */
export function record(
  entry,
  {
    feedbackEndpoint,
    send = FEEDBACK_DEFAULTS.send,
    debug = false,
    storage,
    fetchImpl,
  }: {
    feedbackEndpoint?: string | null
    send?: string
    debug?: boolean
    storage?: Storage | null
    fetchImpl?: typeof fetch
  } = {},
) {
  const list = read(storage).filter((e) => e.messageId !== entry.messageId)

  const scope = entry.scope || {kind: 'all', label: 'All docs', paths: []}
  const paths = scope.paths || []

  const row = /** @type {Record<string, any>} */ ({
    ...entry,
    revision: Number.isInteger(entry.revision) ? entry.revision : 0,
    scope: {
      kind: scope.kind,
      label: scope.label,
      pages: paths.length,
      paths: paths.slice(0, PATHS_CAP),
      truncated: paths.length > PATHS_CAP,
    },
  })

  // ORDER IS LOAD-BEARING: redact, THEN cap. Capping first can cut a live key in
  // half so that no pattern matches what remains, and the fragment ships.
  // Redacting first replaces the whole span with MASK, and a cap that then
  // bisects MASK costs nothing.
  if (typeof row.comment === 'string') {
    const {clean} = redactSecrets(row.comment)
    row.comment = clean.trim().slice(0, COMMENT_MAX) || null
  } else {
    row.comment = null
  }

  // The instruction text is never stored, and on an instructed turn the ANSWER
  // is not stored either: "Restate my instruction, then answer" is a one-line
  // addendum, so the answer is a full-fidelity copy of the thing being protected.
  // The quote goes with the answer, and for the same reason: it is a slice of
  // one. Withholding the answer while shipping five hundred characters of it
  // under another key would be the same leak with a longer path.
  delete row.addendum
  if (row.promptStock === false) {
    delete row.answer
    delete row.quote
  }

  // WHICH verdict this record is about, which is not always the one it carries.
  // A withdrawn vote has `verdict: null` and still has to reach the endpoint —
  // otherwise a reader who takes back a thumb, or takes back the sentence they
  // wrote under it, has no way to do so and the panel would be promising them
  // something it cannot deliver. `retracted` names what was withdrawn so the
  // send filter can answer "would this vote have been sent?" for a vote that is
  // no longer there; it is a routing hint, not part of the record.
  const about = row.verdict ?? row.retracted ?? null
  delete row.retracted

  list.push(row)
  write(list, storage)

  const allowed = SENDS[send] || SENDS[FEEDBACK_DEFAULTS.send]
  if (feedbackEndpoint && about && allowed.includes(about)) {
    try {
      const post = fetchImpl || globalThis.fetch
      post(feedbackEndpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(row),
        keepalive: true,
      }).catch((e) => {
        // Silent by default — a failed vote is not the reader's problem and they
        // are not the one who can fix it. Under ?dpdebug=1 it is the site
        // owner's only thread: a cross-origin endpoint blocked by the shipped
        // `connect-src 'self'` CSP fails exactly here, and without this line the
        // symptom is a working panel and an empty table.
        if (debug) console.warn('[docpilot] feedback POST failed', e)
      })
    } catch (e) {
      if (debug) console.warn('[docpilot] feedback POST failed', e)
    }
  }

  return row
}

export function all(storage?: Storage | null) {
  return read(storage)
}

export function exportJsonl(storage?: Storage | null) {
  return read(storage)
    .map((r) => JSON.stringify(r))
    .join('\n')
}

/** Console helper rather than a UI control: a visible Export button advertises to
 *  readers that their questions are being recorded. The output is the input
 *  format of `npx docpilot feedback pull --from`, so an owner running no
 *  endpoint at all can still get their questions into the eval loop. */
export function installConsoleHelper() {
  if (typeof window === 'undefined') return
  window.__docPilot = Object.assign(window.__docPilot || {}, {
    feedback: () => all(),
    exportFeedback() {
      const text = exportJsonl()
      // eslint-disable-next-line no-console
      console.log(text || '(no feedback recorded)')
      return text
    },
  })
}
