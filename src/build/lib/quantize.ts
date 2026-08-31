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
