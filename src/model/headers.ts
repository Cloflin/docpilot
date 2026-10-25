/**
 * Weight-file headers, read without loading a single tensor.
 *
 * WHY HEADERS AND NOT WEIGHTS. `docpilot model` answers "which weights were
 * measured?", and the sha256 already answers that byte for byte. The header is
 * what makes the answer READABLE: a digest says two files differ, the header
 * says one is a Q4_K_M llama with 8.03B parameters and the other is an F16 one.
 * Both formats put everything that is not a tensor at the front of the file, so
 * a few kilobytes — or, for a GGUF with a 150k-entry vocabulary, a few
 * megabytes — describe a file of tens of gigabytes.
 *
 * BOUNDED BY CONSTRUCTION. Nothing here reads a whole file. Safetensors reads
 * 8 bytes and then the header it announces, refused above 100 MB. GGUF goes
 * through `BoundedReader`, a 1 MB window over a file handle that SKIPS what it
 * does not keep (vocabulary arrays) instead of reading it into memory.
 *
 * PURE in the sense that matters for tests: each function takes a path, opens
 * it, closes it, and returns plain JSON-safe data.
 *
 * Formats: https://github.com/huggingface/safetensors#format and
 * https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

import {open} from 'node:fs/promises'
import type {FileHandle} from 'node:fs/promises'

/** A header this large is not a header — it is a corrupt length or a hostile file. */
export const SAFETENSORS_MAX_HEADER = 100 * 1024 * 1024

/** GGUF arrays at or below this length keep their values; longer ones keep {type, count}. */
export const GGUF_KEEP_ARRAY = 16

/**
 * u64 → number when it is exact, string when it is not.
 *
 * JSON has no BigInt, and a manifest that cannot be `JSON.stringify`-ed is a
 * manifest nobody writes. Every real count and offset fits in 2^53; the string
 * branch exists so a hostile value is recorded rather than silently rounded.
 */
const num = (b: bigint) => (b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString())

const product = (dims: number[]) => dims.reduce((p, d) => p * d, 1)

/**
 * The safetensors header: 8 bytes of little-endian u64 length N, then N bytes
 * of JSON — `{name: {dtype, shape, data_offsets}}` plus an optional
 * `__metadata__` string map.
 */
export async function readSafetensorsHeader(file: string) {
  const fh = await open(file, 'r')
  try {
    const {size} = await fh.stat()
    if (size < 8) throw new Error(`${file}: ${size} bytes is too short for a safetensors file`)
    const lenBuf = Buffer.alloc(8)
    await fh.read(lenBuf, 0, 8, 0)
    const n = lenBuf.readBigUInt64LE(0)
    if (n > BigInt(SAFETENSORS_MAX_HEADER)) {
      throw new Error(`${file}: safetensors header claims ${n} bytes — refused above ${SAFETENSORS_MAX_HEADER}`)
    }
    if (Number(n) > size - 8) {
      throw new Error(`${file}: safetensors header claims ${n} bytes but the file has ${size - 8} after the length`)
    }
    const json = Buffer.alloc(Number(n))
    await fh.read(json, 0, json.length, 8)
    let header
    try {
      header = JSON.parse(json.toString('utf8'))
    } catch (e) {
      throw new Error(`${file}: safetensors header is not JSON — ${e.message}`)
    }
    const metadata = header.__metadata__ ?? null
    const dtypes: Record<string, number> = {}
    let tensorCount = 0
    let parameters = 0
    for (const [name, t] of Object.entries<any>(header)) {
      if (name === '__metadata__') continue
      tensorCount++
      dtypes[t.dtype] = (dtypes[t.dtype] || 0) + 1
      parameters += product(t.shape || [])
    }
    return {format: 'safetensors', headerBytes: Number(n), tensorCount, dtypes, parameters, metadata}
  } finally {
    await fh.close()
  }
}

/**
 * A forward-only reader with a fixed window over a file handle.
 *
 * `skip()` moves the position without reading when the bytes lie beyond the
 * window — that is what makes a 150k-token vocabulary of fixed-size elements
 * cost nothing, and a string vocabulary cost one length read per entry.
 */
export class BoundedReader {
  fh: FileHandle
  size: number
  window: number
  buf: Buffer
  bufStart = 0
  bufLen = 0
  pos = 0

  constructor(fh: FileHandle, size: number, window = 1 << 20) {
    this.fh = fh
    this.size = size
    this.window = window
    this.buf = Buffer.alloc(window)
  }

  async ensure(n: number) {
    if (this.pos + n > this.size) {
      throw new Error(`truncated: need ${n} bytes at offset ${this.pos}, file has ${this.size}`)
    }
    if (this.pos >= this.bufStart && this.pos + n <= this.bufStart + this.bufLen) return
    if (n > this.buf.length) this.buf = Buffer.alloc(n)
    const {bytesRead} = await this.fh.read(this.buf, 0, this.buf.length, this.pos)
    this.bufStart = this.pos
    this.bufLen = bytesRead
  }

  async bytes(n: number) {
    await this.ensure(n)
    const o = this.pos - this.bufStart
    this.pos += n
    return this.buf.subarray(o, o + n)
  }

  skip(n: number) {
    if (this.pos + n > this.size) throw new Error(`truncated: cannot skip ${n} bytes at offset ${this.pos}`)
    this.pos += n
  }

  async u8() { return (await this.bytes(1)).readUInt8(0) }
  async i8() { return (await this.bytes(1)).readInt8(0) }
  async u16() { return (await this.bytes(2)).readUInt16LE(0) }
  async i16() { return (await this.bytes(2)).readInt16LE(0) }
  async u32() { return (await this.bytes(4)).readUInt32LE(0) }
  async i32() { return (await this.bytes(4)).readInt32LE(0) }
  async f32() { return (await this.bytes(4)).readFloatLE(0) }
  async f64() { return (await this.bytes(8)).readDoubleLE(0) }
  async u64() { return (await this.bytes(8)).readBigUInt64LE(0) }
  async i64() { return (await this.bytes(8)).readBigInt64LE(0) }

  /** A count that has to be a usable number — a length, a dimension, a tally. */
  async count(what: string) {
    const v = await this.u64()
    if (v > BigInt(this.size)) throw new Error(`${what} ${v} is larger than the file — corrupt header`)
    return Number(v)
  }

  async str() {
    const n = await this.count('string length')
    return (await this.bytes(n)).toString('utf8')
  }
}

/** GGUF metadata value types. */
const T = {U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12}
const FIXED = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}

/**
 * ggml tensor type ids → names, as of ggml's `enum ggml_type`. An id missing
 * here is printed as `type<n>`, not guessed: the histogram stays truthful when
 * ggml adds a quantisation this table has not heard of.
 */
export const GGML_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S',
  22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64',
  29: 'IQ1_M', 30: 'BF16',
}

async function readValue(r: BoundedReader, type: number): Promise<any> {
  switch (type) {
    case T.U8: return r.u8()
    case T.I8: return r.i8()
    case T.U16: return r.u16()
    case T.I16: return r.i16()
    case T.U32: return r.u32()
    case T.I32: return r.i32()
    case T.F32: return r.f32()
    case T.BOOL: return (await r.u8()) !== 0
    case T.STRING: return r.str()
    case T.U64: return num(await r.u64())
    case T.I64: {
      const v = await r.i64()
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()
    }
    case T.F64: return r.f64()
    case T.ARRAY: {
      const elemType = await r.u32()
      const count = await r.count('array length')
      if (count <= GGUF_KEEP_ARRAY) {
        const values = []
        for (let i = 0; i < count; i++) values.push(await readValue(r, elemType))
        return values
      }
      // The vocabulary lives here: tokenizer.ggml.tokens is ~150k strings.
      // Fixed-size elements are skipped in one move; strings and nested arrays
      // are walked, because their sizes are only known one entry at a time.
      if (FIXED[elemType] != null) r.skip(FIXED[elemType] * count)
      else for (let i = 0; i < count; i++) await skipValue(r, elemType)
      return {type: elemType, count}
    }
    default:
      throw new Error(`unknown GGUF value type ${type} at offset ${r.pos}`)
  }
}

async function skipValue(r: BoundedReader, type: number) {
  if (FIXED[type] != null) return r.skip(FIXED[type])
  if (type === T.STRING) return r.skip(await r.count('string length'))
  if (type === T.ARRAY) {
    const elemType = await r.u32()
    const count = await r.count('array length')
    if (FIXED[elemType] != null) return r.skip(FIXED[elemType] * count)
    for (let i = 0; i < count; i++) await skipValue(r, elemType)
    return
  }
  throw new Error(`unknown GGUF value type ${type} at offset ${r.pos}`)
}

/**
 * The GGUF header: magic, version, counts, metadata KVs, tensor infos.
 *
 * Versions 2 and 3 only. Version 1 used u32 lengths and is long gone from
 * every hub; reading it with u64 lengths would produce garbage, so it is
 * refused by name instead.
 */
export async function readGgufHeader(file: string) {
  const fh = await open(file, 'r')
  try {
    const {size} = await fh.stat()
    const r = new BoundedReader(fh, size)
    const magic = await r.bytes(4)
    if (!(magic[0] === 0x47 && magic[1] === 0x47 && magic[2] === 0x55 && magic[3] === 0x46)) {
      throw new Error(`${file}: not a GGUF file (magic ${magic.toString('hex')})`)
    }
    const version = await r.u32()
    if (version !== 2 && version !== 3) throw new Error(`${file}: GGUF version ${version} is not supported (2 and 3 are)`)
    const tensorCount = await r.count('tensor_count')
    const kvCount = await r.count('metadata_kv_count')

    const metadata: Record<string, any> = {}
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str()
      const type = await r.u32()
      metadata[key] = await readValue(r, type)
    }

    const dtypes: Record<string, number> = {}
    let parameters = 0
    for (let i = 0; i < tensorCount; i++) {
      r.skip(await r.count('tensor name length'))
      const nDims = await r.u32()
      if (nDims > 8) throw new Error(`${file}: tensor ${i} claims ${nDims} dimensions — corrupt header`)
      const dims = []
      for (let d = 0; d < nDims; d++) dims.push(Number(await r.u64()))
      const ggmlType = await r.u32()
      r.skip(8) // offset into the data section — not needed to describe the file
      const name = GGML_TYPES[ggmlType] ?? `type${ggmlType}`
      dtypes[name] = (dtypes[name] || 0) + 1
      parameters += product(dims)
    }

    const arch = metadata['general.architecture'] ?? null
    return {
      format: 'gguf',
      version,
      tensorCount,
      dtypes,
      parameters,
      architecture: arch,
      name: metadata['general.name'] ?? null,
      fileType: metadata['general.file_type'] ?? null,
      quantizationVersion: metadata['general.quantization_version'] ?? null,
      contextLength: arch ? (metadata[`${arch}.context_length`] ?? null) : null,
      metadata,
    }
  } finally {
    await fh.close()
  }
}
