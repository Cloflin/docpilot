/**
 * `fingerprint` and `verify` — a manifest that names WHICH weights were measured.
 *
 * WHY THIS EXISTS. An eval report records `meta.model`, and a model name is a
 * label, not an identity: `my-ft:latest` is a different checkpoint after every
 * training run, and an Ollama tag can be re-pointed under the same name. The
 * manifest is the identity — a sha256 per file plus one digest over all of
 * them — and `compare` prints it next to the numbers.
 *
 * THE DIGEST IS sha256sum-SHAPED on purpose. It is the sha256 of the lines
 * `${sha256}  ${path}\n`, sorted by path. `checksumLines()` returns exactly
 * those lines, so `docpilot model fingerprint --format=sha256sum > SUMS` and
 * `sha256sum -c SUMS`, run from the manifest root, check the same files with a
 * tool that does not need this package.
 *
 * Hashing streams. A 16 GB shard costs 16 GB of disk reads and constant memory.
 */

import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {open, readdir, readFile, stat} from 'node:fs/promises'
import path from 'node:path'
import {readGgufHeader, readSafetensorsHeader} from './headers.js'

const WEIGHT_EXT = {
  '.safetensors': 'safetensors',
  '.gguf': 'gguf',
  '.bin': 'pytorch',
  '.pt': 'pytorch',
  '.pth': 'pytorch',
  '.onnx': 'onnx',
}
const CONFIG_NAMES = new Set([
  'adapter_config.json',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
])

/** The format of a file this command fingerprints, or null for one it ignores. */
export function formatOf(name: string) {
  const base = path.basename(name)
  if (CONFIG_NAMES.has(base)) return base.replace(/\.json$/, '')
  return WEIGHT_EXT[path.extname(base).toLowerCase()] ?? null
}

/**
 * Every fingerprinted file under `dir`, relative and posix, sorted.
 *
 * Hidden directories are not entered: `.git`, `.cache/huggingface` and
 * `.ipynb_checkpoints` hold copies and partial downloads, and a manifest that
 * includes them changes every time the cache does.
 */
export async function listModelFiles(dir: string) {
  const out = []
  const walk = async (abs: string, rel: string) => {
    const entries = await readdir(abs, {withFileTypes: true})
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      // FOLLOWED, because the layouts people fingerprint are made of links: a
      // Hugging Face snapshot is a directory of symlinks into `blobs/`, and an
      // Ollama model is reached the same way. `stat`, not the dirent, says what
      // the link points at; a dangling one is skipped rather than fatal.
      let kind: {isDirectory(): boolean; isFile(): boolean} = e
      if (e.isSymbolicLink()) {
        try {
          kind = await stat(path.join(abs, e.name))
        } catch {
          continue
        }
      }
      if (kind.isDirectory()) {
        if (!e.name.startsWith('.')) await walk(path.join(abs, e.name), r)
      } else if (kind.isFile() && formatOf(e.name)) out.push(r)
    }
  }
  await walk(dir, '')
  return out.sort(byPath)
}

/** Code-unit order: stable across locales, which `localeCompare` is not. */
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Streaming sha256. `onProgress(done, total)` fires per chunk; the caller throttles. */
export function sha256File(file: string, onProgress?: (done: number, total: number) => void, total = 0) {
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    let done = 0
    createReadStream(file, {highWaterMark: 4 << 20})
      .on('data', (chunk: Buffer) => {
        h.update(chunk)
        done += chunk.length
        onProgress?.(done, total)
      })
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

const pick = (o, keys: string[]) => {
  const r = {}
  for (const k of keys) if (o?.[k] !== undefined) r[k] = o[k]
  return r
}

/** What a JSON sidecar says about the model. `tokenizer*.json` is hashed, not parsed. */
async function parseConfig(file: string, format: string) {
  if (format !== 'adapter_config' && format !== 'config') return {}
  try {
    const j = JSON.parse(await readFile(file, 'utf8'))
    if (format === 'adapter_config') {
      return pick(j, ['base_model_name_or_path', 'peft_type', 'r', 'lora_alpha', 'target_modules'])
    }
    return pick(j, ['architectures', 'model_type', 'torch_dtype', 'vocab_size', 'hidden_size', 'num_hidden_layers'])
  } catch (e) {
    return {parseError: e.message}
  }
}

async function parseWeights(file: string, format: string) {
  try {
    if (format === 'safetensors') {
      const {format: _f, ...h} = await readSafetensorsHeader(file)
      return h
    }
    if (format === 'gguf') {
      const {format: _f, ...h} = await readGgufHeader(file)
      return h
    }
  } catch (e) {
    // A header that does not parse is recorded, not fatal: the sha256 is still
    // the identity, and refusing to fingerprint a file because this reader is
    // older than its format would be the wrong failure.
    return {parseError: e.message}
  }
  return {}
}

/** `${sha256}  ${path}` per file, sorted by path — the input to the digest and to `sha256sum -c`. */
export function checksumLines(files: {path: string; sha256: string}[]) {
  return [...files].sort((a, b) => byPath(a.path, b.path)).map((f) => `${f.sha256}  ${f.path}\n`)
}

export const manifestDigest = (files: {path: string; sha256: string}[]) =>
  createHash('sha256').update(checksumLines(files).join('')).digest('hex')

/** The weight format that dominates by bytes — what a reader would call this checkpoint. */
function summarize(files) {
  const weightFormats = new Set(Object.values(WEIGHT_EXT))
  const weights = files.filter((f) => weightFormats.has(f.format))
  const byFormat = new Map<string, number>()
  for (const f of weights) byFormat.set(f.format, (byFormat.get(f.format) || 0) + f.bytes)
  const format = [...byFormat.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  const same = weights.filter((f) => f.format === format)
  const params = same.reduce((s, f) => s + (f.parameters || 0), 0)
  const gguf = files.find((f) => f.format === 'gguf' && !f.parseError)
  const config = files.find((f) => f.format === 'config')
  const adapterCfg = files.find((f) => f.format === 'adapter_config')
  const stMeta = same.find((f) => f.metadata)?.metadata

  return {
    format,
    parameters: params || null,
    architecture: gguf?.architecture ?? config?.architectures?.[0] ?? config?.model_type ?? null,
    name: gguf?.name ?? stMeta?.name ?? null,
    base: adapterCfg?.base_model_name_or_path ?? null,
    adapter: Boolean(adapterCfg) || files.some((f) => /(^|\/)adapter_model\./.test(f.path)),
  }
}

export type ProgressFn = (p: {path: string; done: number; total: number}) => void

/**
 * Fingerprint a file or a directory.
 *
 * @param target a weight file, or a directory searched as `listModelFiles` says
 * @param o.onProgress per-chunk hashing progress; the CLI throttles it
 * @param o.now injectable clock, so a test can pin `createdAt`
 */
/**
 * The format a file's first bytes declare, for the files whose NAME declares
 * nothing — an Ollama blob is `sha256-<hex>` with no extension, and it is a GGUF.
 * safetensors has no magic, but its header is JSON right after an 8-byte length,
 * so a `{` at byte 8 under a plausible length is the signature.
 */
export async function sniffFormat(file: string) {
  const fh = await open(file, 'r')
  try {
    const head = Buffer.alloc(9)
    const {bytesRead} = await fh.read(head, 0, 9, 0)
    if (bytesRead >= 4 && head.toString('latin1', 0, 4) === 'GGUF') return 'gguf'
    if (bytesRead === 9 && head[8] === 0x7b) {
      const n = Number(head.readBigUInt64LE(0))
      if (n > 1 && n < 100 * 1024 * 1024) return 'safetensors'
    }
    return null
  } finally {
    await fh.close()
  }
}

export async function fingerprint(target: string, o: {onProgress?: ProgressFn; now?: () => Date} = {}) {
  const abs = path.resolve(target)
  const st = await stat(abs)
  let root: string
  let rels: string[]
  if (st.isDirectory()) {
    root = abs
    rels = await listModelFiles(abs)
  } else {
    root = path.dirname(abs)
    rels = [path.basename(abs)]
  }

  const files = []
  for (const rel of rels) {
    const file = path.join(root, ...rel.split('/'))
    const {size} = await stat(file)
    const format = formatOf(rel) ?? (await sniffFormat(file)) ?? 'unknown'
    const sha256 = await sha256File(file, o.onProgress && ((done, total) => o.onProgress({path: rel, done, total})), size)
    const parsed = format === 'safetensors' || format === 'gguf' ? await parseWeights(file, format) : await parseConfig(file, format)
    files.push({path: rel, bytes: size, sha256, format, ...parsed})
  }

  return {
    kind: 'docpilot.model-manifest',
    v: 1,
    createdAt: (o.now ?? (() => new Date()))().toISOString(),
    root,
    files,
    summary: summarize(files),
    digest: manifestDigest(files),
  }
}

/**
 * Re-hash and diff against a manifest.
 *
 * A size mismatch is reported without hashing: it already proves a change, and
 * skipping the hash is the difference between seconds and minutes on a shard.
 */
export async function verify(manifest, target?: string, o: {onProgress?: ProgressFn} = {}) {
  if (manifest?.kind !== 'docpilot.model-manifest') throw new Error('not a docpilot model manifest (kind is missing or wrong)')
  const base = path.resolve(target ?? manifest.root)
  const st = await stat(base)
  const root = st.isDirectory() ? base : path.dirname(base)
  const onDisk = st.isDirectory() ? await listModelFiles(root) : [path.basename(base)]
  const expected = new Map<string, any>(manifest.files.map((f) => [f.path, f]))

  const missing = []
  const changed = []
  const ok = []
  for (const [rel, f] of expected) {
    const file = path.join(root, ...rel.split('/'))
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      missing.push(rel)
      continue
    }
    if (size !== f.bytes) {
      changed.push({path: rel, reason: 'bytes', expected: f.bytes, actual: size})
      continue
    }
    const sha = await sha256File(file, o.onProgress && ((done, total) => o.onProgress({path: rel, done, total})), size)
    if (sha !== f.sha256) changed.push({path: rel, reason: 'sha256', expected: f.sha256, actual: sha})
    else ok.push(rel)
  }
  const extra = onDisk.filter((rel) => !expected.has(rel))
  return {root, ok, missing, changed, extra, passed: !missing.length && !changed.length && !extra.length}
}
