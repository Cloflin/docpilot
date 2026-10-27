import {describe, it, expect, beforeAll, afterAll, vi} from 'vitest'
import fs, {mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {readSafetensorsHeader, readGgufHeader} from '../src/model/headers.js'
import {fingerprint, verify, checksumLines} from '../src/model/fingerprint.js'
import {mcnemarExact, mcnemarMinFlips, pairedBootstrap} from '../src/model/stats.js'
import {compareReports, renderCompare, isOk} from '../src/model/compare.js'
import {ngramContamination, normalizeTokens, extractTrainTexts} from '../src/model/contamination.js'
import {runModel, parseModelArgs} from '../src/model/cli.js'

let dir
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'docpilot-model-'))
})
afterAll(() => rmSync(dir, {recursive: true, force: true}))

function safetensors(file, header, dataBytes = 0) {
  const json = Buffer.from(JSON.stringify(header))
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(json.length))
  writeFileSync(file, Buffer.concat([len, json, Buffer.alloc(dataBytes)]))
}

/** A minimal GGUF v3 writer: enough types to exercise the reader. */
function gguf(file, {kvs, tensors}) {
  const parts = []
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b) }
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b) }
  const str = (s) => { const b = Buffer.from(s, 'utf8'); u64(b.length); parts.push(b) }
  const value = (type, v) => {
    if (type === 4) u32(v)
    else if (type === 6) { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b) }
    else if (type === 7) parts.push(Buffer.from([v ? 1 : 0]))
    else if (type === 8) str(v)
    else if (type === 10) u64(v)
    else if (type === 9) {
      u32(v.elemType)
      u64(v.values.length)
      for (const x of v.values) value(v.elemType, x)
    } else throw new Error('test writer: type ' + type)
  }
  parts.push(Buffer.from('GGUF'))
  u32(3)
  u64(tensors.length)
  u64(kvs.length)
  for (const [k, type, v] of kvs) {
    str(k)
    u32(type)
    value(type, v)
  }
  for (const t of tensors) {
    str(t.name)
    u32(t.dims.length)
    for (const d of t.dims) u64(d)
    u32(t.type)
    u64(0)
  }
  writeFileSync(file, Buffer.concat(parts))
}

describe('headers', () => {
  it('reads a safetensors header without the tensors', async () => {
    const f = path.join(dir, 'tiny.safetensors')
    safetensors(
      f,
      {
        __metadata__: {format: 'pt', name: 'tiny'},
        'a.weight': {dtype: 'F16', shape: [4, 8], data_offsets: [0, 64]},
        'b.weight': {dtype: 'F16', shape: [8], data_offsets: [64, 80]},
        'c.bias': {dtype: 'F32', shape: [2, 3], data_offsets: [80, 104]},
      },
      104,
    )
    const h = await readSafetensorsHeader(f)
    expect(h.tensorCount).toBe(3)
    expect(h.parameters).toBe(32 + 8 + 6)
    expect(h.dtypes).toEqual({F16: 2, F32: 1})
    expect(h.metadata).toEqual({format: 'pt', name: 'tiny'})
  })

  it('refuses a safetensors header length over 100 MB', async () => {
    const f = path.join(dir, 'huge.safetensors')
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(200n * 1024n * 1024n)
    writeFileSync(f, Buffer.concat([len, Buffer.from('{}')]))
    await expect(readSafetensorsHeader(f)).rejects.toThrow(/refused/)
  })

  it('reads a GGUF v3 header, keeps short arrays, summarises long ones', async () => {
    const f = path.join(dir, 'tiny.gguf')
    const vocab = Array.from({length: 1000}, (_, i) => `tok${i}`)
    gguf(f, {
      kvs: [
        ['general.architecture', 8, 'llama'],
        ['general.name', 8, 'Tiny Llama'],
        ['general.file_type', 4, 15],
        ['general.quantization_version', 4, 2],
        ['llama.context_length', 4, 4096],
        ['llama.rope.freq_base', 6, 10000],
        ['tokenizer.ggml.add_bos_token', 7, true],
        ['tokenizer.ggml.tokens', 9, {elemType: 8, values: vocab}],
        ['tokenizer.ggml.scores', 9, {elemType: 6, values: vocab.map(() => 0.5)}],
        ['short.list', 9, {elemType: 4, values: [1, 2, 3]}],
        ['big.u64', 10, 2n ** 60n],
      ],
      tensors: [
        {name: 'tok_embd.weight', dims: [64, 1000], type: 12},
        {name: 'output_norm.weight', dims: [64], type: 0},
      ],
    })
    const h = await readGgufHeader(f)
    expect(h.version).toBe(3)
    expect(h.architecture).toBe('llama')
    expect(h.name).toBe('Tiny Llama')
    expect(h.fileType).toBe(15)
    expect(h.quantizationVersion).toBe(2)
    expect(h.contextLength).toBe(4096)
    expect(h.tensorCount).toBe(2)
    expect(h.parameters).toBe(64 * 1000 + 64)
    expect(h.dtypes).toEqual({Q4_K: 1, F32: 1})
    expect(h.metadata['tokenizer.ggml.tokens']).toEqual({type: 8, count: 1000})
    expect(h.metadata['tokenizer.ggml.scores']).toEqual({type: 6, count: 1000})
    expect(h.metadata['short.list']).toEqual([1, 2, 3])
    expect(h.metadata['tokenizer.ggml.add_bos_token']).toBe(true)
    expect(h.metadata['big.u64']).toBe((2n ** 60n).toString())
    expect(() => JSON.stringify(h)).not.toThrow()
  })

  it('refuses a non-GGUF file and an unsupported version', async () => {
    const a = path.join(dir, 'bad.gguf')
    writeFileSync(a, Buffer.from('NOPE0000000000000000000000'))
    await expect(readGgufHeader(a)).rejects.toThrow(/not a GGUF/)
    const b = path.join(dir, 'v1.gguf')
    const buf = Buffer.alloc(24)
    buf.write('GGUF')
    buf.writeUInt32LE(1, 4)
    writeFileSync(b, buf)
    await expect(readGgufHeader(b)).rejects.toThrow(/version 1/)
  })
})

describe('fingerprint + verify', () => {
  let mdir
  beforeAll(() => {
    mdir = path.join(dir, 'ckpt')
    mkdirSync(path.join(mdir, 'sub'), {recursive: true})
    mkdirSync(path.join(mdir, '.cache'), {recursive: true})
    safetensors(path.join(mdir, 'adapter_model.safetensors'), {w: {dtype: 'BF16', shape: [16, 4], data_offsets: [0, 128]}}, 128)
    writeFileSync(
      path.join(mdir, 'adapter_config.json'),
      JSON.stringify({base_model_name_or_path: 'Qwen/Qwen3-8B', peft_type: 'LORA', r: 16, lora_alpha: 32, target_modules: ['q_proj', 'v_proj'], extra: 1}),
    )
    writeFileSync(path.join(mdir, 'sub', 'config.json'), JSON.stringify({architectures: ['Qwen3ForCausalLM'], model_type: 'qwen3', hidden_size: 64}))
    writeFileSync(path.join(mdir, 'README.md'), 'not fingerprinted')
    writeFileSync(path.join(mdir, '.cache', 'model.safetensors'), 'hidden, skipped')
  })

  it('hashes, parses and digests in sha256sum order', async () => {
    const m = await fingerprint(mdir, {now: () => new Date(0)})
    expect(m.kind).toBe('docpilot.model-manifest')
    expect(m.files.map((f) => f.path)).toEqual(['adapter_config.json', 'adapter_model.safetensors', 'sub/config.json'])
    const ac = m.files[0]
    expect(ac.sha256).toBe(createHash('sha256').update(readFileSync(path.join(mdir, 'adapter_config.json'))).digest('hex'))
    expect(ac.r).toBe(16)
    expect(ac.extra).toBeUndefined()
    expect(m.files[1].parameters).toBe(64)
    expect(m.summary).toMatchObject({format: 'safetensors', parameters: 64, architecture: 'Qwen3ForCausalLM', base: 'Qwen/Qwen3-8B', adapter: true})
    const lines = checksumLines(m.files).join('')
    expect(lines).toMatch(/^[0-9a-f]{64}  adapter_config\.json\n/)
    expect(m.digest).toBe(createHash('sha256').update(lines).digest('hex'))
  })

  it('verify passes on the same files and detects one changed byte, a missing and an extra file', async () => {
    const m = await fingerprint(mdir)
    expect((await verify(m)).passed).toBe(true)

    const f = path.join(mdir, 'adapter_model.safetensors')
    const buf = readFileSync(f)
    buf[buf.length - 1] ^= 0xff
    writeFileSync(f, buf)
    writeFileSync(path.join(mdir, 'extra.gguf'), 'x')
    rmSync(path.join(mdir, 'sub', 'config.json'))

    const r = await verify(m)
    expect(r.passed).toBe(false)
    expect(r.changed).toEqual([expect.objectContaining({path: 'adapter_model.safetensors', reason: 'sha256'})])
    expect(r.missing).toEqual(['sub/config.json'])
    expect(r.extra).toEqual(['extra.gguf'])
  })
})

describe('stats', () => {
  it('McNemar exact matches known values', () => {
    // n = 12, P(X <= 2) = 79/4096, two-sided doubles it.
    expect(mcnemarExact(10, 2)).toBeCloseTo((2 * 79) / 4096, 10)
    expect(mcnemarExact(10, 2)).toBeCloseTo(0.0386, 4)
    expect(mcnemarExact(2, 10)).toBe(mcnemarExact(10, 2))
    expect(mcnemarExact(0, 0)).toBe(1)
    expect(mcnemarExact(5, 5)).toBe(1)
    expect(mcnemarExact(6, 0)).toBeCloseTo(2 / 64, 12)
    // large m must not underflow to 0 or NaN
    const p = mcnemarExact(1200, 800)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1e-15)
    expect(mcnemarMinFlips(0.05)).toBe(6)
  })

  it('paired bootstrap is deterministic under a seed and brackets the mean', () => {
    const d = [0.1, -0.05, 0.2, 0, 0.15, -0.1, 0.3, 0.05, 0.12, -0.02]
    const a = pairedBootstrap(d, {seed: 7})
    const b = pairedBootstrap(d, {seed: 7})
    const c = pairedBootstrap(d, {seed: 8})
    expect(a).toEqual(b)
    expect(c.lo).not.toBe(a.lo)
    expect(a.lo).toBeLessThan(a.mean)
    expect(a.hi).toBeGreaterThan(a.mean)
    expect(pairedBootstrap([])).toEqual({n: 0, mean: null, lo: null, hi: null})
  })
})

const row = (id, ok, f1, extra = {}) => ({
  id,
  question: `question ${id}?`,
  expect: 'answer',
  observed: ok ? 'answer' : 'no-answer',
  citationPrecision: ok ? 1 : 0,
  citationRecall: ok ? 1 : 0,
  hallucinated: 0,
  answerF1: f1,
  recall8: 1,
  latencyMs: 1000,
  cost: {promptTokens: 500, outputTokens: 100},
  ...extra,
})
const report = (rows, meta = {}) => ({
  meta: {model: 'm', provider: 'ollama', indexHash: 'aaaa', promptHash: 'pppp', goldenSha: 'gggg', ...meta},
  summary: {},
  incomparable: [],
  diff: null,
  rows,
})

describe('compare', () => {
  const ids = Array.from({length: 40}, (_, i) => `q-${i}`)
  const base = report(ids.map((id) => row(id, true, 0.6)))

  it('calls a regression when 12 of 40 records flip to not-ok', () => {
    const cand = report(ids.map((id, i) => row(id, i >= 12, i >= 12 ? 0.6 : 0.1)), {model: 'm2'})
    const r = compareReports(base, cand, {resamples: 2000})
    expect(r.refused).toBe(false)
    expect(r.pairs).toBe(40)
    expect(r.mcnemar).toMatchObject({b: 12, c: 0})
    expect(r.verdict).toBe('regression')
    expect(r.flipped.worse).toHaveLength(12)
    expect(r.flipped.worse[0].question).toBe('question q-0?')
    expect(r.metrics.answerF1.hi).toBeLessThan(0)
    const md = renderCompare(r)
    expect(md).toContain('Verdict: **regression**')
    expect(md).toContain('question q-0?')
  })

  it('escapes control bytes that a model file put in its own metadata', () => {
    const manifest = {digest: 'a'.repeat(64), summary: {format: 'gguf', name: 'ok\u001b[2J\u001b]52;c;eA==\u0007', architecture: 'llama\n- forged', adapter: false}}
    const r = compareReports(base, report(ids.map((id) => row(id, true, 0.6))), {resamples: 200, baseManifest: manifest, candidateManifest: manifest})
    const md = renderCompare(r)
    expect(md).not.toMatch(/[\u001b\u0007]/)
    expect(md).toContain('name ok\\x1b[2J\\x1b]52;c;eA==\\x07')
    expect(md).toContain('arch llama\\x0a- forged')
  })

  it('says no-significant-difference on identical reports, with the honest resolution', () => {
    const r = compareReports(base, report(ids.map((id) => row(id, true, 0.6))), {resamples: 500})
    expect(r.verdict).toBe('no-significant-difference')
    expect(r.resolution.minFlips).toBe(6)
    expect(r.resolution.minDetectableOkDelta).toBeCloseTo(6 / 40)
  })

  /**
   * `ok` is `eval`'s reading of the outcome: any refusal settles a negative.
   * A model-side refusal — every one under `guard.mode: 'off'` — observes
   * `refuse:not-answerable`, a cause no golden record is authored with, so an
   * exact match scored every correct refusal not-ok on BOTH sides and a
   * candidate that stopped refusing flipped nothing.
   */
  it('credits any refusal of a negative, the way eval scores it', () => {
    expect(isOk({expect: 'refuse:no-evidence', observed: 'refuse:not-answerable'})).toBe(true)
    expect(isOk({expect: 'refuse:out-of-scope', observed: 'refuse:no-evidence'})).toBe(true)
    expect(isOk({expect: 'answer', scoredAsNegative: true, observed: 'refuse:out-of-scope'})).toBe(true)
    expect(isOk({expect: 'answer', scoredAsNegative: true, observed: 'answer', citationPrecision: 1})).toBe(false)
    expect(isOk({expect: 'refuse:no-evidence', observed: 'answer'})).toBe(false)
    expect(isOk({expect: 'refuse:no-evidence', observed: 'error'})).toBe(false)

    const neg = (id, observed) => ({...row(id, true, 0.6), expect: 'refuse:no-evidence', observed})
    const refusing = report(ids.map((id) => neg(id, 'refuse:not-answerable')))
    const answering = report(ids.map((id, i) => neg(id, i < 12 ? 'answer' : 'refuse:not-answerable')), {model: 'm2'})
    const r = compareReports(refusing, answering, {resamples: 200})
    expect(r.mcnemar).toMatchObject({b: 12, c: 0})
    expect(r.verdict).toBe('regression')
  })

  it('a hallucinated citation makes an answer not ok, and unpaired rows are counted', () => {
    const cand = report([...ids.slice(1).map((id) => row(id, true, 0.6)), row('extra', true, 0.6)])
    cand.rows[0].hallucinated = 1
    const r = compareReports(base, cand, {resamples: 200})
    expect(r.unpaired).toEqual({base: 1, candidate: 1})
    expect(r.mcnemar.b).toBe(1)
  })

  it('refuses when indexHash differs, and proceeds loudly with allowIncomparable', () => {
    const cand = report(ids.map((id) => row(id, true, 0.6)), {indexHash: 'bbbb'})
    const r = compareReports(base, cand)
    expect(r.refused).toBe(true)
    expect(r.incomparable).toEqual([{field: 'indexHash', base: 'aaaa', candidate: 'bbbb'}])
    expect(renderCompare(r)).toContain('REFUSED')
    const forced = compareReports(base, cand, {allowIncomparable: true, resamples: 200})
    expect(forced.refused).toBe(false)
    expect(renderCompare(forced)).toContain('WARNING')
  })

  it('an absent hash reads as unknown, not as a difference', () => {
    const cand = report(ids.map((id) => row(id, true, 0.6)), {goldenSha: undefined})
    expect(compareReports(base, cand, {resamples: 100}).refused).toBe(false)
  })

  it('names the weights from manifests', () => {
    const man = {digest: 'd'.repeat(64), summary: {name: 'ft-1', parameters: 8e9, format: 'gguf', base: null, adapter: false}}
    const r = compareReports(base, base, {baseManifest: man, candidateManifest: man, resamples: 100})
    const md = renderCompare(r)
    expect(md).toContain('8.00B params')
    expect(md).toContain('SAME digest')
  })
})

describe('contamination', () => {
  const golden = [
    {
      id: 'g1',
      question: 'How do I turn on the calibrated relevance gate for my documentation site?',
      gold_answer:
        'Set guard mode to calibrated in the docpilot config and run the calibrate command against your own corpus before you deploy it.',
    },
    {id: 'g2', question: 'Как включить калиброванный шлюз?', gold_answer: 'Задайте guard.mode равным calibrated.'},
    {id: 'g3', question: 'What is RRF?', gold_answer: 'Reciprocal rank fusion merges two ranked lists.'},
  ]

  it('normalises Cyrillic and punctuation', () => {
    expect(normalizeTokens('«Как» ВКЛЮЧИТЬ, шлюз?!')).toEqual(['как', 'включить', 'шлюз'])
    expect(normalizeTokens('ﬁle  A.B')).toEqual(['file', 'a', 'b'])
  })

  it('extracts text from chat, TRL and plain records', () => {
    expect(extractTrainTexts({messages: [{role: 'user', content: 'a'}, {role: 'assistant', content: [{type: 'text', text: 'b'}]}]})).toEqual(['a', 'b'])
    expect(extractTrainTexts({prompt: 'p', chosen: 'c', rejected: 'r'})).toEqual(['p', 'c', 'r'])
    expect(extractTrainTexts({prompt: [{role: 'user', content: 'p'}], completion: [{role: 'assistant', content: 'c'}]})).toEqual(['p', 'c'])
    expect(extractTrainTexts({text: 't'})).toEqual(['t'])
  })

  it('flags a 13-gram overlap and a whole short Cyrillic text, and nothing else', () => {
    const train = [
      'Some preamble. Set guard mode to calibrated in the DocPilot config, and run the calibrate command against your own corpus!',
      'Пользователь спросил: как включить калиброванный шлюз? Ответ ниже.',
      'Unrelated text about reciprocal rank lists.',
    ]
    const r = ngramContamination(golden, train)
    expect(r.contaminated.sort()).toEqual(['g1', 'g2'])
    const g1 = r.records.find((x) => x.id === 'g1')
    expect(g1.overlap).toBeGreaterThan(0)
    expect(g1.overlap).toBeLessThan(1)
    expect(r.rate).toBeCloseTo(2 / 3)
  })

  it('is clean on unrelated training text', () => {
    const r = ngramContamination(golden, ['Совсем другой текст о погоде.', 'The weather is nice today and the gate is fine.'])
    expect(r.contaminated).toEqual([])
    expect(r.rate).toBe(0)
  })
})

describe('runModel', () => {
  it('parses flags per mode and rejects unknown ones', () => {
    expect(parseModelArgs(['compare', '--base=a.json', '--alpha', '0.1', '--json'])).toMatchObject({
      mode: 'compare',
      flags: {base: 'a.json', alpha: 0.1, json: true},
    })
    expect(() => parseModelArgs(['verify', '--alpha=1'])).toThrow(/unknown option/)
    expect(() => parseModelArgs(['compare', '--alpha=x'])).toThrow(/number/)
  })

  it('exit codes: help 0, bad mode 2, refused compare 1, contamination 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(await runModel({argv: ['--help']})).toBe(0)
      expect(await runModel({argv: ['nope']})).toBe(2)
      expect(await runModel({argv: ['compare']})).toBe(2)

      const a = path.join(dir, 'a.json')
      const b = path.join(dir, 'b.json')
      writeFileSync(a, JSON.stringify(report([row('q', true, 1)])))
      writeFileSync(b, JSON.stringify(report([row('q', true, 1)], {promptHash: 'zzzz'})))
      expect(await runModel({argv: ['compare', `--base=${a}`, `--candidate=${b}`]})).toBe(1)
      expect(await runModel({argv: ['compare', `--base=${a}`, `--candidate=${a}`]})).toBe(0)

      const ev = path.join(dir, 'evaldir')
      mkdirSync(ev, {recursive: true})
      writeFileSync(path.join(ev, 'golden.jsonl'), JSON.stringify({id: 'x', question: 'Short question here', gold_answer: 'yes'}) + '\n')
      const t = path.join(dir, 'train.jsonl')
      writeFileSync(t, JSON.stringify({messages: [{role: 'user', content: 'a short question here, please'}]}) + '\nnot json\n')
      expect(await runModel({docPilot: {evalDir: ev}, argv: ['contamination', `--train=${t}`, '--json']})).toBe(1)
    } finally {
      log.mockRestore()
      err.mockRestore()
      out.mockRestore()
    }
  })
})

describe('fingerprint — the layouts model caches actually use', () => {
  it('follows symlinks and sniffs an extensionless GGUF blob', async () => {
    const { fingerprint, sniffFormat } = await import('../src/model/fingerprint.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-blob-'))
    const blob = path.join(dir, 'sha256-abc')
    const head = Buffer.alloc(24)
    head.write('GGUF', 0, 'latin1')
    head.writeUInt32LE(3, 4)
    fs.writeFileSync(blob, head)
    expect(await sniffFormat(blob)).toBe('gguf')
    const snap = path.join(dir, 'snapshot')
    fs.mkdirSync(snap)
    fs.symlinkSync(blob, path.join(snap, 'model.gguf'))
    const m = await fingerprint(snap)
    expect(m.files.map((f) => f.path)).toEqual(['model.gguf'])
    const direct = await fingerprint(blob)
    expect(direct.files[0].format).toBe('gguf')
  })
})
