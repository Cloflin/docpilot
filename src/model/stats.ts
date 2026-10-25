/**
 * The two paired statistics `compare` rests on. PURE.
 *
 * WHY PAIRED. Both reports ran the same golden records. A record that is hard
 * for one checkpoint is usually hard for the other, so an unpaired test throws
 * that correlation away and needs several times the records to see the same
 * difference. Pairing by record id keeps it.
 *
 * WHY McNEMAR EXACT, not the chi-square form. Golden sets here are tens of
 * records, and the discordant count — the only thing McNemar reads — is often
 * under ten. The chi-square approximation is poor exactly there. The exact
 * test is a binomial tail and costs nothing at these sizes.
 */

/**
 * Two-sided exact McNemar p-value on the discordant pairs.
 *
 * Under H0 each discordant pair is a fair coin, so with m = b + c,
 * p = min(1, 2 · P(X ≤ min(b, c))) for X ~ Binomial(m, 1/2). Summed in log
 * space, so m in the thousands does not underflow 2^-m to zero.
 *
 * @param b pairs where base was ok and candidate was not
 * @param c pairs where candidate was ok and base was not
 */
export function mcnemarExact(b: number, c: number) {
  const m = b + c
  if (m === 0) return 1
  const k = Math.min(b, c)
  const ln2m = m * Math.LN2
  let logC = 0 // log C(m, 0)
  let maxLog = -Infinity
  const terms = []
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(m - i + 1) - Math.log(i)
    const t = logC - ln2m
    terms.push(t)
    if (t > maxLog) maxLog = t
  }
  const tail = Math.exp(maxLog) * terms.reduce((s, t) => s + Math.exp(t - maxLog), 0)
  return Math.min(1, 2 * tail)
}

/**
 * The smallest number of one-directional flips that can reach p < alpha.
 *
 * With every discordant pair in one direction, p = 2 · 2^-m, so the floor is
 * the least m with 2^(1-m) < alpha. At alpha = 0.05 that is 6. Divided by the
 * number of pairs it is the smallest ok-rate change this golden set can ever
 * call significant — the honest resolution of the instrument.
 */
export function mcnemarMinFlips(alpha: number) {
  let m = 1
  while (mcnemarExact(m, 0) >= alpha && m < 10_000) m++
  return m
}

/** mulberry32 — a 32-bit seeded PRNG. Deterministic, so a CI rerun prints the same interval. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * Paired percentile bootstrap of the mean of per-record deltas.
 *
 * Resampling the DELTAS (candidate − base per record) rather than each side
 * separately is what keeps the pairing: one resample draws whole records.
 *
 * @param deltas one number per paired record
 * @returns `{n, mean, lo, hi}`; `lo`/`hi` are null for n = 0
 */
export function pairedBootstrap(deltas: number[], o: {resamples?: number; seed?: number; level?: number} = {}) {
  const {resamples = 10_000, seed = 1, level = 0.95} = o
  const n = deltas.length
  if (!n) return {n, mean: null, lo: null, hi: null}
  const mean = deltas.reduce((s, d) => s + d, 0) / n
  const rand = mulberry32(seed)
  const means = new Float64Array(resamples)
  for (let r = 0; r < resamples; r++) {
    let s = 0
    for (let i = 0; i < n; i++) s += deltas[(rand() * n) | 0]
    means[r] = s / n
  }
  const sorted = Array.from(means).sort((a, b) => a - b)
  const tail = (1 - level) / 2
  return {n, mean, lo: quantile(sorted, tail), hi: quantile(sorted, 1 - tail)}
}
