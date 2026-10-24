#!/usr/bin/env node
/**
 * WHY THIS SCRIPT EXISTS — engine-spec 026's five-arm A/B on how the transcript
 * carries past answers.
 *
 * `npx docpilot eval` scores ONE turn per record and re-asks every priming turn
 * for every record, so a five-turn chain written as five records costs fifteen
 * turns, and the four it does not score are thrown away. This walks each chain
 * of `docpilot/chains.jsonl` once, as one conversation, and scores EVERY turn:
 * five turns for five measurements, which on a 1000-a-day free allowance is the
 * difference between one day and three.
 *
 * THE TURN IS EVAL'S OWN. `runTurn`, `createRetrieval`, `chainAntecedent`,
 * `composeQuery` and the metrics are this package's, called the way
 * `src/eval/run.ts` calls them: temperature 0.2, seed 20260829, the
 * gate's composed channel deciding which vector the harness re-searches with.
 * Only the history arm differs between runs, through `DOCPILOT_HISTORY_MODE`,
 * and every arm sets `DOCPILOT_ANSWER_SUMMARY=1` so the answers are written under
 * one instruction.
 *
 *   node scripts/chain-bench.mjs --rag=<index dir> --chat=<model> --embed=<model> \
 *     --out=<dir> [--runs=5] [--arms=a,b] [--daily-cap=800] [--limit=N] \
 *     [--embed-provider=ollama --embed-base-url=http://localhost:11434]
 *
 * Resumable: one JSONL per (arm, run) under --out, one line per finished chain;
 * a rerun skips what is there. Requests are counted per UTC day in
 * `<out>/ledger.json`, and the run stops cleanly at --daily-cap.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const argOf = (name, dflt = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const RAG = path.resolve(argOf('rag', 'docs/public/rag'))
const CHAT = argOf('chat')
const EMBED = argOf('embed')
// `ollama` embeds on this machine — free, and the one free embedder a ZDR
// account can reach (every `:free` embedding endpoint on OpenRouter retains data).
const EMBED_PROVIDER = argOf('embed-provider', 'openrouter')
const EMBED_URL = argOf('embed-base-url', EMBED_PROVIDER === 'ollama' ? 'http://localhost:11434' : null)
const OUT = path.resolve(argOf('out', 'docpilot/bench/chains'))
const RUNS = Number(argOf('runs', '5'))
// One run per process, so five can go in parallel against a paid endpoint.
const ONLY_RUN = Number(argOf('only-run', '0')) || 0
const ARMS = (argOf('arms') || 'skeleton,last-full,summary-all+last,summary-each+last,summary-only').split(',')
const DAILY_CAP = Number(argOf('daily-cap', '800'))
const LIMIT = Number(argOf('limit', '0')) || 0
const CHAINS = path.resolve(argOf('chains', 'docpilot/chains.jsonl'))
if (!CHAT || !EMBED) {
  console.error('[chain-bench] --chat and --embed are required')
  process.exit(2)
}

/** The launcher's preamble, in order — see dump-rankings.mjs for why the order matters. */
const D = (p) => import(pathToFileURL(path.resolve('dist', p)).href)
const { applyFileEnv } = await D('cli-env.js')
await applyFileEnv()
const { resolveDocPilot, nodeChatTarget, nodeEmbedTarget } = await D('config.js')
const { findConfig } = await D('cli-init.js')
const mod = await import(pathToFileURL(path.resolve(findConfig())).href)
const authored = {
  ...mod.docPilot,
  chat: { provider: 'openrouter', model: CHAT },
  embed: { provider: EMBED_PROVIDER, model: EMBED, ...(EMBED_URL ? { baseURL: EMBED_URL } : {}) },
}
const docPilot = resolveDocPilot(authored, process.env)
globalThis.__DOCPILOT_SETTINGS__ = docPilot

const { assembleIndex } = await D('theme/docpilot/store.js')
const { createRetrieval } = await D('theme/docpilot/retriever.js')
const { composeQuery, chainAntecedent } = await D('theme/docpilot/gate.js')
const { runTurn } = await D('theme/docpilot/harness.js')
const { splitSummary } = await D('theme/docpilot/prompt.js')
const { prefetchEmbeddings } = await D('eval/prefetch.js')
const { openEmbedCache } = await D('build/lib/embed-cache.js')
const M = await D('eval/metrics.js')

const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
const vb = fs.readFileSync(path.join(RAG, manifest.vectors))
const index = assembleIndex({
  manifest,
  shards: manifest.shards.map((s) => JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8'))),
  vectorBuffer: vb.buffer.slice(vb.byteOffset, vb.byteOffset + vb.byteLength),
  dfDoc: JSON.parse(fs.readFileSync(path.join(RAG, manifest.df), 'utf8')),
})
if (manifest.embedModel !== EMBED) {
  console.error(`[chain-bench] ${RAG} was built with ${manifest.embedModel}, not ${EMBED}`)
  process.exit(2)
}
const ALL = { kind: 'all', paths: [], label: 'All docs' }
const retrieval = createRetrieval({ index, scope: ALL, guard: manifest.guard, tuning: manifest.tuning })

let chains = fs
  .readFileSync(CHAINS, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
if (LIMIT) chains = chains.slice(0, LIMIT)
fs.mkdirSync(OUT, { recursive: true })

// ── the day's request ledger ────────────────────────────────────────────────
const LEDGER = path.join(OUT, ONLY_RUN ? `ledger.run${ONLY_RUN}.json` : 'ledger.json')
const today = () => new Date().toISOString().slice(0, 10)
const ledger = (() => {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
  } catch {
    return {}
  }
})()
const spend = (n) => {
  ledger[today()] = (ledger[today()] || 0) + n
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1))
}
const spentToday = () => ledger[today()] || 0

// ── vectors: every text any arm can embed, bought once ──────────────────────
const embedTarget = nodeEmbedTarget(docPilot, process.env)
const cache = openEmbedCache({
  dir: path.join(OUT, 'embed-cache'),
  model: EMBED,
  provider: embedTarget.provider,
  baseURL: embedTarget.baseURL,
  prefix: 'chain-bench-query',
  warn: (m) => console.warn(`[chain-bench] ${m}`),
})
const wanted = new Set()
for (const c of chains) {
  const qs = c.turns.map((t) => t.question)
  qs.forEach((q, i) => {
    wanted.add(q)
    if (i > 0) {
      wanted.add(composeQuery(q, qs[i - 1]))
      if (i > 1) wanted.add(composeQuery(q, `${qs[i - 2]}\n${qs[i - 1]}`))
    }
  })
}
const VEC = new Map()
const missing = []
for (const t of wanted) {
  if (!t) continue
  const unit = cache.get(t)
  if (unit) VEC.set(t, Float64Array.from(unit, (v) => v * 127))
  else missing.push(t)
}
if (missing.length) {
  const got = await prefetchEmbeddings(missing, { ...embedTarget, model: EMBED })
  spend(got.requests)
  for (const [t, v] of got.vectors) {
    VEC.set(t, v)
    cache.set(t, Float32Array.from(v, (x) => x / 127))
  }
  cache.commit([...wanted].filter(Boolean))
  console.log(`[chain-bench] ${missing.length} query texts embedded in ${got.requests} request(s)`)
}
const vecOf = (t) => (t ? VEC.get(t) ?? null : null)

// ── one turn, as eval runs it ───────────────────────────────────────────────
const chatTarget = nodeChatTarget(docPilot, process.env)
const llm = {
  provider: chatTarget.provider,
  baseURL: chatTarget.baseURL,
  model: CHAT,
  apiKey: chatTarget.apiKey,
  temperature: 0.2,
  tuning: { seed: 20260829 },
  stepTimeoutMs: 180000,
  extraBody: chatTarget.extraBody ?? undefined,
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CapReached extends Error {}

async function playChain(chain) {
  const history = []
  const priors = []
  const turns = []
  for (const [i, t] of chain.turns.entries()) {
    if (spentToday() >= DAILY_CAP) throw new CapReached()
    const ante = chainAntecedent(priors).text
    const composedQuery = ante ? composeQuery(t.question, ante) : null
    const vec = vecOf(t.question)
    const composedVec = composedQuery ? vecOf(composedQuery) : undefined
    const g = retrieval.evaluate({ question: t.question, previousQuestion: ante, queryVec: vec, composedVec, mode: 'hybrid' })
    const won = g.channel === 'composed' && composedVec
    let res = null
    let lastErr = null
    // A `:free` upstream answers 429 when its shared pool is saturated — routinely,
    // not exceptionally — so the turn waits it out rather than failing the chain.
    for (let attempt = 1; attempt <= 8 && !res; attempt++) {
      try {
        res = await runTurn({
          retrieval,
          gateResult: g,
          question: t.question,
          history,
          addendum: '',
          config: {
            llm,
            maxIterations: 2,
            guard: manifest.guard,
            scope: { promptListLimit: 12 },
            prompt: docPilot.prompt,
            product: docPilot.product,
          },
          fallback: false,
          queryVec: won ? composedVec : vec,
          composedQuery: won ? composedQuery : null,
        })
      } catch (e) {
        lastErr = e
        spend(1)
        // 429s and saturated free upstreams: back off, then try the turn again.
        await sleep(Math.min(20000 * attempt, 120000))
      }
    }
    if (!res) throw new Error(`turn ${i + 1}: ${lastErr?.message || lastErr}`)
    spend(res.requests || 1)

    // The schema field first; a `<summary>` line in the text is the fallback shape.
    const split = splitSummary(res.text || '')
    const answer = split.answer
    const summary = res.summary || split.summary
    const cited = res.citations || []
    const page = (id) => M.pageOf(id).replace(/^\//, '')
    const row = {
      turn: i + 1,
      kind: t.kind,
      channel: g.channel,
      requests: res.requests,
      answerF1: M.tokenF1(answer, t.gold_answer),
      mustContain: t.must_contain?.length
        ? t.must_contain.filter((x) => answer.toLowerCase().includes(x.toLowerCase())).length / t.must_contain.length
        : null,
      mustKeep: t.must_keep?.length
        ? t.must_keep.filter((x) => answer.toLowerCase().includes(x.toLowerCase())).length / t.must_keep.length
        : null,
      citationRecall: M.citationRecall(cited, t.gold_chunks ?? []),
      citationPrecision: M.citationPrecision(cited, t.gold_chunks ?? []),
      leak: t.forbidden_pages?.length
        ? cited.filter((id) => t.forbidden_pages.map((p) => p.replace(/^\//, '')).includes(page(id))).length /
          Math.max(1, cited.length)
        : null,
      language: M.languageMatch(t.question, answer),
      summarised: summary !== null,
      chars: answer.length,
      cited,
      answer,
      summary,
    }
    turns.push(row)
    if (answer.trim()) history.push({ question: t.question, answer, summary, citations: cited })
    priors.push({ question: t.question, composed: g.channel === 'composed' })
  }
  return turns
}

// ── the schedule: runs outer, arms shuffled per run ─────────────────────────
const fileOf = (arm, run) => path.join(OUT, `${arm}.run${run}.jsonl`)
const doneIn = (file) => {
  try {
    return new Set(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).id),
    )
  } catch {
    return new Set()
  }
}
const shuffled = (xs, seed) => {
  const a = [...xs]
  let s = seed
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

process.env.DOCPILOT_ANSWER_SUMMARY = '1'
try {
  for (let run = ONLY_RUN || 1; run <= (ONLY_RUN || RUNS); run++) {
    for (const arm of shuffled(ARMS, run)) {
      const file = fileOf(arm, run)
      const done = doneIn(file)
      process.env.DOCPILOT_HISTORY_MODE = arm
      for (const chain of chains) {
        if (done.has(chain.id)) continue
        const t0 = Date.now()
        const turns = await playChain(chain)
        fs.appendFileSync(file, JSON.stringify({ id: chain.id, lang: chain.lang, arm, run, chat: CHAT, embed: EMBED, index: manifest.hash, ranAt: new Date().toISOString(), ms: Date.now() - t0, turns }) + '\n')
        console.log(`[chain-bench] run ${run} ${arm.padEnd(18)} ${chain.id}  F1 ${turns.map((t) => t.answerF1.toFixed(2)).join(' ')}  · today ${spentToday()}/${DAILY_CAP}`)
      }
    }
  }
  console.log('[chain-bench] all runs complete')
} catch (e) {
  if (e instanceof CapReached) {
    console.log(`[chain-bench] daily cap ${DAILY_CAP} reached — rerun after 00:00 UTC to resume`)
    process.exit(75)
  }
  throw e
}
