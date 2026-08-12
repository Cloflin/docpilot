/**
 * Feedback record — RAG-SPEC 8.
 *
 * No telemetry. Without a thumb, nothing leaves the device — and with one, only
 * a down-vote is transmitted, and only when feedbackEndpoint is configured.
 */

const KEY = 'stripo-ask-ai:feedback'
const CAP = 200
const PATHS_CAP = 20

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-CAP)))
  } catch {
    /* quota or private mode — the vote is simply not persisted */
  }
}

export function record(entry, { feedbackEndpoint } = {}) {
  const list = read().filter((e) => e.messageId !== entry.messageId)

  const scope = entry.scope || { kind: 'all', label: 'All docs', paths: [] }
  const paths = scope.paths || []

  const row = {
    ...entry,
    scope: {
      kind: scope.kind,
      label: scope.label,
      pages: paths.length,
      paths: paths.slice(0, PATHS_CAP),
      truncated: paths.length > PATHS_CAP,
    },
  }

  // The instruction text is never stored, and on an instructed turn the ANSWER
  // is not stored either: "Restate my instruction, then answer" is a one-line
  // addendum, so the answer is a full-fidelity copy of the thing being protected.
  delete row.addendum
  if (row.promptStock === false) delete row.answer

  list.push(row)
  write(list)

  if (feedbackEndpoint && row.verdict === 'down') {
    try {
      fetch(feedbackEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(row),
        keepalive: true,
      }).catch(() => {})
    } catch {
      /* fire and forget; a failure is never surfaced */
    }
  }

  return row
}

export function all() {
  return read()
}

export function exportJsonl() {
  return read()
    .map((r) => JSON.stringify(r))
    .join('\n')
}

/** Console helper rather than a UI control: a visible Export button advertises to
 *  readers that their questions are being recorded. */
export function installConsoleHelper() {
  if (typeof window === 'undefined') return
  window.__stripoAskAi = Object.assign(window.__stripoAskAi || {}, {
    feedback: all,
    exportFeedback() {
      const text = exportJsonl()
      // eslint-disable-next-line no-console
      console.log(text || '(no feedback recorded)')
      return text
    },
  })
}
