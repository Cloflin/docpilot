/**
 * The corpus the chat characterisation suite asks its questions of.
 *
 * Six chunks over three pages, with vectors a stub embedder can reproduce: the
 * same function that builds the chunk vectors answers the panel's embedding
 * request, so a question that shares words with a chunk lands near it and a
 * question that shares none does not. Nothing here depends on a real embedding
 * model, and nothing here reaches the network — `stubVector` is a bag-of-words
 * hash into 16 dimensions.
 *
 * The openers document is the SHIPPED bake (`bakeOpeners`), run once with one
 * authored question and answer, so the opener path the suite pins is the path a
 * built site takes rather than a hand-written approximation of its file.
 *
 * Two shapes of the same corpus, because two readers use it: `assembleFixture`
 * is the in-memory index the browser-direct session installs, and
 * `writeFixtureDir` is the index directory `createDocPilotServer` reads.
 *
 * Every call gets a fresh manifest hash. `miniSearchFor` memoises its instance
 * on the hash, so two fixtures sharing one would share a BM25 index built for
 * whichever came first.
 */
import fs from 'node:fs'
import path from 'node:path'

import { assembleIndex } from '../../src/theme/docpilot/store.js'
import { bakeOpeners } from '../../src/build/lib/openers.js'
import { resolveSuggestions } from '../../src/theme/docpilot/switches.js'
import { openerQuestions } from '../../src/theme/docpilot/openers.js'

export const DIMS = 16
export const EMBED_MODEL = 'stub-embed'

const row = (id, pagePath, anchor, title, kind, body, prev = null, next = null) => ({
  id,
  path: pagePath,
  anchor,
  title,
  breadcrumb: 'Docs',
  kind,
  text: `Docs — ${title}\n${body}`,
  prev,
  next,
})

export const FIXTURE_ROWS = [
  row('a#one', '/a', 'one', 'Alpha tokens', 'guide', 'The alpha widget is configured with a manifest and a token passed in a header.', null, 'a#two'),
  row('a#two', '/a', 'two', 'Alpha limits', 'guide', 'The alpha widget accepts at most ten requests per minute and rejects the rest.', 'a#one', null),
  row('b#one', '/b', 'one', 'Beta install', 'reference', 'The beta gizmo installs from the registry with one command and needs no token.', null, 'b#two'),
  row('b#two', '/b', 'two', 'Beta upgrade', 'reference', 'Upgrade the beta gizmo by installing the newest release over the old one.', 'b#one', null),
  row('c#one', '/c', 'one', 'Gamma backups', 'guide', 'Gamma snapshots the database every night and keeps seven nightly backups.', null, 'c#two'),
  row('c#two', '/c', 'two', 'Gamma restore', 'guide', 'Restore a gamma backup by choosing a snapshot and confirming the overwrite.', 'c#one', null),
]

export const FIXTURE_PAGES = [
  { path: '/a', title: 'Alpha', tail: 'Docs' },
  { path: '/b', title: 'Beta', tail: 'Docs' },
  { path: '/c', title: 'Gamma', tail: 'Docs' },
]

export const GUARD = {
  tau: 0.3,
  tauLexical: 0.3,
  wDense: 0.75,
  wLexical: 0.25,
  denseMode: 'cosine',
  cosFloor: 0.44,
  cosCeil: 0.64,
  zexp: null,
}

/**
 * The one authored opener. Its words share nothing with the cold questions the
 * suite asks, so a cold question never lands on it by accident, in the lexical
 * pass or the dense one.
 */
export const OPENER = {
  q: 'How are gamma snapshots scheduled?',
  answer: 'Gamma takes a snapshot every night and keeps seven of them [1].',
  cite: ['c#one'],
}

/** A deterministic bag-of-words hash into `dims` dimensions, L2-normalised. */
export function stubVector(text, dims = DIMS) {
  const v = new Float64Array(dims)
  for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    let h = 2166136261
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619) >>> 0
    v[h % dims] += 1
  }
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum) || 1
  return v.map((x) => x / norm)
}

const toInt8 = (unit) => Int8Array.from(unit, (x) => Math.round(x * 127))

const vectorsFor = (rows) => {
  const out = new Int8Array(rows.length * DIMS)
  rows.forEach((r, i) => out.set(toInt8(stubVector(r.text)), i * DIMS))
  return out
}

const DF = { n: FIXTURE_ROWS.length, df: {} }

let fixtureCount = 0

// `vectors: false` is the lexical fixture: a null `vectors` name is the signal
// `assembleIndex` reads as "built with no embedder", with no width and no model.
const manifestFor = (hash, vectors = true, extra = {}) => ({
  version: 3,
  hash,
  embedModel: vectors ? EMBED_MODEL : null,
  dims: vectors ? DIMS : 0,
  ...(vectors ? { quant: 'int8' } : {}),
  vectors: vectors ? 'vectors.bin' : null,
  chunkCount: FIXTURE_ROWS.length,
  pages: FIXTURE_PAGES.map((p) => ({ ...p })),
  sections: [],
  guard: { ...GUARD },
  ...extra,
})

/**
 * The shipped bake, run once per kind of index and re-stamped per fixture.
 *
 * The bundle's `hash` has to equal the manifest's, which is fresh per call; the
 * rest of it depends on the corpus and the authored question only.
 */
const suggestions = resolveSuggestions({ suggestions: [OPENER] }, () => {})
const bake = async (vectors) => {
  const out = await bakeOpeners({
    questions: openerQuestions(suggestions),
    authored: suggestions.authored,
    manifest: manifestFor('chat-fixture-bake', vectors),
    chunks: FIXTURE_ROWS.map((r) => ({ ...r })),
    vectorBuffer: vectors ? vectorsFor(FIXTURE_ROWS).buffer : null,
    dfDoc: DF,
    hash: 'chat-fixture-bake',
    embed: { model: vectors ? EMBED_MODEL : null, provider: 'custom', baseURL: 'http://stub.test', apiKey: null, cache: null },
    chat: { searchOnly: true },
    docPilot: { prompt: {}, product: 'Docs' },
    // The bake divides by 127, so the stub answers in the scale `embedQuery` does.
    embedFn: async (q) => stubVector(q).map((x) => x * 127),
    warn: () => {},
  })
  if (!out.bundle) throw new Error('chat-fixture: the openers bake produced nothing')
  return out.bundle
}
const baked = { true: await bake(true), false: await bake(false) }

const openersFor = (hash, vectors) => ({ ...baked[vectors], hash })

/** The index the browser-direct session installs, plus the file names a server dir would hold. */
export function assembleFixture({ openers = true, vectors = true } = {}) {
  const hash = `chat-fixture-${++fixtureCount}`
  return assembleIndex({
    manifest: manifestFor(hash, vectors, { openers: openers ? 'openers.json' : null }),
    shards: [FIXTURE_ROWS.map((r) => ({ ...r }))],
    vectorBuffer: vectors ? vectorsFor(FIXTURE_ROWS).buffer : null,
    dfDoc: DF,
    openersDoc: openers ? openersFor(hash, vectors) : null,
  })
}

/** The same corpus as files, in the layout `readIndexDir` reads. Returns the manifest written. */
export function writeFixtureDir(dir, { openers = true, vectors = true } = {}) {
  const hash = `chat-fixture-${++fixtureCount}`
  const manifest = manifestFor(hash, vectors, {
    shards: ['chunks-00.json'],
    df: 'df.json',
    openers: openers ? 'openers.json' : null,
  })
  const put = (name, data) => fs.writeFileSync(path.join(dir, name), data)
  put('manifest.json', JSON.stringify(manifest))
  put('chunks-00.json', JSON.stringify(FIXTURE_ROWS))
  put('df.json', JSON.stringify(DF))
  if (vectors) put('vectors.bin', Buffer.from(vectorsFor(FIXTURE_ROWS).buffer))
  if (openers) put('openers.json', JSON.stringify(openersFor(hash, vectors)))
  return manifest
}
