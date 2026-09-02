#!/usr/bin/env node
/**
 * The `/ai/feedback` receiver this deployment needs to keep a reader's vote.
 *
 * WHY IT EXISTS AT ALL. `feedbackEndpoint` in the panel's settings makes
 * `theme/docpilot/feedback.js#record()` POST one JSON object per vote, and that
 * POST is fire-and-forget: its `.catch()` is silent unless `?dpdebug=1` is on
 * (feedback.js:183-190). So a receiver that 404s, 500s or accepts-and-drops
 * looks, from the panel, exactly like a receiver that works. There is no error
 * surface on the reader's side at all. Everything this file refuses, it refuses
 * with a status and a named field, because the operator running `curl` is the
 * only person who will ever see it.
 *
 * WHAT IT IS BUILT TO. `docs/guide/production.md` §"Collecting feedback" states
 * the contract; `src/feedback/aggregate.js` is the only reader in the package
 * and is what the contract has to be true FOR. Both are cited inline. The five
 * facts the rest of this file is arranged around, each measured rather than
 * assumed (see `evidence-wire.mjs` beside this file, which drives the package's
 * own built `record()` and prints the bytes):
 *
 *   1. `comment` is ALWAYS on the wire and is EXPLICITLY `null` when cleared.
 *      feedback.js:142-147 is an if/else with no third branch. A retraction
 *      therefore sends `"comment":null`, not an absent key — which is why the
 *      `coalesce(excluded.comment, …)` in production.md:391 resurrects the
 *      sentence the reader just withdrew, in direct violation of the paragraph
 *      three lines below it (production.md:403). This receiver REPLACES.
 *   2. `retracted` NEVER reaches the wire — feedback.js:169 deletes it after
 *      using it to answer "would this vote have been sent?". So the name is
 *      free, and this file derives it (verdict `null` at a raised revision).
 *   3. `revision` is always an integer on the wire — feedback.js:128 coerces it
 *      unconditionally. Its absence therefore means a client that is not this
 *      package, and there is no safe value to invent. See `validate()`.
 *   4. `answer`+`quote` (feedback.js:155-159) and `retrievedIds`
 *      (session.js:2692) are genuinely ABSENT on the records that withhold
 *      them. `gate` is not — session.js:2720 writes the key with `null` on
 *      every record, so production.md:374's claim that it is "absent rather
 *      than null" is wrong about that third key.
 *   5. No wire key begins with `_`. That is what makes `_receivedAt` a
 *      timestamp that cannot collide with the format, and this file strips
 *      leading-underscore keys off the incoming row so the reservation is real
 *      rather than nominal.
 *
 * THE READ PATH IS A SILENT DROP, which is what makes the shape gate load-
 * bearing. `dedupe()` at aggregate.js:38 is
 *
 *     if (!r || typeof r.question !== 'string' || !r.messageId) continue
 *
 * — no warning, no count, no exit code. A row this receiver accepts and that
 * line rejects is a vote that is on disk, in the export, and in no report ever.
 * `validate()` below guarantees that predicate and a little more, and every
 * "little more" is justified where it is written.
 *
 * IT IS ALSO A CRASH PATH. `for (const reason of r.reasons || [])`
 * (aggregate.js:114) throws `TypeError: … is not iterable` on a numeric
 * `reasons`, out of `aggregate()`, out of `docpilot feedback pull` — so ONE
 * malformed row destroys the whole report, not one row of it. `reasons` is
 * validated here for that reason and no other.
 *
 * WHAT IT IS NOT. No CORS headers, anywhere, on any response — the same
 * argument `lib/ai-proxy.js:170-176` makes for the proxy: production.md:345-351
 * says mount this same-origin, the shipped CSP is `connect-src 'self'`, and the
 * defence against another site spending this endpoint is that a cross-origin
 * fetch is refused by the browser before it is read. Adding
 * `access-control-allow-origin` here gives that away. Cross-origin deployments
 * that need it should add it at the reverse proxy, where the origin list is
 * configuration rather than code.
 *
 * No rate limiter either, and that is a deliberate omission rather than an
 * oversight: `take()` in lib/ai-proxy.js is the one to copy, and it belongs in
 * front of this endpoint exactly as it sits in front of `/ai/v1`. It is left
 * out because a limiter whose buckets live in this process's memory is a
 * different component with a different lifetime, and pretending otherwise is
 * how a reference implementation grows a second, worse copy of one that exists.
 *
 * ZERO DEPENDENCIES, node: builtins only. This file is meant to be read in
 * full by the person who will run it, and a dependency tree is the part of a
 * trust boundary nobody reads.
 */

import {createServer} from 'node:http'
import {createHash, timingSafeEqual} from 'node:crypto'
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

/* ────────────────────────────── the contract ────────────────────────────── */

/** Exact paths. Never a prefix match — lib/ai-proxy.js's contract note 1. */
export const POST_PATH = '/ai/feedback'
export const EXPORT_PATH = '/ai/feedback/export'
export const HEALTH_PATH = '/healthz'

/**
 * 16 KB, and the number is an arithmetic bound rather than a round figure.
 *
 * The fattest record the panel can construct is the amendment: the question,
 * the answer, the citations, the retrieved ids and the reader's sentence. The
 * sentence is capped at 500 characters by feedback.js:144, the answer is one
 * turn's output — 0.7k tokens measured, a few kilobytes of UTF-8 — and every
 * other field is an id, a number or a short enum. A realistic record measured
 * against this package's own `record()` is 782-832 bytes; a pathological one
 * with a 4000-character answer and twenty retrieved ids is still single-digit
 * kilobytes. 16 KB is several times that, and a body that exceeds it is not a
 * vote.
 *
 * IT IS ALSO A STORAGE INVARIANT, which is the reason it is this low. The
 * NDJSON store appends with `O_APPEND`, whose atomicity holds for a write the
 * kernel does not split. Capping the body caps the line — a stored line is at
 * most this plus the two keys added below — and that is what makes a concurrent
 * append from a second process safe rather than lucky.
 */
export const BODY_LIMIT = 16 * 1024

/**
 * `COMMENT_MAX` in src/theme/docpilot/feedback.ts, re-stated rather than
 * imported: importing it would make this file depend on the package it is the
 * server half of, and this file has no dependencies on purpose. The test beside
 * it asserts the two numbers agree, which is the same arrangement
 * lib/ai-proxy.js keeps for `UPSTREAM`.
 */
export const COMMENT_MAX = 500

/**
 * A sanity ceiling on the upsert key. `turn.id` is a short generated id; a
 * primary key of ten kilobytes is not one, and under the body cap it is
 * otherwise legal. Not derived from anything — state it, test it, move it if
 * your ids are longer.
 */
export const MESSAGE_ID_MAX = 200

/** Read by `fetchRows` in src/feedback/source.ts. Named, never printed. */
export const TOKEN_ENV = 'DOCPILOT_FEEDBACK_TOKEN'

/**
 * THE ONE HEADER THAT DECIDES WHETHER THE CLI SEES ANY ROWS AT ALL.
 *
 * `fetchRows` (source.ts:91) branches on
 *
 *     type.includes('json') && !type.includes('ndjson') && body.trim()[0] === '{'
 *
 * and a JSONL body's first character is `{`. So NDJSON served as
 * `application/json` takes the paginated-envelope branch: on a multi-row export
 * `JSON.parse(body)` throws and `docpilot feedback pull` reports "could not
 * read the feedback source"; on a SINGLE-row export it parses, finds no
 * `items`/`rows`/`data` key, and returns ZERO ROWS WITH NO ERROR AND EXIT 0.
 * That is the worst failure this endpoint can produce and it is one header
 * away. `x-ndjson` contains both substrings and is the only value that takes
 * the branch this body is written for.
 *
 * The `accept` header the CLI sends (`application/x-ndjson, application/json`)
 * is deliberately NOT negotiated against: obliging it would let a proxy that
 * rewrites `accept` re-open the trap above.
 */
export const EXPORT_CONTENT_TYPE = 'application/x-ndjson'

/**
 * The server's own clock, under a name the wire format cannot collide with.
 *
 * Twenty-six keys come off `record()` and not one begins with `_` (measured).
 * Epoch MILLISECONDS, the same unit as the wire's `ts`, so an operator reading
 * a line does not convert between two conventions to compare them — the same
 * argument lib/ai-proxy.js:343-346 makes for publishing `x-ratelimit-reset` in
 * milliseconds.
 *
 * `?since=` filters on THIS and never on `ts`. `ts` is `Date.now()` in the
 * reader's browser (session.js:2677): a device whose clock is a day slow writes
 * a row that a `since` computed from the previous export skips forever. The
 * server clock is at least monotone with respect to the order rows entered the
 * store, which is the only property the filter needs.
 */
export const RECEIVED_AT = '_receivedAt'

/* ───────────────────────────── the shape gate ───────────────────────────── */

/**
 * Exactly what `dedupe()` requires, plus four rejections that each have a named
 * consequence. Returns `null` when the row is acceptable, or the operator-
 * facing reason it is not.
 *
 * `messageId` — aggregate.js:38 asks only for truthiness. A NON-STRING truthy
 * id is refused anyway, because it is the upsert key: `123` and `"123"` are two
 * entries in `dedupe`'s `Map` and one row under a `text primary key`, so
 * admitting it is admitting that the three stores below stop agreeing. The
 * panel only ever sends a string (session.js:2683).
 *
 * `question` — aggregate.js:38 asks for a string; `aggregate()` then drops the
 * row a second time, at aggregate.js:72-73, if `normalise(question)` comes out
 * empty. This file cannot run `normalise()` — it lives in the package's theme
 * bundle and importing it would be a dependency — so it refuses the empty case
 * it CAN see and accepts a punctuation-only question it cannot. That residue is
 * named rather than papered over.
 *
 * `revision` — see `THE DEFAULT THAT IS NOT ZERO` below.
 *
 * `verdict` — must be present and one of `'up' | 'down' | null`. Present, not
 * merely valid: `retracted` is derived from `verdict === null`, so an ABSENT
 * verdict and a withdrawn one would be the same row. production.md:361 and
 * session.js:2715 both make it unconditional.
 *
 * `reasons` — must be absent or an array. This is the only field whose
 * malformation is not a dropped row but a dropped REPORT: aggregate.js:114
 * spreads it with `for…of`, which throws on a number and silently iterates the
 * CHARACTERS of a string. One such row ends `docpilot feedback pull`.
 *
 * `comment` — see `TRUNCATE OR REFUSE` below.
 */
export function validate(row) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return 'body must be a JSON object'
    }
    if (typeof row.messageId !== 'string' || row.messageId === '') {
        return 'messageId must be a non-empty string'
    }
    if (row.messageId.length > MESSAGE_ID_MAX) {
        return `messageId is over ${MESSAGE_ID_MAX} characters`
    }
    if (typeof row.question !== 'string') return 'question must be a string'
    if (row.question.trim() === '') return 'question must not be empty'

    /**
     * THE DEFAULT THAT IS NOT ZERO.
     *
     * A missing `revision` is refused rather than defaulted, and the reason is
     * that BOTH readers of the field resolve ties in favour of the later
     * arrival. `dedupe()` (aggregate.js:40) keeps a row when
     * `(r.revision ?? 0) >= (prev.revision ?? 0)`, and the documented upsert
     * guard (production.md:395) updates when
     * `excluded.revision >= docpilot_feedback.revision`. Both are `>=`.
     *
     * So a fabricated `0` is not a neutral value: it is the SAME value the
     * thumb sends. A duplicate thumb — and `keepalive` POSTs are re-delivered,
     * which is the whole reason the guard exists — would then land at 0 after
     * an amendment that was also flattened to 0, and win. The reader's sentence
     * is erased by a retransmission of the click that preceded it, silently,
     * which is precisely the failure production.md:400 says the guard prevents.
     *
     * There is no value that avoids this. `0` collides with the thumb. Anything
     * above 0 claims an amendment the reader never made and would let a
     * non-conforming client outrank every real revision forever. A server-
     * assigned counter is not comparable across the two POSTs of one report
     * arriving out of order, which is the case the field exists for.
     *
     * feedback.js:128 makes the field unconditional, so its absence means the
     * POST did not come from this package. Refusing is the only outcome that
     * cannot silently reorder a reader's own words, and the 400 is visible to
     * the operator in a way a reordering never is.
     *
     * A STRING of digits is accepted — a proxy or a hand-written client that
     * form-encoded the body is a real thing and the value is unambiguous — but
     * a float, a negative, `true` or `"abc"` are not: a negative revision sorts
     * below the thumb and is dropped by both guards, and a float compares in a
     * way no store can index.
     */
    const revision = coerceRevision(row.revision)
    if (revision === null) {
        return 'revision must be a non-negative integer (feedback.js always sends one)'
    }

    if (!('verdict' in row)) return 'verdict must be present ("up", "down" or null)'
    if (row.verdict !== null && row.verdict !== 'up' && row.verdict !== 'down') {
        return 'verdict must be "up", "down" or null'
    }

    if ('reasons' in row && row.reasons !== null && !Array.isArray(row.reasons)) {
        return 'reasons must be an array'
    }
    if (Array.isArray(row.reasons) && row.reasons.some((r) => typeof r !== 'string')) {
        return 'reasons must be an array of strings'
    }

    /**
     * TRUNCATE OR REFUSE — refuse, and the deciding fact is the ORDER of two
     * lines in the client.
     *
     * feedback.js:138-144 redacts the comment and THEN caps it, and says why:
     * capping first can bisect a live key so that no pattern matches what
     * remains, and the fragment ships. This server has no redactor. `redactSecrets`
     * lives in the panel's bundle and a zero-dependency receiver cannot call it.
     *
     * So a server-side truncation is the forbidden order, performed by the one
     * participant that cannot perform the safe one: it would cut at 500
     * characters of text that was never redacted, and store the first 500
     * characters of whatever the reader pasted. The one thing worse than
     * refusing a comment is keeping half a credential out of it.
     *
     * And the row is not a loss. A comment over 500 characters cannot come from
     * `record()` — it caps unconditionally, measured: a 900-character comment
     * left the client as 500. So this 400 refuses a client that is not this
     * package, and the vote it carried was already stored at the revision below
     * it: the thumb POSTs first and separately (feedback.js:9-12).
     *
     * 400 rather than 413: the body is inside the transport cap. This is a
     * shape violation, and shape violations are 400 — 413 would send the
     * operator looking at their proxy's `client_max_body_size`.
     */
    if ('comment' in row && row.comment !== null && typeof row.comment !== 'string') {
        return 'comment must be a string or null'
    }
    if (typeof row.comment === 'string' && [...row.comment].length > COMMENT_MAX) {
        return `comment is over ${COMMENT_MAX} characters — the client caps it, so this did not come from the panel`
    }

    return null
}

/** `null` when the value cannot be a revision. Kept beside `validate` so the two never disagree. */
export function coerceRevision(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null
    }
    if (typeof value === 'string' && /^\d{1,15}$/.test(value)) {
        const n = Number(value)
        return Number.isSafeInteger(n) ? n : null
    }
    return null
}

/**
 * The row as it is stored: the client's object, with the two fields the client
 * is not allowed to state.
 *
 * `retracted` is DERIVED and never accepted. It reaches this server only from a
 * client pretending to be the panel — feedback.js:169 deletes it before the
 * POST — so it is dropped and recomputed. production.md:403: "A withdrawn vote
 * arrives as `verdict: null` under a raised revision." Revision 0 is excluded
 * because a first record with no verdict is not a withdrawal of anything; the
 * panel cannot even produce one, since `record()` only POSTs when there is a
 * verdict or a `retracted` to route on (feedback.js:168-175).
 *
 * Every leading-underscore key is stripped for the same reason: the namespace
 * is reserved for the server, and a reservation that a client can write into is
 * not one.
 */
export function stored(row, receivedAt) {
    const out = {}
    for (const [k, v] of Object.entries(row)) {
        if (k === 'retracted') continue
        if (k.startsWith('_')) continue
        out[k] = v
    }
    out.revision = coerceRevision(row.revision)
    if (out.verdict === null && out.revision > 0) out.retracted = true
    out[RECEIVED_AT] = receivedAt
    return out
}

/* ─────────────────────────────── the stores ─────────────────────────────── */

/**
 * THE SEMANTICS, SETTLED. All three stores below REPLACE the row wholesale on a
 * higher-or-equal revision. None of them merges, and the `coalesce()` in
 * production.md:391-394 is not reproduced. Three reasons, in the order they
 * were established:
 *
 * 1. THE COALESCE ON `comment` IS A LIVE BUG. `comment` is never absent —
 *    feedback.js:142-147 sets it to `null` when it is not a string, with no
 *    third branch — and a retraction sends `"comment":null` explicitly
 *    (measured; the POST is printed in `evidence-wire.mjs`'s output). Under
 *    `coalesce(excluded.comment, docpilot_feedback.comment)` an explicit null
 *    is exactly as invisible as an absent one, so the sentence the reader just
 *    withdrew survives the withdrawal. production.md:403 says that record "is
 *    the reader taking back what they said, including their own words"; the SQL
 *    twelve lines above it keeps the words.
 *
 * 2. THE COALESCE ON `retrieved_ids` DESTROYS THE SIGNAL production.md:373
 *    INTRODUCES. That paragraph says `restored: true` is how you tell "nothing
 *    was retrieved" from "this was not recorded". A coalesce fills the column
 *    on a restored amendment from the live revision below it, and the row then
 *    says `restored: true` AND carries ids — a state no client ever reported
 *    and the exact state the flag exists to rule out.
 *
 * 3. `dedupe()` REPLACES. aggregate.js:35-43 picks the highest-revision row and
 *    uses it ENTIRE. A merging store hands the reader a row no POST ever
 *    contained — revision 0's answer under revision 2's null comment — and a
 *    wrong number in a report built from it cannot be traced to a request. The
 *    reader is the specification here, and it does not merge.
 *
 * WHAT REPLACEMENT COSTS, stated rather than hidden: a vote cast on a turn
 * restored from the reader's archive genuinely has no `retrievedIds`
 * (session.js:2692), so the winning revision has none and the candidate has
 * none. Under the NDJSON store nothing is lost — the earlier revision is still
 * a line in the file, and the operator can read it. Under an upserting store it
 * is gone. That is a real difference between the two, and it is a difference in
 * what the OPERATOR can dig up, not in what the reader computes: `dedupe()`
 * would have discarded the earlier revision either way. The three stores
 * therefore produce byte-identical `aggregate()` output, which the test beside
 * this file asserts against the package's own `aggregate`.
 *
 * Every store is `{append(row), read(since)}` and nothing else.
 */

/**
 * NDJSON day-files. The default, and the one that is right BY CONSTRUCTION:
 * append-only plus `dedupe()` is replacement semantics with no code, and
 * aggregate.js:8-13 says so outright — "The receiver is told to upsert; a
 * receiver that stored every revision instead is repaired here."
 *
 * ONE `appendFileSync` PER ROW, which is `O_APPEND`: the kernel makes the seek
 * and the write one operation, so two writers cannot interleave at the offset.
 * Within this process there is no concurrency to speak of — a synchronous
 * append cannot be preempted by the event loop, so a hundred simultaneous POSTs
 * are a hundred serialised writes. The guarantee matters across PROCESSES (a
 * `cluster`, two containers on one volume), and there it holds only while the
 * kernel does not split the write. That is why `BODY_LIMIT` is 16 KB rather
 * than 256 KB: the cap on the body is what bounds the line.
 *
 * The day is UTC and comes from the SERVER's clock, never from `ts`. A device
 * with a wrong clock would otherwise file its row under a day the operator's
 * `since` has already passed.
 */
export function ndjsonStore({dir, warn = console.error}) {
    const NAME = /^feedback-(\d{4}-\d{2}-\d{2})\.ndjson$/

    const fileFor = (at) => path.join(dir, `feedback-${new Date(at).toISOString().slice(0, 10)}.ndjson`)

    return {
        kind: 'ndjson',
        describe: () => `ndjson day-files in ${dir}`,

        /**
         * `mkdirSync(…, {recursive: true})` on every append rather than once at
         * startup. It is idempotent and costs a syscall; doing it once means a
         * deployment whose volume is mounted after the process starts — or an
         * operator who deletes the directory while it runs — appends into
         * nothing and reports success.
         */
        append(row) {
            mkdirSync(dir, {recursive: true})
            // JSON.stringify escapes U+000A as the two characters \n, so a
            // comment containing a newline cannot end the record early. This is
            // the property the whole line-delimited format rests on and the
            // test beside this file asserts it rather than trusting it.
            appendFileSync(fileFor(row[RECEIVED_AT]), JSON.stringify(row) + '\n')
        },

        read(since) {
            if (!existsSync(dir)) return []
            const day = since === null ? null : new Date(since).toISOString().slice(0, 10)
            // ISO day names sort lexicographically into chronological order, so
            // the export is in append order and `dedupe()`'s `>=` tie-break
            // resolves in favour of the later arrival, as it does in a database.
            const files = readdirSync(dir)
                .filter((n) => NAME.test(n))
                .sort()
            const out = []
            for (const name of files) {
                // The filename is an optimisation, never the filter: a row's own
                // `_receivedAt` decides. Skipping a whole file is safe only for
                // days strictly before the day `since` falls in.
                if (day && NAME.exec(name)[1] < day) continue
                const text = readFileSync(path.join(dir, name), 'utf8')
                const lines = text.split('\n')
                for (const [i, line] of lines.entries()) {
                    if (line === '') continue
                    let row
                    try {
                        row = JSON.parse(line)
                    } catch {
                        /**
                         * A TORN LINE, which is a crash between the write and
                         * the newline. It is skipped rather than thrown on,
                         * because the alternative is that one interrupted
                         * append makes every row in that day unreadable — the
                         * CLI's own `parseRows` (source.ts:36) throws
                         * "line N is not JSON" and takes the whole pull with
                         * it.
                         *
                         * WHERE it is torn is the diagnosis and is reported as
                         * such. The last line is a crash and is expected. A
                         * line in the MIDDLE cannot be a crash — something was
                         * appended after it — so it is a split write from a
                         * second process, which is the one failure the 16 KB
                         * body cap exists to prevent.
                         */
                        const trailing = lines.slice(i + 1).every((l) => l === '')
                        warn(
                            `[receiver] ${name} line ${i + 1} is not JSON and was skipped — ` +
                                (trailing
                                    ? 'torn final line, i.e. a crash mid-append'
                                    : 'MID-FILE: two writers split a record, or the file was edited'),
                        )
                        continue
                    }
                    if (since !== null && !includeSince(row, since)) continue
                    out.push(row)
                }
            }
            return out
        },
    }
}

/**
 * Whether a row is inside `?since=`, and the two directions of doubt resolve
 * differently on purpose.
 *
 * INCLUSIVE (`>=`). `dedupe()` collapses on `messageId`, so re-exporting a row
 * the operator already has changes nothing about the candidate it lands in — a
 * duplicate is free. A GAP is not: the row is simply never seen again, and
 * nothing anywhere reports it. Every ambiguity here is resolved towards the
 * duplicate.
 *
 * A row with no usable `_receivedAt` falls back to `ts` and, failing that, is
 * INCLUDED. It cannot have come from this receiver, so it is a file the
 * operator assembled by hand — and a row whose age cannot be established is not
 * a row that can be proven older than the cutoff.
 */
function includeSince(row, since) {
    const at = row?.[RECEIVED_AT]
    if (typeof at === 'number' && Number.isFinite(at)) return at >= since
    if (typeof row?.ts === 'number' && Number.isFinite(row.ts)) return row.ts >= since
    return true
}

/**
 * SQLite through `node:sqlite`. Imported lazily so this file loads on a Node
 * without it.
 *
 * THE DDL IS PART OF THE STORE. `db.prepare()` on a table that does not exist
 * throws at prepare time, not at first use, so a receiver that ships the upsert
 * without the `create table` does not start — and the operator's first
 * encounter with the schema is a stack trace during a deploy.
 *
 * `strict` is SQLite 3.37+ (3.53.4 in Node 26). Without it SQLite's type
 * affinity accepts `'abc'` into `revision integer` and the ordering guard
 * silently compares a string.
 */
export const SQLITE_DDL = `
create table if not exists docpilot_feedback (
  message_id      text    primary key,
  revision        integer not null,
  received_at     integer not null,
  ts              integer,
  session_id      text,
  conversation_id text,
  question        text    not null,
  verdict         text,
  retracted       integer not null default 0,
  row             text    not null
) strict;

create index if not exists docpilot_feedback_by_received_at
  on docpilot_feedback (received_at, message_id);
`

/**
 * The columns are a PROJECTION for indexing and for `psql`-by-hand; `row` is
 * the record. Replacing both together is what keeps them from disagreeing —
 * there is no update path that touches one and not the other.
 *
 * `where excluded.revision >= docpilot_feedback.revision` is production.md:395,
 * kept verbatim and for its stated reason: `keepalive` POSTs arrive out of
 * order, and without it a slow revision 0 landing after revision 1 erases the
 * sentence the reader wrote. `>=` rather than `>` so a re-sent record at the
 * same revision refreshes `received_at`, which is what `?since=` pages on.
 */
export const SQLITE_UPSERT = `
insert into docpilot_feedback
  (message_id, revision, received_at, ts, session_id, conversation_id,
   question, verdict, retracted, row)
values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict (message_id) do update set
  revision        = excluded.revision,
  received_at     = excluded.received_at,
  ts              = excluded.ts,
  session_id      = excluded.session_id,
  conversation_id = excluded.conversation_id,
  question        = excluded.question,
  verdict         = excluded.verdict,
  retracted       = excluded.retracted,
  row             = excluded.row
where excluded.revision >= docpilot_feedback.revision;
`

export async function sqliteStore({file}) {
    const {DatabaseSync} = await import('node:sqlite')
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), {recursive: true})
    const db = new DatabaseSync(file)
    db.exec('pragma journal_mode = wal')
    db.exec(SQLITE_DDL)
    const upsert = db.prepare(SQLITE_UPSERT)
    const selectAll = db.prepare('select row from docpilot_feedback order by received_at, message_id')
    const selectSince = db.prepare(
        'select row from docpilot_feedback where received_at >= ? order by received_at, message_id',
    )
    // `strict` refuses a REAL in an `integer` column, and a hostile `ts` of 1.5
    // would otherwise be the one field that can throw out of `append`.
    const int = (v) => (Number.isSafeInteger(v) ? v : null)
    const text = (v) => (typeof v === 'string' ? v : null)
    return {
        kind: 'sqlite',
        describe: () => `sqlite at ${file}`,
        db,
        append(row) {
            upsert.run(
                row.messageId,
                row.revision,
                row[RECEIVED_AT],
                int(row.ts),
                text(row.sessionId),
                text(row.conversationId),
                row.question,
                text(row.verdict),
                row.retracted ? 1 : 0,
                JSON.stringify(row),
            )
        },
        read(since) {
            const rows = since === null ? selectAll.all() : selectSince.all(since)
            return rows.map((r) => JSON.parse(r.row))
        },
        close: () => db.close(),
    }
}

/**
 * Postgres. SQL ONLY — no driver, for the reason source.ts:4-9 gives for the
 * package itself: shipping one would be this file having an opinion about
 * someone else's infrastructure.
 *
 * This is production.md:380-395 with the four `coalesce()` calls removed and
 * the reasons given above the store block. `received_at` and `retracted` are
 * added because they are what this receiver computes and the documented DDL has
 * nowhere to put them. `row jsonb` keeps the record whole: the columns are for
 * indexes and for reading by hand, and a projection that is the only copy is a
 * projection that will one day be missing the field somebody needs.
 */
export const POSTGRES_SQL = `
create table if not exists docpilot_feedback (
  message_id      text        primary key,
  revision        bigint      not null check (revision >= 0),
  received_at     timestamptz not null,
  ts              timestamptz,
  session_id      text,
  conversation_id text,
  question        text        not null,
  verdict         text        check (verdict in ('up', 'down')),
  retracted       boolean     not null default false,
  row             jsonb       not null
);

create index if not exists docpilot_feedback_by_received_at
  on docpilot_feedback (received_at, message_id);

-- $3 and $4 are epoch MILLISECONDS: $3 is this receiver's own clock, $4 is the
-- reader's browser clock, and they are different facts. Filter on $3.
insert into docpilot_feedback
  (message_id, revision, received_at, ts, session_id, conversation_id,
   question, verdict, retracted, row)
values ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0),
        $5, $6, $7, $8, $9, $10::jsonb)
on conflict (message_id) do update set
  revision        = excluded.revision,
  received_at     = excluded.received_at,
  ts              = excluded.ts,
  session_id      = excluded.session_id,
  conversation_id = excluded.conversation_id,
  question        = excluded.question,
  verdict         = excluded.verdict,
  retracted       = excluded.retracted,
  row             = excluded.row
where excluded.revision >= docpilot_feedback.revision;

-- The export. One row per messageId, whole, in the order the CLI's dedupe()
-- wants to see them.
select row from docpilot_feedback
where received_at >= to_timestamp($1 / 1000.0)
order by received_at, message_id;
`

/* ─────────────────────────────── the transport ──────────────────────────── */

/**
 * The body, buffered, with the ceiling applied to BYTES READ — lib/ai-proxy.js's
 * `readBody`, restated for `node:http`.
 *
 * `content-length` is supplied by the client, so a cap that trusts it is a cap
 * the client sets. It is checked FIRST anyway, because refusing an honest
 * oversized body before reading a byte is free, and then it is ignored: the
 * measured count is the one that decides.
 *
 * `Number(undefined)` is NaN but `Number(null)` is 0, and Node hands back
 * `undefined` for an absent header — the distinction is written out rather than
 * relied on, because the same line in lib/ai-proxy.js:217 had to be repaired
 * for exactly this.
 *
 * On the measured overflow the stream is PAUSED, not destroyed. Destroying it
 * kills the socket before the 413 has left, and the client sees a transport
 * error instead of a status — which for `record()`'s silent `.catch()` is the
 * difference between a refusal an operator can find in a log and nothing at all.
 */
export function readBody(req, cap = BODY_LIMIT) {
    return new Promise((resolve) => {
        const stated = req.headers['content-length']
        const declared = stated === undefined || stated === '' ? NaN : Number(stated)
        if (Number.isFinite(declared) && declared > cap) {
            resolve({tooLarge: true, declared: true, body: null, bytes: 0})
            return
        }
        const parts = []
        let bytes = 0
        let settled = false
        const done = (result) => {
            if (settled) return
            settled = true
            resolve(result)
        }
        req.on('data', (chunk) => {
            if (settled) return
            bytes += chunk.length
            if (bytes > cap) {
                req.pause()
                done({tooLarge: true, declared: false, body: null, bytes})
                return
            }
            parts.push(chunk)
        })
        req.on('end', () => done({tooLarge: false, declared: false, body: Buffer.concat(parts), bytes}))
        // The reader closed the tab mid-POST. Not an error anyone can act on,
        // and the one thing it must not do is reject an un-awaited promise.
        req.on('aborted', () => done({aborted: true, body: null, bytes}))
        req.on('error', () => done({aborted: true, body: null, bytes}))
    })
}

/**
 * `crypto.timingSafeEqual` THROWS on unequal-length buffers —
 * `RangeError: Input buffers must have the same byte length` — so calling it on
 * a presented token is calling it on a length an attacker chooses. A one-
 * character token would take the endpoint's 401 path through a 500, and a
 * `try/catch` around it would leak the length through which branch ran.
 *
 * Hashing both sides first is the fix: SHA-256 is 32 bytes for every input, so
 * the comparison is always defined and always the same width. The presented
 * token's length is then observable only through the cost of hashing it, which
 * is not a comparison and not the secret.
 *
 * A MISSING SERVER TOKEN IS A 503, not a 401 and never an open door. It is an
 * unset variable rather than a rejected caller — the same distinction
 * lib/ai-proxy.js:374-381 draws for `OPENROUTER_API_KEY` — and answering 401
 * sends the operator hunting for a token they did set.
 */
export function authorise(req, env = process.env) {
    const expected = env[TOKEN_ENV]
    if (!expected) {
        return {ok: false, status: 503, message: `no export token — set ${TOKEN_ENV} in the environment`}
    }
    const presented = bearer(req.headers.authorization)
    if (presented === null) {
        return {ok: false, status: 401, message: 'this endpoint requires Authorization: Bearer <token>'}
    }
    const a = createHash('sha256').update(presented, 'utf8').digest()
    const b = createHash('sha256').update(expected, 'utf8').digest()
    if (!timingSafeEqual(a, b)) return {ok: false, status: 401, message: 'bad token'}
    return {ok: true, status: 200, message: null}
}

/** RFC 7235: the scheme is case-insensitive and separated by one or more spaces. */
function bearer(header) {
    if (typeof header !== 'string') return null
    const m = /^Bearer[ \t]+(\S.*)$/i.exec(header.trim())
    return m ? m[1].trim() || null : null
}

/**
 * `?since=`, which is an UNVALIDATED RAW STRING and must be treated as one.
 *
 * cli.ts:68-69 reads `--since` straight off argv and source.ts:74 does
 * `url.searchParams.set('since', since)` with no parse in between, so whatever
 * the operator typed arrives here. `new Date('garbage').toISOString()` throws
 * `RangeError: Invalid time value`, and a handler that formats the parameter
 * before checking it answers 500 to a typo.
 *
 * A GARBAGE VALUE IS A 400, not "everything". Returning the whole store on an
 * unparseable date is the dangerous answer: the operator asked for a delta, got
 * a full export, and has no way to tell. `fetchRows` (source.ts:86) turns the
 * 400 into `"… responded 400"` and cli.ts:162 prints it, so a mistyped date
 * fails loudly at the terminal — measured end to end in the round-trip below.
 *
 * `Date.parse` IS NOT A VALIDATOR, and this is the part that has to be measured
 * rather than assumed. V8 falls back to a legacy parser that accepts a great
 * deal — all three of these are real, from `node -e`:
 *
 *     Date.parse('%00')      → 2000-01-01   (local)
 *     Date.parse('0')        → 2000-01-01   (local)
 *     Date.parse('abc 2026') → 2026-01-01   (local)
 *
 * So a receiver that "validates by parsing" turns a typo into a PLAUSIBLE date
 * and exports the wrong window with a 200 — which is the same silent lie the
 * 400 above exists to prevent, one layer down. The shape is therefore checked
 * FIRST, against what cli.ts:41 documents the flag takes (`--since <ISO>`), and
 * `Date.parse` is used only to reject impossible fields inside a well-shaped
 * one (`2026-13-45`).
 *
 * ACCEPTED: an ISO-8601 date or instant — year, date, or date plus time with an
 * optional fraction and offset — and a run of 10+ digits read as epoch
 * milliseconds, because an operator paging on the previous export's last
 * `_receivedAt` has that number and not a string. Ten digits is the floor
 * because it puts a four-digit year (`?since=2026`) out of the numeric branch.
 *
 * NOT NORMALISED: ECMA-262 reads a bare `2026-01-01` as UTC and a zoneless
 * `2026-01-01T00:00:00` as LOCAL. That is a real and surprising asymmetry, and
 * it is left alone — a receiver that re-interprets the operator's string is a
 * receiver inventing a timezone on their behalf. Send an offset if it matters.
 */
const ISO = /^\d{4}(-\d{2}(-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/

export function parseSince(raw) {
    if (raw === null || raw === undefined) return {at: null, error: null}
    const s = String(raw).trim()
    if (s === '') return {at: null, error: null}
    if (/^\d{10,}$/.test(s)) {
        const n = Number(s)
        if (Number.isSafeInteger(n)) return {at: n, error: null}
    }
    const at = ISO.test(s) ? Date.parse(s) : NaN
    if (!Number.isFinite(at)) {
        return {at: null, error: `?since= is not an ISO date or an epoch-ms integer: ${JSON.stringify(s.slice(0, 80))}`}
    }
    return {at, error: null}
}

/* ──────────────────────────────── the handler ───────────────────────────── */

const NO_STORE = {'cache-control': 'no-store'}

function problem(res, status, message, headers = {}) {
    const body = JSON.stringify({error: {code: status, message}})
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...NO_STORE,
        ...headers,
    })
    res.end(body)
}

/**
 * ONE REQUEST.
 *
 * ROUTING IS NOT A GATE — it decides WHICH list of gates applies, which is why
 * it comes first and why every path is an exact string. A prefix match on
 * `/ai/feedback` would make `/ai/feedback/export` a POST target and the export
 * a place to write rows into.
 *
 * The POST gates are in the order of what each costs, exactly as
 * lib/ai-proxy.js:352-366 argues: method is free, the declared cap is free, the
 * measured cap costs the read, the parse costs the parse, the shape costs
 * nothing more, and the store is last because it is the only one that writes.
 *
 *   405  not POST                      — free, `allow: POST`
 *   413  declared content-length > cap — free, refused WITHOUT reading a byte
 *   413  measured bytes > cap          — the read, stopped at the first chunk over
 *   400  not JSON                      — the parse
 *   400  wrong shape                   — `validate()`, with the field named
 *   500  the store threw               — the only one that is this server's fault
 *   204  stored, EMPTY BODY
 *
 * THE 204 CARRIES NOTHING. `record()` never reads the response (feedback.js:178)
 * and the POST is `keepalive`, sent while the page may be unloading; a body
 * there is bytes on a connection nobody is listening to. It is also the status
 * that says "accepted, and there is nothing to say back", which is true.
 */
export function createHandler({store, env = process.env, now = Date.now, warn = console.error}) {
    return async function handle(req, res) {
        let url
        try {
            url = new URL(req.url, `http://${req.headers.host || 'receiver.invalid'}`)
        } catch {
            problem(res, 400, 'unparseable request target')
            return
        }

        try {
            if (url.pathname === HEALTH_PATH) return health(req, res)
            if (url.pathname === POST_PATH) return await post(req, res, {store, now, warn})
            if (url.pathname === EXPORT_PATH) return await exportRows(req, res, {store, env, url})
            problem(res, 404, 'not found')
        } catch (e) {
            // The last line of defence, and it exists because the alternative is
            // an unhandled rejection that takes the process down and loses every
            // vote in flight. The reason is logged for the operator and NOT
            // returned: an exception message is the one place a connection
            // string reaches a response body.
            warn(`[receiver] ${req.method} ${url.pathname} failed —`, e)
            if (!res.headersSent) problem(res, 500, 'the receiver failed to handle this request')
            else res.end()
        }
    }
}

function health(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return problem(res, 405, `${req.method} not allowed`, {allow: 'GET, HEAD'})
    }
    const body = 'ok\n'
    res.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body), ...NO_STORE})
    res.end(req.method === 'HEAD' ? undefined : body)
}

async function post(req, res, {store, now, warn}) {
    if (req.method !== 'POST') {
        return problem(res, 405, `${req.method} not allowed — this endpoint takes POST`, {allow: 'POST'})
    }

    const read = await readBody(req, BODY_LIMIT)
    if (read.aborted) {
        // Nothing to answer to. `res.destroy()` rather than a status, because
        // the socket the status would go down is already gone.
        res.destroy()
        return
    }
    if (read.tooLarge) {
        // `connection: close` because the request body was not consumed, so this
        // socket cannot be reused for a second request — saying so is what lets
        // the client stop writing instead of blocking on a full buffer.
        return problem(res, 413, `body over ${BODY_LIMIT} bytes`, {connection: 'close'})
    }

    let row
    try {
        row = JSON.parse(read.body.toString('utf8'))
    } catch (e) {
        return problem(res, 400, `body is not JSON — ${e.message}`)
    }

    const bad = validate(row)
    if (bad) return problem(res, 400, bad)

    try {
        store.append(stored(row, now()))
    } catch (e) {
        // The store is the only failure here that is the SERVER's. It is a 500
        // rather than a swallowed error precisely because the panel will not
        // show it: an operator watching for 5xx at the proxy is the only person
        // who can find out that the disk filled up.
        warn('[receiver] store.append failed —', e)
        return problem(res, 500, 'could not store the record')
    }

    // 204: no content-type, no content-length, no body. Node emits none of them
    // for a 204 and the test asserts the response is zero bytes.
    res.writeHead(204, NO_STORE)
    res.end()
}

async function exportRows(req, res, {store, env, url}) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return problem(res, 405, `${req.method} not allowed — this endpoint takes GET`, {allow: 'GET, HEAD'})
    }
    const auth = authorise(req, env)
    if (!auth.ok) {
        // RFC 7235 requires the challenge on a 401. It also has to NOT carry a
        // `realm` naming anything about this deployment.
        return problem(res, auth.status, auth.message, auth.status === 401 ? {'www-authenticate': 'Bearer'} : {})
    }

    const since = parseSince(url.searchParams.get('since'))
    if (since.error) return problem(res, 400, since.error)

    const rows = await store.read(since.at)
    // A trailing newline on a non-empty body, none on an empty one.
    // `parseRows` (source.ts:24) trims and returns `[]` for empty input, and
    // cli.ts:167 then prints "the source is empty — nothing to aggregate" and
    // exits 1, which is the honest answer to a `since` that matched nothing.
    const body = rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : ''
    res.writeHead(200, {
        'content-type': EXPORT_CONTENT_TYPE,
        'content-length': Buffer.byteLength(body),
        ...NO_STORE,
    })
    // NO CURSOR, deliberately, and it is not a stub. `fetchRows` pages only on
    // the JSON-envelope branch (source.ts:91-97), and taking that branch means
    // giving up the `x-ndjson` content type this endpoint depends on. An
    // operator whose export outgrows one response should page on `?since=`,
    // which is a cursor they can read.
    res.end(req.method === 'HEAD' ? undefined : body)
}

/* ─────────────────────────────────── run ────────────────────────────────── */

export async function createReceiver({
    storeKind = process.env.DOCPILOT_FEEDBACK_STORE || 'ndjson',
    dir = process.env.DOCPILOT_FEEDBACK_DIR || './feedback',
    file = process.env.DOCPILOT_FEEDBACK_DB || './feedback/feedback.sqlite',
    env = process.env,
    now = Date.now,
    warn = console.error,
} = {}) {
    const store = storeKind === 'sqlite' ? await sqliteStore({file}) : ndjsonStore({dir, warn})
    const server = createServer(createHandler({store, env, now, warn}))
    // A socket that dies mid-request must not become an unhandled 'error' on
    // the server object. lib/ai-proxy.js's `.catch(() => {})` on `reader.cancel()`
    // is the same habit: the cleanup path is the one that must not throw.
    server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
        else socket.destroy()
    })
    return {server, store}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT || 8787)
    const host = process.env.HOST || '127.0.0.1'
    const {server, store} = await createReceiver()
    if (!process.env[TOKEN_ENV]) {
        console.error(`[receiver] ${TOKEN_ENV} is not set — ${EXPORT_PATH} will answer 503 until it is`)
    }
    server.listen(port, host, () => {
        const at = server.address()
        console.error(`[receiver] ${store.describe()}`)
        console.error(`[receiver] POST http://${host}:${at.port}${POST_PATH}`)
        console.error(`[receiver] GET  http://${host}:${at.port}${EXPORT_PATH}`)
        console.error(`[receiver] GET  http://${host}:${at.port}${HEALTH_PATH}`)
        // stdout carries the port and nothing else, so a test harness can read
        // one line and know where to POST.
        console.log(String(at.port))
    })
}
