import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  resolveDocPilot,
  resolveEmbed,
  noEmbed,
  embedModels,
  poolProviderOf,
  themeDocPilot,
  nodeEmbedTarget,
  readiness,
} from '../src/config.js'
import { assembleIndex, loadIndex, __setIndex } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { aggregate } from '../src/feedback/aggregate.js'
import { resolveEmbed as resolveClientEmbed } from '../src/theme/docpilot/switches.js'

/**
 * `embed: false` — a deployment with no embedder at all.
 *
 * Lexical-only retrieval already existed as a RUNTIME DEGRADATION: an embedder
 * that stopped answering, or an index that outlived the model that built it.
 * This is the other thing entirely — a mode the author declared, built for, and
 * deployed — and almost every assertion in this file is about keeping the two
 * apart. The failure they collapse into is quiet in both directions: a declared
 * mode reported to the reader as an outage, or an outage reported as a choice.
 *
 * Nothing here touches a socket. The whole point of the mode is that there is no
 * service to call, so a suite that needed one to check it would be testing the
 * opposite configuration.
 */

const ENV = {}
const cfg = (settings) => resolveDocPilot(settings, ENV)

/**
 * Manifests written to disk, because `readiness` reads the index through the
 * filesystem — a stubbed `indexInfo` would test the stub, and the disagreements
 * being checked here are exactly the ones between a config and a real file.
 */
const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

const indexDir = (manifest) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docpilot-no-embed-'))
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  tmpDirs.push(dir)
  return dir
}

// What `npx docpilot index --no-embed` writes, and what a build with an embedder
// writes, in the three keys that tell them apart.
const VECTORLESS = { version: 3, hash: 'h', embedModel: null, dims: 0, vectors: null, chunkCount: 3 }
const WITH_VECTORS = {
  version: 3,
  hash: 'h',
  embedModel: 'bge-m3',
  dims: 1024,
  vectors: 'vectors.h.bin',
  chunkCount: 3,
}

describe('embed: false — one mode, two spellings', () => {
  it('resolves both to the same object', () => {
    // `fallback` is stated even here, and null: `embed: false` is the mode
    // itself, so there is nothing for a fallback to fall back FROM — and the key
    // has to survive the JSON round trip the test below asserts.
    const want = {
      provider: null,
      model: null,
      baseURL: null,
      auto: false,
      lexicalOnly: true,
      fallback: null,
    }
    expect(resolveEmbed(cfg({ embed: false }))).toEqual(want)
    expect(resolveEmbed(cfg({ embed: 'none' }))).toEqual(want)
  })

  /**
   * Nulls, never `undefined`, and the round trip is asserted rather than the
   * intention: this object is serialised into themeConfig with JSON.stringify,
   * which DELETES an undefined key, after which session.js fills the hole from
   * its own defaults — the failure already recorded in `resolveEmbed`'s
   * comments, arriving here as a browser certain it embeds with `bge-m3`.
   */
  it('states every key, so the trip through themeConfig cannot lose one', () => {
    const e = resolveEmbed(cfg({ embed: false }))
    expect(Object.values(e).some((v) => v === undefined)).toBe(false)
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
  })

  it('answers the predicate the Node callers branch on before resolving anything', () => {
    expect(noEmbed(cfg({ embed: false }))).toBe(true)
    expect(noEmbed(cfg({ embed: 'none' }))).toBe(true)
    expect(noEmbed(cfg({}))).toBe(false)
    expect(noEmbed(cfg({ embed: { provider: 'ollama', model: 'bge-m3' } }))).toBe(false)
  })

  /**
   * A null provider has no free pool, and both helpers already said so. Pinned
   * rather than restructured — the mode reaches them through `resolveEmbed`, so
   * this is the arm that would break first if either grew a `provider` read that
   * assumed one.
   */
  it('leaves the pool helpers with nothing to answer', () => {
    for (const spelling of [false, 'none']) {
      expect(embedModels(cfg({ embed: spelling }))).toBe(null)
      expect(poolProviderOf(cfg({ embed: spelling }), 'embed')).toBe(null)
    }
  })

  /**
   * A target in the shape the caller destructures, with nothing to post to. A
   * `baseURL` here would be somewhere the indexer COULD send the corpus, and the
   * key is null even with one in the environment: no request is made, so none is
   * signed.
   */
  it('hands the indexer a target with no endpoint and no key', () => {
    const want = {
      lexicalOnly: true,
      id: null,
      provider: null,
      baseURL: null,
      model: null,
      models: null,
      apiKey: null,
    }
    expect(nodeEmbedTarget(cfg({ embed: false }), { OPENROUTER_API_KEY: 'sk-or-x' })).toEqual(want)
    expect(nodeEmbedTarget(cfg({ embed: 'none' }), {})).toEqual(want)
  })

  /**
   * NOT routed through `targetOf`, and this is the assertion that says so from
   * the outside: `targetOf` reads a provider it does not recognise as the local
   * one, so a null provider comes back as an Ollama at localhost:11434 — a site
   * that declared no embedder spending every question on a connection refused to
   * a service nobody installed.
   */
  it('sends the browser a null embedder rather than a local one', () => {
    for (const spelling of [false, 'none']) {
      const client = themeDocPilot(cfg({ embed: spelling }), ENV)
      expect(client.embed).toEqual({
        provider: null,
        baseURL: null,
        model: null,
        lexicalOnly: true,
      })
      expect(JSON.stringify(client.embed)).not.toContain('11434')
    }
  })

  /**
   * The key exists on BOTH arms. session.js branches on `cfg.embed.lexicalOnly`
   * to decide whether to embed the question at all, and an absent key is an
   * undefined one that JSON.stringify deletes — leaving the browser to read the
   * absence as "not chosen" only by luck.
   */
  it('carries the flag on the ordinary arm too, set false', () => {
    expect(themeDocPilot(cfg({}), ENV).embed).toEqual({
      provider: 'ollama',
      baseURL: 'http://localhost:11434',
      model: 'bge-m3',
      lexicalOnly: false,
    })
    const split = themeDocPilot(
      cfg({ embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' } }),
      ENV,
    )
    expect(split.embed.lexicalOnly).toBe(false)
  })
})

describe('the embed assertion — silent for the mode, unchanged for everything else', () => {
  it('does not stop a build that declared no embedder', () => {
    for (const spelling of [false, 'none']) {
      expect(() => themeDocPilot(cfg({ embed: spelling }), ENV)).not.toThrow()
      expect(() => nodeEmbedTarget(cfg({ embed: spelling }), ENV)).not.toThrow()
      expect(() => readiness(cfg({ embed: spelling }), ENV)).not.toThrow()
    }
  })

  /**
   * THE REGRESSION THIS MODE COULD HAVE CAUSED. `embed: {provider: 'anthropic'}`
   * is a sentence the author wrote naming a service that answers and does not
   * retrieve, and it has always stopped the build. An early return for "no
   * embedder" that read the absence of a MODEL rather than the absence of the
   * SETTING would swallow it, and the site would deploy lexical-only with an
   * embed block in its config file saying otherwise.
   */
  it('still refuses an explicit chat-only embed provider', () => {
    const c = cfg({ embed: { provider: 'anthropic' } })
    expect(() => themeDocPilot(c, ENV)).toThrow(/no embeddings endpoint/)
    expect(() => nodeEmbedTarget(c, ENV)).toThrow(/no embeddings endpoint/)
    // `readiness` reports the same refusal rather than raising it: doctor has to
    // survive a configuration a build would stop on.
    const r = readiness(c, ENV)
    expect(r.ok).toBe(false)
    expect(r.missing.map((m) => `${m.what} ${m.fix}`).join(' ')).toMatch(/no embeddings endpoint/)
  })

  // The other arm, for a provider that CAN embed and was named without a model.
  // Also untouched, and it fails with the message about the model rather than
  // the one about the provider.
  it('still refuses an embedder named without a model', () => {
    expect(() => themeDocPilot(cfg({ embed: { provider: 'openai' } }), ENV)).toThrow(
      /embed\.model is not set/,
    )
  })
})

describe('assembleIndex — a manifest that names no vector blob', () => {
  const chunk = (id, text) => ({
    id: `${id}#one`,
    path: `/${id}`,
    anchor: 'one',
    title: id,
    breadcrumb: 'Docs',
    kind: 'guide',
    text,
    prev: null,
    next: null,
  })
  const shard = () => [chunk('a', 'The alpha widget'), chunk('b', 'The beta gizmo')]
  const manifest = (over = {}) => ({
    version: 3,
    hash: 'h',
    embedModel: null,
    dims: 0,
    vectors: null,
    chunkCount: 2,
    pages: [],
    guard: {},
    ...over,
  })
  const assemble = (over, extra = {}) =>
    assembleIndex({
      manifest: manifest(over),
      shards: [shard()],
      vectorBuffer: null,
      dfDoc: { df: {} },
      ...extra,
    })

  it('returns no vectors, no width, and names the mode', () => {
    const idx = assemble()
    expect(idx.vectors).toBe(null)
    expect(idx.dims).toBe(0)
    expect(idx.lexicalOnly).toBe(true)
    expect(idx.chunks).toHaveLength(2)
    expect(idx.byId.get('a#one').row).toBe(0)
  })

  /**
   * `manifest.vectors` is THE signal, so a buffer handed in beside a null one is
   * ignored rather than read. The alternative — trusting whichever argument
   * arrived — puts an index's mode in the hands of its caller, and `loadIndex`
   * and `eval/run.js` are two different callers.
   */
  it('ignores a vector buffer a caller passed anyway', () => {
    const idx = assemble({}, { vectorBuffer: new Int8Array(64).buffer })
    expect(idx.vectors).toBe(null)
    expect(idx.dims).toBe(0)
    expect(idx.lexicalOnly).toBe(true)
  })

  // The integrity check that has nothing to do with vectors keeps running: a
  // short shard is a truncated build in either mode.
  it('does not stop counting chunks', () => {
    expect(() => assemble({ chunkCount: 3 })).toThrow(/chunk count mismatch/)
  })

  it('still enforces chunkCount × dims when there are vectors', () => {
    const over = { embedModel: 'test', dims: 4, vectors: 'vectors.h.bin' }
    expect(() => assemble(over, { vectorBuffer: new Int8Array(4).buffer })).toThrow(
      /vector buffer does not match/,
    )
    const idx = assemble(over, { vectorBuffer: new Int8Array(8).buffer })
    expect(idx.vectors).toHaveLength(8)
    expect(idx.dims).toBe(4)
    expect(idx.lexicalOnly).toBe(false)
  })

  /**
   * NOTHING KEYS OFF `dims === 0` ALONE. A manifest that names a blob and a width
   * of zero is a corrupt index, and reading the width as the mode would turn that
   * into a silent downgrade to BM25 — indistinguishable, from every layer above,
   * from a deliberate one.
   */
  it('reads the blob name, not the width', () => {
    expect(() =>
      assemble({ embedModel: 'test', dims: 0, vectors: 'vectors.h.bin' }, {
        vectorBuffer: new Int8Array(8).buffer,
      }),
    ).toThrow(/vector buffer does not match/)
  })
})

describe('retrieval over an index with no vector space', () => {
  const GUARD = {
    tau: 0.3,
    tauLexical: 0.3,
    wDense: 0.75,
    wLexical: 0.25,
    denseMode: 'cosine',
    cosFloor: 0.44,
    cosCeil: 0.64,
    zexp: null,
  }

  const ROWS = () => [
    {
      id: 'a#one',
      path: '/a',
      anchor: 'one',
      title: 'Alpha',
      breadcrumb: 'Docs',
      kind: 'guide',
      text: 'The alpha widget is configured with a manifest and a token.',
      prev: null,
      next: null,
    },
    {
      id: 'b#one',
      path: '/b',
      anchor: 'one',
      title: 'Beta',
      breadcrumb: 'Docs',
      kind: 'reference',
      text: 'The beta gizmo installs from the registry and needs no token.',
      prev: null,
      next: null,
    },
    {
      id: 'c#one',
      path: '/c',
      anchor: 'one',
      title: 'Gamma',
      breadcrumb: 'Docs',
      kind: 'guide',
      text: 'Gamma covers billing plans, invoices and refunds.',
      prev: null,
      next: null,
    },
  ]

  /**
   * `hash` must differ per fixture: `miniSearchFor` memoises its MiniSearch
   * instance on `manifest.hash`, so two fixtures sharing one would have the
   * second search the first's chunks.
   */
  let fixtureCount = 0
  const makeIndex = () => {
    const chunks = ROWS()
    return assembleIndex({
      manifest: {
        version: 3,
        hash: `lexical-${++fixtureCount}`,
        embedModel: null,
        dims: 0,
        vectors: null,
        chunkCount: chunks.length,
        pages: chunks.map((c) => ({ path: c.path, title: `Page ${c.path}`, tail: 'Docs' })),
        guard: GUARD,
      },
      shards: [chunks],
      vectorBuffer: null,
      dfDoc: { df: {} },
    })
  }

  const ALL = { kind: 'all', paths: [], label: 'All docs' }
  // The vector a deployment that names an embedder over a vectorless index
  // arrives holding — the disagreement `readiness` reports rather than prevents.
  const STRAY = Float64Array.from([1, 0, 0, 0])

  it('ranks lexically, with or without a query vector in hand', () => {
    const r = createRetrieval({ index: makeIndex(), scope: ALL, guard: GUARD })
    expect(r.search({ query: 'invoices refunds', queryVec: null })[0].id).toBe('c#one')
    expect(r.search({ query: 'invoices refunds', queryVec: STRAY })[0].id).toBe('c#one')
    // The vector is dropped, not scored: a dense channel would have put the
    // chunk on the query's axis first, and there are no axes here.
    expect(r.search({ query: 'alpha widget token', queryVec: STRAY })[0].id).toBe('a#one')
  })

  /**
   * NOT a `dim-mismatch`. That event names a real disagreement — a vector of one
   * width scored against an index of another — and whoever reads it goes looking
   * for an embed model that changed under a cached index. An index built without
   * an embedder disagrees with nothing.
   */
  it('reports no dimension mismatch, because there is no second width', () => {
    const seen = []
    const r = createRetrieval({
      index: makeIndex(),
      scope: ALL,
      guard: GUARD,
      onDebug: (kind, data) => seen.push([kind, data]),
    })
    r.search({ query: 'invoices refunds', queryVec: STRAY })
    r.evaluate({ question: 'how is the alpha widget configured?', queryVec: STRAY })
    expect(seen.filter(([k]) => k === 'dim-mismatch')).toEqual([])

    // The control, so the silence above is the mode and not a debug channel that
    // never fires: the SAME corpus with vectors, asked with a vector of the
    // wrong width, still reports the disagreement it always did.
    const chunks = ROWS()
    const vectors = new Int8Array(chunks.length * 4)
    chunks.forEach((_, i) => vectors.set([127, 0, 0, 0], i * 4))
    const withVectors = assembleIndex({
      manifest: {
        version: 3,
        hash: `dense-${++fixtureCount}`,
        embedModel: 'test',
        dims: 4,
        vectors: 'vectors.h.bin',
        chunkCount: chunks.length,
        pages: chunks.map((c) => ({ path: c.path, title: `Page ${c.path}`, tail: 'Docs' })),
        guard: GUARD,
      },
      shards: [chunks],
      vectorBuffer: vectors.buffer,
      dfDoc: { df: {} },
    })
    const dense = []
    createRetrieval({
      index: withVectors,
      scope: ALL,
      guard: GUARD,
      onDebug: (kind, data) => dense.push([kind, data]),
    }).search({ query: 'invoices refunds', queryVec: Float64Array.from([1, 0]) })
    expect(dense.filter(([k]) => k === 'dim-mismatch')).toHaveLength(1)
  })

  it('scores the gate as lexical-only, against tauLexical', () => {
    const r = createRetrieval({ index: makeIndex(), scope: ALL, guard: GUARD })
    const hit = r.evaluate({ question: 'how is the alpha widget configured?', queryVec: STRAY })
    expect(hit.mode).toBe('lexical-only')
    // G is L alone, and the threshold is the lexical one — not the hybrid tau
    // with a dense channel silently contributing zero, which is the arrangement
    // that refuses the most on-topic question in a corpus.
    expect(hit.D).toBe(0)
    expect(hit.G).toBe(hit.L)
    expect(hit.threshold).toBe(GUARD.tauLexical)
    expect(hit.pass).toBe(true)

    const miss = r.evaluate({ question: 'quarterly hiring headcount', queryVec: STRAY })
    expect(miss.mode).toBe('lexical-only')
    expect(miss.pass).toBe(false)
    expect(miss.G).toBeLessThan(GUARD.tauLexical)
  })

  /**
   * The undefined/null distinction the composed channel runs on: undefined means
   * "no second query to score", null means "score it lexically". Collapsing them
   * when the vectors are dropped would silently switch follow-up questions off
   * on every lexical-only site — and `admissible` is the only observable that
   * tells the two apart, being non-null exactly when the composed channel ran.
   */
  it('keeps the composed channel for a follow-up', () => {
    const r = createRetrieval({ index: makeIndex(), scope: ALL, guard: GUARD })
    const asked = {
      question: 'and the token?',
      previousQuestion: 'how is the alpha widget configured?',
    }
    expect(r.evaluate({ ...asked, queryVec: STRAY, composedVec: STRAY }).admissible).not.toBe(null)
    // Genuinely absent stays absent: no second query was offered, so none ran.
    expect(r.evaluate({ ...asked, queryVec: STRAY }).admissible).toBe(null)
  })

  it('offers the closest pages for a refusal, by either entry point', () => {
    const r = createRetrieval({ index: makeIndex(), scope: ALL, guard: GUARD })
    const want = [{ path: '/c', title: 'Page /c', tail: 'Docs', origin: null }]
    expect(r.closest({ query: 'billing invoices', queryVec: null })).toEqual(want)
    // `closest` is the one entry point whose query vector never passes through
    // `rank`, so it drops it itself — otherwise it would score a live vector
    // against a null array and offer three pages chosen by arithmetic on
    // unrelated numbers.
    expect(r.closest({ query: 'billing invoices', queryVec: STRAY })).toEqual(want)
  })

  /**
   * A scope is still a hard filter, and a scoped refusal still answers — with
   * `wouldPassUnscoped` false, because that check is computed from the dense
   * cosines over the whole corpus and there are none. The widen affordance
   * therefore never renders on a lexical-only site. That is a consequence of the
   * mode rather than a decision this file is asserting is right; it is written
   * down so a future lexical unscoped check has a test to change.
   */
  it('answers inside a scope without reaching for a dense distribution', () => {
    const scoped = createRetrieval({
      index: makeIndex(),
      scope: { kind: 'page', paths: ['/b'], label: 'Beta' },
      guard: GUARD,
    })
    expect(scoped.search({ query: 'billing invoices', queryVec: STRAY })).toEqual([])
    expect(scoped.pages('/').map((p) => p.path)).toEqual(['/b'])
    const g = scoped.evaluate({ question: 'gamma billing invoices refunds', queryVec: STRAY })
    expect(g.pass).toBe(false)
    expect(g.wouldPassUnscoped).toBe(false)
    expect(g.unscopedG).toBe(null)
    expect(scoped.closest({ query: 'billing invoices', queryVec: STRAY, outsideScope: true })).toEqual([
      { path: '/c', title: 'Page /c', tail: 'Docs', origin: null },
    ])
  })

  it('refuses an empty corpus instead of throwing', () => {
    const empty = assembleIndex({
      manifest: {
        version: 3,
        hash: `lexical-empty-${++fixtureCount}`,
        embedModel: null,
        dims: 0,
        vectors: null,
        chunkCount: 0,
        pages: [],
        guard: GUARD,
      },
      shards: [[]],
      vectorBuffer: null,
      dfDoc: { df: {} },
    })
    const r = createRetrieval({ index: empty, scope: ALL, guard: GUARD })
    expect(r.search({ query: 'anything', queryVec: STRAY })).toEqual([])
    expect(r.evaluate({ question: 'anything', queryVec: STRAY }).pass).toBe(false)
  })
})

describe('readiness — what the mode is owed, and what it is not', () => {
  it('demands no embedding key, because no request is ever signed', () => {
    // The control: the same deployment with an embedder named is asked for one.
    const named = readiness(
      cfg({ embed: { provider: 'openai', model: 'text-embedding-3-small' }, indexDir: indexDir(WITH_VECTORS) }),
      ENV,
    )
    expect(named.missing.map((m) => m.what)).toContain(
      'embed: "openai" needs a key and none is set',
    )

    const declared = readiness(cfg({ embed: false, indexDir: indexDir(VECTORLESS) }), ENV)
    expect(declared.missing.filter((m) => m.what.startsWith('embed:'))).toEqual([])
    expect(declared.missing).toEqual([])
    expect(declared.ok).toBe(true)
  })

  // The chat half is still a chat half: an answering model still needs its key.
  it('still demands the chat key', () => {
    const c = cfg({ chat: { provider: 'openrouter' }, embed: false, indexDir: indexDir(VECTORLESS) })
    expect(readiness(c, ENV).missing.map((m) => m.what)).toContain(
      'chat: "openrouter" needs a key and none is set',
    )
    expect(readiness(c, { OPENROUTER_API_KEY: 'sk-or-x' }).missing).toEqual([])
  })

  /**
   * A NOTE, because nothing is missing — and it quotes the measurement, because
   * the config file cannot show the author the size of what they gave up. The
   * numbers are asserted verbatim: a note that says "retrieval will be worse"
   * is advice, and this one is evidence.
   */
  it('prints the measured cost of the mode as a note', () => {
    const r = readiness(cfg({ embed: false, indexDir: indexDir(VECTORLESS) }), ENV)
    const note = r.notes.find((n) => n.startsWith('embed: false'))
    expect(note).toMatch(/recall@8 0\.97 → 0\.41/)
    expect(note).toMatch(/retrieval F1 0\.35 → 0\.18/)
    expect(note).toMatch(/11 of 44 answerable questions refused outright/)
    // The cross-language sentence is a different failure and is said separately:
    // the lexical channel does not degrade for a question in another language
    // than the corpus, it scores zero.
    expect(note).toMatch(/scores zero/)
    expect(note).toMatch(/npx docpilot eval --gate-only --lexical/)
  })

  /**
   * Bandwidth, not behaviour: retrieval is exactly what was declared, and the
   * whole quantised blob is downloaded by every reader and never read. A note,
   * so the panel is not switched off over it.
   */
  it('notes an index that still carries vectors nothing will query', () => {
    const r = readiness(cfg({ embed: false, indexDir: indexDir(WITH_VECTORS) }), ENV)
    expect(r.ok).toBe(true)
    expect(r.notes.join(' ')).toMatch(/still carries vectors \("bge-m3", 1024d\)/)
    expect(r.notes.join(' ')).toMatch(/npx docpilot index/)
  })

  /**
   * The same disagreement from the other side, and a `missing` rather than a
   * note: the deployment pays for an embedder — a key, a bill, a self-hosted
   * service — embeds every question, and has nothing to score it in. It fails
   * silently because lexical-only is a working mode; the answers are merely
   * worse than the ones being paid for.
   */
  it('reports a configured embedder over a vectorless index as missing', () => {
    const r = readiness(cfg({ indexDir: indexDir(VECTORLESS) }), ENV)
    expect(r.ok).toBe(false)
    const found = r.missing.find((m) => m.what.includes('was built without vectors'))
    expect(found.what).toMatch(/embed names "ollama"/)
    // Both ways out, named: rebuild with vectors, or declare the mode.
    expect(found.fix).toMatch(/npx docpilot index/)
    expect(found.fix).toMatch(/embed: false/)
  })

  // The model-mismatch check is about two vector spaces, so it has nothing to
  // compare in a mode that has none — and `embedModel: null` must not be read as
  // a model that disagrees with the configured one.
  it('skips the embed-model comparison entirely', () => {
    const r = readiness(cfg({ embed: false, indexDir: indexDir(VECTORLESS) }), ENV)
    expect(r.missing.map((m) => m.what).join(' ')).not.toMatch(/but embed\.model is/)
  })
})

describe('loadIndex — three files, not four', () => {
  afterEach(() => {
    // The module memoises the load and only releases the memo on failure, so a
    // successful one would be returned to every later call. `__setIndex` is the
    // seam that puts it back.
    __setIndex(null)
    vi.unstubAllGlobals()
  })

  const MANIFEST = {
    version: 3,
    hash: 'h',
    embedModel: null,
    dims: 0,
    vectors: null,
    chunkCount: 1,
    shards: ['chunks-00.h.json'],
    df: 'df.h.json',
    pages: [{ path: '/a', title: 'Alpha', tail: 'Docs' }],
    guard: {},
  }
  const CHUNK = {
    id: 'a#one',
    path: '/a',
    anchor: 'one',
    title: 'Alpha',
    breadcrumb: 'Docs',
    kind: 'guide',
    text: 'The alpha widget.',
    prev: null,
    next: null,
  }

  /**
   * `${base}/${manifest.vectors}` with a null name is a request for
   * `${base}/null` — a file that was never written — and in that position a 404
   * fails the whole load rather than costing the dense channel. The panel would
   * be dead on a site whose index is exactly as it was meant to be.
   */
  it('never asks for a blob the manifest does not name', async () => {
    const asked = []
    const bodies = {
      '/docs/rag/manifest.json': MANIFEST,
      '/docs/rag/chunks-00.h.json': [CHUNK],
      '/docs/rag/df.h.json': { n: 1, df: {} },
    }
    vi.stubGlobal('fetch', async (url) => {
      asked.push(url)
      if (!(url in bodies)) throw new Error(`unexpected fetch: ${url}`)
      return { ok: true, json: async () => bodies[url] }
    })

    const index = await loadIndex('/docs/rag')
    expect(index.lexicalOnly).toBe(true)
    expect(index.vectors).toBe(null)
    expect(index.dims).toBe(0)
    expect(asked).toEqual([
      '/docs/rag/manifest.json',
      '/docs/rag/chunks-00.h.json',
      '/docs/rag/df.h.json',
    ])
  })

  /**
   * A manifest MISSING the key is a corrupt index, not a declared mode. Read
   * loosely it becomes the quietest failure this package has: the blob is never
   * fetched, the `chunkCount × dims` assertion is skipped, the browser embeds
   * every question anyway because the CONFIG names an embedder, nothing is
   * degraded, nothing is logged, and retrieval is BM25 for the life of the
   * deployment. It has to fail where it used to — on the fetch.
   */
  it('does not read an absent key as the declared mode', async () => {
    const { vectors, ...noKey } = MANIFEST
    expect(vectors).toBe(null)
    const bodies = {
      '/docs/rag/manifest.json': { ...noKey, embedModel: 'bge-m3', dims: 1024 },
      '/docs/rag/chunks-00.h.json': [CHUNK],
      '/docs/rag/df.h.json': { n: 1, df: {} },
    }
    vi.stubGlobal('fetch', async (url) => {
      if (url === '/docs/rag/undefined') return { ok: false, status: 404 }
      return { ok: true, json: async () => bodies[url] }
    })
    await expect(loadIndex('/docs/rag')).rejects.toThrow(/vectors → 404/)
  })
})

/**
 * The turn, pinned from its source.
 *
 * `submit()` is a whole turn — an index, a transport, a reactive store and a
 * model — and the three properties below are decisions taken inside it that no
 * return value carries out. They are read from the text for that reason, and
 * because the risk they guard against is a FOURTH site being added later without
 * the qualifier rather than one of these two being edited.
 */
/**
 * The browser's own half of the union.
 *
 * `configure` used to spread the settings key — `{...DEFAULTS.embed, ...(cfg.embed
 * || {})}` — which reads `false` as an absent key and spreads `'none'` character
 * by character. Both left the panel believing it embedded with `bge-m3`, and
 * because `embedTarget` falls back to the CHAT service for every field it does not
 * have, every turn POSTed an embedding to the chat endpoint, took the 404 as an
 * outage, and stamped its refusals `degraded`. Invisible on a generated config,
 * certain on the hand-written one `docs/install/web.md` documents first.
 */
describe('the client config — a union resolved at both ends', () => {
  const resolve = (embed, report = () => {}) => resolveClientEmbed({ embed }, report)

  it('reads both settings spellings as the declared mode', () => {
    for (const spelling of [false, 'none']) {
      expect(resolve(spelling)).toEqual({
        provider: null,
        baseURL: null,
        model: null,
        apiKey: null,
        lexicalOnly: true,
      })
    }
  })

  // The generated config carries the RESOLVED object, so the flag has to survive
  // a second pass: `themeDocPilot` is the path that must work without the
  // settings spelling ever reaching the browser.
  it('keeps the flag through a round trip from themeDocPilot', () => {
    const emitted = themeDocPilot(
      resolveDocPilot({ embed: false, chat: { provider: 'anthropic', model: 'claude-sonnet-5' } }),
    )
    expect(resolve(emitted.embed).lexicalOnly).toBe(true)
  })

  it('leaves an ordinary embedder exactly as the build emitted it', () => {
    const emitted = themeDocPilot(
      resolveDocPilot({ chat: { provider: 'openai', model: 'gpt-4o' } }),
    )
    expect(resolve(emitted.embed)).toEqual({ ...emitted.embed, apiKey: null, lexicalOnly: false })
  })

  // A config that says both things at once. The named half wins because it is the
  // half somebody typed, and the disagreement is reported rather than resolved in
  // silence — the mode decides whether a request is made at all.
  it('refuses the flag beside a named embedder, and says so', () => {
    const said = []
    const out = resolve({ provider: 'openai', model: 'text-embedding-3-small', lexicalOnly: true }, (m) =>
      said.push(m),
    )
    expect(out.lexicalOnly).toBe(false)
    expect(out.provider).toBe('openai')
    expect(said.join(' ')).toContain('embed: false')
  })

  it('falls back to the shipped embedder for a value that is neither', () => {
    const said = []
    expect(resolve(42, (m) => said.push(m)).lexicalOnly).toBe(false)
    expect(resolve(42, (m) => said.push(m)).model).toBe('bge-m3')
    expect(said.join(' ')).toContain('embed accepts')
  })

  // `'auto'` is the NODE spelling: it names a target the browser never resolves.
  // Arriving here it means a hand-written themeConfig copied the settings key, and
  // the shipped defaults are the honest reading of it — same service as chat.
  it('does not read the Node spelling as a mode', () => {
    expect(resolve('auto').lexicalOnly).toBe(false)
  })
})

describe('the turn — a declared mode is not an outage', () => {
  const src = readFileSync(new URL('../src/theme/docpilot/session.js', import.meta.url), 'utf8')

  /**
   * `degraded` drives the reader-facing `refusal.degraded` and `degraded.lead`,
   * whose sentence is that the semantic index is unavailable — a promise of a
   * better search once the outage clears, and a lie on a site that never had one
   * and never will.
   */
  it('marks no refusal degraded when the mode was chosen', () => {
    const sites = src.match(/degraded: mode === 'lexical-only'[^\n]*/g)
    expect(sites).toHaveLength(2)
    for (const site of sites) {
      expect(site).toContain("mode === 'lexical-only' && !cfg.embed.lexicalOnly")
    }
  })

  /**
   * No network call and no allowance spent on a service the config declined to
   * name — and nothing on the console, which the outage path prints once per
   * question for the lifetime of the site.
   */
  it('reaches the gate without asking anyone to embed the question', () => {
    const branch = src.match(/if \(cfg\.embed\.lexicalOnly\) \{[\s\S]*?\n    \} else \{/)[0]
    expect(branch).toContain("mode = 'lexical-only'")
    expect(branch).toContain("state.retrieval = 'lexical-only'")
    expect(branch).not.toContain('embed(')
    expect(branch).not.toContain('embedderMatchesIndex')
    expect(branch).not.toContain('console.error')
    // `retrievalError` is cleared above the branch and left alone inside it: a
    // reason filed there is a reason the panel offers the reader.
    expect(branch).not.toContain('state.retrievalError =')
  })

  /**
   * Two nulls meeting is not agreement. A vectorless index names no model and a
   * declared mode names none either, so the comparison would come back true
   * anyway — until a hand-written themeConfig leaves `embed.model` at its
   * default and puts a name back on one side.
   */
  it('has nothing for the embedder-versus-index check to disagree about', () => {
    const fn = src.match(/function embedderMatchesIndex\(\) \{[\s\S]*?\n\}/)[0]
    expect(fn).toContain('if (state.config.embed.lexicalOnly) return true')
  })

  /**
   * The composed channel is a STRING operation, and it runs without a vector.
   * `undefined` skips it, `null` runs it lexically, and the old condition —
   * "compose only where there is a query vector" — could only ever produce
   * undefined here, which switched follow-ups off on the one deployment shape
   * that has no dense channel to fall back to. `docpilot calibrate` sweeps
   * `tauLexical` with that channel running, so the browser skipping it scores
   * every follow-up against a threshold measured on a gate it does not run.
   */
  it('runs the composed channel without a vector rather than skipping it', () => {
    expect(src).toContain("if (antecedent && mode === 'lexical-only') {\n      composedVec = null")
    expect(src).toContain('} else if (antecedent && queryVec) {')
  })

  /**
   * `mode` says lexical-only for a declared site and for a broken embedder
   * alike, and `src/feedback/stratum.js` drops one of those on grounds that are
   * false for the other. The record carries the difference because nothing else
   * in it can: `retrieval` is the same string in both cases too.
   */
  it('files with each vote whether the mode was chosen or failed', () => {
    expect(src).toContain(
      "degraded: turn.gate.mode === 'lexical-only' && !state.config.embed.lexicalOnly,",
    )
  })
})

/**
 * The feedback loop, which is the only way a deployed site grows the probe set
 * its own calibration needs.
 *
 * On a declared no-embed site EVERY record is lexical-only, so a reader that
 * discards the mode discards the whole population — and it did, with a note
 * telling the reviewer retrieval had been degraded on a site that never had a
 * dense channel to lose.
 */
describe('votes from a site that was built this way', () => {
  const record = (over = {}) => ({
    messageId: 'm1',
    question: 'how do I rotate a key?',
    verdict: 'down',
    reasons: ['wrong'],
    refusal: 'no-evidence',
    scope: { kind: 'all', paths: [] },
    gate: {
      G: 0.21,
      tau: 0.3,
      mode: 'lexical-only',
      degraded: false,
      n: 40,
      channel: 'raw',
      antecedent: null,
      wouldPassUnscoped: false,
    },
    ...over,
  })

  it('proposes the probe the lexical threshold is swept on', () => {
    const [c] = aggregate([record()])
    expect(c.target).toBe('calibration')
    expect(c.stratum).toBe('U')
    // The record's `tau` is whatever it was scored against, and naming the
    // wrong one is how a threshold gets moved in the wrong file.
    expect(c.note).toContain('tauLexical')
    expect(c.gate.degraded).toBe(0)
  })

  it('still drops the turn whose embedder was down', () => {
    const outage = record({ gate: { ...record().gate, degraded: true } })
    const [c] = aggregate([outage])
    expect(c.target).toBe('none')
    expect(c.note).toContain('degraded')
    expect(c.gate.degraded).toBe(1)
  })

  /**
   * A record written before the panel filed the difference can only be the
   * outage — that was the only way the mode existed then — so it keeps the
   * reading it was written under rather than quietly joining the declared
   * population.
   */
  it('reads a record that predates the field as the outage it must have been', () => {
    const { degraded, ...gate } = record().gate
    expect(degraded).toBe(false)
    const [c] = aggregate([record({ gate })])
    expect(c.target).toBe('none')
    expect(c.gate.degraded).toBe(1)
  })
})

/**
 * The builder writes the manifest inside `main()`, which reads the project's own
 * config off disk — so the three keys that define the format are pinned from the
 * source text. They have to be written TOGETHER: `assembleIndex` reads `vectors`,
 * `logDocPilot` and `readiness` read `embedModel` and `dims` beside it, and a
 * build that emitted one without the others would produce an index every layer
 * above disagrees about.
 */
describe('the build — what a lexical-only index writes', () => {
  const src = readFileSync(new URL('../src/build/build-rag-index.js', import.meta.url), 'utf8')

  // The config alone is enough; the flag is the one-off override. Read before
  // the target is resolved, so a build that names an embedder it will not use
  // cannot fail on a key it was never going to send.
  it('takes the mode from the config as well as from the flag', () => {
    expect(src).toContain(
      "const NO_EMBED = process.argv.includes('--no-embed') || noEmbed(docPilot)",
    )
    expect(src).toContain('if (!DRY && !NO_EMBED && !EMBED_URL)')
  })

  /**
   * `vectorless`, not `NO_EMBED` — and the difference is the whole of
   * `embed.fallback`.
   *
   * `NO_EMBED` is what the build was TOLD: `embed: false`, or `--no-embed`.
   * Since the fallback landed there is a second way to arrive here — an embedder
   * was configured, refused, and the config said a vectorless index was
   * preferred to no index — and the three writes below must read the mode the
   * build ARRIVED AT. A manifest that named an embedder the build never reached
   * is a manifest the browser believes.
   */
  it('names no blob, writes none, and records the mode in the manifest', () => {
    expect(src).toContain('const vecName = vectorless ? null : `vectors.${hash}.bin`')
    expect(src).toContain('if (vecName) fs.writeFileSync(path.join(OUT, vecName)')
    expect(src).toContain('embedModel: vectorless ? null : EMBED_MODEL,')
    expect(src).toContain('vectors: vecName,')
    // The declared mode still seeds it, so `embed: false` never embeds at all.
    expect(src).toContain('let vectorless = NO_EMBED')
  })

  // A build log that merely omits the quantisation error and the vector file
  // line is indistinguishable from one where embedding was skipped by accident.
  // That index still deploys, so the difference has to be visible where it is
  // made.
  it('says on the build log that the index has no vectors', () => {
    expect(src).toMatch(/console\.log\('  retrieval\s+lexical-only \(BM25\)/)
    expect(src).toContain("console.log('    no vectors file  lexical-only")
  })
})

/**
 * The three on-disk readers of the same artefact, pinned together.
 *
 * `eval/run.js`, `eval/calibrate.js` and `eval/answer-bench.js` each carry their
 * own `loadIndex()` — deliberately, since the browser's fetches cannot reach a
 * file — and each one reads `manifest.vectors` before it can know what it is
 * holding. `bench` is dispatched at the top level of its module, so an
 * unguarded `path.join(RAG, null)` there throws an ERR_INVALID_ARG_TYPE before
 * any of the command's own diagnostics run. Read from the source because
 * importing any of these three starts a CLI.
 */
describe('the eval commands — all three loaders, not two', () => {
  const readers = ['run.js', 'calibrate.js', 'answer-bench.js'].map((f) => [
    f,
    readFileSync(new URL(`../src/eval/${f}`, import.meta.url), 'utf8'),
  ])

  it.each(readers)('%s reads no blob a vectorless manifest does not name', (_f, src) => {
    expect(src).toContain('if (manifest.vectors !== null) {')
    // STRICT, matching `indexInfo` in config.js: a manifest missing the key is a
    // corrupt index rather than a declared mode, and `!= null` would answer it
    // with the mode.
    expect(src).not.toContain('manifest.vectors != null')
  })

  // The loader alone is half a fix: the bench embeds every question and every
  // composed follow-up, against a model and a host that are both null here.
  it('answer-bench embeds nothing on an index with no vector space', () => {
    const src = readers.find(([f]) => f === 'answer-bench.js')[1]
    const fn = src.match(/async function task\(\{[\s\S]*?\n    const g = retrieval\.evaluate/)[0]
    expect(fn).toContain('const vectorless = index.manifest.vectors === null')
    expect(fn).toContain('const vec = vectorless\n      ? null')
    // `null` runs the composed channel with no vector; `undefined` skips it.
    // Skipping it scores every follow-up on the raw question alone.
    expect(fn).toContain('composedVec = vectorless\n        ? null')
  })
})

/**
 * Saying it out loud — the one place a reader is told this site has no embedder.
 *
 * Every other assertion in this file is about NOT reporting the declared mode as
 * an outage: no console line, no `degraded` on the refusal, no retry against a
 * service nobody configured. This is the other half of that decision, and it was
 * missing. Silence is right for a refusal, which is about one question; it is
 * wrong for the composer, where the reader is choosing what to ask and lexical
 * retrieval scores ZERO for a question in a language the corpus is not written
 * in. A site can now state the limit without stating a failure.
 *
 * It rides `budget.showRemaining`, which is the same muted line and the same
 * question from the reader's side: what is this next question limited to. A
 * project that asked the panel not to discuss its own limits is not told about
 * this one either.
 */
describe('embed: false — the panel may say so under the composer', () => {
  const panel = readFileSync(
    new URL('../src/theme/components/DocPilot.vue', import.meta.url),
    'utf8',
  )

  it('is silent on the shipped defaults', () => {
    const client = themeDocPilot(cfg({ chat: { provider: 'ollama', model: 'x' }, embed: false }))
    expect(client.embed.lexicalOnly).toBe(true)
    // Both halves of the line are off, so there is no paragraph at all — which
    // is the state every site that writes nothing is in.
    expect(client.budget.showRemaining).toBe(false)
  })

  it('is offered by the switch that offers the request count', () => {
    const client = themeDocPilot(
      cfg({
        chat: { provider: 'ollama', model: 'x' },
        embed: false,
        budget: { showRemaining: true },
      }),
    )
    expect(client.budget.showRemaining).toBe(true)
    expect(client.embed.lexicalOnly).toBe(true)
  })

  // The two conditions the component ANDs, pinned on the source: there is no
  // mounted-component harness in this suite, and what matters about this line is
  // which two facts gate it.
  it('reads the declared mode, not the runtime one', () => {
    expect(panel).toContain(
      "s.config.budget.showRemaining && s.config.embed.lexicalOnly ? T('error.noEmbedder') : ''",
    )
    // `state.retrieval` is the same word arrived at by the other route — an
    // embedder that was configured and could not be reached — and it is only
    // known after a question has been asked. This line has to be readable
    // before the reader types one.
    expect(panel).not.toContain('s.retrieval ===')
  })

  // One paragraph, either half, or neither — and the count keeps its own name so
  // the low-budget sentence beside it still tracks the count rather than the note.
  it('joins the two halves into one line', () => {
    expect(panel).toContain(
      "const statusLine = computed(() => [budgetLine.value, embedNote.value].filter(Boolean).join(' · '))",
    )
    expect(panel).toContain('v-if="statusLine"')
    expect(panel).toContain('const budgetLowDue = computed(() => oneShot.value && !!budgetLine.value)')
  })

  it('has copy that names the mode rather than a failure', () => {
    const shipped = readFileSync(
      new URL('../src/theme/docpilot/i18n.js', import.meta.url),
      'utf8',
    )
    expect(shipped).toContain(
      "noEmbedder: 'No embedding model — search matches words only.',",
    )
  })
})

/**
 * `embed.fallback: 'lexical'` — a vectorless index PREFERRED TO NO INDEX.
 *
 * Without it `npx docpilot index` dies when the embedder will not answer, and
 * that stays the default: an index quietly missing its vectors is a site whose
 * retrieval got materially worse with nothing said. The fallback is the author
 * answering that question in advance, and everything below exists to make sure
 * it is answered ONCE — in the config — rather than arriving as a surprise.
 *
 * It is the same mode `embed: false` already ships. That is the whole argument
 * for it: no second vector space, nothing new for the browser to reach, and the
 * ~1000 lines above already cover what a vectorless index does.
 */
describe("embed.fallback: 'lexical' — when the embedder will not answer", () => {
  const src = readFileSync(
    new URL('../src/build/build-rag-index.js', import.meta.url),
    'utf8',
  )

  /**
   * The key describes WHAT TO DO, not WHICH embedder — so it must not decide
   * which arm of the resolver runs. Left in the object it would take the
   * explicit-split arm and produce a provider of `undefined`, which
   * `assertProviders` then reports as a broken config for a key used correctly.
   */
  it('is lifted out of the arm dispatch, so it can ride on `auto`', () => {
    const auto = resolveEmbed(cfg({}))
    const withFb = resolveEmbed(cfg({ embed: { fallback: 'lexical' } }))
    expect(withFb.provider).toBe(auto.provider)
    expect(withFb.model).toBe(auto.model)
    expect(withFb.fallback).toBe('lexical')
    expect(auto.fallback).toBe(null)
  })

  it('rides on an explicit split too, without disturbing it', () => {
    const plain = resolveEmbed(cfg({ embed: { provider: 'openrouter' } }))
    const withFb = resolveEmbed(cfg({ embed: { provider: 'openrouter', fallback: 'lexical' } }))
    expect(withFb).toEqual({ ...plain, fallback: 'lexical' })
  })

  // A borrowed embedder is still an embedder that can refuse.
  it('rides on the borrowed pool a chat-only provider falls back to', () => {
    const e = resolveEmbed(cfg({ chat: { provider: 'anthropic' }, embed: { fallback: 'lexical' } }))
    expect(e.borrowed).toBe('anthropic')
    expect(e.fallback).toBe('lexical')
  })

  it('accepts only the one word, and states the key on every arm', () => {
    for (const embed of [undefined, false, 'none', 'auto', { provider: 'ollama' }]) {
      const e = resolveEmbed(cfg(embed === undefined ? {} : { embed }))
      expect(Object.hasOwn(e, 'fallback'), JSON.stringify(embed)).toBe(true)
      expect(e.fallback).toBe(null)
    }
    // Anything else is not the fallback, and does not silently become one.
    expect(resolveEmbed(cfg({ embed: { fallback: 'ollama' } })).fallback).toBe(null)
    expect(resolveEmbed(cfg({ embed: { fallback: true } })).fallback).toBe(null)
  })

  /**
   * ONE EXIT. `createEmbedder` was built with a single `fail` — no model and no
   * pool, every pool member refusing the probe, the chosen model dying mid-pass
   * with nothing left to restart on — so the fallback needs exactly one place to
   * live, and the sentinel is how it leaves a function whose contract says
   * `fail` never returns.
   */
  it('takes over at the indexer’s single point of failure', () => {
    expect(src).toContain('class LexicalFallback extends Error {}')
    expect(src).toContain('if (!EMBED_FALLBACK_LEXICAL) die(m)')
    expect(src).toContain('throw new LexicalFallback(m)')
    expect(src).toContain('if (!(e instanceof LexicalFallback)) throw e')
    // Only ours is swallowed; a real failure still belongs to the caller.
    expect(src).toContain('    return null')
  })

  // The size of what was given up, at the moment it is given up. A build log
  // that merely stopped mentioning vectors would be indistinguishable from one
  // where embedding was skipped by accident.
  it('says on the build log what it cost', () => {
    expect(src).toContain('FELL BACK')
    expect(src).toContain('recall@8 0.97 → 0.41')
    expect(src).toContain('WITHOUT VECTORS')
  })

  /**
   * The deployment is running the mode it declared for this case, so this is a
   * NOTE — and it carries the measurement, because nothing about the site
   * changed to cause it.
   */
  it('is a note, not a missing, when the config declared it', () => {
    const dir = indexDir(VECTORLESS)
    const settings = resolveDocPilot({
      chat: { provider: 'ollama' },
      embed: { provider: 'ollama', model: 'bge-m3', fallback: 'lexical' },
      indexDir: dir,
    })
    const r = readiness(settings, {})
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.notes.join(' ')).toContain('WITHOUT VECTORS')
    expect(r.notes.join(' ')).toContain('recall@8 0.97 → 0.41')
  })

  // Undeclared, it is exactly as fatal as it was: a site paying for semantic
  // retrieval and getting BM25 is the failure this branch was written for.
  it('stays fatal when the config declared nothing', () => {
    const dir = indexDir(VECTORLESS)
    const settings = resolveDocPilot({
      chat: { provider: 'ollama' },
      embed: { provider: 'ollama', model: 'bge-m3' },
      indexDir: dir,
    })
    const r = readiness(settings, {})
    expect(r.ok).toBe(false)
    expect(r.missing.map((m) => m.what).join(' ')).toContain('without vectors')
    // And the message now offers the fallback as one of the ways out.
    expect(r.missing.map((m) => m.fix).join(' ')).toContain("fallback: 'lexical'")
  })

  /**
   * THE INDEX GETS A VOTE. Without this the browser embeds every question and
   * the retriever drops the vector on the floor — a request per turn for a
   * channel that cannot score — and the panel never tells the reader why the
   * answers got worse.
   */
  it('makes the browser stop embedding into an index with nothing to score', () => {
    const dir = indexDir(VECTORLESS)
    const client = themeDocPilot(
      resolveDocPilot({
        chat: { provider: 'ollama' },
        embed: { provider: 'ollama', model: 'bge-m3', fallback: 'lexical' },
        indexDir: dir,
      }),
    )
    expect(client.embed).toEqual({ provider: null, baseURL: null, model: null, lexicalOnly: true })
  })

  // A statement about the INDEX, not the config — so an index WITH vectors is
  // untouched however the fallback is set.
  it('leaves a normal index alone', () => {
    const dir = indexDir({ ...VECTORLESS, embedModel: 'bge-m3', dims: 1024, vectors: 'vectors.h.bin' })
    const client = themeDocPilot(
      resolveDocPilot({
        chat: { provider: 'ollama' },
        embed: { provider: 'ollama', model: 'bge-m3', fallback: 'lexical' },
        indexDir: dir,
      }),
    )
    expect(client.embed.lexicalOnly).toBe(false)
    expect(client.embed.model).toBe('bge-m3')
  })

  // No index on disk is UNKNOWN, not vectorless. A project that has not run the
  // indexer yet must emit exactly what it emitted before this feature existed.
  it('treats a missing index as unknown rather than vectorless', () => {
    const client = themeDocPilot(
      resolveDocPilot({
        chat: { provider: 'ollama' },
        embed: { provider: 'ollama', model: 'bge-m3', fallback: 'lexical' },
        indexDir: path.join(tmpdir(), 'docpilot-no-such-index-dir'),
      }),
    )
    expect(client.embed.lexicalOnly).toBe(false)
  })
})
