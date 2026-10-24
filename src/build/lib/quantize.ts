/**
 * int8 quantisation of embeddings — RAG-SPEC 2.4.
 *
 * Vectors are L2-normalised first, so cosine similarity IS the dot product and
 * the runtime can score with integer arithmetic over a flat Int8Array: no float
 * unpacking, no per-vector scale to carry, ~512 KB instead of ~2 MB.
 */

export function l2normalise(vec: ArrayLike<number> & Iterable<number>) {
  let sum = 0
  for (const v of vec) sum += v * v
  const n = Math.sqrt(sum) || 1
  return Float32Array.from(vec, (v) => v / n)
}

/** q[i] = round(v[i] * 127), clamped. Input must already be L2-normalised. */
export function toInt8(normalised) {
  const out = new Int8Array(normalised.length)
  for (let i = 0; i < normalised.length; i++) {
    out[i] = Math.max(-127, Math.min(127, Math.round(normalised[i] * 127)))
  }
  return out
}

/** cos ≈ dot(a, b) / 127². Both operands must come from toInt8(). */
export function cosineInt8(a, b, offsetA = 0, offsetB = 0, dims = a.length) {
  let dot = 0
  for (let i = 0; i < dims; i++) dot += a[offsetA + i] * b[offsetB + i]
  return dot / 16129 // 127 * 127
}

/**
 * 1-bit quantisation — engine-spec 027.
 *
 * One SIGN per dimension, eight to a byte: a 4096-dimension vector is 512 bytes
 * instead of 4096. Only the chunk side is binarised. The query stays float, so
 * the runtime score is `Σ q[i] · sign(d[i])` — asymmetric, which keeps most of
 * what the sign threw away — times one corpus-wide `cosScale` that puts it back
 * on the cosine scale the gate's thresholds are written in.
 *
 * Bit i of a row lives at byte `i >> 3`, bit `i & 7`; a set bit is `+1`.
 * `unpackSigns` in `theme/docpilot/store.js` is the reader of this layout.
 */
export const bytesPerRow = (dims: number) => Math.ceil(dims / 8)

export function packSigns(vectors: ArrayLike<number>[]) {
  const dims = vectors[0]?.length ?? 0
  const stride = bytesPerRow(dims)
  const out = new Uint8Array(vectors.length * stride)
  vectors.forEach((v, r) => {
    for (let i = 0; i < dims; i++) if (v[i] >= 0) out[r * stride + (i >> 3)] |= 1 << (i & 7)
  })
  return out
}

/** The same pair sample `quantisationError` draws, so both report on one population. */
function samplePairs(n: number, sampleSize: number) {
  const pairs: [number, number][] = []
  const step = Math.max(1, Math.floor(n / Math.sqrt(sampleSize)))
  for (let i = 0; i < n && pairs.length < sampleSize; i += step) {
    for (let j = i + 1; j < n && pairs.length < sampleSize; j += step) pairs.push([i, j])
  }
  return pairs
}

/** `Σ a[i] · sign(b[i])` — the asymmetric score before `cosScale`. */
function signDot(a: ArrayLike<number>, b: ArrayLike<number>) {
  let s = 0
  for (let k = 0; k < a.length; k++) s += b[k] >= 0 ? a[k] : -a[k]
  return s
}

/**
 * `cosScale`: the least-squares fit of `cos(a, b) ≈ cosScale · Σ a[i]·sign(b[i])`
 * over sampled chunk pairs, the float chunk standing in for a query.
 *
 * Fitted rather than derived. The closed form (`1 / Σ|b[i]|`) assumes isotropic
 * vectors, and embedders are not; the fit is what keeps D, and therefore every
 * calibrated threshold, on the scale it was measured on.
 */
export function binaryScale(vectors: ArrayLike<number>[], sampleSize = 2000) {
  let num = 0
  let den = 0
  for (const [i, j] of samplePairs(vectors.length, sampleSize)) {
    for (const [a, b] of [[vectors[i], vectors[j]], [vectors[j], vectors[i]]]) {
      let exact = 0
      for (let k = 0; k < a.length; k++) exact += a[k] * b[k]
      const raw = signDot(a, b)
      num += raw * exact
      den += raw * raw
    }
  }
  return den ? num / den : 0
}

/** `quantisationError` for the 1-bit blob: float query side, sign chunk side. */
export function binaryQuantisationError(vectors: ArrayLike<number>[], cosScale: number, sampleSize = 200) {
  let total = 0
  let n = 0
  for (const [i, j] of samplePairs(vectors.length, sampleSize)) {
    const a = vectors[i]
    const b = vectors[j]
    let exact = 0
    for (let k = 0; k < a.length; k++) exact += a[k] * b[k]
    total += Math.abs(exact - cosScale * signDot(a, b))
    n++
  }
  return n ? total / n : 0
}

/**
 * Build-time guard: if quantisation costs more than 0.01 mean absolute cosine
 * error over a sample of pairs, the whole retrieval story is built on sand and
 * the build must fail rather than ship a silently worse index.
 */
export function quantisationError(vectors, sampleSize = 200) {
  if (vectors.length < 2) return 0
  let total = 0
  let n = 0
  const step = Math.max(1, Math.floor(vectors.length / Math.sqrt(sampleSize)))
  for (let i = 0; i < vectors.length && n < sampleSize; i += step) {
    for (let j = i + 1; j < vectors.length && n < sampleSize; j += step) {
      const a = vectors[i]
      const b = vectors[j]
      let exact = 0
      for (let k = 0; k < a.length; k++) exact += a[k] * b[k]
      const approx = cosineInt8(toInt8(a), toInt8(b))
      total += Math.abs(exact - approx)
      n++
    }
  }
  return n ? total / n : 0
}
