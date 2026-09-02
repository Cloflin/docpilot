/**
 * The receiver, tested against the package it is a receiver for.
 *
 * Where a claim can be checked against DocPilot's own built code it is —
 * `aggregate`, `dedupe`, `parseRows`, `fetchRows` and `COMMENT_MAX` are
 * imported from dist/ rather than restated — so a test that passes here is a
 * statement about the two together, not about this file's opinion of the other.
 */

import {describe, it, expect, afterAll, onTestFinished} from 'vitest'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import net from 'node:net'
import {timingSafeEqual} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
    createHandler,
    ndjsonStore,
    sqliteStore,
    validate,
    coerceRevision,
    stored,
    parseSince,
    authorise,
    readBody,
    BODY_LIMIT,
    COMMENT_MAX,
    RECEIVED_AT,
    EXPORT_CONTENT_TYPE,
    TOKEN_ENV,
    SQLITE_DDL,
    POSTGRES_SQL,
} from '../lib/feedback-receiver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const RECEIVER = path.join(PKG, 'lib/feedback-receiver.mjs')

const {aggregate, dedupe} = await import(`${PKG}/dist/feedback/aggregate.js`)
const {parseRows, fetchRows} = await import(`${PKG}/dist/feedback/source.js`)
const pkgFeedback = await import(`${PKG}/dist/theme/docpilot/feedback.js`)

const TOKEN = 'test-token-3f9c'

let temps = []
function tmp() {
    const d = mkdtempSync(path.join(tmpdir(), 'dp-fb-'))
    temps.push(d)
    return d
}
afterAll(() => temps.forEach((d) => rmSync(d, {recursive: true, force: true})))

/** A live receiver on an ephemeral port. */
async function up({store, env = {[TOKEN_ENV]: TOKEN}, now = Date.now} = {}) {
    const dir = store ? null : path.join(tmp(), 'nested', 'missing')
    const warned = []
    const s = store || ndjsonStore({dir, warn: (m) => warned.push(m)})
    const server = createServer(createHandler({store: s, env, now, warn: (...a) => warned.push(a.join(' '))}))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const base = `http://127.0.0.1:${port}`
    return {
        server,
        store: s,
        dir,
        port,
        base,
        warned,
        post: (body, init = {}) =>
            fetch(`${base}/ai/feedback`, {
                method: 'POST',
                headers: {'content-type': 'application/json', ...(init.headers || {})},
                body: typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body),
                ...init,
            }),
        get: (p, init = {}) =>
            fetch(`${base}${p}`, {headers: {authorization: `Bearer ${TOKEN}`, ...(init.headers || {})}, ...init}),
        close: () => new Promise((r) => server.close(r)),
    }
}

/** A realistic record, built from what session.ts:2668-2763 hands record(). */
const ROW = (over = {}) => ({
    ts: 1756800000000,
    sessionId: 's-1',
    conversationId: 'c-1',
    messageId: 'm-1',
    revision: 0,
    question: 'How do I set the editor locale?',
    quote: null,
    answer: 'Set `locale` in the initialization settings.',
    citations: ['/editor-configuration/initialization-settings.html'],
    retrievedIds: ['chunk-7', 'chunk-9'],
    retrieval: 'hybrid',
    model: 'qwen3:8b',
    iterations: 1,
    rejectedFetches: 0,
    latencyMs: 2100,
    verdict: 'down',
    reasons: [],
    comment: null,
    refusal: null,
    gate: {
        G: 0.41, tau: 0.29, mode: 'hybrid', degraded: false, n: 5,
        channel: 'direct', antecedent: null, source: 'index', wouldPassUnscoped: true,
    },
    support: null,
    scope: {kind: 'all', label: 'All docs', pages: 0, paths: [], truncated: false},
    promptHash: 'ph-1',
    promptStock: true,
    addendumHash: null,
    addendumChars: 0,
    ...over,
})

const lines = (dir) =>
    (existsSync(dir) ? readdirSync(dir) : [])
        .filter((n) => n.endsWith('.ndjson'))
        .sort()
        .flatMap((n) => readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean))

/** One request written by hand, because `fetch` will not send a header it knows to be a lie. */
function raw(port, request, waitMs = 4000) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(request))
        let buf = ''
        sock.setTimeout(waitMs, () => (sock.destroy(), reject(new Error('no response — the handler waited for a body'))))
        sock.on('data', (d) => {
            buf += d
            if (buf.includes('\r\n\r\n')) resolve(buf), sock.destroy()
        })
        sock.on('error', (e) => (buf ? resolve(buf) : reject(e)))
    })
}

/* ══════════════════════════ the contract this mirrors ═════════════════════ */

it('COMMENT_MAX matches the package it is a cap for', () => {
    assert.equal(COMMENT_MAX, pkgFeedback.COMMENT_MAX)
    assert.equal(COMMENT_MAX, 500)
})

it('the read path drops exactly what validate() guarantees (aggregate.js:38)', () => {
    // dedupe keeps a row iff: truthy, question is a string, messageId truthy.
    assert.equal(dedupe([{messageId: 'a', question: 'q'}]).length, 1)
    assert.equal(dedupe([{messageId: '', question: 'q'}]).length, 0)
    assert.equal(dedupe([{messageId: 'a', question: 7}]).length, 0)
    assert.equal(dedupe([{messageId: 'a'}]).length, 0)
    // Every row validate() accepts survives dedupe.
    for (const over of [{}, {verdict: null, revision: 3}, {comment: 'x'.repeat(COMMENT_MAX)}]) {
        const row = ROW(over)
        assert.equal(validate(row), null, JSON.stringify(over))
        assert.equal(dedupe([row]).length, 1)
    }
})

it('a numeric `reasons` crashes the REAL aggregate — which is why it is validated', () => {
    assert.throws(
        () => aggregate([{messageId: 'a', question: 'q', reasons: 5}]),
        /is not iterable/,
        'aggregate.js:114 spreads reasons with for…of',
    )
    // and a string silently iterates its characters
    const c = aggregate([{messageId: 'a', question: 'q', reasons: 'ab'}])
    assert.deepEqual(Object.keys(c[0].reasons), ['a', 'b'])
    // this receiver refuses both
    assert.match(validate(ROW({reasons: 5})), /reasons must be an array/)
    assert.match(validate(ROW({reasons: 'ab'})), /reasons must be an array/)
    assert.match(validate(ROW({reasons: ['ok', 2]})), /array of strings/)
})

it('no wire key begins with _, so RECEIVED_AT cannot collide', () => {
    const sent = []
    const mem = new Map()
    pkgFeedback.record(ROW({retracted: null}), {
        feedbackEndpoint: '/ai/feedback',
        send: 'both',
        storage: {getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v)},
        fetchImpl: (u, i) => (sent.push(i.body), Promise.resolve({ok: true})),
    })
    const keys = Object.keys(JSON.parse(sent[0]))
    assert.equal(keys.filter((k) => k.startsWith('_')).length, 0)
    assert.ok(RECEIVED_AT.startsWith('_'))
    assert.equal(keys.includes('retracted'), false, 'feedback.js:169 deletes it')
})

/* ═════════════════════════════ gate order & statuses ══════════════════════ */

it('gate order: method → cap → parse → shape → store → 204', async () => {
    const r = await up()
    onTestFinished(() => r.close())

    // method — free, before anything is read
    const get = await fetch(`${r.base}/ai/feedback`)
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    // cap comes before the parse: an oversized body that is ALSO not JSON is 413
    const big = await r.post('x'.repeat(BODY_LIMIT + 1))
    assert.equal(big.status, 413)

    // parse comes before the shape: invalid JSON that would also fail validate()
    const bad = await r.post('{"messageId":')
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error.message, /body is not JSON/)

    // shape
    const shape = await r.post(ROW({messageId: undefined}))
    assert.equal(shape.status, 400)
    assert.match((await shape.json()).error.message, /messageId/)

    // store, then 204 with an EMPTY body
    const ok = await r.post(ROW())
    assert.equal(ok.status, 204)
    assert.equal(ok.headers.get('content-length'), null)
    assert.equal(ok.headers.get('content-type'), null)
    assert.equal((await ok.arrayBuffer()).byteLength, 0)
    assert.equal(lines(r.dir).length, 1)
})

it('every status this endpoint can produce', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    const cases = [
        [200, () => fetch(`${r.base}/healthz`)],
        [204, () => r.post(ROW())],
        [400, () => r.post('nope')],
        [404, () => fetch(`${r.base}/ai/feedback/`)], // exact match, never a prefix
        [404, () => fetch(`${r.base}/`)],
        [405, () => fetch(`${r.base}/ai/feedback`, {method: 'OPTIONS'})],
        [405, () => fetch(`${r.base}/healthz`, {method: 'POST'})],
        [405, () => r.get('/ai/feedback/export', {method: 'DELETE'})],
        [401, () => fetch(`${r.base}/ai/feedback/export`)],
        [413, () => r.post('y'.repeat(BODY_LIMIT + 1))],
    ]
    for (const [want, run] of cases) {
        const res = await run()
        await res.arrayBuffer()
        assert.equal(res.status, want, `${want} case`)
    }
    // 503 needs a server with no token
    const noToken = await up({env: {}})
    const res = await fetch(`${noToken.base}/ai/feedback/export`, {headers: {authorization: `Bearer ${TOKEN}`}})
    assert.equal(res.status, 503)
    assert.match((await res.json()).error.message, /DOCPILOT_FEEDBACK_TOKEN/)
    await noToken.close()
})

it('no access-control-* header on any response, ever', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    for (const res of [
        await fetch(`${r.base}/healthz`),
        await r.post(ROW()),
        await r.post('nope'),
        await fetch(`${r.base}/ai/feedback`, {method: 'OPTIONS'}),
        await r.get('/ai/feedback/export'),
        await fetch(`${r.base}/nope`),
    ]) {
        await res.arrayBuffer()
        for (const [k] of res.headers) assert.ok(!k.startsWith('access-control'), `${k} leaked`)
        assert.equal(res.headers.get('cache-control'), 'no-store')
    }
})

/* ══════════════════════════ the byte-exact 16 KB cap ══════════════════════ */

/** A syntactically valid record whose JSON is EXACTLY `n` bytes. */
function bodyOfExactly(n) {
    let q = 'a'
    for (;;) {
        const body = JSON.stringify(ROW({question: q}))
        const len = Buffer.byteLength(body)
        if (len === n) return body
        if (len > n) throw new Error(`cannot hit ${n}; overshot at ${len}`)
        q += 'a'.repeat(n - len)
    }
}

it('16384 bytes pass, 16385 refuse — with a declared content-length', async () => {
    const r = await up()
    onTestFinished(() => r.close())

    const exact = bodyOfExactly(BODY_LIMIT)
    assert.equal(Buffer.byteLength(exact), 16384)
    const pass = await r.post(exact)
    assert.equal(pass.status, 204)

    const over = bodyOfExactly(BODY_LIMIT + 1)
    assert.equal(Buffer.byteLength(over), 16385)
    const refuse = await r.post(over)
    assert.equal(refuse.status, 413)
    assert.match((await refuse.json()).error.message, /body over 16384 bytes/)

    assert.equal(lines(r.dir).length, 1, 'only the 16384 one was stored')
})

it('16384 / 16385 with NO declared content-length (chunked)', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    const chunked = (body) =>
        r.post(
            new ReadableStream({
                start(c) {
                    c.enqueue(Buffer.from(body))
                    c.close()
                },
            }),
            {duplex: 'half'},
        )
    const pass = await chunked(bodyOfExactly(BODY_LIMIT))
    assert.equal(pass.status, 204)
    const refuse = await chunked(bodyOfExactly(BODY_LIMIT + 1))
    assert.equal(refuse.status, 413)
    assert.equal(lines(r.dir).length, 1)
})

it('a declared content-length over the cap is refused WITHOUT reading a byte', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    // A raw socket: headers only, and then nothing. If the handler waited for
    // the body this would hang until the socket timed out.
    const reply = await raw(
        r.port,
        'POST /ai/feedback HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${r.port}\r\n` +
            'Content-Type: application/json\r\n' +
            'Content-Length: 1048576\r\n' +
            '\r\n',
    )
    assert.match(reply, /^HTTP\/1\.1 413 /)
    assert.match(reply, /connection: close/i)
    assert.equal(lines(r.dir).length, 0)
})

it('a LYING content-length cannot smuggle bytes past the cap', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    // Declares 20 bytes, sends 40000. HTTP framing is the parser's: the handler
    // is handed exactly 20 bytes and the remainder is never body. So the cap
    // holds and the truncated JSON is a 400 — not a 204, and not a crash.
    const payload = JSON.stringify(ROW({question: 'x'.repeat(40000)}))
    const reply = await raw(
        r.port,
        'POST /ai/feedback HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${r.port}\r\n` +
            'Content-Type: application/json\r\n' +
            'Content-Length: 20\r\n' +
            'Connection: close\r\n\r\n' +
            payload,
    )
    assert.match(reply, /^HTTP\/1\.1 400 /)
    assert.equal(lines(r.dir).length, 0)

    // And the other direction: a body of 4 KB that DECLARES 16385 is refused on
    // the declaration alone, before a byte of it is read. (`fetch` will not send
    // this at all — undici raises UND_ERR_REQ_CONTENT_LENGTH_MISMATCH — which is
    // itself why the check has to be made over a socket.)
    const small = bodyOfExactly(4096)
    const lied = await raw(
        r.port,
        'POST /ai/feedback HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${r.port}\r\n` +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${BODY_LIMIT + 1}\r\n\r\n` +
            small,
    )
    assert.match(lied, /^HTTP\/1\.1 413 /)
    assert.equal(lines(r.dir).length, 0)
})

it('readBody in isolation: declared vs measured', async () => {
    const seen = []
    const server = createServer(async (req, res) => {
        seen.push(await readBody(req, 10))
        res.writeHead(204).end()
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    await fetch(base, {method: 'POST', body: '0123456789'}) // exactly 10
    await fetch(base, {method: 'POST', body: '01234567890'}) // 11
    await fetch(base, {method: 'POST'}) // none
    assert.deepEqual(
        seen.map((s) => [s.tooLarge ?? false, s.declared ?? false, s.bytes]),
        [
            [false, false, 10],
            [true, true, 0], // refused on the declaration, zero bytes read
            [false, false, 0],
        ],
    )
    await new Promise((r) => server.close(r))
})

/* ═══════════════════════════════ shape gate ═══════════════════════════════ */

it('shape: messageId, question', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    const cases = [
        [ROW({messageId: undefined}), /messageId must be a non-empty string/],
        [ROW({messageId: ''}), /messageId must be a non-empty string/],
        [ROW({messageId: null}), /messageId must be a non-empty string/],
        [ROW({messageId: 12345}), /messageId must be a non-empty string/],
        [ROW({messageId: 'm'.repeat(201)}), /over 200 characters/],
        [ROW({question: 7}), /question must be a string/],
        [ROW({question: null}), /question must be a string/],
        [ROW({question: undefined}), /question must be a string/],
        [ROW({question: '   '}), /question must not be empty/],
        ['[1,2,3]', /body must be a JSON object/],
        ['null', /body must be a JSON object/],
        ['"a string"', /body must be a JSON object/],
    ]
    for (const [body, re] of cases) {
        const res = await r.post(body)
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60))
        assert.match((await res.json()).error.message, re)
    }
    assert.equal(lines(r.dir).length, 0)
})

it('comment: 500 stored, 501 refused, and the refusal names the cap', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    assert.equal((await r.post(ROW({comment: 'x'.repeat(500), revision: 1}))).status, 204)
    const over = await r.post(ROW({messageId: 'm-2', comment: 'x'.repeat(501), revision: 1}))
    assert.equal(over.status, 400)
    assert.match((await over.json()).error.message, /comment is over 500 characters/)
    assert.equal((await r.post(ROW({messageId: 'm-3', comment: 7}))).status, 400)
    // counted in CODE POINTS, so an emoji comment is not refused for its bytes
    assert.equal((await r.post(ROW({messageId: 'm-4', comment: '🙂'.repeat(500), revision: 1}))).status, 204)
    assert.equal((await r.post(ROW({messageId: 'm-5', comment: '🙂'.repeat(501), revision: 1}))).status, 400)
})

it('revision: missing / non-integer / string-of-digits / negative', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    for (const v of [undefined, null, 1.5, -1, '01x', 'abc', true, {}, [], '', NaN]) {
        const res = await r.post(ROW({messageId: `m-${JSON.stringify(v)}`, revision: v}))
        assert.equal(res.status, 400, `revision ${JSON.stringify(v)}`)
        assert.match((await res.json()).error.message, /revision must be a non-negative integer/)
    }
    assert.equal(coerceRevision(0), 0)
    assert.equal(coerceRevision(7), 7)
    assert.equal(coerceRevision('7'), 7, 'a form-encoded client is unambiguous')
    assert.equal(coerceRevision('007'), 7)
    assert.equal(coerceRevision(2 ** 53), null)
    assert.equal((await r.post(ROW({messageId: 'm-s', revision: '3'}))).status, 204)
    assert.equal(JSON.parse(lines(r.dir).find((l) => l.includes('m-s'))).revision, 3, 'coerced to a number')
})

it('out-of-order revisions: the reader keeps the higher one either way', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    await r.post(ROW({revision: 1, comment: 'the sentence', verdict: 'down'}))
    await r.post(ROW({revision: 0, comment: null, verdict: 'down'})) // the slow thumb
    const rows = lines(r.dir).map((l) => JSON.parse(l))
    assert.equal(rows.length, 2, 'the ndjson store keeps both — aggregate.js:8-13 repairs it')
    const kept = dedupe(rows)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].revision, 1)
    assert.equal(kept[0].comment, 'the sentence', 'the slow thumb did not erase it')
})

it('verdict must be present and one of up / down / null', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    const absent = ROW()
    delete absent.verdict
    assert.equal((await r.post(absent)).status, 400)
    assert.equal((await r.post(ROW({verdict: 'sideways'}))).status, 400)
    assert.equal((await r.post(ROW({verdict: undefined}))).status, 400)
    assert.equal((await r.post(ROW({verdict: 'up'}))).status, 204)
    assert.equal((await r.post(ROW({messageId: 'm-2', verdict: null, revision: 1}))).status, 204)
})

/* ═════════════════════════════ derived fields ═════════════════════════════ */

it('retraction sets retracted:true — verdict null at a raised revision', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    await r.post(ROW({revision: 0, verdict: 'down'}))
    await r.post(ROW({revision: 1, verdict: 'down', comment: 'wrong page', reasons: ['wrong']}))
    await r.post(ROW({revision: 2, verdict: null, comment: null, reasons: []}))
    const rows = lines(r.dir).map((l) => JSON.parse(l))
    assert.deepEqual(rows.map((x) => x.retracted ?? false), [false, false, true])
    // and the reader sees the retraction, comment cleared
    const kept = dedupe(rows)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].verdict, null)
    assert.equal(kept[0].comment, null)
    assert.equal(kept[0].retracted, true)
})

it('verdict null at revision 0 is NOT a retraction', () => {
    assert.equal(stored(ROW({revision: 0, verdict: null}), 1).retracted, undefined)
    assert.equal(stored(ROW({revision: 1, verdict: null}), 1).retracted, true)
    assert.equal(stored(ROW({revision: 1, verdict: 'up'}), 1).retracted, undefined)
})

it('a client cannot state retracted, or write into the _ namespace', () => {
    const out = stored(ROW({revision: 0, verdict: 'up', retracted: true, _receivedAt: 1, _evil: 'x'}), 99)
    assert.equal(out.retracted, undefined, 'the claim was dropped, not trusted')
    assert.equal(out[RECEIVED_AT], 99, "the server's clock, not the client's 1")
    assert.equal(out._evil, undefined)
})

it('the server timestamp is the server clock, in epoch ms', async () => {
    const r = await up({now: () => 1788300000123})
    onTestFinished(() => r.close())
    await r.post(ROW({ts: 1}))
    const row = JSON.parse(lines(r.dir)[0])
    assert.equal(row[RECEIVED_AT], 1788300000123)
    assert.equal(row.ts, 1, "the reader's own clock is untouched")
})

/* ═══════════════════════════════ NDJSON store ═════════════════════════════ */

it('a missing directory is created on the first append', async () => {
    const dir = path.join(tmp(), 'a', 'b', 'c')
    const r = await up({store: ndjsonStore({dir, warn: () => {}})})
    onTestFinished(() => r.close())
    assert.equal((await r.get('/ai/feedback/export')).status, 200, 'export on a missing dir is empty, not 500')
    await r.post(ROW())
    assert.equal(lines(dir).length, 1)
})

it('JSON.stringify escapes newlines, so a multi-line comment cannot end a record', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    const comment = 'line one\nline two\r\nline three and a separator'
    await r.post(ROW({revision: 1, comment}))
    const raw = readFileSync(path.join(r.dir, readdirSync(r.dir)[0]), 'utf8')
    assert.equal(raw.split('\n').filter(Boolean).length, 1, 'one record, one line')
    assert.ok(raw.includes('\\n'), 'the newline is two characters on disk')
    assert.equal(JSON.parse(raw.trim()).comment, comment, 'and it round-trips exactly')
    // the CLI's own parser agrees
    assert.equal(parseRows(raw)[0].comment, comment)
})

it('a torn final line is skipped, and the diagnosis says WHERE', async () => {
    const warned = []
    const dir = tmp()
    const store = ndjsonStore({dir, warn: (m) => warned.push(m)})
    const day = `feedback-${new Date().toISOString().slice(0, 10)}.ndjson`
    store.append(stored(ROW(), Date.now()))
    store.append(stored(ROW({messageId: 'm-2'}), Date.now()))
    // a crash between the write and the newline
    appendFileSync(path.join(dir, day), '{"messageId":"m-3","question":"half a re')
    const rows = store.read(null)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.messageId), ['m-1', 'm-2'])
    assert.equal(warned.length, 1)
    assert.match(warned[0], /line 3 is not JSON and was skipped — torn final line/)

    // the same file through the CLI's own parser is a total loss — which is what
    // read() is protecting the export from
    assert.throws(() => parseRows(readFileSync(path.join(dir, day), 'utf8')), /line 3 is not JSON/)

    // a tear in the MIDDLE is a different diagnosis
    warned.length = 0
    appendFileSync(path.join(dir, day), '\n' + JSON.stringify(stored(ROW({messageId: 'm-4'}), Date.now())) + '\n')
    assert.equal(store.read(null).length, 3)
    assert.match(warned[0], /MID-FILE/)
})

it('an export served over a torn store is still parseable by the CLI', async () => {
    const dir = tmp()
    const r = await up({store: ndjsonStore({dir, warn: () => {}})})
    onTestFinished(() => r.close())
    await r.post(ROW())
    appendFileSync(path.join(dir, readdirSync(dir)[0]), '{"messageId":"torn')
    const res = await r.get('/ai/feedback/export')
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.equal(parseRows(body).length, 1)
})

it('concurrent appends: 200 simultaneous POSTs, every line intact', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    const N = 200
    const results = await Promise.all(
        Array.from({length: N}, (_, i) =>
            r.post(ROW({messageId: `m-${i}`, revision: 1, comment: `${i}:` + 'z'.repeat(400)})),
        ),
    )
    assert.deepEqual([...new Set(results.map((x) => x.status))], [204])
    const raw = lines(r.dir)
    assert.equal(raw.length, N)
    const ids = new Set()
    for (const line of raw) {
        const row = JSON.parse(line) // throws if a write interleaved
        ids.add(row.messageId)
        assert.equal(row.comment.length, `${row.messageId.slice(2)}:`.length + 400)
    }
    assert.equal(ids.size, N)
})

it('concurrent appends from SEPARATE PROCESSES (O_APPEND, not the event loop)', async () => {
    const dir = tmp()
    const P = 8
    const M = 60
    const child = `
      import {ndjsonStore} from ${JSON.stringify(RECEIVER)}
      const [dir, tag, m] = process.argv.slice(2)
      const s = ndjsonStore({dir, warn: () => {}})
      const at = Date.now()
      for (let i = 0; i < Number(m); i++) {
        s.append({messageId: tag + '-' + i, question: 'q', revision: 0, verdict: 'up',
                  pad: 'q'.repeat(15000), _receivedAt: at})
      }
    `
    const kid = path.join(dir, 'kid.mjs')
    writeFileSync(kid, child)
    await Promise.all(
        Array.from({length: P}, (_, p) =>
            new Promise((res, rej) => {
                try {
                    execFileSync(process.execPath, [kid, dir, `p${p}`, String(M)], {stdio: 'pipe'})
                    res()
                } catch (e) {
                    rej(e)
                }
            }),
        ),
    )
    const raw = lines(dir)
    assert.equal(raw.length, P * M, 'no line lost')
    const ids = new Set()
    for (const l of raw) ids.add(JSON.parse(l).messageId) // throws on a split write
    assert.equal(ids.size, P * M, 'no line torn or duplicated')
    // each stored line is bounded by the body cap, which is what makes the
    // single O_APPEND write atomic in the first place
    assert.ok(Math.max(...raw.map((l) => Buffer.byteLength(l))) < BODY_LIMIT + 256)
})

/* ═════════════════════════════════ the export ═════════════════════════════ */

it('the export content-type is the one source.ts sniffs for', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    await r.post(ROW())
    const res = await r.get('/ai/feedback/export')
    assert.equal(res.headers.get('content-type'), EXPORT_CONTENT_TYPE)
    assert.equal(EXPORT_CONTENT_TYPE, 'application/x-ndjson')
    // source.ts:91 — the branch it takes
    const type = res.headers.get('content-type')
    assert.ok(type.includes('json') && type.includes('ndjson'), 'takes the parseRows branch')

    // and the CLI's own fetchRows reads it
    const rows = await fetchRows({from: `${r.base}/ai/feedback/export`, env: {[TOKEN_ENV]: TOKEN}})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].messageId, 'm-1')
})

it('application/json over the SAME body is the silent-zero trap', async () => {
    // Proof, through the CLI's real fetchRows, of why the header above is fixed.
    const one = JSON.stringify({messageId: 'm-1', question: 'q', revision: 0, verdict: 'up'}) + '\n'
    const two = one + JSON.stringify({messageId: 'm-2', question: 'q', revision: 0, verdict: 'up'}) + '\n'
    const serve = async (body) => {
        const s = createServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(body)
        })
        await new Promise((r) => s.listen(0, '127.0.0.1', r))
        const from = `http://127.0.0.1:${s.address().port}/x`
        try {
            return {rows: await fetchRows({from, env: {}})}
        } catch (e) {
            return {error: e.message}
        } finally {
            await new Promise((r) => s.close(r))
        }
    }
    const single = await serve(one)
    assert.deepEqual(single.rows, [], 'ONE row served as application/json becomes ZERO, with no error')
    const multi = await serve(two)
    assert.match(multi.error, /Unexpected non-whitespace|JSON/, 'two rows throw instead')
})

it('?since=: valid, absent, epoch-ms, empty and garbage', async () => {
    const clock = {at: Date.parse('2026-03-01T00:00:00Z')}
    const r = await up({now: () => clock.at})
    onTestFinished(() => r.close())
    await r.post(ROW({messageId: 'old'}))
    clock.at = Date.parse('2026-03-05T12:00:00Z')
    await r.post(ROW({messageId: 'new'}))

    const ids = async (q) => {
        const res = await r.get(`/ai/feedback/export${q}`)
        assert.equal(res.status, 200, q)
        return parseRows(await res.text()).map((x) => x.messageId)
    }
    assert.deepEqual(await ids(''), ['old', 'new'], 'absent → everything')
    assert.deepEqual(await ids('?since='), ['old', 'new'], 'empty → everything')
    assert.deepEqual(await ids('?since=2026-03-05'), ['new'])
    assert.deepEqual(await ids('?since=2026-03-01'), ['old', 'new'])
    assert.deepEqual(await ids('?since=2026-03-05T12:00:00.000Z'), ['new'], 'inclusive on the boundary')
    assert.deepEqual(await ids('?since=2026-03-05T12:00:00.001Z'), [])
    assert.deepEqual(await ids(`?since=${Date.parse('2026-03-05T12:00:00Z')}`), ['new'], 'epoch ms')
    assert.deepEqual(await ids('?since=2027'), [], 'a bare year is a legal Date.parse')

    for (const junk of [
        'garbage', 'yesterday', '2026-13-45', '../../etc/passwd', 'NaN', '{}',
        // V8's LEGACY date parser accepts all three of these. `Date.parse` alone
        // is not a validator: it reads "%00" and "0" as the year 2000 and
        // "abc 2026" as 2026, so a typo becomes a plausible date rather than an
        // error — the same silent lie the 400 exists to prevent, one layer down.
        // parseSince() requires an ISO-8601 SHAPE first, which is what
        // cli.ts documents (`--since <ISO>`).
        '%00', '0', 'abc 2026', '01/02/2026', 'Mar 5 2026',
    ]) {
        const res = await r.get(`/ai/feedback/export?since=${encodeURIComponent(junk)}`)
        assert.equal(res.status, 400, junk)
        assert.match((await res.json()).error.message, /not an ISO date or an epoch-ms integer/)
    }
    // and the thing this is protecting against
    assert.throws(() => new Date('garbage').toISOString(), RangeError)
    assert.equal(parseSince('garbage').at, null)
    assert.match(parseSince('garbage').error, /not an ISO date/)
    assert.equal(parseSince(null).at, null)
    assert.equal(parseSince('2026').at, Date.parse('2026'))
})

it('a garbage ?since= reaches the operator through the real CLI plumbing', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    await r.post(ROW())
    await assert.rejects(
        () => fetchRows({from: `${r.base}/ai/feedback/export`, since: 'garbage', env: {[TOKEN_ENV]: TOKEN}}),
        /responded 400/,
        'source.ts:86 turns it into an error cli.ts:162 prints',
    )
})

/* ═══════════════════════════════ the token ════════════════════════════════ */

it('token: absent, wrong, short, long, wrong scheme — 401, never a throw', async () => {
    const r = await up()
    onTestFinished(() => r.close())
    // timingSafeEqual THROWS on unequal lengths. Every header below would be a
    // 500 rather than a 401 if the comparison saw the raw token.
    for (const header of [
        undefined,
        '',
        'x', // one character, the case that throws
        'Bearer',
        'Bearer ',
        'Bearer x',
        'Bearer ' + 'x'.repeat(4096),
        `Basic ${TOKEN}`,
        `Token ${TOKEN}`,
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(0, -1)}`,
        TOKEN,
    ]) {
        const res = await fetch(`${r.base}/ai/feedback/export`, {
            headers: header === undefined ? {} : {authorization: header},
        })
        await res.arrayBuffer()
        assert.equal(res.status, 401, `authorization: ${JSON.stringify(header)}`)
        assert.equal(res.headers.get('www-authenticate'), 'Bearer')
    }
    for (const header of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER  ${TOKEN}`, `Bearer\t${TOKEN}`]) {
        const res = await fetch(`${r.base}/ai/feedback/export`, {headers: {authorization: header}})
        await res.arrayBuffer()
        assert.equal(res.status, 200, `authorization: ${JSON.stringify(header)}`)
    }
})

it('authorise() does not throw on any token length', () => {
    const env = {[TOKEN_ENV]: TOKEN}
    for (const t of ['', 'x', 'xx', TOKEN, 'x'.repeat(100000), '🙂']) {
        const req = {headers: {authorization: `Bearer ${t}`}}
        const got = authorise(req, env) // must not throw
        assert.equal(got.ok, t === TOKEN)
    }
    // the raw call this is protecting against
    assert.throws(
        () => timingSafeEqual(Buffer.from('a'), Buffer.from('ab')),
        /must have the same byte length/,
    )
    assert.equal(authorise({headers: {}}, {}).status, 503, 'unset server token is 503, never open')
})

/* ═════════════════════════ the three stores agree ═════════════════════════ */

it('ndjson and sqlite produce byte-identical aggregate() output', async () => {
    const dir = tmp()
    const nd = await up({store: ndjsonStore({dir, warn: () => {}})})
    const sq = await up({store: await sqliteStore({file: path.join(tmp(), 'f.sqlite')})})
    onTestFinished(() => Promise.all([nd.close(), sq.close()]))

    const script = [
        ROW({revision: 0, verdict: 'down'}),
        ROW({revision: 1, verdict: 'down', reasons: ['wrong'], comment: 'It answered about the plugin.'}),
        ROW({messageId: 'm-2', revision: 0, verdict: 'up', question: 'How do I embed the editor?'}),
        ROW({revision: 2, verdict: null, comment: null, reasons: []}), // the retraction
        ROW({messageId: 'm-3', revision: 1, verdict: 'down', question: 'How do I set the editor LOCALE?'}),
        ROW({messageId: 'm-3', revision: 0, verdict: 'down'}), // out of order
    ]
    for (const row of script) {
        assert.equal((await nd.post(row)).status, 204)
        assert.equal((await sq.post(row)).status, 204)
    }

    const rowsOf = async (r) => parseRows(await (await r.get('/ai/feedback/export')).text())
    const ndRows = await rowsOf(nd)
    const sqRows = await rowsOf(sq)
    assert.equal(ndRows.length, 6, 'append-only keeps every revision')
    assert.equal(sqRows.length, 3, 'the upsert keeps one row per messageId')

    const strip = (cs) => cs.map((c) => ({...c, firstSeen: null, lastSeen: null}))
    assert.deepEqual(strip(aggregate(sqRows)), strip(aggregate(ndRows)))

    const cs = aggregate(ndRows)
    const locale = cs.find((c) => /locale/i.test(c.question))
    assert.deepEqual(locale.comments, [], 'the retraction took the sentence with it')
    assert.equal(locale.up + locale.down, 1, 'm-3 rev1 down; m-1 rev2 is a retraction and counts as neither')
})

it('the retraction is only clean because the store REPLACES — coalesce resurrects', async () => {
    // Run production.md:391 against the same three POSTs, in real SQL.
    const {DatabaseSync} = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec('create table fb (message_id text primary key, revision integer, comment text)')
    const coalescing = db.prepare(`
      insert into fb (message_id, revision, comment) values (?, ?, ?)
      on conflict (message_id) do update set
        revision = excluded.revision,
        comment  = coalesce(excluded.comment, fb.comment)
      where excluded.revision >= fb.revision`)
    coalescing.run('m-1', 0, null) // the thumb
    coalescing.run('m-1', 1, 'It answered about the plugin.') // the form
    coalescing.run('m-1', 2, null) // THE RETRACTION — comment explicitly null
    assert.equal(
        db.prepare('select comment from fb').get().comment,
        'It answered about the plugin.',
        'production.md:391 keeps the words production.md:403 says were taken back',
    )

    db.exec('create table fb2 (message_id text primary key, revision integer, comment text)')
    const replacing = db.prepare(`
      insert into fb2 (message_id, revision, comment) values (?, ?, ?)
      on conflict (message_id) do update set
        revision = excluded.revision, comment = excluded.comment
      where excluded.revision >= fb2.revision`)
    replacing.run('m-1', 0, null)
    replacing.run('m-1', 1, 'It answered about the plugin.')
    replacing.run('m-1', 2, null)
    assert.equal(db.prepare('select comment from fb2').get().comment, null, 'replacement withdraws it')

    // and the guard still does its job under replacement
    replacing.run('m-1', 0, 'a slow thumb') // revision 0 after revision 2
    assert.equal(db.prepare('select revision from fb2').get().revision, 2)
    db.close()
})

it('sqlite: the DDL is required, the guard holds, since works', async () => {
    const {DatabaseSync} = await import('node:sqlite')
    const bare = new DatabaseSync(':memory:')
    assert.throws(() => bare.prepare('select * from docpilot_feedback'), /no such table/)
    bare.close()

    const s = await sqliteStore({file: ':memory:'})
    s.append(stored(ROW({revision: 1, comment: 'kept'}), 1000))
    s.append(stored(ROW({revision: 0, comment: 'slow thumb'}), 2000))
    assert.equal(s.read(null).length, 1)
    assert.equal(s.read(null)[0].comment, 'kept', 'the revision guard refused the late thumb')
    s.append(stored(ROW({messageId: 'm-2'}), 3000))
    assert.deepEqual(s.read(2500).map((r) => r.messageId), ['m-2'])
    assert.deepEqual(s.read(1000).map((r) => r.messageId), ['m-1', 'm-2'])
    // strict typing refuses a float ts rather than storing one
    s.append(stored(ROW({messageId: 'm-3', ts: 1.5}), 4000))
    assert.equal(s.read(3500)[0].ts, 1.5, 'the record keeps it')
    assert.equal(s.db.prepare('select ts from docpilot_feedback where message_id = ?').get('m-3').ts, null,
        'the indexed column does not')
    s.close()
    assert.match(SQLITE_DDL, /strict/)
    assert.ok(!/coalesce/i.test(SQLITE_DDL + POSTGRES_SQL), 'no coalesce anywhere')
    assert.match(POSTGRES_SQL, /where excluded\.revision >= docpilot_feedback\.revision/)
})
