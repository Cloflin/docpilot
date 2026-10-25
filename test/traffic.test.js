/**
 * `docpilot traffic` — the turn log read back into a report and golden candidates.
 * Pure modules on fixtures, plus one CLI run against a temp directory.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {parseTurns, joinFeedback, sinceFilter} from '../src/traffic/turns.js'
import {clusterTurns} from '../src/traffic/cluster.js'
import {trafficReport, vocabularyMisses} from '../src/traffic/report.js'
import {trafficCandidates} from '../src/traffic/candidates.js'
import {runTraffic} from '../src/traffic/cli.js'
import {terms, setVocabulary, setTokenizer} from '../src/theme/docpilot/text.js'

let n = 0
const turn = (o = {}) => ({
    kind: 'docpilot.turn',
    v: 1,
    at: '2026-10-20T10:00:00.000Z',
    messageId: `m-${++n}`,
    conversationId: `c-${n}`,
    question: 'How do I install the panel?',
    quote: null,
    lang: 'en',
    scope: {kind: 'all', paths: []},
    depth: 0,
    outcome: 'answer',
    refusal: null,
    gate: {pass: true},
    retrievedIds: ['install/vitepress#', 'install/vue#'],
    emitted: ['install/vitepress#'],
    citations: ['install/vitepress#'],
    answer: 'Run npm install.',
    summary: null,
    confidence: 'high',
    support: 0.9,
    tentative: false,
    iterations: 1,
    requests: 2,
    latencyMs: 1200,
    usage: {promptTokens: 1000, outputTokens: 100, cachedTokens: 400},
    model: 'm',
    provider: 'p',
    embedModel: 'e',
    indexHash: 'aaaa',
    promptHash: 'p1',
    error: null,
    ...o,
})

beforeEach(() => {
    setVocabulary(null)
    setTokenizer(null)
})

describe('parseTurns', () => {
    it('counts malformed rows instead of throwing, and collapses duplicate messageIds', () => {
        const a = turn({messageId: 'dup', question: 'first'})
        const b = turn({messageId: 'dup', question: 'second'})
        const text = [
            JSON.stringify(turn()),
            '{"kind": "docpilot.turn", torn',
            JSON.stringify({...turn(), kind: 'something.else'}),
            JSON.stringify({...turn(), outcome: 'exploded'}),
            JSON.stringify({...turn(), at: 'yesterday'}),
            '',
            JSON.stringify(a),
            JSON.stringify(b),
        ].join('\n')
        const r = parseTurns(text)
        expect(r.turns).toHaveLength(2)
        expect(r.malformed).toHaveLength(4)
        expect(r.malformed[0]).toEqual({line: 2, why: 'not JSON'})
        expect(r.malformed.map((m) => m.why).join(' ')).toMatch(/kind.*outcome.*at/)
        expect(r.duplicates).toBe(1)
        expect(r.total).toBe(7)
        expect(r.turns.find((t) => t.messageId === 'dup').question).toBe('second')
    })

    it('reads a JSON array, and filters by --since', () => {
        const r = parseTurns(JSON.stringify([turn({at: '2026-10-01T00:00:00Z'}), turn({at: '2026-10-21T00:00:00Z'})]))
        expect(r.turns).toHaveLength(2)
        expect(sinceFilter(r.turns, '2026-10-20')).toHaveLength(1)
    })
})

describe('joinFeedback', () => {
    it('joins by messageId, latest revision wins, a retraction stays a retraction', () => {
        const t1 = turn({messageId: 'a'})
        const t2 = turn({messageId: 'b'})
        const t3 = turn({messageId: 'c'})
        const rows = [
            {messageId: 'a', question: 'q', revision: 1, verdict: 'down', reasons: ['wrong'], comment: 'nope'},
            {messageId: 'a', question: 'q', revision: 0, verdict: 'down', reasons: []},
            {messageId: 'b', question: 'q', revision: 0, verdict: 'up'},
            {messageId: 'b', question: 'q', revision: 1, verdict: null},
            {messageId: 'zzz', question: 'q', revision: 0, verdict: 'up'},
        ]
        const j = joinFeedback([t1, t2, t3], rows)
        expect(j.joined).toBe(2)
        expect(j.orphans).toBe(1)
        const [a, b, c] = j.turns
        expect(a.feedback).toEqual({verdict: 'down', reasons: ['wrong'], comment: 'nope', revision: 1})
        expect(b.feedback.verdict).toBeNull()
        expect(c.feedback).toBeUndefined()
    })
})

describe('content gaps', () => {
    it('clusters by term overlap and by a shared rare term, with the closest pages', () => {
        const df = {n: 1000, df: {configure: 50, retry: 40, panel: 300, install: 200}}
        const turns = [
            turn({outcome: 'refused', refusal: 'no-evidence', question: 'How do I configure webhooks?', retrievedIds: ['guide/production#a']}),
            turn({outcome: 'refused', refusal: 'no-evidence', question: 'configure webhooks please', retrievedIds: ['guide/production#b']}),
            turn({outcome: 'not-answerable', question: 'Do webhooks retry on failure?', retrievedIds: ['guide/faq#x']}),
            turn({outcome: 'refused', refusal: 'no-evidence', question: 'What is the pricing of the enterprise plan?', retrievedIds: []}),
        ]
        const cl = clusterTurns(turns, {df})
        expect(cl).toHaveLength(2)
        expect(cl[0].count).toBe(3)
        expect(cl[0].closest[0]).toEqual({page: '/guide/production', count: 2})
        expect(cl[1].count).toBe(1)

        // Without a df nothing is rare, so only Jaccard joins.
        expect(clusterTurns(turns)).toHaveLength(3)
    })
})

describe('vocabulary misses', () => {
    it('names failed-turn terms that no chunk has', () => {
        const [stem] = terms('webhooks')
        const turns = [
            turn({outcome: 'refused', question: 'set up webhooks'}),
            turn({outcome: 'refused', question: 'webhooks for deploys'}),
            turn({outcome: 'answer', question: 'install webhooks'}),
        ]
        const miss = vocabularyMisses(turns, {n: 10, df: {deploy: 2, install: 3}})
        expect(miss.map((m) => m.term)).toContain(stem)
        const row = miss.find((m) => m.term === stem)
        expect(row).toMatchObject({word: 'webhooks', failed: 2, answered: 1})
        expect(vocabularyMisses(turns, {n: 10, df: {[stem]: 1}}).map((m) => m.term)).not.toContain(stem)
        expect(vocabularyMisses(turns, null)).toBeNull()
    })
})

describe('trafficReport', () => {
    it('measures and writes all six RAG sections with a next command', () => {
        const turns = [
            turn({at: '2026-10-19T09:00:00Z'}),
            turn({at: '2026-10-20T09:00:00Z', citations: [], promptHash: 'p2', latencyMs: 3000}),
            turn({at: '2026-10-20T10:00:00Z', outcome: 'refused', refusal: 'no-evidence', question: 'webhooks?', lang: 'ru', citations: []}),
            turn({at: '2026-10-20T11:00:00Z', outcome: 'refused', refusal: 'no-evidence', question: 'webhooks retry', lang: 'ru', citations: []}),
            turn({at: '2026-10-20T12:00:00Z', outcome: 'error', error: 'boom'}),
            turn({at: '2026-10-21T12:00:00Z', feedback: {verdict: 'down', reasons: ['wrong'], comment: null, revision: 1}}),
        ]
        const {stats, markdown} = trafficReport(turns, {
            df: {n: 100, df: {install: 5, panel: 5}},
            pages: [{path: '/install/vitepress', title: 'VitePress'}, {path: '/guide/orphan', title: 'Orphan'}],
            malformed: [{line: 3, why: 'not JSON'}],
            source: 'fixture',
        })
        expect(stats.turns).toBe(6)
        expect(stats.malformed).toBe(1)
        expect(stats.outcomes).toMatchObject({answer: 3, refused: 2, error: 1})
        expect(stats.quality.zeroCitations).toBeCloseTo(1 / 3, 3)
        expect(stats.quality.tokens.cachedShare).toBe(0.4)
        expect(stats.feedback.down).toBe(1)
        expect(stats.neverRetrieved.map((p) => p.page)).toEqual(['/guide/orphan'])
        expect(stats.drift).toHaveLength(2)
        expect(stats.languages.find((l) => l.lang === 'ru').failed).toBe(1)
        for (const h of ['## 1. Content gaps', '## 2. Vocabulary misses', '## 3. Retrieved, rarely cited', '## 4. Never retrieved', '## 5. Language', '## 6. Prompt, index and model drift']) {
            expect(markdown).toContain(h)
        }
        expect(markdown).toContain('npx docpilot vocabulary')
        expect(markdown).toContain('npx docpilot calibrate')
        expect(markdown).toContain('1 malformed row(s) skipped')
    })

    it('flags a page retrieved often and cited rarely', () => {
        const turns = [1, 2, 3, 4].map(() => turn({retrievedIds: ['a/b#x', 'c/d#y'], citations: ['c/d#y']}))
        const {stats} = trafficReport(turns)
        expect(stats.uncited.map((u) => u.page)).toEqual(['/a/b'])
    })
})

describe('trafficCandidates', () => {
    it('excludes golden duplicates, dedupes, caps each cluster, writes no gold_answer', () => {
        const golden = [{id: 'q-01', question: 'How do I configure webhooks?', expect: 'answer'}]
        const turns = [
            // golden duplicate, by normalised text
            turn({outcome: 'refused', refusal: 'no-evidence', question: 'how do I configure webhooks'}),
            // one cluster of six paraphrases about rotating keys
            ...['rotate api keys', 'rotate api keys now', 'how rotate api keys', 'rotate the api keys', 'api keys rotate when', 'rotate api keys daily'].map((q) =>
                turn({outcome: 'not-answerable', question: q, retrievedIds: ['guide/credentials#x']}),
            ),
            // a repeat of one of them
            turn({outcome: 'not-answerable', question: 'Rotate API keys?', retrievedIds: ['guide/credentials#x']}),
            // an up-voted answer in the same cluster supplies gold_chunks
            turn({question: 'rotate api keys safely', citations: ['guide/credentials#rotate'], feedback: {verdict: 'up', reasons: [], comment: null, revision: 0}}),
            // a different gap, refused with nothing retrieved
            turn({outcome: 'refused', refusal: 'no-evidence', question: 'enterprise pricing tiers', retrievedIds: []}),
            // no signal at all
            turn({question: 'install vitepress'}),
            turn({outcome: 'social', question: 'hello'}),
        ]
        const {candidates, counts} = trafficCandidates(turns, {golden, perCluster: 3})
        expect(counts.inGolden).toBe(1)
        expect(counts.duplicate).toBe(1)
        expect(counts.noSignal).toBe(2)
        expect(counts.capped).toBe(4)
        expect(candidates).toHaveLength(4)
        for (const c of candidates) {
            expect(c.needsReview).toBe(true)
            expect(c.source).toBe('traffic')
            expect(c.messageId).toMatch(/^m-/)
            expect(c).not.toHaveProperty('gold_answer')
            expect(c.question).not.toMatch(/configure webhooks/)
        }
        const rot = candidates.filter((c) => /rotat/.test(c.question))
        expect(rot).toHaveLength(3)
        const na = rot.find((c) => c.why === 'not-answerable')
        expect(na.expect).toBe('answer')
        expect(na.gold_chunks).toEqual(['guide/credentials#rotate'])
        const pricing = candidates.find((c) => /pricing/.test(c.question))
        expect(pricing.expect).toBe('refuse:no-evidence')
        expect(pricing.expectOptions).toContain('answer')
        expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length)

        // --limit, round-robin: the second cluster still gets in.
        const limited = trafficCandidates(turns, {golden, perCluster: 3, limit: 2})
        expect(limited.candidates).toHaveLength(2)
        expect(new Set(limited.candidates.map((c) => c.cluster)).size).toBe(2)
        expect(limited.counts.limited).toBe(2)

        // A re-run does not re-propose what the file already has.
        const again = trafficCandidates(turns, {golden, existing: candidates})
        expect(again.candidates.every((c) => !candidates.some((p) => p.question === c.question))).toBe(true)
        expect(again.candidates.every((c) => Number(c.id.slice(3)) > 4)).toBe(true)
    })
})

describe('runTraffic', () => {
    let dir
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'dp-traffic-'))
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    })
    afterEach(() => {
        vi.restoreAllMocks()
        rmSync(dir, {recursive: true, force: true})
    })

    it('reads the day files, writes candidates beside golden, never into it', async () => {
        const evalDir = path.join(dir, 'docpilot')
        mkdirSync(path.join(evalDir, 'turns'), {recursive: true})
        const golden = JSON.stringify({id: 'q-01', question: 'What is the gate?', expect: 'answer'}) + '\n'
        writeFileSync(path.join(evalDir, 'golden.jsonl'), golden)
        writeFileSync(
            path.join(evalDir, 'turns', 'turns-2026-10-20.jsonl'),
            [JSON.stringify(turn({outcome: 'refused', question: 'webhooks?'})), 'torn{', JSON.stringify(turn({outcome: 'refused', question: 'what is the gate'}))].join('\n'),
        )
        writeFileSync(path.join(evalDir, 'turns', 'turns-2026-10-01.jsonl'), JSON.stringify(turn({outcome: 'refused', question: 'old one'})))
        const docPilot = {evalDir, docsDir: path.join(dir, 'docs')}

        expect(await runTraffic({docPilot, argv: ['candidates', '--since=2026-10-10']})).toBe(0)
        const rows = readFileSync(path.join(evalDir, 'traffic-candidates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        expect(rows.map((r) => r.question)).toEqual(['webhooks?'])
        expect(readFileSync(path.join(evalDir, 'golden.jsonl'), 'utf8')).toBe(golden)

        expect(await runTraffic({docPilot, argv: ['report', `--out=${path.join(dir, 'r.md')}`]})).toBe(0)
        expect(readFileSync(path.join(dir, 'r.md'), 'utf8')).toMatch(/1 malformed row/)

        expect(await runTraffic({docPilot, argv: ['report', '--limit=x']})).toBe(2)
        expect(await runTraffic({docPilot, argv: ['report', '--bogus']})).toBe(2)
        expect(await runTraffic({docPilot, argv: ['candidates', `--out=${path.join(evalDir, 'golden.jsonl')}`]})).toBe(2)
        expect(await runTraffic({docPilot, argv: ['report', '--from', path.join(dir, 'nope')]})).toBe(1)
        expect(existsSync(path.join(evalDir, 'calibration.jsonl'))).toBe(false)
    })
})
