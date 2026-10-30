/**
 * The two bounds on a remote read: how long it may take and how much it may
 * return (engine-spec 043, D-27, T-02-12).
 *
 * `docpilot import` makes up to a handful of requests per page: the page, and one
 * per candidate `.md`. Each of them gets the same deadline and the same size
 * ceiling, from here, so no request is bounded by accident of being written
 * second.
 */

import { MAX_HTML_BYTES } from './extract-html.js'

/**
 * How long an import waits for one request. An import is one page and a person
 * waits for it; a page silent for 30 s is behind a wall, and the fix is `--html`
 * or a fetcher, not a longer wait (engine-spec 043, D-27, T-02-12).
 */
export const FETCH_TIMEOUT_MS = 30_000

/** The deadline passed before `work` finished. */
export class DeadlineExceeded extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`no answer within ${timeoutMs} ms`)
    this.name = 'DeadlineExceeded'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Run `work` with an abort signal that fires after `timeoutMs`, and give up on
 * it when the signal fires.
 *
 * The signal alone is a request, not a deadline: a fetcher that ignores it, or a
 * body read that never ends, would hold the import for ever. So the call is
 * RACED against the signal, and the deadline holds whether or not `work`
 * listens. The timer is an ordinary ref'd one, not `AbortSignal.timeout`'s
 * unref'd one: with nothing else pending, an unref'd timer lets Node exit with
 * the import unfinished and no message. It is cleared, with its listener, on
 * every way out.
 *
 * Rejects with `DeadlineExceeded` when the deadline wins; anything `work`
 * throws first is rethrown as it is.
 */
export async function withDeadline<T>(timeoutMs: number, work: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
  const controller = new AbortController()
  const { signal } = controller
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DeadlineExceeded(timeoutMs))
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeoutMs)
  })
  // `work` may lose the race and reject later; that rejection is already handled.
  expired.catch(() => {})
  try {
    return await Promise.race([Promise.resolve().then(() => work(signal)), expired])
  } catch (e) {
    if (e instanceof DeadlineExceeded) throw e
    // `work` failed on the abort itself (a fetch rejects with the signal's
    // reason) a moment before the race could see the deadline.
    if (signal.aborted) throw new DeadlineExceeded(timeoutMs)
    throw e
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** A body read either returns its text or says it was over the ceiling. */
export type CappedBody = { text: string } | { tooLarge: true }

/**
 * A response body, refused as soon as it passes `maxBytes`.
 *
 * `res.text()` buffers everything before anything can be checked, so a 2 GB body
 * was 2 GB of memory before the "too large" verdict, and the deadline bounds the
 * time, not the memory. Counting while reading makes the ceiling a ceiling: the
 * declared `content-length` is believed only to refuse early, and the stream is
 * cancelled the moment the count passes the limit. A response with no stream
 * (a test double, a fetcher's own object) is read whole and measured.
 */
export async function readBodyCapped(res: any, maxBytes: number = MAX_HTML_BYTES): Promise<CappedBody> {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel?.().catch?.(() => {})
    return { tooLarge: true }
  }
  if (typeof res.body?.getReader !== 'function') {
    const text = String(await res.text())
    return Buffer.byteLength(text, 'utf8') > maxBytes ? { tooLarge: true } : { text }
  }
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      reader.cancel().catch(() => {})
      return { tooLarge: true }
    }
    parts.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.byteLength
  }
  return { text: new TextDecoder().decode(all) }
}
