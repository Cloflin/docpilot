import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

import {
  stripImages,
  collapseWhitespace,
  normaliseMarkdown,
  applyLlmTags,
} from '../src/build/lib/normalise.js'
import { chunkMarkdown, slug } from '../src/build/lib/chunker.js'
import { resolveSections, orphanPages } from '../src/build/lib/sections.js'
import { l2normalise, toInt8, cosineInt8 } from '../src/build/lib/quantize.js'
import { terms, norm, stemLite } from '../src/theme/docpilot/text.js'
import {
  lexicalCoverage,
  denseFromCosine,
  verdict,
  assertWeights,
  composeQuery,
  admissible,
  foreignTail,
} from '../src/theme/docpilot/gate.js'
import { chat, detectTools, parseFallback, splitOpenThink, splitThink, streamingAnswerText } from '../src/theme/docpilot/llm.js'
import { providerFor } from '../src/theme/docpilot/providers.js'
import {
  systemText,
  buildMessages,
  clampAddendum,
  clampQuote,
  QUOTE_WRAPPER,
  QUOTE_MAX,
  HISTORY_QUOTE_MAX,
  detectLanguage,
  languageDirective,
  promptDocument,
  coreText,
  promptHash,
  localeOf,
  CORE,
  LEXICAL_DOC,
} from '../src/theme/docpilot/prompt.js'
import {
  isKnownPath,
  renderAnswer,
  renderPassage,
  toPlainText,
} from '../src/theme/docpilot/markdown.js'
import { GLYPHS, SYMBOLS, symbolId } from '../src/theme/docpilot/glyphs.js'
import { highlight, __setHighlighterForTests } from '../src/theme/docpilot/highlight.js'
import { identifiers, computeSupport } from '../src/theme/docpilot/support.js'
import {
  findSecrets,
  hasSecret,
  redactSecrets,
  credentialCopy,
  CREDENTIAL_LANGUAGES,
  MASK,
} from '../src/theme/docpilot/credentials.js'
import {
  tokenF1,
  wilsonUpper95,
  languageMatch,
  retrievalF1Loose,
  hardGatesFailed,
  underPath,
  recallAtK,
} from '../src/eval/metrics.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sweepRow,
  chooseTau,
  contiguousScope,
  TAU_STEPS,
  dOf,
  regate,
  chooseWindow,
  STRATA,
  fitWindowAtTau,
  pickAnchors,
  WINDOWS,
} from '../src/eval/calibrate.js'
import { guardFor, tuningFor } from '../src/build/build-rag-index.js'
import {
  LEVELS,
  DEFAULT_RECORD_LEVEL,
  DEFAULT_RUN_LEVEL,
  levelRank,
  recordLevel,
  filterByLevel,
  parseLevelArg,
  levelHistogram,
} from '../src/eval/levels.js'
import { previousReport, writeReport } from '../src/eval/report.js'
import { lintRecords, levelSummary } from '../src/eval/lint-golden.js'
import { mmr, pageCap, resolveLevers, LEVER_NAMES } from '../src/theme/docpilot/retriever.js'
import { parseRange, chooseCell, buildTuningDoc } from '../src/eval/tune.js'
import { TUNING_OUT, CALIBRATION_OUT } from '../src/cli-context.js'
import {
  resolveSuggestions,
  themeDocPilot,
  resolveDocPilot,
  readiness,
  proxyContract,
  SERVER_ONLY,
  // ui-specs/009 rule 11 walks it: every leaf here either reaches the panel or
  // is named in SERVER_ONLY, and every one of them is written down in the
  // configuration reference.
  DEFAULTS,
  THEME_ONLY,
} from '../src/config.js'
import { resolveUi, UI_DEFAULTS, UI_TRIGGERS } from '../src/theme/docpilot/ui.js'
import {
  record as recordFeedback,
  resolveFeedback,
  COMMENT_MAX,
  FEEDBACK_SENDS,
} from '../src/theme/docpilot/feedback.js'
import { STRATA } from '../src/eval/calibrate.js'
import { aggregate, merge, normalise, dedupe } from '../src/feedback/aggregate.js'
import { suggest, TARGETS } from '../src/feedback/stratum.js'
import { parseRows, fetchRows, TOKEN_ENV } from '../src/feedback/source.js'
import { renderReport } from '../src/feedback/report.js'
import { bindHotkey, unbindHotkey, hotkeyRefCount } from '../src/theme/docpilot/hotkey.js'
import { configure, state as sessionState } from '../src/theme/docpilot/session.js'
import {
  createHistory,
  slimTurn,
  conversationTitle,
  relativeParts,
} from '../src/theme/docpilot/history.js'
import * as session from '../src/theme/docpilot/session.js'
import { __setHistoryForTests } from '../src/theme/docpilot/session.js'
import { parseAllowlist, checkSource } from '../src/build/lib/sources.js'
import { absoluteSidebar } from '../src/sidebar.js'
import { detectSocial, socialCopy, SOCIAL_LANGUAGES } from '../src/theme/docpilot/social.js'
import { createRetrieval, ScopeEscape } from '../src/theme/docpilot/retriever.js'
import { excerptWindow } from '../src/theme/docpilot/excerpt.js'
import { runTurn } from '../src/theme/docpilot/harness.js'
import { assembleIndex } from '../src/theme/docpilot/store.js'
import {
  KEY_PATHS,
  resolveI18n,
  validateI18n,
  t,
  normaliseLocale,
  summariseI18n,
} from '../src/theme/docpilot/i18n.js'

describe('normalise — llm content tags', () => {
  it('drops an llm-exclude block WITH its content', () => {
    const src = ['keep me', '<llm-exclude>', 'marketing filler', '</llm-exclude>', 'keep me too'].join('\n')
    const out = applyLlmTags(src)
    expect(out).toContain('keep me')
    expect(out).toContain('keep me too')
    expect(out).not.toContain('marketing filler')
  })

  it('unwraps an llm-only block and keeps its content', () => {
    const src = ['intro', '<llm-only>', 'Autosaving is configured with autoSaveInterval.', '</llm-only>'].join('\n')
    const out = applyLlmTags(src)
    expect(out).toContain('autoSaveInterval')
    expect(out).not.toContain('<llm-only>')
  })

  it('leaves both tags verbatim inside a fenced block', () => {
    const src = ['```md', '<llm-only>', 'shown to models only', '</llm-only>', '```'].join('\n')
    expect(applyLlmTags(src)).toBe(src)
  })

  it('handles a block spanning several paragraphs', () => {
    const src = ['a', '<llm-exclude>', 'one', '', 'two', '', 'three', '</llm-exclude>', 'b'].join('\n')
    const out = applyLlmTags(src)
    expect(out).toContain('a')
    expect(out).toContain('b')
    for (const gone of ['one', 'two', 'three']) expect(out).not.toContain(gone)
  })

  it('handles the inline single-line forms', () => {
    expect(applyLlmTags('x <llm-exclude>gone</llm-exclude> y').trim()).toBe('x  y')
    expect(applyLlmTags('x <llm-only>kept</llm-only> y').trim()).toBe('x kept y')
  })

  it('excludes to end of file when the tag is never closed, and warns', () => {
    const warnings = []
    const out = applyLlmTags(['a', '<llm-exclude>', 'b', 'c'].join('\n'), (m) => warnings.push(m))
    expect(out.trim()).toBe('a')
    expect(warnings[0]).toMatch(/unclosed/)
  })

  /**
   * The page most likely to name these tags is the page documenting them, and
   * naming one in backticks used to open the state machine: `reference/cli` said
   * "this pass may add `<llm-only>` and `<llm-exclude>`" and lost every line after
   * that sentence from the index, silently, on a page nobody had marked private.
   */
  it('reads a tag named in backticks as prose, not as a directive', () => {
    const warnings = []
    const src = ['may add `<llm-only>` and `<llm-exclude>` and nothing else', 'still indexed'].join(
      '\n',
    )
    const out = applyLlmTags(src, (m) => warnings.push(m))
    expect(out).toBe(src)
    expect(warnings).toEqual([])
  })

  // The safety rule is unchanged for a tag somebody actually wrote — quoting one
  // earlier on the page must not disarm the next real one.
  it('still excludes to end of file when a real tag follows a quoted one', () => {
    const warnings = []
    const out = applyLlmTags(
      ['doc `<llm-exclude>` here', '<llm-exclude>', 'secret'].join('\n'),
      (m) => warnings.push(m),
    )
    expect(out.trim()).toBe('doc `<llm-exclude>` here')
    expect(warnings[0]).toMatch(/unclosed/)
  })

  it('keeps a line that is nothing but a code span', () => {
    expect(applyLlmTags('`<llm-exclude>`')).toBe('`<llm-exclude>`')
  })

  it('runs before stripHtml, so exclude never survives the full pipeline', () => {
    const { text } = normaliseMarkdown('---\ntitle: T\n---\n\n<llm-exclude>\nsecret\n</llm-exclude>\n\nvisible')
    expect(text).toContain('visible')
    expect(text).not.toContain('secret')
  })

  it('reads the frontmatter description', () => {
    const { description } = normaliseMarkdown('---\ntitle: T\ndescription: How to wire the editor.\n---\n\nbody')
    expect(description).toBe('How to wire the editor.')
  })
})

/**
 * The markdown pass used to skip the whole `/reference/` PREFIX, with the comment
 * "generated stubs; the YAML is indexed instead". True of the stub an OpenAPI spec
 * generates, and of nothing else: every hand-written reference page a project keeps
 * under that path was dropped from its own index in silence — this package lost
 * `config`, `cli`, `highlighting` and `skills`, printed `sidebar link has no
 * indexed content: /reference/config` on every build, and answered questions about
 * its own documented settings with "not in the docs". A spec claims one route.
 */
describe('the index — which /reference/ routes a spec claims', () => {
  const src = fs.readFileSync(new URL('../src/build/build-rag-index.js', import.meta.url), 'utf8')

  it('skips no route on a project that publishes no spec', () => {
    // The blanket prefix skip and the comment that justified it. `kindFor` still
    // tests the same prefix one line apart, and legitimately — it classifies a
    // page, it does not drop one.
    expect(src).not.toMatch(/startsWith\('\/reference\/'\)\) continue/)
    expect(src).toMatch(/specRoutes\.has\(route\)\) continue/)
  })

  it('derives the claimed routes from the spec filenames', () => {
    expect(src).toMatch(/specRoutes = new Set\(specs\.map\(/)
    // Resolved above the markdown loop, which needs the answer before it decides.
    expect(src.indexOf('const specRoutes')).toBeLessThan(src.indexOf('for (const file of files)'))
  })
})

describe('normalise — images and whitespace', () => {
  it('drops a data: URI image and keeps its alt', () => {
    const src = `| \`accordion\` | <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E" alt="accordion"> |`
    expect(stripImages(src)).toBe('| `accordion` | accordion |')
  })

  it('survives a payload containing literal quotes and >', () => {
    const src = `<img src="data:image/svg+xml,%3Csvg a='b'%3E>x" alt="ok">`
    expect(stripImages(src).trim()).toBe('ok')
  })

  it('collapses table padding but never touches fenced code', () => {
    const src = ['| a    |    b |', '```js', 'if (x) {', '    indented()', '}', '```'].join('\n')
    const out = collapseWhitespace(src)
    expect(out).toContain('| a | b |')
    expect(out).toContain('    indented()')
  })

  it('is what actually shrinks the icons page, not the URI strip alone', () => {
    const row = `| \`i\` | <img src="data:image/svg+xml,${'x'.repeat(2000)}" alt="i"> |${' '.repeat(2000)}`
    const src = Array.from({ length: 20 }, () => row).join('\n')
    const out = collapseWhitespace(stripImages(src))
    expect(out.length).toBeLessThan(src.length * 0.05)
    expect(out).toContain('`i`')
  })

  it('keeps frontmatter title and flattens links', () => {
    const { title, text } = normaliseMarkdown('---\ntitle: T\n---\n\nsee [Auth](/getting-started/authentication)')
    expect(title).toBe('T')
    expect(text).toContain('Auth (/getting-started/authentication)')
  })
})

describe('chunker', () => {
  const page = ['# Page', 'intro text here', '## One', 'a'.repeat(600), '## Two', 'b'.repeat(600)].join('\n\n')

  it('splits at H2 and carries a context line', () => {
    const { chunks } = chunkMarkdown({ src: page, path: '/p', kind: 'guide' })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[chunks.length - 1].text.startsWith('Page — Two')).toBe(true)
  })

  it('disambiguates repeated headings the way VitePress does', () => {
    // Bodies must clear the merge floor, or rule 4 folds the two sections into
    // one and there is no second anchor to disambiguate.
    const src = `# P\n\n## Use cases\n\n${'x'.repeat(600)}\n\n## Use cases\n\n${'y'.repeat(600)}`
    const { chunks } = chunkMarkdown({ src, path: '/p', kind: 'guide' })
    const anchors = chunks.map((c) => c.anchor)
    expect(new Set(anchors).size).toBe(anchors.length)
    expect(anchors).toContain('use-cases-1')
  })

  it('never emits a chunk over the ceiling', () => {
    const huge = `# P\n\n## Big\n\n${'z'.repeat(50000)}`
    const { chunks } = chunkMarkdown({ src: huge, path: '/p', kind: 'guide' })
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(8000)
  })

  it('keeps prev/next inside one page', () => {
    const { chunks } = chunkMarkdown({ src: page, path: '/p', kind: 'guide' })
    expect(chunks[0].prev).toBeNull()
    expect(chunks[chunks.length - 1].next).toBeNull()
  })

  it('slugs headings', () => expect(slug('How-To: Build `x`')).toBe('how-to-build-x'))
})

describe('sections', () => {
  const sidebar = {
    '/': [
      {
        items: [
          {
            text: 'Getting Started',
            base: '/getting-started/',
            link: 'creating-an-application',
            items: [{ text: 'A', link: 'creating-an-application' }, { text: 'B', link: 'authentication' }],
          },
          { text: 'Loose', link: '/introduction' },
        ],
      },
    ],
  }

  it('registers a group and includes its own link at index 0', () => {
    const { sections } = resolveSections(sidebar)
    const gs = sections.find((s) => s.label === 'Getting Started')
    expect(gs.paths).toContain('/getting-started/creating-an-application')
    expect(gs.paths).toContain('/getting-started/authentication')
  })

  it('never registers a node without items as a section', () => {
    const { sections } = resolveSections(sidebar)
    expect(sections.find((s) => s.label === 'Loose')).toBeUndefined()
  })

  it('reports pages that belong to no group', () => {
    const { sections } = resolveSections(sidebar)
    expect(orphanPages(['/introduction', '/getting-started/authentication'], sections)).toEqual(['/introduction'])
  })
})

/**
 * VitePress accepts a sidebar in two shapes. Only one was handled, and the flat
 * one — which is what every small site writes — took the whole index build down
 * with `(nodes || []) is not iterable` from three frames deep.
 */
describe('sections — both sidebar shapes', () => {
  const flat = [
    { text: 'Guide', base: '/guide/', items: [{ text: 'Start', link: 'start' }] },
  ]
  const byRoute = { '/guide/': flat }

  it('reads a flat SidebarItem[]', () => {
    const { sections } = resolveSections(flat)
    expect(sections.map((s) => s.label)).toEqual(['Guide'])
    expect(sections[0].paths).toEqual(['/guide/start'])
  })

  it('reads a route-keyed object, and agrees with the flat form', () => {
    const a = resolveSections(flat)
    const b = resolveSections(byRoute)
    expect(a.sections.map((s) => s.paths)).toEqual(b.sections.map((s) => s.paths))
  })

  it('survives a sidebar that is absent or not an object', () => {
    for (const bad of [undefined, null, 'nonsense', 42]) {
      expect(resolveSections(bad).sections, String(bad)).toEqual([])
    }
  })
})

describe('quantize', () => {
  it('round-trips within the build-time tolerance', () => {
    const a = l2normalise(Array.from({ length: 768 }, (_, i) => Math.sin(i)))
    const b = l2normalise(Array.from({ length: 768 }, (_, i) => Math.cos(i / 3)))
    let exact = 0
    for (let i = 0; i < a.length; i++) exact += a[i] * b[i]
    expect(Math.abs(exact - cosineInt8(toInt8(a), toInt8(b)))).toBeLessThan(0.01)
  })
})

describe('text', () => {
  it('trims sentence punctuation off token edges', () => {
    expect(terms('Initialise the editor.')).toEqual(terms('Initialise the editor'))
  })
  it('keeps dots inside identifiers', () => expect(terms('Plugin.init')).toContain('plugin.init'))
  it('strips zero-width characters', () => expect(norm('ed​itor')).toBe('editor'))
  it('drops function words in three languages', () => {
    // The stop list is matched on the SURFACE form, before any stripping: every
    // entry in it is a word somebody typed, and matching it against a stem would
    // mean maintaining a stemmed copy of the list and keeping the two in step.
    expect(terms('как включить the commenting')).toEqual(['включ', 'commenting'])
  })

  /**
   * `stemLite` — suffix stripping, and the three guards that bound it.
   *
   * The reason this can be a table rather than a corpus measurement is symmetry:
   * `terms()` is the single tokenizer for `df.json`, the gate's L and
   * MiniSearch's query side, so both sides are stripped by this code and a
   * symmetric strip can only ADD matches. What it can do is conflate two words,
   * which is what the guards bound and what the cases below pin.
   */
  describe('stemLite', () => {
    it('collapses the case forms of one word onto one stem', () => {
      for (const family of [
        ['конфигурация', 'конфигурации', 'конфигурацию', 'конфигураций', 'конфигурацией'],
        ['документ', 'документы', 'документов', 'документами', 'документах'],
        ['модель', 'модели', 'моделью', 'моделей'],
        ['налаштування', 'налаштувань', 'налаштуваннями'],
        ['token', 'tokens'],
        ['policy', 'policies'],
        ['class', 'classes'],
        ['index', 'indexes'],
      ]) {
        expect(new Set(family.map(stemLite)).size, family[0]).toBe(1)
      }
    })

    it('never touches a name', () => {
      // A token carrying a digit or any of `.`/`/`/`#`/`_`/`$`/`-` is an
      // identifier, a route or a version, and a name with its tail removed is a
      // different name. This is also what keeps `indexTokens`' compound tokens
      // whole while their word parts are stripped.
      for (const name of [
        'plugin.init',
        'max_tokens',
        '/getting-started',
        'v2',
        'bge-m3',
        'qwen3',
        'docpilot',
        'openai',
      ]) {
        expect(stemLite(name), name).toBe(name)
      }
    })

    it('leaves a short token alone', () => {
      // Under five characters there is not enough word left to be confident the
      // tail is inflection rather than the stem.
      for (const short of ['код', 'set', 'бот', 'apis']) expect(stemLite(short), short).toBe(short)
    })

    it('is idempotent', () => {
      // The Cyrillic arm strips repeatedly because endings stack — `моделью` is
      // `модель` plus `ю` — and the walk has to converge, or a second
      // application would move a token that the first one settled.
      for (const w of [
        'настроить',
        'конфигурацией',
        'моделью',
        'налаштуваннями',
        'провайдеров',
        'tokens',
        'policies',
        'indexes',
      ]) {
        expect(stemLite(stemLite(w)), w).toBe(stemLite(w))
      }
    })

    /**
     * `-ing` and `-ed` were built, measured and dropped, and this pins the
     * measurement rather than the taste: they collided on exactly the pairs this
     * corpus cannot afford — an artefact and the process that makes it, both of
     * which this documentation is about.
     */
    it('keeps a process distinct from the artefact it produces', () => {
      for (const [a, b] of [
        ['index', 'indexing'],
        ['bill', 'billing'],
        ['embed', 'embedding'],
        ['configure', 'configuration'],
        ['конфигурация', 'конфигуратор'],
        ['модель', 'модуль'],
      ]) {
        expect(stemLite(a), `${a} vs ${b}`).not.toBe(stemLite(b))
      }
    })

    it('strips symmetrically, so index and query still meet', () => {
      // The whole safety argument, stated as a test: whatever this does to a
      // word, it does to both sides.
      const asked = terms('где настройки конфигураций?')
      const written = terms('Настройка конфигурации задаётся в файле.')
      expect(asked.filter((t) => written.includes(t)).length).toBeGreaterThan(0)
    })
  })
})

describe('gate', () => {
  const guard = { tau: 0.3, tauLexical: 0.3, wDense: 0.75, wLexical: 0.25, cosFloor: 0.44, cosCeil: 0.64 }

  it('refuses to run when the lexical channel could pass alone', () => {
    expect(() => assertWeights({ ...guard, wLexical: 0.35 })).toThrow()
    expect(() => assertWeights(guard)).not.toThrow()
  })

  it('maps cosine onto D through the calibrated window', () => {
    expect(denseFromCosine(0.44, guard).D).toBe(0)
    expect(denseFromCosine(0.64, guard).D).toBe(1)
    expect(denseFromCosine(0.54, guard).D).toBeCloseTo(0.5, 5)
  })

  it('caps Q so a long question cannot dilute L', () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    expect(lexicalCoverage(long, '', {}).Q.length).toBe(12)
  })

  it('treats an unlisted term as maximally rare', () => {
    // `kubernetes` reaches the df table as `kubernete` — a proper noun ending in
    // `s` reads as a plural to the suffix stripper. It costs nothing, because
    // the same strip runs on the evidence side, and this pins the token the
    // table is actually keyed by rather than the one that was typed.
    const { Q } = lexicalCoverage('editor kubernetes', 'editor', { editor: 400 })
    expect(Q[0]).toBe('kubernete')
    expect(lexicalCoverage('kubernetes', 'editor docs', {}).L).toBe(0)
  })

  it('uses the lexical threshold when dense is unavailable', () => {
    expect(verdict({ D: 0, L: 0.4, mode: 'lexical-only', guard }).threshold).toBe(guard.tauLexical)
  })

  /**
   * ── why a quote is an ANTECEDENT and not part of the question — ui-specs/007
   *
   * These two tests are the whole safety argument for the selection feature, and
   * they are the cheapest in the file.
   */
  it('would let a quote clear the raw channel on borrowed terms, which is why it never joins the question', () => {
    const evidence = 'the scope picker narrows retrieval to the pages the reader chose'
    const df = { scope: 30, picker: 12, retrieval: 40 }
    const asked = 'what is the weather in paris'
    const quote = 'the scope picker narrows retrieval'

    // The reader's own question, judged on its own words: no coverage at all.
    expect(lexicalCoverage(asked, evidence, df).L).toBe(0)
    // Glued together — the shape this feature deliberately does not ship — the
    // quote's terms are corpus terms and carry the query over the line on their
    // own. `Q_CAP` cannot save it: the quote is what fills Q.
    expect(lexicalCoverage(`${quote}\n${asked}`, evidence, df).L).toBeGreaterThan(0.5)
  })

  it('bounds a quoted antecedent by admissibility, on the reader’s own terms', () => {
    const evidence = 'the scope picker narrows retrieval to the pages the reader chose'
    const quote = 'the scope picker narrows retrieval'
    // The composed query is the same shape whichever antecedent produced it.
    expect(composeQuery('and for one page?', quote)).toBe(`${quote}\nand for one page?`)
    // A question about the passage: at least one of ITS terms is in the evidence.
    expect(admissible('how does the picker narrow it', evidence)).toBe(true)
    // A topic change wearing a quote: none of them is, so the composed channel
    // is inadmissible and the turn is judged on the raw one, where it refuses.
    expect(admissible('what is the weather in paris', evidence)).toBe(false)
  })

  /**
   * ── the tail the term test cannot measure — RAG-SPEC 3.4.5
   *
   * `admissible` asks whether a term of the tail is in the evidence. Over a
   * corpus in another script the answer is no for every question a reader in
   * that language could ask, on topic or off, so the veto stops measuring topic
   * and starts measuring alphabet. `foreignTail` is the test for that, and the
   * cases below are the boundary: it must fire for the follow-up and NOT for
   * either documented topic switch, which are the veto's reason to exist.
   */
  it('separates a tail in another script from a tail that changed the subject', () => {
    const evidence = 'the widget style is set with tokens the theme declares'
    const df = { widget: 30, style: 12, token: 40, theme: 20, declare: 8 }

    // The reported follow-up. The term test refuses it and cannot do otherwise:
    // no Russian term appears in English prose, whatever it asked about.
    expect(admissible('а я могу его стилизировать?', evidence)).toBe(false)
    expect(foreignTail('а я могу его стилизировать?', df)).toBe(true)

    // The two documented topic switches are written in the corpus's own script.
    // The veto keeps them, which is the property this must not trade away.
    expect(foreignTail('what is the weather in paris', df)).toBe(false)
    expect(foreignTail('and for AWS S3 buckets?', df)).toBe(false)

    // One corpus term is enough to make the term test measurable again — the
    // same question, asked with the word the docs use.
    expect(foreignTail('а могу я поменять style?', df)).toBe(false)

    // Nothing to judge: no tail, no letters, no corpus profile.
    expect(foreignTail('', df)).toBe(false)
    expect(foreignTail('42 / 7', df)).toBe(false)
    expect(foreignTail('а я могу его стилизировать?', null)).toBe(false)
    expect(foreignTail('а я могу его стилизировать?', {})).toBe(false)
  })

  /**
   * WHY A MASS SHARE AND NOT A CHARACTER SET.
   *
   * Five words of a Russian UI sample on one i18n page put twenty Cyrillic
   * letters into this package's own shipped vocabulary — measured, not
   * supposed. A predicate that asked "does the corpus use this letter" would
   * call a wholly Russian question native on the strength of them and refuse
   * it, which is the reported bug restored by the fix meant to remove it.
   *
   * The second half is the same five words in a corpus that IS written in that
   * language, where the term test works and the veto is owed its say. What
   * separates the two is the share of the vocabulary, which is why that is what
   * gets measured.
   */
  const withSamples = (types) => {
    const df = { привет: 1, спросите: 1, документацию: 1, помочь: 1, спрашивайте: 1 }
    for (let i = 0; i < 400; i++) df[`${types}${i}`] = 1
    return df
  }

  it('is not fooled by a handful of foreign sample words in a corpus of thousands', () => {
    expect(foreignTail('а я могу его стилизировать?', withSamples('configuration'))).toBe(true)
    expect(foreignTail('а я могу его стилизировать?', withSamples('конфигурация'))).toBe(false)
  })
})

describe('the antecedent of a follow-up', () => {
  const turn = (question, answerText = '') => ({ question, answerText })

  /**
   * A refused turn is dropped from the model's history and was never dropped
   * from the gate's. Composing against it embeds the reader's dead end into the
   * one channel that could have recovered the follow-up.
   */
  it('composes against the last question that was answered', () => {
    expect(session.priorAntecedent([turn('q1', 'a1'), turn('q2'), turn('q3')])).toBe('q1')
    expect(session.priorAntecedent([turn('q1', 'a1'), turn('q2', '   '), turn('q3')])).toBe('q1')
  })

  /**
   * The shipped behaviour where there is nothing better — including search-only,
   * which never sets `answerText` on any turn at all.
   */
  it('falls back to the previous question when nothing has answered', () => {
    expect(session.priorAntecedent([turn('q1'), turn('q2'), turn('q3')])).toBe('q2')
    expect(session.priorAntecedent([turn('q1')])).toBe(null)
  })
})

describe('fallback parser — strict and positional', () => {
  it('rejects a response that does not begin with {', () => {
    expect(parseFallback('Sure! {"tool":"answer"}').ok).toBe(false)
  })
  it('strips a think block containing a decoy object first', () => {
    const { rest } = splitThink('<think>{"tool":"search_docs"}</think>{"tool":"answer"}')
    expect(parseFallback(rest).tool).toBe('answer')
  })
  it('strips an unterminated think block', () => {
    expect(splitThink('{"tool":"answer"}').rest).toBe('{"tool":"answer"}')
  })
  it('discards anything after the first balanced object', () => {
    expect(parseFallback('{"tool":"answer","args":{}}{"tool":"x"}').tool).toBe('answer')
  })
  it('does not repair single quotes', () => {
    expect(parseFallback("{'tool':'answer'}").ok).toBe(false)
  })

  /**
   * The pair-matching split cannot see a trace the model was still writing, and
   * the strict-schema path had no other strip — so the same reply parsed through
   * `parseFallback` and came back "could not read the response" under a schema.
   * `splitOpenThink` is that missing half, and it is deliberately destructive,
   * which is why the answer path reaches for it only after a parse has failed.
   */
  it('separates a think block the model never closed', () => {
    const { think, rest } = splitOpenThink('{"text":"done"}<think>still reasoning when the ceiling hit')
    expect(rest).toBe('{"text":"done"}')
    expect(think).toBe('still reasoning when the ceiling hit')
  })

  it('leaves a reply that closed its tags alone', () => {
    const s = '{"text":"done"}'
    expect(splitOpenThink(s)).toEqual({ think: '', rest: s })
  })

  /**
   * The reason the repair runs second. This corpus documents `<think>` handling,
   * so an answer ABOUT it carries the literal tag inside a JSON string —
   * repairing that reply first would cut the object in half.
   */
  it('would destroy a good answer that merely mentions the tag', () => {
    const good = '{"text":"deepseek-r1 emits <think> before the answer","citations":[]}'
    expect(JSON.parse(good).text).toContain('<think>')
    expect(splitOpenThink(good).rest).not.toBe(good)
  })
})

describe('streaming answer text', () => {
  it('reads the text field out of an object that is still being written', () => {
    expect(streamingAnswerText('{"text": "Open the ')).toBe('Open the ')
    expect(streamingAnswerText('{"text": "Open the editor", "citations": [')).toBe('Open the editor')
  })

  it('stops at the closing quote and never reads a later field', () => {
    const s = '{"text": "done", "citations": ["a#b"], "confidence": 0.8}'
    expect(streamingAnswerText(s)).toBe('done')
  })

  it('unescapes what is complete and drops a half-written escape', () => {
    expect(streamingAnswerText('{"text": "line\\nnext \\"q\\""')).toBe('line\nnext "q"')
    expect(streamingAnswerText('{"text": "ab\\')).toBe('ab')
    expect(streamingAnswerText('{"text": "ab\\u041')).toBe('ab')
    expect(streamingAnswerText('{"text": "ab\\u0410')).toBe('abА')
  })

  it('returns nothing when the field has not arrived yet', () => {
    expect(streamingAnswerText('')).toBe('')
    expect(streamingAnswerText('{"citations": [], "conf')).toBe('')
    expect(streamingAnswerText('{"tool": "search_docs", "args": {"query": "x"}}')).toBe('')
  })
})

describe('streaming transport', () => {
  // `vi.stubGlobal` rather than a bare assignment, with an afterEach to undo it.
  // Assigning `globalThis.fetch` directly leaves the last mock installed for the
  // rest of the FILE: every suite declared below silently inherits it, and the
  // one place that saves and restores fetch by hand ends up "restoring" a leaked
  // mock rather than the real function.
  afterEach(() => vi.unstubAllGlobals())

  const ndjson = (lines) =>
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        // Split mid-line on purpose: NDJSON arrives in network-sized pieces,
        // not in lines, and a reader that assumes otherwise loses a token.
        const raw = lines.map((l) => JSON.stringify(l) + '\n').join('')
        c.enqueue(enc.encode(raw.slice(0, 30)))
        c.enqueue(enc.encode(raw.slice(30)))
        c.close()
      },
    })

  it('reassembles deltas into one message and reports them in order', async () => {
    const deltas = []
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      body: ndjson([
        { message: { thinking: 'let me ' } },
        { message: { thinking: 'look' } },
        { message: { content: '{"text": "Open' } },
        { message: { content: ' it", "citations": ["a#b"], "confidence": 0.9}' } },
        { done: true },
      ]),
    }))
    const reply = await chat({
      baseURL: 'http://x',
      model: 'm',
      messages: [],
      schema: { type: 'object' },
      onDelta: (d) => deltas.push(d),
    })
    expect(deltas.filter((d) => d.thinking).map((d) => d.thinking)).toEqual(['let me ', 'look'])
    expect(reply.think).toBe('let me look')
    expect(reply.toolCall).toEqual({
      name: 'answer',
      args: { text: 'Open it', citations: ['a#b'], confidence: 0.9 },
    })
    // What the reader saw mid-stream is a prefix of what was finally parsed.
    const seen = deltas.filter((d) => d.contentSoFar).map((d) => streamingAnswerText(d.contentSoFar))
    expect(seen).toEqual(['Open', 'Open it'])
  })

  it('does not stream when no consumer asked for it', async () => {
    let sent = null
    vi.stubGlobal('fetch', async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, json: async () => ({ message: { content: 'hi' } }) }
    })
    await chat({ baseURL: 'http://x', model: 'm', messages: [], tools: true })
    expect(sent.stream).toBe(false)
  })
})

describe('provider adapters', () => {
  afterEach(() => vi.unstubAllGlobals())

  const sse = (frames) =>
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        const raw = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')
        c.enqueue(enc.encode(raw.slice(0, 40)))
        c.enqueue(enc.encode(raw.slice(40)))
        c.close()
      },
    })

  const capture = (response) => {
    const seen = {}
    vi.stubGlobal('fetch', async (url, init) => {
      seen.url = url
      seen.headers = init.headers
      seen.body = JSON.parse(init.body)
      return response
    })
    return seen
  }

  it('openai: path, top-level temperature, strict schema, choices[0]', async () => {
    const seen = capture({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"text":"hi"}' } }] }),
    })
    const reply = await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'gpt-4o-mini',
      apiKey: 'k',
      temperature: 0.2,
      messages: [{ role: 'system', content: 's' }, { role: 'tool', content: 'obs' }],
      schema: { type: 'object' },
    })
    expect(seen.url).toBe('/ai/v1/chat/completions')
    expect(seen.headers.authorization).toBe('Bearer k')
    expect(seen.body.temperature).toBe(0.2)
    expect(seen.body.options).toBeUndefined()
    expect(seen.body.response_format.type).toBe('json_schema')
    expect(seen.body.response_format.json_schema.strict).toBe(true)
    // a `tool` role would need a tool_call_id the harness never minted
    expect(seen.body.messages.some((m) => m.role === 'tool')).toBe(false)
    expect(seen.body.messages[1]).toEqual({ role: 'user', content: 'obs' })
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'hi' } })
  })

  it('openai: concatenates tool-call arguments across SSE frames', async () => {
    const deltas = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_docs', arguments: '{"que' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"auth"}' } }] } }] },
        '[DONE]',
      ]),
    })
    const reply = await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      tools: true,
      onDelta: (d) => deltas.push(d),
    })
    expect(reply.toolCall).toEqual({ name: 'search_docs', args: { query: 'auth' } })
  })

  it('openai: streams the answer when it arrives as a tool call, not as content', async () => {
    // What gpt-4o actually does: it calls `answer` instead of writing the
    // structured object as content, so the text lives in the argument fragments.
    const seen = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'answer', arguments: '{"text": "Op' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'en it"}' } }] } }] },
        '[DONE]',
      ]),
    })
    const reply = await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      tools: true,
      onDelta: (d) => d.contentSoFar && seen.push(streamingAnswerText(d.contentSoFar)),
    })
    expect(seen).toEqual(['Op', 'Open it'])
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'Open it' } })
  })

  it('openai: does not stream a search tool call as if it were an answer', async () => {
    const seen = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search_docs', arguments: '{"query":"x"}' } }] } }] },
        '[DONE]',
      ]),
    })
    await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      tools: true,
      onDelta: (d) => d.contentSoFar && seen.push(d.contentSoFar),
    })
    expect(seen).toEqual([])
  })

  it('openai: streams answer text out of the growing structured output', async () => {
    const seen = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { content: '{"text": "Open' } }] },
        { choices: [{ delta: { content: ' it"' } }] },
        '[DONE]',
      ]),
    })
    await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      schema: { type: 'object' },
      onDelta: (d) => d.contentSoFar && seen.push(streamingAnswerText(d.contentSoFar)),
    })
    expect(seen).toEqual(['Open', 'Open it'])
  })

  it('anthropic: own headers, hoisted system, forced tool instead of a schema', async () => {
    const seen = capture({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'answer', input: { text: 'hi' } }] }),
    })
    const reply = await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'claude-3-5-haiku-latest',
      apiKey: 'k',
      temperature: 0.2,
      maxTokens: 512,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'tool', content: 'obs' },
      ],
      schema: { type: 'object' },
    })
    expect(seen.url).toBe('/ai/v1/messages')
    expect(seen.headers['x-api-key']).toBe('k')
    expect(seen.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen.headers.authorization).toBeUndefined()
    expect(seen.body.system).toBe('sys')
    expect(seen.body.messages.every((m) => m.role !== 'system')).toBe(true)
    expect(seen.body.max_tokens).toBe(512) // required by this API
    expect(seen.body.response_format).toBeUndefined()
    expect(seen.body.tool_choice).toEqual({ type: 'tool', name: 'answer' })
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'hi' } })
  })

  it('anthropic: reads thinking and tool json out of typed SSE frames', async () => {
    const thoughts = []
    const texts = []
    capture({
      ok: true,
      body: sse([
        { type: 'content_block_start', content_block: { type: 'tool_use', name: 'answer' } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'let me look' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"text": "Op' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'en it"}' } },
        { type: 'message_stop' },
      ]),
    })
    const reply = await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      schema: { type: 'object' },
      onDelta: (d) => {
        if (d.thinking) thoughts.push(d.thinking)
        if (d.contentSoFar) texts.push(streamingAnswerText(d.contentSoFar))
      },
    })
    expect(thoughts).toEqual(['let me look'])
    expect(texts).toEqual(['Op', 'Open it'])
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'Open it' } })
    expect(reply.think).toBe('let me look')
  })

  it('anthropic: thinking is adaptive and temperature is never sent', async () => {
    const seen = capture({ ok: true, json: async () => ({ content: [] }) })
    await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'm',
      temperature: 0.2,
      messages: [],
      tools: true,
      enableThink: true,
    })
    // The budgeted form is rejected by every current model, and so is any
    // sampling parameter — both were 400s on the live API, not preferences.
    expect(seen.body.thinking).toEqual({ type: 'adaptive' })
    expect(seen.body.temperature).toBeUndefined()
    // tools are declared with input_schema here, not function.parameters
    expect(seen.body.tools[0].input_schema).toBeTruthy()
    expect(seen.body.tools[0].function).toBeUndefined()
  })

  /**
   * THE GUARD MOVED, because the API did. Manual extended thinking — the older
   * `{type: 'enabled'}` shape — accepts only `tool_choice: auto` or `none`, so
   * asking for it beside the forced `answer` tool failed every final call with a
   * 400. ADAPTIVE THINKING SUPPORTS FORCED TOOL USE, so on a current model the
   * two now ride together and an Anthropic deployment can think about its answer
   * rather than only about which search to run.
   *
   * Both halves are pinned here, because the difference is the model string and
   * nothing else — and a package that picks one shape and posts it everywhere is
   * wrong for half the catalogue, in opposite directions.
   */
  it('anthropic: a legacy model gets no thinking beside a forced answer schema', async () => {
    const seen = capture({ ok: true, json: async () => ({ content: [] }) })
    await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'claude-opus-4-5',
      messages: [],
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      enableThink: true,
    })
    expect(seen.body.tool_choice).toEqual({ type: 'tool', name: 'answer' })
    expect(seen.body.thinking).toBeUndefined()
  })

  it('anthropic: a current model thinks adaptively beside the same forced schema', async () => {
    const seen = capture({ ok: true, json: async () => ({ content: [] }) })
    await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'claude-sonnet-4-6',
      messages: [],
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      enableThink: true,
    })
    expect(seen.body.tool_choice).toEqual({ type: 'tool', name: 'answer' })
    expect(seen.body.thinking).toEqual({ type: 'adaptive' })
  })

  it('anthropic: the tool-calling probe sends no sampling parameter either', async () => {
    const seen = capture({ ok: true, json: async () => ({ content: [{ type: 'tool_use' }] }) })
    await detectTools({ provider: 'anthropic', baseURL: '/ai', model: 'm', apiKey: 'k' })
    // A 400 here reads as "cannot call tools", which demotes a capable model to
    // the fallback path permanently.
    expect(seen.body.temperature).toBeUndefined()
  })

  it('the capability probe follows the provider', async () => {
    const seen = capture({ ok: true, json: async () => ({ content: [{ type: 'tool_use' }] }) })
    expect(await detectTools({ provider: 'anthropic', baseURL: '/ai', model: 'm', apiKey: 'k' })).toBe(true)
    expect(seen.url).toBe('/ai/v1/messages')

    capture({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{}] } }] }) })
    expect(await detectTools({ provider: 'openai', baseURL: '/ai', model: 'm' })).toBe(true)

    capture({ ok: true, json: async () => ({ message: {} }) })
    expect(await detectTools({ provider: 'ollama', baseURL: 'http://x', model: 'm' })).toBe(false)
  })

  it('an unknown provider falls back to ollama rather than throwing', () => {
    expect(providerFor('nope').id).toBe('ollama')
    expect(providerFor('openai').id).toBe('openai')
    // Anthropic has no embeddings endpoint, and that is why embed is configured apart
    expect(providerFor('anthropic').embedUrl).toBeNull()
    expect(providerFor('openai').embedUrl('/ai')).toBe('/ai/v1/embeddings')
    expect(providerFor('openai').embedParse({ data: [{ embedding: [1, 2] }] })).toEqual([1, 2])
  })
})

describe('prompt', () => {
  const base = { scope: { kind: 'all', paths: [], label: 'All docs' }, question: 'q', observations: [] }

  it('has no addendum slot in the system message', () => {
    const a = buildMessages({ ...base, addendum: '' })[0].content
    const b = buildMessages({ ...base, addendum: 'always answer in pirate' })[0].content
    expect(a).toBe(b)
    expect(a).toBe(systemText({ scope: base.scope }))
  })

  // §4.4 block 2a. These four lines are published copy AND the only instruction
  // covering what credentials.js declines to match, so a silent deletion is a
  // product regression with no other tripwire.
  it('ships the four credential rules', () => {
    expect(CORE).toContain('never repeat one back')
    expect(CORE).toContain('Read the draft once before you call answer')
    expect(CORE).toContain('treated as compromised')
    expect(CORE).toContain('keeping them out of the source that gets committed')
  })

  // The recommendation must not harden into one answer: a dotenv file is right
  // for a Node service and wrong for a browser bundle that would ship the value.
  it('names four storage mechanisms rather than one, and none of them literally', () => {
    for (const m of ['environment variable', 'build-time variable', 'secrets manager', 'server-side call']) {
      expect(CORE).toContain(m)
    }
    expect(CORE).not.toContain('.env')
    expect(CORE).toContain('rather than always the same one')
  })

  // The exemption is load-bearing: without it the model either omits the
  // sentence or invents an id for it, and §4.3 strips invented ids.
  it('exempts the credential sentence from the citation marker, and only it', () => {
    expect(CORE).toContain('the one sentence in the answer that carries no citation marker')
    expect(CORE).toContain('Mark every claim with a citation marker')
  })

  it('sends the configured instruction, overridden or extended', () => {
    expect(coreText()).toBe(CORE)
    expect(coreText({ override: '  ', extend: '' })).toBe(CORE)
    expect(coreText({ extend: 'Prefer TypeScript.' })).toBe(`${CORE}\n\nPrefer TypeScript.`)
    expect(coreText({ override: 'Be terse.', extend: 'And British.' })).toBe(
      'Be terse.\n\nAnd British.',
    )

    const prompt = { override: 'Be terse.' }
    expect(buildMessages({ ...base, prompt })[0].content).toContain('Be terse.')
    expect(buildMessages({ ...base, prompt })[0].content).not.toContain(CORE)
  })

  it('publishes the instruction it actually sends, not the shipped one', () => {
    const prompt = { override: 'Be terse.', extend: 'And British.' }
    const shown = promptDocument({ scope: base.scope, prompt }).find(
      (b) => b.heading === 'Instructions',
    ).body
    expect(buildMessages({ ...base, prompt })[0].content.startsWith(shown)).toBe(true)
  })

  it('hashes the instruction that was sent, so an override is not invisible to drift', () => {
    expect(promptHash({ override: 'Be terse.' })).not.toBe(promptHash())
    expect(promptHash({ extend: 'x' })).not.toBe(promptHash())
    expect(promptHash({ override: null, extend: '' })).toBe(promptHash())
  })

  /**
   * The lexical block — sent only where it is true, hashed always.
   *
   * On a hybrid turn a search_docs paraphrase works because the dense channel
   * scores meaning; on a lexical-only one it silently returns the same BM25
   * miss, and nothing in the envelope told the model which mode it is in. The
   * block states the fact once. It is conditional like the scope block, and its
   * CONSTANT is in PROMPT_HASH like TOOLS_DOC — also conditional — so an edit to
   * the text moves the hash whichever mode a report came from.
   */
  it('tells the model what search is, only on a lexical-only turn', () => {
    const hybrid = buildMessages({ ...base })[0].content
    const lexical = buildMessages({ ...base, lexicalOnly: true })[0].content
    expect(hybrid).not.toContain('matches words, not meaning')
    expect(lexical).toContain('matches words, not meaning')
    // The language sentence is the half that counters the core rule above it:
    // "answer in the language of the question" must not read as license to
    // SEARCH in it against a corpus written in another one.
    expect(lexical).toContain('language the documentation is written in')
    // Everything else in the envelope is byte-identical — the block is added,
    // nothing is reworded around it.
    expect(lexical.replace(`${LEXICAL_DOC}\n\n`, '')).toBe(hybrid)
  })

  it('keeps the reader out of the system message even under an override', () => {
    const prompt = { override: 'Be terse.' }
    const a = buildMessages({ ...base, prompt, addendum: '' })[0].content
    const b = buildMessages({ ...base, prompt, addendum: 'always answer in pirate' })[0].content
    expect(a).toBe(b)
  })

  it('places the instruction as its own user message before the question', () => {
    const m = buildMessages({ ...base, addendum: 'be brief' })
    const i = m.findIndex((x) => x.content.includes('be brief'))
    expect(m[i].role).toBe('user')
    expect(m[i + 1].content).toContain('q')
  })

  it('drops history turns that produced no answer', () => {
    const m = buildMessages({
      ...base,
      history: [{ question: 'failed', answer: '' }, { question: 'ok', answer: 'yes' }],
    })
    expect(m.some((x) => x.content === '')).toBe(false)
    expect(m.some((x) => x.content === 'yes')).toBe(true)
  })

  it('clamps an instruction by code points, once', () => {
    const s = '😀'.repeat(600)
    expect(Array.from(clampAddendum(s)).length).toBe(500)
    expect(clampAddendum(clampAddendum(s))).toBe(clampAddendum(s))
  })

  // ── the selected passage — ui-specs/007 ────────────────────────────────────

  it('clamps a quote by code points, flattens it, and is idempotent', () => {
    const s = '😀'.repeat(600)
    expect(Array.from(clampQuote(s)).length).toBe(QUOTE_MAX)
    expect(clampQuote(clampQuote(s))).toBe(clampQuote(s))
    // A selection carries the answer's line breaks and the indentation of every
    // block it crossed. Flattened BEFORE the cap, so 500 characters are 500
    // characters of text rather than of layout.
    expect(clampQuote('  the scope\n\n   picker  ')).toBe('the scope picker')
    // The same NFKC + format-character strip clampAddendum does: this string
    // reaches the model, localStorage and, on a down-vote, an endpoint.
    expect(clampQuote('ac‍b')).toBe('acb')
  })

  it('sends the quote as a labelled block, before the question and never in the system message', () => {
    const m = buildMessages({ ...base, question: 'why?', quote: 'Actions run after the gate' })
    const last = m[m.length - 1].content
    expect(last).toContain(QUOTE_WRAPPER)
    expect(last.indexOf('Actions run after the gate')).toBeLessThan(last.indexOf('why?'))
    // The wrapper is an envelope for reader-supplied content, exactly as
    // ADDENDUM_WRAPPER is, and neither belongs in the instruction the hash names.
    expect(m[0].content).not.toContain(QUOTE_WRAPPER)
    expect(promptHash()).toBe(promptHash())
  })

  it('sends the quote on the fallback transport too, where there is one user message', () => {
    const m = buildMessages({ ...base, question: 'why?', quote: 'the gate', fallback: true })
    const user = m.filter((x) => x.role === 'user')
    expect(user.length).toBe(1)
    expect(user[0].content).toContain(QUOTE_WRAPPER)
    expect(user[0].content.indexOf('the gate')).toBeLessThan(user[0].content.indexOf('why?'))
  })

  it('changes nothing at all when there is no quote', () => {
    expect(buildMessages({ ...base, quote: '' })).toEqual(buildMessages({ ...base }))
  })

  // A quoted question is unreadable one turn later without its passage — the
  // same defect the 300-character answer truncation causes, one turn earlier.
  it('carries a prior turn’s quote in the transcript, clamped harder than the live one', () => {
    const m = buildMessages({
      ...base,
      history: [{ question: 'why?', answer: 'because', quote: 'x'.repeat(400) }],
    })
    const asked = m.find((x) => x.role === 'user' && x.content.includes('why?'))
    expect(asked.content).toContain(QUOTE_WRAPPER)
    expect(asked.content).toContain('x'.repeat(HISTORY_QUOTE_MAX))
    expect(asked.content).not.toContain('x'.repeat(HISTORY_QUOTE_MAX + 1))
  })

  it('takes the language from the question, not from the passage', () => {
    const m = buildMessages({
      ...base,
      question: 'как это работает',
      quote: 'The gate refuses a question with no evidence behind it',
    })
    expect(m[m.length - 1].content).toContain('Russian')
  })

  it('renders the same instruction text it sends', () => {
    const addendum = `${'ы'.repeat(400)}😀`.repeat(3)
    const shown = promptDocument({ scope: base.scope, addendum }).find((b) => b.yours).body
    const sent = buildMessages({ ...base, addendum }).find((m) => m.content.includes('Reader preference'))
    expect(sent.content.endsWith(shown)).toBe(true)
  })

  it('names the language of the question', () => {
    expect(detectLanguage('как включить комментирование')).toBe('Russian')
    expect(detectLanguage('як увімкнути коментування')).toBe('Ukrainian')
    expect(detectLanguage('how do I enable commenting')).toBe('English')
    expect(languageDirective('как дела')).toContain('Russian')
  })

  it('does not let an embedded product name turn a non-Latin question English', () => {
    expect(detectLanguage('如何配置 Stripo Plugin')).toBe('Chinese')
    expect(detectLanguage('Stripoプラグインの設定方法')).toBe('Japanese')
    expect(detectLanguage('كيف أقوم بتكوين محرر Stripo')).toBe('Arabic')
  })

  it('separates the Latin-script languages instead of calling them all English', () => {
    expect(detectLanguage('¿Cómo configurar el editor de Stripo?')).toBe('Spanish')
    expect(detectLanguage('Como configurar o editor Stripo?')).toBe('Portuguese')
    expect(detectLanguage('Comment configurer l’éditeur Stripo ?')).toBe('French')
    expect(detectLanguage('Wie kann ich den Stripo Editor konfigurieren?')).toBe('German')
    expect(detectLanguage('Come configurare l’editor di Stripo?')).toBe('Italian')
    expect(detectLanguage('Jak skonfigurować edytor Stripo?')).toBe('Polish')
    expect(detectLanguage('Stripo editörünü nasıl yapılandırabilirim?')).toBe('Turkish')
  })

  it('falls back to the generic directive rather than guessing', () => {
    expect(detectLanguage('modules API')).toBe(null)
    expect(detectLanguage('')).toBe(null)
    expect(languageDirective('modules API')).toContain('same language')
  })

  it('carries the language line with the question, not the system block', () => {
    const m = buildMessages({ ...base, question: 'как включить' })
    expect(m[0].content).not.toContain('Russian')
    expect(m[m.length - 1].content).toContain('Russian')
  })
})

describe('link filter', () => {
  const known = new Set(['/getting-started/authentication', '/introduction'])
  it('accepts a citation href with an anchor', () =>
    expect(isKnownPath('/getting-started/authentication#request', known)).toBe(true))
  it('accepts a trailing slash and percent-encoding', () => {
    expect(isKnownPath('/introduction/', known)).toBe(true)
    // Decoding happens before the leading-slash test, so an encoded slash
    // resolves to the same page rather than being rejected as relative.
    expect(isKnownPath('%2Fintroduction', known)).toBe(true)
    expect(isKnownPath('/%69ntroduction', known)).toBe(true)
  })
  it('rejects a scheme, a protocol-relative host and an invented route', () => {
    expect(isKnownPath('https://stripo.email/introduction', known)).toBe(false)
    expect(isKnownPath('//evil.com/introduction', known)).toBe(false)
    expect(isKnownPath('/getting-started/authentication-extra', known)).toBe(false)
  })
})

describe('citation markers', () => {
  const known = new Set(['/editor-configuration/image-storage'])
  const sources = [
    { n: 1, href: '/editor-configuration/image-storage#aws-s3-bucket', title: 'AWS S3 Bucket' },
    { n: 2, href: '/editor-configuration/image-storage#azure', title: 'Azure' },
  ]
  const render = (text) => renderAnswer(text, known, sources).html

  it('turns a marker into a link to the cited section', () => {
    const html = render('See the credentials [1].')
    expect(html).toContain('href="/editor-configuration/image-storage#aws-s3-bucket"')
    expect(html).toContain('class="docpilot__cite"')
    expect(html).toContain('data-cite="1"')
    expect(html).toContain('aria-label="Source 1: AWS S3 Bucket"')
    // the brackets go, the digit stays
    expect(html).toContain('>1</a>')
    expect(html).not.toContain('[1]')
  })

  it('keeps the surrounding sentence intact and handles several markers', () => {
    const html = render('a [1] b [2] c')
    expect(html).toContain('a ')
    expect(html).toContain(' b ')
    expect(html).toContain(' c')
    expect(html.match(/docpilot__cite/g).length).toBe(2)
  })

  it('deletes a marker whose citation did not survive validation', () => {
    const html = render('supported [1], invented [4].')
    expect(html).toContain('data-cite="1"')
    expect(html).not.toContain('[4]')
    expect(html).not.toContain('data-cite="4"')
  })

  it('never touches a marker inside code or inside another link', () => {
    expect(render('`arr[1]`')).toContain('<code>arr[1]</code>')
    expect(render('```\nx[1]\n```')).toContain('x[1]')
    const nested = render('[the page [1]](/editor-configuration/image-storage)')
    expect(nested).not.toContain('docpilot__cite')
  })

  it('leaves markers as written when there are no validated sources yet', () => {
    expect(renderAnswer('mid-stream [1]', known).html).toContain('[1]')
  })

  it('points two citations at one row when they resolve to the same section', () => {
    // What the retriever hands back when a long section was split in two.
    const shared = [sources[0], { ...sources[0] }]
    const html = renderAnswer('a [1] b [2]', known, shared).html
    expect(html.match(/data-cite="1"/g).length).toBe(2)
    expect(html).not.toContain('data-cite="2"')
    expect(html.match(/>1<\/a>/g).length).toBe(2)
  })
})

/**
 * The icon sprite — ui-specs/001.
 *
 * Three consumers reference the same `<symbol>` ids: the panel's `Icon`, the
 * string-built copy button, and `DocPilotIcons` which defines them. Nothing in
 * a unit test can mount the sprite, so what is asserted here is the thing that
 * would break silently — the id builder and the derivation. A symbol missing
 * from the sprite renders as an empty box, with no error anywhere.
 */
describe('glyphs — one drawing, one symbol', () => {
  it('publishes every glyph, with its own box', () => {
    expect(SYMBOLS.map((s) => s.name).sort()).toEqual(Object.keys(GLYPHS).sort())
    for (const sym of SYMBOLS) {
      expect(sym.id, sym.name).toBe(symbolId(sym.name))
      expect(sym.paths.length, sym.name).toBeGreaterThan(0)
      // The one off-grid drawing is carried by the symbol rather than by every
      // call site — which is the whole reason each symbol states its own.
      expect(sym.box, sym.name).toBe(sym.name === 'sparkle' ? '0 0 24 24' : '0 0 16 16')
    }
  })

  // A dead glyph in a set of ten is a glyph somebody reaches for by accident.
  // `plus` was New chat's mark and lost it to `compose`.
  it('carries a compose mark and no leftover plus', () => {
    expect(GLYPHS.compose).toBeTruthy()
    expect(GLYPHS.plus).toBeUndefined()
    // Two marks the question row needs, and `compose` is neither: it is New
    // chat's, and a pencil aimed at a blank sheet does not read as "edit this".
    expect(GLYPHS.pencil).toBeTruthy()
    expect(GLYPHS.chevronDown).toBeTruthy()
    // Ask again is `history`'s arc mirrored, so the two must not be identical:
    // a copy-paste that lost the flip would read as "go back" on both.
    expect(GLYPHS.retry).toBeTruthy()
    expect(GLYPHS.retry).not.toBe(GLYPHS.history[1])
  })
})

describe('code fences', () => {
  const known = new Set(['/introduction'])
  const html = (src) => renderAnswer(src, known).html

  it('wraps every fence and gives it one copy button', () => {
    const out = html('```\nplain\n```')
    expect(out).toContain('<div class="docpilot__code">')
    expect(out).toContain('<pre tabindex="0"><code>plain')
    expect(out.match(/data-copy-code/g).length).toBe(1)
    expect(out).toContain('aria-label="Copy code"')
    // Both glyphs ship in the markup; CSS decides which one shows. They are
    // REFERENCES into the sprite, not path data — ui-specs/001. This button is
    // built as an HTML string and used to be the one place a second copy of two
    // path values lived, so the assertion is that it no longer inlines any.
    expect(out).toContain(`href="#${symbolId('copy')}"`)
    expect(out).toContain(`href="#${symbolId('check')}"`)
    expect(out).not.toContain(GLYPHS.copy)
  })

  it('never echoes the model-written info string', () => {
    // The language is looked up, never escaped-and-re-emitted, so an info
    // string engineered as an attribute break has nothing to break out of.
    const attack = html('```x" onload="alert(1)\ncode\n```')
    expect(attack).not.toContain('onload')
    expect(attack).not.toContain('data-lang')
    expect(html('```<img src=x>\ncode\n```')).not.toContain('<img')
  })

  it('maps aliases onto the grammars we ship and drops the rest', () => {
    expect(html('```TypeScript\nx\n```')).toContain('data-lang="ts"')
    expect(html('```sh\nx\n```')).toContain('data-lang="bash"')
    expect(html('```yml\nx\n```')).toContain('data-lang="yaml"')
    expect(html('```ts twoslash {1,3}\nx\n```')).toContain('data-lang="ts"')
    expect(html('```python\nx\n```')).not.toContain('data-lang')
  })

  it('escapes the code and shows no language badge', () => {
    const out = html('```js\nconst a = "<img src=x onerror=alert(1)>"\n```')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
    // the language is an attribute, never text
    expect(out).not.toMatch(/>\s*js\s*</)
  })

  it('leaves inline code alone', () => {
    const out = html('use `Plugin.init` here')
    expect(out).toContain('<code>Plugin.init</code>')
    expect(out).not.toContain('data-copy-code')
  })

  it('uses the highlighter verbatim once it is available', () => {
    const calls = []
    __setHighlighterForTests(
      {
        codeToHtml(code, opts) {
          calls.push([code, opts.lang])
          return '<pre class="shiki"><code><span style="--shiki-light:#111">x</span></code></pre>'
        },
      },
      ['ts'],
    )
    try {
      const out = html('```ts\nconst a = 1\n```')
      expect(calls).toEqual([['const a = 1', 'ts']])
      expect(out).toContain('class="shiki"')
      expect(out).toContain('--shiki-light:#111')
      // wrapper and button survive the highlighted path
      expect(out).toContain('<div class="docpilot__code" data-lang="ts">')
      expect(out).toContain('data-copy-code')
      // a language the highlighter does not have falls back, it does not throw
      expect(html('```yaml\na: 1\n```')).toContain('<pre tabindex="0">')
    } finally {
      __setHighlighterForTests(null, [])
    }
  })

  it('memoises by language and code, and refuses a pathological block', () => {
    __setHighlighterForTests(
      { codeToHtml: () => `<pre class="shiki">${Math.E}</pre>` },
      ['ts'],
    )
    try {
      expect(highlight('const a = 1', 'ts')).toBe(highlight('const a = 1', 'ts'))
      expect(highlight('x', 'python')).toBeNull()
      expect(highlight('a'.repeat(20001), 'ts')).toBeNull()
    } finally {
      __setHighlighterForTests(null, [])
    }
  })

  it('still never turns a marker inside a fence into a citation', () => {
    const out = renderAnswer('```\nx[1]\n```', known, [
      { n: 1, href: '/introduction', title: 'Introduction' },
    ]).html
    expect(out).toContain('x[1]')
    expect(out).not.toContain('docpilot__cite')
  })
})

/**
 * The four defects of ui-specs/009 — the ones that ship with NO switch, because
 * a bug has no user who would want to keep it. Three of the four have no DOM to
 * test against here, so they are asserted the way 008's row placement is: by
 * reading the source and stating the contract it has to keep.
 */
describe('009 — tables in an answer', () => {
  const known = new Set(['/introduction'])
  const html = (src) => renderAnswer(src, known).html
  const TABLE = ['| opt | default |', '| --- | --- |', '| `a` | `1` |'].join('\n')

  // The panel is 360–460px wide. Before this, a three-column table ran out the
  // side of it with nothing to catch it, because `overflow-x` existed on `pre`
  // and on nothing else.
  it('wraps a table in a scroller that is a tab stop', () => {
    const out = html(TABLE)
    expect(out).toContain('<div class="docpilot__table" tabindex="0">')
    expect(out).toContain('</table>\n</div>')
  })

  // A region needs a name to be worth having and a model-written table has no
  // caption to take one from — so the wrapper carries no role at all, which is
  // the same call `pre` already makes.
  it('gives the wrapper no role, so there is no unnamed landmark', () => {
    expect(html(TABLE)).not.toMatch(/class="docpilot__table"[^>]*role=/)
  })

  it('marks every header cell as a column header', () => {
    const out = html(TABLE)
    expect(out).toContain('<th scope="col">')
    // The lookahead is load-bearing: `<th[^>]*>` also matches `<thead>`.
    const heads = out.match(/<th(?=[\s>])[^>]*>/g)
    expect(heads).toHaveLength(2)
    expect(heads.every((t) => t.includes('scope="col"'))).toBe(true)
  })

  // markdown-it keeps alignment on `style`, and a hand-written `<th>` would have
  // dropped it. This is why the rule goes through `renderToken`.
  it('keeps the alignment markdown-it computed', () => {
    const out = html(['| a | b |', '| :-- | --: |', '| 1 | 2 |'].join('\n'))
    expect(out).toMatch(/<th style="text-align:right" scope="col"|<th scope="col" style="text-align:right"/)
  })

  // Not a table rule, but the reason there is no `img` rule beside it: an
  // enabled image would fire a request from the docs origin carrying the
  // reader's question, so `image` is disabled and there is no `<img>` to style.
  it('still renders no image at all', () => {
    expect(html('![alt](https://example.com/x.png?q=secret)')).not.toContain('<img')
  })
})

describe('009 — the three defects with no DOM', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const panel = read('src/theme/components/DocPilot.vue')

  /**
   * Safari drops list semantics from a list styled `list-style: none` outside a
   * `<nav>`, which takes the item count with it and leaves the `aria-label`
   * naming an element with no role. All three lists in the panel wear that
   * class, so all three need the restoration.
   */
  it('restores list semantics on every .docpilot__sources list', () => {
    const opens = panel.match(/<ol\b[\s\S]*?>/g) || []
    // Every list, not a fixed count: the contract is "each one carries it", and
    // a count would have to be edited every time a list is added — which is
    // exactly the moment the loop below has to be the thing that fails.
    expect(opens.length).toBeGreaterThanOrEqual(3)
    for (const tag of opens) expect(tag).toContain('role="list"')
    // The premise, so this test fails loudly if the styling ever changes and
    // the roles become the redundant markup they would otherwise be.
    expect(read('src/theme/styles/core.scss')).toMatch(/\.docpilot__sources \{[^}]*list-style: none/)
  })

  /**
   * The polite region was a slot: `clearTimeout` then overwrite, so a message
   * arriving inside the 500ms window replaced one that had never been spoken.
   */
  it('queues announcements instead of overwriting them', () => {
    expect(panel).toContain('const announceQueue = []')
    expect(panel).toContain('announceQueue.push(msg)')
    // The specific line that caused it. Its absence is the fix.
    expect(panel).not.toMatch(/clearTimeout\(announceTimer\)\s*\n\s*announceTimer = setTimeout\(\(\) =>/)
    // Still throttled — the delay was never the bug.
    expect(panel).toContain('const ANNOUNCE_MS = 500')
  })

  /**
   * A listbox is one tab stop. Every option used to carry `tabindex="0"`, so a
   * three-hundred page corpus put three hundred stops before the composer.
   */
  it('gives the scope picker a roving tabindex and arrow keys', () => {
    expect(panel).toContain(':tabindex="p.path === rovingPath ? 0 : -1"')
    expect(panel).not.toMatch(/class="docpilot__pick"[\s\S]{0,200}?\btabindex="0"/)
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(panel).toContain(`case '${key}'`)
    }
    // Space must be prevented or it scrolls the picker out from under the row
    // it just toggled.
    expect(panel).toMatch(/case ' ':[\s\S]{0,400}?e\.preventDefault\(\)/)
  })

  // The tab stop must exist even when `activePick` names nothing in the list —
  // a filter that removed it, or a picker nobody has arrowed through yet.
  // Without this a listbox can end up with no way in at all.
  it('always leaves exactly one option in the tab order', () => {
    expect(panel).toContain('pages.some((p) => p.path === activePick.value) ? activePick.value : pages[0].path')
  })
})

/**
 * ui-specs/009, wave 3 — a citation you can check without leaving.
 *
 * The whole point is that the text is ALREADY in the browser: the chunk the host
 * put in front of the model this turn, or the same chunk in the index by id.
 */
describe('009 — the passage behind a citation', () => {
  const SRC = { n: 1, id: '/guide#auth', href: '/guide#auth', title: 'Auth', tail: 'Guide' }
  const chunk = (text) => ({ id: SRC.id, text })

  // `passage: true` written out, because it is no longer the shipped value: the
  // disclosure is a second layer over a link and a project opts into it. The
  // three cases below are about what it resolves to WHEN it is on; the fourth is
  // about the default itself.
  beforeEach(() => {
    configure({ docPilot: themeDocPilot(resolveDocPilot({ citations: { passage: true } })) })
    sessionState.index = null
  })

  it('prefers the chunk THIS turn put in front of the model', () => {
    sessionState.index = { byId: new Map([[SRC.id, chunk('what the index has now')]]) }
    const turn = { gate: { chunks: [chunk('  what the model saw  ')] } }
    expect(session.passageFor(turn, SRC)).toBe('what the model saw')
  })

  // A restored conversation: history.js drops `gate.chunks` deliberately rather
  // than spend kilobytes a turn on them, and `sources[].id` is what survives.
  it('falls back to the index by id when the gate did not survive', () => {
    sessionState.index = { byId: new Map([[SRC.id, chunk('from the index')]]) }
    expect(session.passageFor({}, SRC)).toBe('from the index')
  })

  // The third real case: the docs were rebuilt and the chunk is gone. Empty, so
  // the component renders no disclosure — a control that opens onto nothing is
  // worse than no control.
  it('returns nothing when the corpus has moved on', () => {
    sessionState.index = { byId: new Map() }
    expect(session.passageFor({}, SRC)).toBe('')
    expect(session.passageFor({}, { n: 1 })).toBe('')
  })

  it('is off entirely when the project switched it off', () => {
    configure({ docPilot: themeDocPilot(resolveDocPilot({ citations: { passage: false } })) })
    sessionState.index = { byId: new Map([[SRC.id, chunk('still here')]]) }
    expect(session.passageFor({ gate: { chunks: [chunk('still here')] } }, SRC)).toBe('')
  })

  // And off is the SHIPPED state, which is the half a `passage: false` case
  // cannot say on its own: a project that writes nothing gets the link and no
  // chevron, and the component's `v-if="passage(...)"` renders neither the
  // control nor the region for an empty string.
  it('is off on a config that says nothing', () => {
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = { byId: new Map([[SRC.id, chunk('still here')]]) }
    expect(session.passageFor({ gate: { chunks: [chunk('still here')] } }, SRC)).toBe('')
  })

  // `passageHtml` is the same three resolutions with a renderer on the end, and
  // it stays SEPARATE from `passageFor` because the text still answers two
  // questions that want nothing to do with html: whether the row gets a chevron
  // at all, and whether it gets the `has-passage` column.
  describe('as html', () => {
    const withIndex = (text) => {
      sessionState.index = {
        byId: new Map([[SRC.id, chunk(text)]]),
        manifest: { pages: [{ path: '/guide' }] },
      }
    }

    it('renders the chunk rather than handing over its syntax', () => {
      withIndex('## Auth\n\nSet the **token** first.')
      const html = session.passageHtml({}, SRC)
      expect(html).toContain('<h2>Auth</h2>')
      expect(html).toContain('<strong>token</strong>')
    })

    // The renderer is shared, so the manifest has to reach it: a chunk's own
    // cross-references are exactly the links a reader following provenance
    // presses, and the ones that resolve to nothing must not look pressable.
    it("filters the chunk's links against the manifest", () => {
      withIndex('See [guide](/guide) and [gone](/gone).')
      const html = session.passageHtml({}, SRC)
      expect(html).toContain('<a href="/guide">guide</a>')
      expect(html).toContain('<span>gone</span>')
    })

    it('is empty wherever the text is', () => {
      sessionState.index = { byId: new Map(), manifest: { pages: [] } }
      expect(session.passageHtml({}, SRC)).toBe('')
    })
  })
})

/**
 * The passage, RENDERED — the same markdown pipeline the answer runs on.
 *
 * A chunk is corpus markdown, so shown as a text node it was the one surface in
 * the panel that asked the reader to parse `##` and `**` themselves, directly
 * under an answer that never does. Nothing about what is shown changes here:
 * the whole chunk, still uncut, which is the invariant 009 argues for.
 */
describe('009 — the passage renders as markdown', () => {
  const known = new Set(['/guide/config'])
  const html = (src) => renderPassage(src, known)

  it('renders the block constructs a documentation chunk is made of', () => {
    const out = html('## Setting up\n\nA **token** and `a value`.\n\n- one\n- two')
    expect(out).toContain('<h2>Setting up</h2>')
    expect(out).toContain('<strong>token</strong>')
    expect(out).toContain('<code>a value</code>')
    expect(out).toContain('<li>one</li>')
    expect(out).not.toContain('##')
    expect(out).not.toContain('**')
  })

  // The fence card, minus its button. A copy control inside a 240px quotation
  // sits under the turn's own copy button and adds a tab stop to a scroller
  // that already is one.
  it('renders a fence as a card with no copy button', () => {
    const out = html('```js\nconst a = 1\n```')
    expect(out).toContain('class="docpilot__code"')
    expect(out).toContain('const a = 1')
    expect(out).not.toContain('docpilot__code-copy')
  })

  // The other half of that switch: the answer is the reason the button exists.
  it('leaves the answer its copy button', () => {
    expect(renderAnswer('```js\nconst a = 1\n```', known).html).toContain('docpilot__code-copy')
  })

  // Not because a chunk can lie — it is what the site's own author wrote. A
  // corpus link is written relative to the page it sits on, and resolved against
  // a panel teleported to `body` it points at nothing.
  it('keeps a link the manifest knows and de-links one it does not', () => {
    const out = html('See [config](/guide/config) and [next](../guide/next.md).')
    expect(out).toContain('<a href="/guide/config">config</a>')
    expect(out).toContain('<span>next</span>')
    expect(out).not.toContain('href="../guide/next.md"')
  })

  // A literal `[1]` in a chunk is prose about a footnote on that page, not a
  // citation into this turn's source list.
  it('does not turn a bracketed digit into a citation marker', () => {
    const out = html('See note [1] below.')
    expect(out).toContain('[1]')
    expect(out).not.toContain('docpilot__cite')
  })

  // `html: false` on the shared instance, which is what makes this the second
  // v-html in the panel that needs no escaping of its own.
  it('escapes an author\'s raw HTML rather than passing it through', () => {
    expect(html('Use <script>alert(1)</script> nowhere.')).not.toContain('<script>')
  })

  // The panel has no DOM here, so the binding is asserted the way 008's row
  // placement is: by reading the source and stating the contract it keeps.
  describe('the disclosure that shows it', () => {
    const panel = fs.readFileSync(
      new URL('../src/theme/components/DocPilot.vue', import.meta.url),
      'utf8',
    )
    const region = panel.slice(panel.indexOf('class="docpilot__passage"'))

    it('renders the html and not the interpolated source', () => {
      expect(region).toContain('v-html="passageHtml(turn, src)"')
      expect(panel).not.toContain('>{{ passage(turn, src) }}<')
    })

    // A link inside v-html has no Vue handler of its own, and a chunk's own
    // cross-references are exactly the links a reader following provenance
    // presses: without this it is a full page load out of the SPA, which below
    // 960px also drops the panel it was opened from.
    it('delegates its clicks the way the answer does', () => {
      expect(region.slice(0, region.indexOf('</div>'))).toContain('@click="onAnswerClick"')
    })
  })
})

/**
 * `toPlainText` — markdown as the text under it, for the search-only snippet.
 *
 * A row shows a 220-character window so a reader can tell whether it is the one
 * they want, and characters spent on `**` and `](/guide/config#tokens)` buy them
 * nothing.
 */
describe('toPlainText', () => {
  it('drops the syntax and keeps the words', () => {
    expect(toPlainText('## Heading\n\nA **bold** and [linked](/x) line.')).toBe(
      'Heading\nA bold and linked line.',
    )
  })

  // Half the answers in a documentation corpus ARE the code block.
  it('keeps the body of a fence', () => {
    expect(toPlainText('```js\nconst a = 1\n```')).toBe('const a = 1')
  })

  // A cell separator of its own: a row of cells is one line, not four.
  it('flattens a table to a line per row', () => {
    expect(toPlainText('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('a b\n1 2')
  })

  // The one thing it must not do: an emphasis close is INSIDE a sentence, and
  // ending the line there would cut every emphasised phrase in the corpus.
  it('does not break the sentence an emphasis sits in', () => {
    expect(toPlainText('Set **token** before you start.')).toBe('Set token before you start.')
  })

  it('is empty for nothing at all', () => {
    expect(toPlainText('')).toBe('')
    expect(toPlainText(null)).toBe('')
  })
})

describe('009 — a copied answer carries its sources', () => {
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')

  // `[1]` pasted into a ticket with nothing behind it is worse than no citation
  // at all, because it looks like provenance.
  it('copies through withSources, not answerText', () => {
    expect(panel).toContain('await navigator.clipboard.writeText(withSources(turn))')
    expect(panel).not.toContain('await navigator.clipboard.writeText(turn.answerText)')
  })

  // Absolute, because the paste lands outside the site that could resolve a route.
  it('builds absolute URLs and honours the switch', () => {
    expect(panel).toContain('if (!s.config.citations.inCopy || !turn.sources?.length) return text')
    expect(panel).toContain('const href = src.origin || `${origin}${src.href}`')
  })

  // From the list the reader is looking at — not by parsing markers back out of
  // prose the model wrote.
  it('builds the list from turn.sources', () => {
    expect(panel).toContain('turn.sources.map((src)')
  })
})

/**
 * ui-specs/009, wave 4 — the ways in.
 *
 * `applyDeepLink` is exercised for real; the prefetch split is asserted on the
 * source, because what matters about it is which half runs and there is no
 * network in a node run to watch it not happen.
 */
describe('009 — ?dp-ask= fills the composer and does not send it', () => {
  beforeEach(() => {
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.pendingQuestion = ''
    sessionState.pendingScope = null
    sessionState.open = false
  })

  it('opens the panel with the question waiting, unsent', () => {
    expect(session.applyDeepLink('?dp-ask=How%20do%20I%20rotate%20a%20key')).toBe(true)
    expect(sessionState.pendingQuestion).toBe('How do I rotate a key')
    expect(sessionState.open).toBe(true)
    // The one thing that must NOT have happened.
    expect(sessionState.turns).toHaveLength(0)
    expect(sessionState.busy).toBe(false)
  })

  it('takes a page scope as an intention, to be applied when there is a manifest', () => {
    session.applyDeepLink('?dp-ask=hello&dp-scope=page')
    expect(sessionState.pendingScope).toBe('page')
    // Anything else is ignored rather than guessed at.
    sessionState.pendingScope = null
    session.applyDeepLink('?dp-ask=hello&dp-scope=everything')
    expect(sessionState.pendingScope).toBe(null)
  })

  // A link is somebody else's input and the field it lands in caps at a thousand.
  it('clamps to the composer’s own ceiling', () => {
    session.applyDeepLink(`?dp-ask=${'x'.repeat(2000)}`)
    expect(sessionState.pendingQuestion).toHaveLength(1000)
  })

  it('strips both parameters and leaves the rest of the query alone', () => {
    let seen = null
    session.applyDeepLink('?utm=1&dp-ask=hi&dp-scope=page', (params) => (seen = params.toString()))
    expect(seen).toBe('utm=1')
  })

  it('does nothing at all when the project switched it off', () => {
    configure({ docPilot: themeDocPilot(resolveDocPilot({ composer: { deepLink: false } })) })
    expect(session.applyDeepLink('?dp-ask=hello')).toBe(false)
    expect(sessionState.pendingQuestion).toBe('')
    expect(sessionState.open).toBe(false)
  })

  it('ignores an empty or absent parameter', () => {
    expect(session.applyDeepLink('?dp-ask=%20%20')).toBe(false)
    expect(session.applyDeepLink('?other=1')).toBe(false)
    expect(session.applyDeepLink('')).toBe(false)
  })
})

describe('009 — the prefetch split', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const store = read('src/theme/docpilot/session.js')

  /**
   * The whole reason `ensureIndex` was split. It restores the scope, and that
   * can `say()` into a polite live region — with the panel closed and the
   * reader reading something else entirely.
   */
  it('prefetches the network half and nothing that announces', () => {
    const fn = store.match(/export function prefetchIndex\(\) \{[\s\S]*?\n\}/)[0]
    expect(fn).toContain('loadIndex(')
    expect(fn).not.toContain('scopeApi.restore')
    expect(fn).not.toContain('say(')
    expect(fn).not.toContain('restoreConversation')
  })

  // A prefetch is speculative and must not be able to degrade the panel before
  // the reader has asked for anything.
  it('swallows its own failure', () => {
    expect(store).toContain('loadIndex(hostConfig(state.config).ragBase).catch(() => {})')
  })

  /**
   * Both callers name the base, and neither invents one.
   *
   * `loadIndex` used to default to the literal `/rag`, which was wrong for every
   * site not served from the root of its origin — and because the prefetch
   * memoises, a base that differed between the two calls would have poisoned the
   * real load with the speculative one's answer.
   */
  it('asks the host where the index is, in both callers', () => {
    const all = store.match(/loadIndex\(/g) || []
    const resolved = store.match(/loadIndex\(hostConfig\(state\.config\)\.ragBase\)/g) || []
    expect(all.length).toBe(2)
    expect(resolved.length).toBe(2)
    // And nothing anywhere still names the literal the default used to be.
    expect(store).not.toContain("'/rag'")
  })

  // The index of a large corpus is real traffic, spent on readers who may never
  // open the panel.
  it('respects saveData and a 2G connection', () => {
    const guard = store.match(/function mayPrefetch\(\) \{[\s\S]*?\n\}/)[0]
    expect(guard).toContain('c.saveData')
    expect(guard).toContain('effectiveType')
  })

  /**
   * `loadIndex` memoises, and used to memoise its REJECTION too — so one dropped
   * connection meant a panel that could never load its index again. Harmless
   * while the only caller was `open()`; load-bearing now that a hover can fire
   * it seconds after page load.
   */
  it('releases the index memo when the fetch fails', () => {
    expect(read('src/theme/docpilot/store.js')).toMatch(/\.catch\(\(e\) => \{[\s\S]*?loading = null[\s\S]*?throw e/)
  })

  it('is wired to intent, not to page load, by default', () => {
    const trigger = read('src/theme/components/DocPilotTrigger.vue')
    expect(trigger).toContain('@pointerenter="warm"')
    expect(trigger).toContain('@focus="warm"')
    expect(trigger).toContain("ui.value.prefetch === 'hover'")
    expect(trigger).toContain('requestIdleCallback')
  })
})

describe('009 — quoting the documentation itself', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const quote = read('src/theme/components/DocPilotQuote.vue')

  /**
   * The two mounts cannot both claim one selection: the panel teleports to
   * `<body>`, so an answer is never inside the host's article, and an article
   * paragraph is never inside `.docpilot__answer`.
   *
   * The article's selector is the HOST's to name — `.vp-doc` on VitePress,
   * `.theme-doc-markdown` on Docusaurus, `article` on a blog — so what is pinned
   * here is that the component asks rather than that it knows. The literal now
   * lives in `host-vitepress.js`, asserted directly below.
   */
  it('watches the host article and nothing else on the page', () => {
    expect(quote).toContain('.closest?.(hostConfig(theme.value?.docPilot).article)')
    expect(read('src/theme/components/DocPilot.vue')).toContain(".closest?.('.docpilot__answer')")
  })

  it('takes the article selector from the binding, not from the store', () => {
    // `configure()` has not run when the first selection on a page is made, so
    // reading `session.state.config` here would use the pre-config default and
    // silently miss the host's real article on every first visit.
    expect(quote).toContain('hostConfig(theme.value?.docPilot)')
    expect(read('src/theme/docpilot/host-vitepress.js')).toContain("article: '.vp-doc, main'")
  })

  // The reader picked a paragraph, not a question. Submitting one on their
  // behalf would spend a turn on words nobody wrote.
  it('attaches the passage and opens the panel without asking anything', () => {
    const take = quote.match(/function take\(\) \{[\s\S]*?\n\}/)[0]
    expect(take).toContain('session.state.pendingQuote = text')
    expect(take).toContain('session.open()')
    expect(take).not.toContain('submit')
  })

  it('is off unless the project turned it on', () => {
    expect(quote).toContain('resolveQuote(theme.value?.docPilot).fromDocs')
    expect(themeDocPilot(resolveDocPilot({})).quote.fromDocs).toBe(false)
    expect(themeDocPilot(resolveDocPilot({ quote: { fromDocs: true } })).quote.fromDocs).toBe(true)
  })

  // ui-specs/001: a component a consumer may compose on its own must not depend
  // on the sprite being mounted.
  it('inlines its one glyph rather than referencing the sprite', () => {
    expect(quote).toContain('GLYPHS.quote')
    // By what addresses the sprite, not by the substring: the comment above the
    // glyph explains the rule by naming the element it is not using, and a
    // literal search finds the explanation as readily as a violation.
    expect(quote).not.toContain('symbolId')
    expect(quote).not.toMatch(/<use\s/)
  })
})

/**
 * ui-specs/009, wave 5 — what to do next.
 *
 * The asymmetry between these two is the defaults policy working, and it is
 * asserted rather than described: copy that ships ON has to be good for every
 * corpus, so A5 generates nothing; copy that is opted INTO only has to be good
 * enough for the project that opted in.
 */
describe('009 — an empty panel under a narrow scope', () => {
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')

  // The reason the blank state existed, and the reason it was right: the
  // built-in three fall outside a narrow scope and the gate refuses all of them.
  it('still suppresses the built-in openers outside `all`', () => {
    expect(panel).toContain("if (s.scope.kind !== 'all') return []")
  })

  // Rows built from the manifest, not questions built from headings. Nothing in
  // this path can name a page the corpus does not have.
  it('offers the pages in the scope, and generates nothing', () => {
    const fn = panel.match(/const scopedPages = computed\(\(\) => \{[\s\S]*?\n\}\)/)[0]
    expect(fn).toContain('s.index.manifest.pages')
    expect(fn).toContain('s.scope.paths.map')
    expect(fn).toContain("s.scope.kind === 'all'")
    expect(fn).toContain('s.config.suggestions.scoped')
  })

  it('is on by default and removable', () => {
    expect(themeDocPilot(resolveDocPilot({})).suggestions.scoped).toBe(true)
    expect(themeDocPilot(resolveDocPilot({ suggestions: { scoped: false } })).suggestions.scoped).toBe(false)
    // The array form still means what it always meant.
    const legacy = themeDocPilot(resolveDocPilot({ suggestions: ['One?'] }))
    expect(legacy.suggestions.questions).toEqual(['One?'])
    expect(legacy.suggestions.scoped).toBe(true)
  })
})

describe('009 — follow-up questions', () => {
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')
  const fn = panel.match(/function followUps\(turn\) \{[\s\S]*?\n\}/)[0]

  // ChatGPT ships these and its readers write custom instructions to suppress
  // them. That is the measurement behind the default, not a preference.
  it('is off until a project asks for it', () => {
    expect(themeDocPilot(resolveDocPilot({})).suggestions.followUps).toBe(false)
    expect(
      themeDocPilot(resolveDocPilot({ suggestions: { followUps: true } })).suggestions.followUps,
    ).toBe(true)
    expect(fn).toContain('s.config.suggestions.followUps')
  })

  // Three rows after EVERY answer turns a thread into a feed.
  it('appears under the newest settled turn only', () => {
    expect(fn).toContain('turn !== s.turns[s.turns.length - 1]')
    expect(fn).toContain("turn.state !== 'complete'")
    expect(fn).toContain('s.busy')
  })

  // Every string comes out of the index; the template does the grammar. A
  // generated question can name a section the corpus does not have — this
  // cannot, which is the whole difference from the openers A5 refused.
  it('takes headings from the cited pages and invents nothing', () => {
    expect(fn).toContain('s.index.chunks')
    expect(fn).toContain('pages.has(chunk.path)')
    expect(fn).toContain("T('empty.followUp', { heading: chunk.title })")
    expect(fn).toContain('FOLLOW_UPS_MAX')
  })
})

describe('009 — the first-visit hint', () => {
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')

  it('is off by default — it paints something nobody asked for', () => {
    expect(themeDocPilot(resolveDocPilot({})).ui.firstRunHint).toBe(false)
    expect(themeDocPilot(resolveDocPilot({ ui: { firstRunHint: true } })).ui.firstRunHint).toBe(true)
  })

  /**
   * The hint names one gesture. A panel with both quoting switches off does not
   * answer that gesture, and advertising it there would be the same kind of
   * overstatement the three `disclaimer` variants exist to avoid.
   */
  it('is withheld when neither quoting switch is on', () => {
    const fn = panel.match(/const showHint = computed\(\s*\([\s\S]*?\n\)/)[0]
    expect(fn).toContain('s.config.quote.fromAnswer || s.config.quote.fromDocs')
    expect(fn).toContain('s.config.ui.firstRunHint')
  })

  // Default `true`, so a server render and the first client frame agree on
  // showing nothing — and a private-mode throw costs the hint and nothing else.
  it('defaults to seen and reads storage on mount', () => {
    expect(panel).toContain('const hintSeen = ref(true)')
    expect(panel).toContain("localStorage.getItem(HINT_KEY) === '1'")
  })
})

/**
 * The footnote's last word — `ui.credit`.
 *
 * A panel a reader cannot name is a panel they cannot ask about, so the row
 * under the composer closes on one linked word: `DocPilot`. It is the only
 * segment of that row with no condition on it, which is what makes the
 * SEPARATORS the interesting part — the two segments in front of it are both
 * optional, and a footnote that opens with `· ` is what happens when nobody
 * checks.
 */
describe('the credit link in the footnote', () => {
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')
  const collect = () => {
    const messages = []
    const err = (message) => messages.push(message)
    err.messages = messages
    return err
  }

  it('is on by default and comes off with one word', () => {
    expect(themeDocPilot(resolveDocPilot({})).ui.credit).toBe(true)
    expect(themeDocPilot(resolveDocPilot({ ui: { credit: false } })).ui.credit).toBe(false)
  })

  /**
   * Through `pick`, not `!== false`. `credit: 'no'` is an author switching the
   * link OFF, and the difference between reporting that and resolving it
   * silently to `true` is whether they spend the afternoon looking for the
   * setting that already exists.
   */
  it('names a value it does not recognise instead of keeping the badge in silence', () => {
    const err = collect()
    expect(resolveUi({ ui: { credit: 'no' } }, err).credit).toBe(true)
    expect(err.messages.join('\n')).toContain('ui.credit')
  })

  // Documented and dead is the failure this asserts against: the knob resolves,
  // the reference describes it, and the template never asks.
  it('is what the template actually reads', () => {
    expect(panel).toContain('s.config.ui.credit')
    expect(panel).toContain("T('credit.label')")
  })

  /**
   * NOT GATED ON A TURN, unlike the disclaimer beside it. The moment a reader
   * wants to know what is about to answer them is the moment the thread is
   * still empty, so the credit is there on the first open.
   */
  it('does not wait for the first answer', () => {
    const row = panel.match(/<p id="dp-footnote"[\s\S]*?<\/p>/)[0]
    const credit = row.match(/<span v-if="s\.config\.ui\.credit"[\s\S]*?<\/span\s*>/)[0]
    expect(credit).not.toContain('s.turns.length')
  })

  /**
   * The separator belongs to what PRECEDES it. With `scope.enabled: false` and
   * no turn yet, both earlier segments are gone and an unconditional ` · ` is
   * the first thing in the row.
   */
  it('never leaves a leading separator in the row', () => {
    const fn = panel.match(/const creditSep = computed\([\s\S]*?\)\n/)[0]
    expect(fn).toContain('s.config.scope.enabled')
    expect(fn).toContain('s.turns.length')
    // The disclaimer's own separator, one segment earlier, on the same terms.
    const row = panel.match(/<p id="dp-footnote"[\s\S]*?<\/p>/)[0]
    expect(row).toContain('<template v-if="s.config.scope.enabled"> · </template>')
    expect(row).toContain('<template v-if="creditSep"> · </template')
  })

  // A link that leaves the site, on the same terms as every external source row
  // in the thread — see the `c.origin` pair on the refusal list.
  it('opens the project in a new tab, safely', () => {
    const row = panel.match(/<p id="dp-footnote"[\s\S]*?<\/p>/)[0]
    expect(row).toContain('target="_blank"')
    expect(row).toContain('rel="noopener noreferrer"')
  })
})

/** ui-specs/009, wave 6 — working the thread, and the panel beside the docs. */
describe('009 — working the thread', () => {
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')

  /**
   * ChatGPT's own behaviour, and readline's before it. The EMPTY condition is
   * the part that matters: without it the key stops moving the caret inside a
   * multi-line draft, which is the behaviour it is borrowing from.
   */
  it('gives ↑ the last question, only in an empty composer', () => {
    const fn = panel.match(/function editLastQuestion\(e\) \{[\s\S]*?\n\}/)[0]
    expect(fn).toContain('s.config.composer.editLastOnArrowUp')
    expect(fn).toContain('input.value.length')
    expect(fn).toContain('s.busy')
    expect(fn).toContain('editingId.value')
    expect(fn).toContain('startTurnEdit(last)')
    expect(themeDocPilot(resolveDocPilot({})).composer.editLastOnArrowUp).toBe(true)
  })

  /**
   * Submitting used to remove the form and say nothing a sighted reader could
   * see. The line has to be true under all four `send` modes, which is why
   * there are two of them.
   */
  it('leaves a confirmation the eye can see, in two truthful forms', () => {
    expect(panel).toContain("T(feedbackLive ? 'feedback.thanksSent' : 'feedback.thanks')")
    expect(panel).toContain('turn.feedbackDone')
    const session = fs.readFileSync(new URL('../src/theme/docpilot/session.js', import.meta.url), 'utf8')
    // Set BEFORE the "nothing to amend" early return: the reader pressed Send
    // either way, and the verdict was recorded when they pressed the thumb.
    const fn = session.match(/export function submitFeedback\(turn\) \{[\s\S]*?\n\}/)[0]
    expect(fn.indexOf('turn.feedbackDone')).toBeLessThan(fn.indexOf('if (!turn.reasons.length'))
    expect(fn).toContain('state.config.feedback.confirm')
  })

  // Not persisted: a restored conversation showing "thanks" for a report sent
  // two days ago would describe an interaction that is not on screen.
  it('does not carry the confirmation into the archive', () => {
    const slim = slimTurn({
      id: 't1',
      question: 'q',
      state: 'complete',
      answerText: 'a',
      sources: [],
      feedbackDone: true,
    })
    expect(Object.hasOwn(slim, 'feedbackDone')).toBe(false)
  })

  // What a support engineer pastes into a ticket is the thread, not one answer.
  it('exports the conversation through the same source rule as one answer', () => {
    const fn = panel.match(/async function copyThread\(\) \{[\s\S]*?\n\}/)[0]
    expect(fn).toContain('withSources(turn)')
    expect(fn).toContain('s.turns')
    expect(panel).toContain("s.turns.length && s.config.history.exportThread")
    expect(themeDocPilot(resolveDocPilot({})).history.exportThread).toBe(true)
  })
})

describe('009 — the picker at corpus scale', () => {
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')

  // A text input is not an option, so it cannot live inside the listbox.
  it('puts the filter outside the listbox and binds it with aria-controls', () => {
    const filterAt = panel.indexOf('docpilot__picker-filter')
    const listAt = panel.indexOf('id="dp-picker-list"')
    expect(filterAt).toBeGreaterThan(-1)
    expect(filterAt).toBeLessThan(listAt)
    expect(panel).toContain('aria-controls="dp-picker-list"')
  })

  it('shows the filter on a corpus too long to scan, and obeys an explicit value', () => {
    const fn = panel.match(/const showFilter = computed\(\(\) => \{[\s\S]*?\n\}\)/)[0]
    expect(fn).toContain("typeof mode === 'boolean'")
    expect(fn).toContain('FILTER_AUTO_ABOVE')
    expect(themeDocPilot(resolveDocPilot({})).scope.filter).toBe('auto')
    expect(themeDocPilot(resolveDocPilot({ scope: { filter: true } })).scope.filter).toBe(true)
  })

  /**
   * `focusPickAt` reaches a row by POSITION among the rendered nodes, so the
   * groups' concatenation is the keyboard's list. Deriving one from the other is
   * what stops them drifting the day the grouping changes the order.
   */
  it('derives the keyboard’s list from the rendered groups', () => {
    expect(panel).toContain('const pickFlat = computed(() => pickGroups.value.flatMap((g) => g.pages))')
    expect(panel).toContain('const pages = pickFlat.value')
    expect(panel).toContain('const page = pickFlat.value[i]')
    // The offsets are what make `g.offset + j` the flat index.
    expect(panel).toContain('group.offset = offset')
  })

  // Grouping a filtered list fragments it into headings with one row under each.
  it('goes flat while a filter is on', () => {
    const fn = panel.match(/const pickGroups = computed\(\(\) => \{[\s\S]*?\n\}\)/)[0]
    expect(fn).toContain("pickFilter.value.trim()")
    expect(fn).toContain('s.config.scope.groupBySection')
  })
})

describe('009 — the panel beside the docs', () => {
  const adapter = fs.readFileSync(new URL('../src/theme/styles/vitepress.scss', import.meta.url), 'utf8')
  const core = fs.readFileSync(new URL('../src/theme/styles/core.scss', import.meta.url), 'utf8')
  const panel = fs.readFileSync(new URL('../src/theme/components/DocPilot.vue', import.meta.url), 'utf8')

  // The SUBJECT is the host's element; our class only says when. That is rule
  // 2 of the adapter, and the reason the core may not carry this rule at all.
  it('lives in the adapter, on a foreign subject', () => {
    expect(adapter).toContain('html.docpilot-push .VPContent')
    expect(core).not.toContain('VPContent')
  })

  // `overlay` is what shipped, and an upgrade must not rearrange a docs site.
  it('is off by default', () => {
    expect(themeDocPilot(resolveDocPilot({})).ui.layout).toBe('overlay')
    expect(themeDocPilot(resolveDocPilot({ ui: { layout: 'push' } })).ui.layout).toBe('push')
    expect(themeDocPilot(resolveDocPilot({})).ui.theme).toBe('auto')
    expect(themeDocPilot(resolveDocPilot({ ui: { theme: 'dark' } })).ui.theme).toBe('dark')
  })

  // Below the sheet breakpoint the panel is edge to edge; there is nothing to
  // push. And the class must not outlive the component that wrote it.
  it('is desktop-only and is cleaned up on unmount', () => {
    expect(panel).toContain("layout === 'push' && !narrow")
    expect(panel).toContain('document.documentElement.classList.remove(LAYOUT_CLASS)')
  })
})

/**
 * ── RULE 11 — every reader-visible action is removable, and its switch is
 * documented. ui-specs/009.
 *
 * The defect this exists to make unrepeatable already shipped once, and
 * `themeDocPilot`'s own comment records it: `docPilot.suggestions` was read by
 * the client and never emitted by the build, so for the whole life of the
 * setting the fallback was the only branch that could run. Nothing failed;
 * nothing was visible in a diff.
 *
 * IT LIVES HERE RATHER THAN IN `check-docpilot.sh` because it has to import
 * `DEFAULTS` and walk a tree, and portable `grep` cannot. That is the same call
 * the check script's own header records for the two original rules that moved
 * into this suite.
 */
describe('rule 11 — every action has a switch', () => {
  const root = new URL('../', import.meta.url)
  const read = (f) => fs.readFileSync(new URL(f, root), 'utf8')

  const leavesOf = (node, prefix = '') => {
    const out = []
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...leavesOf(value, path))
      else out.push(path)
    }
    return out
  }

  /**
   * Comments out, and this is not fussiness.
   *
   * The rule scans for `config.<group>.<key>`, and the prose EXPLAINING a
   * setting names it in exactly that form — including the comment recording
   * that `config.llm.think` was deleted. `check-docpilot.sh` strips comments
   * before every one of its greps for the same reason.
   */
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')

  /** Every `.js` and `.vue` under src/theme — the whole reader-facing surface. */
  const themeFiles = () => {
    const out = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${dir}${entry.name}/`)
        else if (/\.(js|vue)$/.test(entry.name)) out.push(`${dir}${entry.name}`)
      }
    }
    walk('src/theme/')
    return out
  }

  /**
   * 11a — the panel reads no setting the config cannot set.
   *
   * Against the CLIENT half, not against `DEFAULTS`: the emitted object is what
   * the panel actually receives, and the two are deliberately different shapes —
   * `chat` in the settings becomes `llm` in the browser.
   */
  it('11a — every config read resolves to a key the client half carries', () => {
    const emitted = themeDocPilot(resolveDocPilot({}))
    const known = new Set(leavesOf(emitted).map((l) => l.split('.').slice(0, 2).join('.')))
    for (const group of Object.keys(emitted)) known.add(group)
    // The named exceptions — the eval runner's seam into the shared harness, and
    // the two credentials the client half must never carry.
    for (const path of THEME_ONLY) known.add(path)

    const unknown = new Map()
    for (const file of themeFiles()) {
      const src = stripComments(read(file))
      for (const m of src.matchAll(/\bconfig\.([a-z][A-Za-z0-9]*)\.([a-zA-Z][A-Za-z0-9]*)/g)) {
        const path = `${m[1]}.${m[2]}`
        if (!known.has(path)) unknown.set(path, file)
      }
    }
    expect(
      [...unknown].map(([path, file]) => `${path} (${file})`),
      'a setting the panel reads that nothing can set',
    ).toEqual([])
  })

  /**
   * 11b — every knob is written down. A setting added and not documented is a
   * setting nobody will find, which is rule 10's argument applied to behaviour
   * instead of to tokens.
   */
  it('11b — every leaf in DEFAULTS is named in the config reference', () => {
    const doc = read('docs/reference/config.md')
    const named = (leaf) => {
      const key = leaf.split('.').pop()
      const dotted = leaf.replace(/\./g, '\\.')
      return (
        new RegExp(`\`${dotted}\``).test(doc) ||
        new RegExp(`\`${key}\``).test(doc) ||
        new RegExp(`^#+\\s+.*\\b${dotted}\\b`, 'm').test(doc) ||
        new RegExp(`^#+\\s+${key}\\s*$`, 'm').test(doc)
      )
    }
    expect(leavesOf(DEFAULTS).filter((l) => !named(l)), 'undocumented settings').toEqual([])
  })

  /**
   * 11d — the documented VALUE, not just the documented name.
   *
   * 11b above asks whether a key is mentioned anywhere on the page, which is the
   * check a setting nobody wrote down fails. It is not the check a setting whose
   * default MOVED fails: `- **Default:** ... showRemaining: true` went on
   * satisfying 11b for as long as the key was called `showRemaining`, and a
   * reference that states the wrong shipped value is worse than one that omits
   * it — the reader configures against it and gets a panel they did not ask for.
   *
   * So the `## All defaults` block is executed and compared to the tree it
   * claims to be. This is the same arrangement the i18n key table is held to at
   * the bottom of this file, and it exists for the same reason: that table had
   * drifted by twenty-one leaves before anything was checking.
   */
  it('11d — the `All defaults` block in the reference is DEFAULTS', () => {
    const doc = read('docs/reference/config.md')
    const fence = doc.match(/^## All defaults$[\s\S]*?```js[^\n]*\n([\s\S]*?)^```$/m)
    expect(fence, 'a js block under `## All defaults`').not.toBe(null)

    // `export const docPilot =` is there because the block is meant to be
    // pasted into a config file, not because anything here needs it.
    const literal = fence[1].replace(/^\s*export\s+const\s+docPilot\s*=\s*/, '')
    // eslint-disable-next-line no-new-func
    expect(new Function(`return (${literal})`)(), 'the documented defaults').toEqual(DEFAULTS)
  })

  /**
   * 11e — the PARAMETERS TABLE, held to the same standard as the block above it.
   *
   * The reference carries two views of one tree now: `## All defaults`, which is
   * paste-able, and `## Parameters`, which is scannable — a row per setting with
   * its type, its shipped value and one line of what it does. Two views is two
   * places to drift, and the second one is the worse place: a reader who scans a
   * table trusts it precisely because they are not reading the prose.
   *
   * So the table is parsed and its Default column is EXECUTED, exactly as 11d
   * executes the block. What is checked is the set of rows and the value in each
   * one; the wording of a description is not something a test can hold, and the
   * types are held by the review that wrote them.
   *
   * `i18n` is the one row that is not a leaf. Its two keys are open maps — a
   * translation tree and a locale table — so `leavesOf` bottoms out at `{}` and
   * yields nothing for either, and the whole key is documented, and tabulated,
   * as one thing.
   *
   * `chat.extraBody` is the one row with no DEFAULT to check. It cannot have
   * one: `extraBodyOf` reads PRESENCE, so `undefined` means "the provider's own
   * fragment" and `null` means "none", and a value in `DEFAULTS` would have to
   * be one of those two and would delete the other. It is tabulated anyway —
   * a reader who scans this table and does not find a setting concludes it does
   * not exist — so its Default cell is prose and is skipped below.
   */
  it('11e — the `Parameters` table is DEFAULTS, row for row', () => {
    const doc = read('docs/reference/config.md')
    const section = doc.match(/^## Parameters$([\s\S]*?)^## /m)
    expect(section, 'a `## Parameters` section').not.toBe(null)

    /**
     * Split on an UNESCAPED pipe. The Type column is a TypeScript union and is
     * therefore full of `\|` — a naive `[^|]*` per cell tears
     * `'openai' \| 'together'` in half and reads the second fragment as the
     * default, which is a parser bug that would have been reported as a
     * documentation one.
     *
     * The link text is the key in code formatting — [`ui.trigger`](#ui-trigger)
     * — because every key on this page is.
     */
    const rows = section[1]
      .split('\n')
      .filter((line) => /^\|\s*\[/.test(line))
      .map((line) => {
        const cells = line.replace(/^\||\|\s*$/g, '').split(/(?<!\\)\|/)
        const name = /\[([^\]]+)\]\(#[^)]+\)/.exec(cells[0])
        return {
          name: name ? name[1].replace(/`/g, '').trim() : cells[0].trim(),
          type: (cells[1] || '').trim(),
          value: (cells[2] || '').trim(),
        }
      })
    expect(rows.length, 'parsed table rows').toBeGreaterThan(0)

    // Every setting, once, in the order the tree declares them — a table sorted
    // differently from the block above it is two orders for the reader to hold.
    const expected = [...leavesOf(DEFAULTS), 'i18n', 'chat.extraBody']
    expect(rows.map((r) => r.name).sort(), 'the tabulated settings').toEqual([...expected].sort())

    // And the VALUE, executed rather than string-matched: `'docs'` and `"docs"`
    // are the same default written two ways, and only one of them is the way
    // anybody writes JavaScript.
    const leafOf = (path) => path.split('.').reduce((o, k) => o?.[k], DEFAULTS)
    for (const row of rows) {
      // The one row whose default is a sentence rather than a value — see above.
      if (row.name === 'chat.extraBody') {
        expect(row.type.replace(/`/g, '').trim(), 'chat.extraBody — Type cell').not.toBe('')
        continue
      }
      const literal = row.value.replace(/^`|`$/g, '').trim()
      let got
      expect(() => {
        // eslint-disable-next-line no-new-func
        got = new Function(`return (${literal})`)()
      }, `${row.name} — Default cell is not a JavaScript value: ${row.value}`).not.toThrow()
      expect(got, `${row.name} — documented default`).toEqual(leafOf(row.name))
      // A type nobody wrote is a column that is decoration.
      expect(row.type.replace(/`/g, '').trim(), `${row.name} — Type cell`).not.toBe('')
    }
  })

  /**
   * 11c — the inventory, printed, the way rule 1b prints the rings. A reviewer
   * should be able to see every switch by name without reading the config.
   */
  it('11c — prints the switch inventory', () => {
    const switches = leavesOf(DEFAULTS).filter((l) => l.includes('.'))
    // eslint-disable-next-line no-console
    console.log(`  rule 11 — ${switches.length} switches: ${switches.join(' ')}`)
    expect(switches.length).toBeGreaterThan(0)
  })

  /**
   * The clause 009 is actually for, and the only one a reader would notice: with
   * every new switch off, the panel is the panel that shipped before it.
   */
  it('every 009 switch can be turned off, and off means what it says', () => {
    const off = themeDocPilot(
      resolveDocPilot({
        quote: { fromAnswer: false, fromDocs: false },
        citations: { passage: false, inCopy: false, pagesRead: false },
        composer: { editLastOnArrowUp: false, deepLink: false },
        suggestions: { scoped: false, followUps: false },
        scope: { filter: false, groupBySection: false },
        history: { exportThread: false },
        feedback: { confirm: false },
        ui: { layout: 'overlay', prefetch: false, firstRunHint: false },
      }),
    )
    expect(off.quote).toEqual({ fromAnswer: false, fromDocs: false })
    expect(off.citations).toEqual({ passage: false, inCopy: false, pagesRead: false })
    expect(off.composer).toEqual({ editLastOnArrowUp: false, deepLink: false })
    expect(off.suggestions.scoped).toBe(false)
    expect(off.suggestions.followUps).toBe(false)
    expect(off.scope.filter).toBe(false)
    expect(off.scope.groupBySection).toBe(false)
    expect(off.history.exportThread).toBe(false)
    expect(off.feedback.confirm).toBe(false)
    expect(off.ui.prefetch).toBe(false)
  })

  // A defect is not a feature: the four fixes of 009 ship with no key, and this
  // says so rather than leaving it to be noticed.
  it('gives the four defects no switch', () => {
    const leaves = leavesOf(DEFAULTS).join(' ')
    for (const notAKnob of ['tableScroll', 'rovingTabindex', 'listRole', 'announceQueue']) {
      expect(leaves).not.toContain(notAKnob)
    }
  })
})

describe('support', () => {
  it('extracts identifiers and ignores ones echoed from the question', () => {
    const ids = identifiers('Call `initEditor` with Plugin.init and BLOCKS_SETTINGS', 'what does initEditor do')
    expect(ids).toContain('Plugin.init')
    expect(ids).toContain('BLOCKS_SETTINGS')
    expect(ids).not.toContain('initEditor')
  })
  it('is a no-op below the identifier floor', () =>
    expect(computeSupport('plain prose', [{ text: '' }], '')).toBe(1))
  it('is null when the cited text is not in memory', () =>
    expect(computeSupport('`a.b` `c.d` `e.f` `g.h`', [{}], '')).toBeNull())
})

describe('metrics', () => {
  /**
   * The gate that could not fail a build.
   *
   * `run.js` printed "HARD GATE FAILED" and exited 0, so a breach was invisible
   * to CI, to `npm run verify` and to any script. The null cases are the reason
   * this is a function and not an `if`: a `--gate-only` pass runs no model, so
   * `hallucinated` is null there on every healthy run, and reading null as a
   * breach would fail every gate-only run ever made.
   */
  it('hard gates fail on a measured breach and only on one', () => {
    expect(hardGatesFailed({ hallucinated: 0, scopeContainment: 1 })).toBe(false)
    expect(hardGatesFailed({ hallucinated: 0.02, scopeContainment: 1 })).toBe(true)
    expect(hardGatesFailed({ hallucinated: 0, scopeContainment: 0.99 })).toBe(true)
    // --gate-only: no model ran, so there is no citation to have hallucinated.
    expect(hardGatesFailed({ hallucinated: null, scopeContainment: 1 })).toBe(false)
    expect(hardGatesFailed({ hallucinated: null, scopeContainment: null })).toBe(false)
    expect(hardGatesFailed({})).toBe(false)
    expect(hardGatesFailed(null)).toBe(false)
  })

  /**
   * The three shapes of a gold entry. The page pin is the one that was broken:
   * `path#` scored a miss on every anchor of its own page, understating recall@8
   * by about seven points across the development golden set.
   */
  it('matches the three gold shapes and nothing between them', () => {
    // bare page path — the page, and pages nested under it
    expect(underPath('guide/auth#request', 'guide/auth')).toBe(true)
    expect(underPath('guide/auth/oauth#step', 'guide/auth')).toBe(true)
    expect(underPath('guide/auth', 'guide/auth')).toBe(true)
    // ...and not a sibling whose route merely extends the string
    expect(underPath('guide/authorisation#x', 'guide/auth')).toBe(false)
    expect(underPath('guide/auth-2#x', 'guide/auth')).toBe(false)

    // page pin — every anchor of that page, and nothing else
    expect(underPath('ref/ExtensionBuilder#', 'ref/ExtensionBuilder#')).toBe(true)
    expect(underPath('ref/ExtensionBuilder#addstyles', 'ref/ExtensionBuilder#')).toBe(true)
    expect(underPath('ref/ExtensionBuilderX#api', 'ref/ExtensionBuilder#')).toBe(false)

    // one section, plus the continuation parts chunker.js splits it into.
    // `~N` is a continuation; `-N` is VitePress disambiguating a repeated
    // heading, which is a DIFFERENT section and must not score as a hit.
    expect(underPath('guide/auth#request', 'guide/auth#request')).toBe(true)
    expect(underPath('guide/auth#request~2', 'guide/auth#request')).toBe(true)
    expect(underPath('guide/auth#request-1', 'guide/auth#request')).toBe(false)
    expect(underPath('guide/auth#request-manually', 'guide/auth#request')).toBe(false)
  })

  it('token-F1 normalises SQuAD-style', () => {
    expect(tokenF1('The Editor, initialised!', 'editor initialised')).toBe(1)
    expect(tokenF1('', 'x')).toBe(0)
  })
  it('language match ignores code and paths', () => {
    expect(languageMatch('как включить', 'Включите тумблер `enableCommenting` в /editor-configuration')).toBe(1)
    expect(languageMatch('как включить', 'Toggle it on in Plugin Settings')).toBe(0)
  })
  it('wilson upper bound is wider than the point estimate', () => {
    expect(wilsonUpper95(0, 12)).toBeGreaterThan(0)
    expect(wilsonUpper95(0, 12)).toBeLessThan(wilsonUpper95(0, 3))
  })
  it('retrieval F1 credits a chunk id by its page prefix', () => {
    const r = retrievalF1Loose(['a/b#x', 'c/d#y'], ['a/b'])
    expect(r.r).toBe(1)
    expect(r.p).toBe(0.5)
  })
})

describe('calibration — the sweep selection rule (RAG-SPEC 5.6 steps 3-5)', () => {
  /** A probe row carries only what the sweep reads: an id, a stratum and a G. */
  const probe = (id, stratum, G, extra = {}) => ({ id, stratum, G, G_lex: G, ...extra })

  /** n positives at G = 1 never refuse, so they only ever supply the denominator. */
  const clean = (stratum, n, from = 0) =>
    Array.from({ length: n }, (_, i) => probe(`${stratum}-${from + i}`, stratum, 1))

  it('takes the LARGEST tau that satisfies all three bounds, not the first', () => {
    // 130 unscoped positives, one of them at G = 0.42. UB95(1,130) = 0.0324,
    // under the 0.05 bound, so that probe alone must NOT cap tau.
    const rows = [...clean('U', 129), probe('u-low', 'U', 0.42)]
    const sweep = TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))
    expect(chooseTau(sweep).tau).toBe(1)

    // Nine more at the same G takes it to 10/130, UB95 0.098 — over the bound.
    // tau must then stop at the last step BELOW the lowest failing probe.
    const many = [...clean('U', 120), ...Array.from({ length: 10 }, (_, i) => probe(`u-l${i}`, 'U', 0.42))]
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(many, t, 'G'))).tau).toBe(0.42)
  })

  it('applies the three bounds simultaneously — the tightest stratum wins', () => {
    // U is generous; S refuses one probe at 0.30 and at n = 56 UB95(1,56) is
    // 0.076, over 0.05. The scoped stratum therefore caps tau at that probe's
    // own G — refusal is `G < tau`, so a probe at 0.30 survives tau = 0.30 and
    // dies at 0.31 — even though the unscoped stratum would allow 1.00.
    const rows = [...clean('U', 130), ...clean('S', 55), probe('s-low', 'S', 0.3)]
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))).tau).toBe(0.3)
    expect(wilsonUpper95(1, 56)).toBeGreaterThan(0.05)
  })

  it('gives follow-ups the looser 0.08 bound, and it is a real difference', () => {
    // One failure among 60: UB95 = 0.0713. Over 0.05, under 0.08. The same
    // count is fatal to a positive stratum and survivable for a follow-up.
    const asS = [...clean('S', 59), probe('s-low', 'S', 0.5)]
    const asF = [...clean('F', 59), probe('f-low', 'F', 0.5)]
    expect(wilsonUpper95(1, 60)).toBeGreaterThan(0.05)
    expect(wilsonUpper95(1, 60)).toBeLessThanOrEqual(0.08)
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(asS, t, 'G'))).tau).toBe(0.5)
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(asF, t, 'G'))).tau).toBe(1)
  })

  it('scores X on refusal alone during the sweep, cause-agnostic', () => {
    // An X probe that refuses is credited whatever wouldPassUnscoped says: the
    // counterfactual is itself thresholded at tau, so scoring the cause during
    // the sweep would let the number being chosen decide its own score.
    const rows = [...clean('U', 130), probe('x-a', 'X', 0.1, { unscopedG: 1 }), probe('x-b', 'X', 0.1, { unscopedG: 0 })]
    const row = sweepRow(rows, 0.5, 'G')
    expect(row.byStratum.X.failures).toBe(0) // both refused, neither is an escape
    expect(sweepRow(rows, 0.05, 'G').byStratum.X.failures).toBe(2)
  })

  it('gatePrecision never enters the feasibility decision (step 6)', () => {
    // At tau 0.60 every negative is caught — a perfect gatePrecision — and ten
    // of the 130 unscoped positives are refused with it. The rule still will not
    // go there, because step 6 makes over-refusal the constraint and
    // negative-catch merely the objective.
    const rows = [
      ...clean('U', 120),
      ...Array.from({ length: 10 }, (_, i) => probe(`u-l${i}`, 'U', 0.11)),
      ...Array.from({ length: 40 }, (_, i) => probe(`n-${i}`, 'N2', 0.5)),
    ]
    const sweep = TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))
    const at60 = sweep.find((r) => r.tau === 0.6)
    expect(at60.gatePrecision).toBe(1) // every negative caught
    expect(at60.feasible).toBe(false) // and it is still not allowed
    expect(chooseTau(sweep).tau).toBe(0.11) // capped by the positives, not helped by the negatives
  })

  it('an n below 52 makes the 0.05 bound unreachable at zero failures', () => {
    // The arithmetic that sizes the strata: UB95(0,n) = z²/(n+z²).
    expect(wilsonUpper95(0, 51)).toBeGreaterThan(0.05)
    expect(wilsonUpper95(0, 52)).toBeLessThanOrEqual(0.05)
    // So a 51-probe positive stratum is infeasible at EVERY tau, including 0.
    const rows = clean('U', 51)
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(rows, t, 'G')))).toBeNull()
  })

  it('FAIL: no-feasible-tau when a stratum cannot meet its bound at any tau', () => {
    // This is the first of the five named RAG-SPEC 5.6 step 5 conditions, and
    // the one a too-small probe set triggers on its own.
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(clean('S', 40), t, 'G')))).toBeNull()
  })

  it('FAIL: tau-below-wlexical is decidable from the chosen tau alone', () => {
    // RAG-SPEC 3.4.4: gate.js throws at init unless wLexical < tau, so a tau at
    // or under the lexical weight can never ship. Both halves are checked here
    // — the rejection AND the acceptance — because a guard that always throws
    // would pass a one-sided test.
    const rows = [
      ...clean('U', 120),
      ...Array.from({ length: 10 }, (_, i) => probe(`u-l${i}`, 'U', 0.2)),
      ...clean('S', 56),
      ...clean('F', 36),
    ]
    const tau = chooseTau(TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))).tau
    expect(tau).toBe(0.2)
    expect(() => assertWeights({ tau, wLexical: 0.25 })).toThrow()
    expect(() => assertWeights({ tau: 0.3, wLexical: 0.25 })).not.toThrow()
  })

  it('the zExp ladder is drawn from page-contiguous scopes, never chunk samples', () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ path: `/p${i}`, chunks: 5 }))
    const s = contiguousScope(pages, 12, 3)
    expect(s.paths).toEqual(['/p3', '/p4', '/p5']) // a run, in order, no gaps
    expect(s.n).toBe(15)
    // and it wraps rather than returning a short scope at the end of the list
    expect(contiguousScope(pages, 12, 9).paths).toEqual(['/p9', '/p0', '/p1'])
  })
})

describe('calibration — what the build inlines (RAG-SPEC 5.6)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-guard-'))
  const write = (name, doc) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, JSON.stringify(doc))
    return p
  }
  const calibrated = (over = {}) => ({
    probeCount: 315,
    byStratum: { U: 130, S: 56 },
    guard: {
      tau: 0.42,
      tauLexical: 0.21,
      wDense: 0.75,
      wLexical: 0.25,
      denseMode: 'cosine',
      cosFloor: 0.44,
      cosCeil: 0.64,
      source: 'calibrated-reduced',
      calibratedAt: 'abc12345',
      zexp: [{ n: 2, z: 1 }, { n: 1191, z: 4 }],
      zexpSource: 'measured',
      overRefusalUB95: 0.02,
      gatePrecision: 0.3,
      ...over,
    },
  })
  const silent = { warn: () => {}, note: () => {} }
  const guard = (hash, doc, opts = {}) =>
    guardFor(hash, { file: doc === null ? path.join(dir, 'missing.json') : write('c.json', doc), ...silent, ...opts })

  it('inlines the measured guard when calibratedAt matches the hash being built', () => {
    const g = guard('abc12345', calibrated())
    expect(g.tau).toBe(0.42)
    expect(g.tauLexical).toBe(0.21)
    expect(g.source).toBe('calibrated-reduced')
    expect(g.zexpSource).toBe('measured')
  })

  it('stamps source from the file, so a reduced run cannot read as a full one', () => {
    expect(guard('abc12345', calibrated()).source).toBe('calibrated-reduced')
    expect(guard('abc12345', calibrated({ source: 'calibrated' })).source).toBe('calibrated')
  })

  it('warns and falls back to provisional on a hash mismatch — never fails', () => {
    const warnings = []
    const g = guardFor('deadbeef', {
      file: write('c.json', calibrated()),
      warn: (m) => warnings.push(m),
      note: () => {},
    })
    expect(g.tau).toBe(0.3)
    expect(g.source).toBe('provisional')
    expect(g.calibratedAt).toBeNull()
    expect(warnings.join(' ')).toMatch(/abc12345/)
  })

  it('falls back when there is no calibration at all', () => {
    const g = guard('abc12345', null)
    expect(g.source).toBe('provisional')
    expect(g.tau).toBe(0.3)
  })

  it('refuses a guard measured in the other denseMode', () => {
    expect(guard('abc12345', calibrated({ denseMode: 'zscore' })).source).toBe('provisional')
  })

  it('refuses a guard gate.js would throw on, rather than shipping a dead panel', () => {
    expect(guard('abc12345', calibrated({ tau: 0.2 })).source).toBe('provisional')
    expect(() => assertWeights(calibrated({ tau: 0.2 }).guard)).toThrow()
  })

  it('survives a corrupt calibration file', () => {
    const p = path.join(dir, 'bad.json')
    fs.writeFileSync(p, '{ not json')
    expect(guardFor('abc12345', { file: p, ...silent }).source).toBe('provisional')
  })

  /**
   * The chunk hash covers the CORPUS. It is sha256 over chunk text and moves for
   * no other reason, so an embedder swap leaves it identical while every cosine
   * underneath it moves — and a threshold measured on one vector space inlines
   * itself onto another in silence. This is the check that stops it.
   */
  it('refuses a guard measured with a different embedding model', () => {
    const doc = { ...calibrated(), embedModel: 'bge-m3' }
    const swapped = guard('abc12345', doc, { embedModel: 'text-embedding-3-small' })
    expect(swapped.source).toBe('provisional')
    // …and the same file is still accepted by the embedder that measured it.
    expect(guard('abc12345', doc, { embedModel: 'bge-m3' }).source).toBe('calibrated-reduced')
  })

  it('says which two models disagreed, not just that something is stale', () => {
    const warnings = []
    guardFor('abc12345', {
      file: write('c.json', { ...calibrated(), embedModel: 'bge-m3' }),
      embedModel: 'text-embedding-3-small',
      warn: (m) => warnings.push(m),
      note: () => {},
    })
    expect(warnings.join(' ')).toContain('bge-m3')
    expect(warnings.join(' ')).toContain('text-embedding-3-small')
  })

  // A calibration written before this field existed carries no `embedModel`, and
  // rejecting it would invalidate every calibration in the wild for a fact
  // nobody recorded. Absent means "unknown", which is not the same as "wrong".
  it('accepts a calibration that predates the field', () => {
    expect(guard('abc12345', calibrated(), { embedModel: 'anything' }).source).toBe(
      'calibrated-reduced',
    )
  })

  /**
   * A `--no-embed` index is calibrated on ONE threshold. `docpilot calibrate`
   * measures `tauLexical` there and writes `tau: null` rather than a number
   * nothing measured — and demanding two numbers threw the document away whole,
   * so the provisional 0.3 replaced the measured `tauLexical` on every rebuild,
   * over the only threshold that gate ever consults, while the warning told the
   * operator to run the command they had just run.
   */
  const lexicalDoc = (over = {}) => ({
    ...calibrated({ tau: null, source: 'calibrated-reduced-lexical', ...over }),
    embedModel: null,
    lexicalOnly: true,
  })

  it('keeps the tauLexical a vectorless calibration measured', () => {
    const g = guard('abc12345', lexicalDoc(), { embedModel: null })
    expect(g.tauLexical).toBe(0.21)
    expect(g.source).toBe('calibrated-reduced-lexical')
    expect(g.calibratedAt).toBe('abc12345')
    // The slot `assertWeights` reads at every retriever init, and that no
    // lexical-only turn ever reads: provisional, because nothing measured it.
    expect(g.tau).toBe(0.3)
    expect(() => assertWeights(g)).not.toThrow()
  })

  // `tau: null` on its own is ambiguous in the one way that matters: a HYBRID
  // run writes the same null when no threshold in its grid is feasible, and that
  // is a broken score function to fix rather than a measurement that is
  // finished. `lexicalOnly` is what separates them.
  it('still refuses a hybrid run that found no feasible tau', () => {
    const doc = { ...calibrated({ tau: null }), embedModel: 'bge-m3' }
    expect(guard('abc12345', doc, { embedModel: 'bge-m3' }).source).toBe('provisional')
  })

  // The other half of the pairing: `cosFloor`, `cosCeil` and `zexp` come back
  // untouched from a run that never scored a cosine, so half a guard measured
  // with no dense channel describes nothing this build's dense channel does.
  it('refuses to pair a vectorless calibration with a build that embeds', () => {
    const warnings = []
    const g = guardFor('abc12345', {
      file: write('c.json', lexicalDoc()),
      embedModel: 'bge-m3',
      warn: (m) => warnings.push(m),
      note: () => {},
    })
    expect(g.source).toBe('provisional')
    expect(warnings.join(' ')).toContain('no vectors')
  })
})

/**
 * The cosine window, swept rather than inherited.
 *
 * The failure this exists for: `cosFloor`/`cosCeil` describe where an EMBEDDER
 * puts its cosines, the pair [0.44, 0.64] was measured on bge-m3, and the sweep
 * only ever moved tau inside it. Swap the embedder and the floor can land inside
 * the positive distribution — every positive compresses toward D = 0, the only
 * feasible tau falls under `wLexical`, and `assertWeights` refuses to ship it.
 */
describe('calibration — the cosine window sweep', () => {
  const guard = {
    wDense: 0.75,
    wLexical: 0.25,
    cosFloor: 0.44,
    cosCeil: 0.64,
    denseMode: 'cosine',
    source: 'provisional',
  }

  /** A cached probe row as the sweep reads it: raw channel only, no lexical hit. */
  const row = (id, stratum, z, extra = {}) => ({
    id,
    stratum,
    z_raw: z,
    L_raw: 0,
    z_composed: null,
    L_composed: null,
    admissible: false,
    ...extra,
  })
  const many = (stratum, n, z) => Array.from({ length: n }, (_, i) => row(`${stratum}-${i}`, stratum, z))

  // Positives at 0.49, negatives at 0.42 — the shape measured when the corpus
  // moved to text-embedding-3-small. Strata are sized to their Wilson bounds:
  // 52 is the smallest n that can reach 0.05 at zero failures, 45 the smallest
  // that can reach 0.08.
  const rows = [
    ...many('U', 130, 0.49),
    ...many('S', 56, 0.49),
    ...many('F', 45, 0.49),
    ...many('N4', 20, 0.42),
    ...many('N2', 20, 0.42),
  ]

  /**
   * The transfer's half of the sweep: the window is re-fitted against a new
   * embedder while tau is inherited. These pin the two properties that make
   * that legal — it recovers the joint search's own answer, and it cannot be
   * talked into buying negative-catch with over-refusal.
   */
  describe('with tau inherited rather than chosen', () => {
    const sourceRate = { U: 0, S: 0, F: 0 }

    it('recovers the jointly-searched window when handed the tau that search chose', () => {
      const joint = chooseWindow(rows, guard)
      expect(joint).not.toBeNull()
      const pinned = fitWindowAtTau(rows, guard, joint.best.tau, sourceRate)
      expect(pinned).not.toBeNull()
      // Self-consistency: applied to the embedder it was measured on, the
      // pinned fit is the joint search. Without this the mode is a new
      // estimator rather than the same one with a coordinate fixed.
      expect(pinned.window).toEqual(joint.window)
    })

    it('refuses the window that buys negative-catch by over-refusing', () => {
      const tau = 0.63
      // The unconstrained argmax: right-shift the window until D collapses for
      // everything, and precision reads 100% because every negative is refused
      // — along with most of the positives. Measured on this package's own
      // corpus, [0.44, 0.84] scores exactly that at 77.5% over-refusal on U.
      const greedy = WINDOWS.map((w) => ({ w, row: sweepRow(regate(rows, w, guard), tau, 'G') }))
        .filter((c) => c.row.gatePrecision === 1)
        .sort((a, b) => b.row.byStratum.U.rate - a.row.byStratum.U.rate)[0]
      expect(greedy).toBeDefined()
      expect(greedy.row.byStratum.U.rate).toBeGreaterThan(0.5)

      const pinned = fitWindowAtTau(rows, guard, tau, sourceRate)
      if (pinned) expect(pinned.window).not.toEqual(greedy.w)
    })

    it('returns null rather than a window when no candidate makes the inherited tau feasible', () => {
      // Nothing in the grid can lift a corpus this flat to tau 0.95.
      expect(fitWindowAtTau(rows, guard, 0.95, sourceRate)).toBeNull()
    })

    it('refuses an inherited tau at or below wLexical, which gate.js throws on', () => {
      expect(fitWindowAtTau(rows, guard, guard.wLexical, sourceRate)).toBeNull()
      expect(fitWindowAtTau(rows, guard, 0.1, sourceRate)).toBeNull()
    })

    it('never exceeds the over-refusal the source measured', () => {
      const pinned = fitWindowAtTau(rows, guard, 0.63, { U: 0, S: 0, F: 0 })
      if (pinned) {
        for (const k of ['U', 'S', 'F']) expect(pinned.row.byStratum[k].rate).toBe(0)
      }
    })
  })

  /**
   * The anchor draw. Its size is not a preference: below the n at which UB95 at
   * zero failures fits inside a stratum's own bound, `feasible` is unreachable
   * and every window in the grid is filtered out — a run that refuses always.
   */
  describe('anchor selection for a transfer', () => {
    const probes = [
      ...Array.from({ length: 169 }, (_, i) => ({ id: `u-${i}`, question: 'q', stratum: 'U' })),
      ...Array.from({ length: 128 }, (_, i) => ({ id: `s-${i}`, question: 'q', stratum: 'S' })),
      ...Array.from({ length: 60 }, (_, i) => ({ id: `f-${i}`, question: 'q', stratum: 'F' })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `n4-${i}`, question: 'q', stratum: 'N4' })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `p-${i}`, question: 'q', stratum: 'P' })),
    ]

    it('is deterministic, so one calibration onto one index is one window', () => {
      const a = pickAnchors(probes, 'bounded').map((p) => p.id)
      const b = pickAnchors(probes, 'bounded').map((p) => p.id)
      expect(a).toEqual(b)
    })

    it('gives every bounded stratum an n its own ceiling can reach at zero failures', () => {
      const picked = pickAnchors(probes, 'bounded')
      for (const [k, v] of Object.entries(STRATA)) {
        if (!v.positive) continue
        const n = picked.filter((p) => p.stratum === k).length
        expect(wilsonUpper95(0, n)).toBeLessThanOrEqual(v.bound)
      }
    })

    it('takes the whole set under "full"', () => {
      expect(pickAnchors(probes, 'full')).toHaveLength(probes.length)
    })
  })

  it('maps a cosine onto D linearly inside the window and clamps outside it', () => {
    const w = { cosFloor: 0.16, cosCeil: 0.24 }
    expect(dOf(0.2, w)).toBeCloseTo(0.5, 10)
    expect(dOf(0.1, w)).toBe(0)
    expect(dOf(0.9, w)).toBe(1)
    // A degenerate window is a division this must not turn into Infinity.
    expect(dOf(0.5, { cosFloor: 0.3, cosCeil: 0.3 })).toBe(1)
  })

  it('the inherited window leaves no tau that gate.js would accept', () => {
    const legacy = regate(rows, { cosFloor: 0.44, cosCeil: 0.64 }, guard)
    const best = chooseTau(TAU_STEPS.map((t) => sweepRow(legacy, t, 'G')))
    // Feasible in the sweep's own terms, and unshippable: RAG-SPEC 3.4.4 has
    // gate.js throw at init unless wLexical < tau.
    expect(best.tau).toBeLessThanOrEqual(guard.wLexical)
    expect(() => assertWeights({ tau: best.tau, wLexical: guard.wLexical })).toThrow()
  })

  it('and the sweep finds one that is', () => {
    const found = chooseWindow(rows, guard)
    expect(found).not.toBeNull()
    expect(found.best.tau).toBeGreaterThan(guard.wLexical)
    expect(() => assertWeights({ tau: found.best.tau, wLexical: guard.wLexical })).not.toThrow()
    expect(WINDOWS).toContainEqual(found.window)
  })

  it('every window it will consider clears the step-5 floor', () => {
    const found = chooseWindow(rows, guard)
    for (const s of found.shortlist) {
      expect(s.blatant).toBeGreaterThanOrEqual(0.8)
      expect(s.tau).toBeGreaterThan(guard.wLexical)
    }
    // Non-degenerate when the grid offers one: a window narrower than the spread
    // it maps is a step function on the raw cosine wearing a score's clothes.
    expect(found.rampShare).toBeGreaterThanOrEqual(0.33)
  })

  it('returns null rather than a window, when no window separates the corpus', () => {
    // Positives and negatives at the same cosine: no floor and no ceiling can
    // put a threshold between them, and that is an answer about the embedder.
    const flat = [...many('U', 130, 0.5), ...many('N4', 20, 0.5)]
    expect(chooseWindow(flat, guard)).toBeNull()
  })

  it('regate takes the composed channel only when it is admissible AND higher', () => {
    const better = row('a', 'U', 0.3, { z_composed: 0.9, L_composed: 0, admissible: true })
    const inadmissible = row('b', 'U', 0.3, { z_composed: 0.9, L_composed: 0, admissible: false })
    const worse = row('c', 'U', 0.9, { z_composed: 0.3, L_composed: 0, admissible: true })
    const w = { cosFloor: 0.2, cosCeil: 0.8 }
    const [x, y, z] = regate([better, inadmissible, worse], w, guard)
    expect(x.channel).toBe('composed')
    expect(y.channel).toBe('raw')
    expect(z.channel).toBe('raw')
    // The raw channel's own G is kept beside the winner — the report reads it.
    expect(x.G_raw).toBeCloseTo(0.75 * dOf(0.3, w), 10)
  })

  it('leaves a pre-window cache line exactly as it was measured', () => {
    // RAW_SCHEMA is bumped so this should not happen; if it ever does, handing
    // back an unswept row unchanged is the honest outcome, not a silent zero.
    const old = { id: 'legacy', stratum: 'U', G: 0.61, D: 0.5, L: 0.1, channel: 'raw' }
    expect(regate([old], { cosFloor: 0.2, cosCeil: 0.8 }, guard)[0]).toEqual(old)
  })
})

/**
 * Every literal below is synthetic. A test fixture is committed text, and a
 * committed key is a leaked key — which is the exact failure this module exists
 * to stop, so it may not be reproduced here to prove the point.
 */
describe('credentials — the host-side test that runs before the embedder', () => {
  const HEX64 = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'beef1234'
  const OPENROUTER = `sk-or-v1-${HEX64}`

  it('catches the prefixed API key shape and replaces the whole span', () => {
    const { clean, count, kinds } = redactSecrets(`вот мой ключ, куда его вставить? - ${OPENROUTER}`)
    expect(count).toBe(1)
    expect(kinds).toEqual(['api-key'])
    expect(clean).toBe(`вот мой ключ, куда его вставить? - ${MASK}`)
  })

  // The hex rule would otherwise claim the tail of a key the api-key rule
  // already owns, and a half-redacted key on screen is a leaked key.
  it('leaves no fragment when two rules overlap the same span', () => {
    const { clean } = redactSecrets(OPENROUTER)
    expect(clean).toBe(MASK)
    expect(clean).not.toMatch(/[a-f0-9]{8}/)
  })

  it('catches a bare hex digest, a JWT, a Bearer header and an AWS key id', () => {
    expect(hasSecret('secretKey: 0123456789abcdef0123456789abcdef')).toBe(true)
    expect(hasSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r')).toBe(true)
    expect(hasSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(true)
    expect(hasSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    expect(hasSecret('ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1')).toBe(true)
  })

  // The corpus is full of these. Firing on them would put a credential warning
  // in front of the most ordinary question the panel gets.
  it('does not fire on the placeholders the documentation itself uses', () => {
    for (const q of [
      'where do I put YOUR_SECRET_KEY?',
      'what is the difference between PLUGIN_ID and SECRET_KEY?',
      'the sample shows "secretKey": "YOUR_SECRET_KEY" — is that literal?',
      'how do I pass secretKey to initEditor?',
    ]) {
      expect(hasSecret(q)).toBe(false)
    }
  })

  // Deliberate: a pluginId is a UUID, and so is every template, message and
  // account id a reader legitimately pastes. See the note in credentials.js.
  it('does not fire on a bare UUID', () => {
    expect(hasSecret('template 3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d does not open')).toBe(false)
  })

  it('does not fire on ordinary prose, however long the words', () => {
    expect(hasSecret('how do I configure the AMP validation service for my account?')).toBe(false)
    expect(hasSecret('')).toBe(false)
  })

  // askWithoutSecret re-enters through submit(), so the second pass must be a
  // no-op or the reader gets the same warning forever.
  it('is idempotent — the mask is not itself a credential shape', () => {
    const once = redactSecrets(`куда вставить ${OPENROUTER}?`).clean
    const twice = redactSecrets(once)
    expect(twice.count).toBe(0)
    expect(twice.clean).toBe(once)
  })

  it('redacts every occurrence, not just the first', () => {
    const { count, clean } = redactSecrets(`old ${OPENROUTER} new sk-proj-${HEX64}`)
    expect(count).toBe(2)
    expect(clean).toBe(`old ${MASK} new ${MASK}`)
  })

  it('reports offsets into the original string', () => {
    const hits = findSecrets(`key: ${OPENROUTER}`)
    expect(hits).toHaveLength(1)
    expect(hits[0].start).toBe(5)
    expect(hits[0].end).toBe(5 + OPENROUTER.length)
  })

  // Keyed by SUBTAG, not by the detector's own language name: that is the key
  // space VitePress `locales` uses, so one `ru` override block covers both the
  // panel chrome and this reply. `localeOf` is the bridge between the two.
  it('writes the warning in the language of the question, English when unsure', () => {
    expect(credentialCopy('ru').lead).toBe('Не вставляйте сюда ключи и токены.')
    expect(credentialCopy('uk').action).toBe('Відповісти на запитання без ключа')
    expect(credentialCopy(null)).toBe(credentialCopy('en'))
    expect(credentialCopy('tlh')).toBe(credentialCopy('en'))
    expect(credentialCopy(localeOf('Russian'))).toBe(credentialCopy('ru'))
  })

  it('has all three strings for every language it claims to speak', () => {
    for (const lang of CREDENTIAL_LANGUAGES) {
      const c = credentialCopy(lang)
      for (const key of ['lead', 'body', 'action']) {
        expect(typeof c[key], `${lang}.${key}`).toBe('string')
        expect(c[key].trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
      // The body carries the whole explanation — the key went nowhere, and here
      // is what to do about the one that did — so it is the long string of the
      // three in every language, including the ones that write it in 61
      // characters.
      expect(c.body.length, lang).toBeGreaterThan(c.lead.length + c.action.length)
    }
  })

  // The detector is only reachable for languages the directive detector names.
  it('speaks every language detectLanguage can return', () => {
    for (const [q, lang] of [
      ['как вставить ключ', 'Russian'],
      // Needs a letter Russian does not have; the script detector has no other
      // signal, so a Ukrainian question written without one reads as Russian.
      ['куди вставити ключ і токен', 'Ukrainian'],
      ['wie füge ich den Schlüssel ein', 'German'],
      ['キーを貼り付ける方法', 'Japanese'],
    ]) {
      expect(detectLanguage(q)).toBe(lang)
      expect(CREDENTIAL_LANGUAGES).toContain(localeOf(lang))
    }
  })
})

describe('empty-state suggestions — configured, with the built-in three as fallback', () => {
  const docPilot = (suggestions) => ({
    enabled: true,
    chat: { provider: 'ollama', model: 'qwen3:8b', temperature: 0.2 },
    embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
    topK: 12,
    maxIterations: 2,
    prompt: { show: false, allowAppend: false, override: null, extend: '' },
    suggestions,
  })
  const quiet = () => {}
  const collect = () => {
    const out = []
    const fn = (m) => out.push(m)
    fn.messages = out
    return fn
  }

  // The regression this whole change exists for: the key was documented in
  // UI-SPEC §13 and read by DocPilot.vue, but never put in the client object, so
  // the built-in fallback was the only branch that could run.
  it('reaches the client config at all', () => {
    expect(themeDocPilot(docPilot(['One?', 'Two?'])).suggestions.questions).toEqual(['One?', 'Two?'])
  })

  it('falls back to the built-in three by returning empty, for [] and for absent', () => {
    expect(resolveSuggestions(docPilot([]), quiet).questions).toEqual([])
    expect(resolveSuggestions(docPilot(undefined), quiet).questions).toEqual([])
    expect(resolveSuggestions(docPilot(null), quiet).questions).toEqual([])
  })

  it('trims, collapses inner whitespace and drops empties and repeats', () => {
    const w = collect()
    expect(resolveSuggestions(docPilot(['  How   do I auth? ', 'How do I auth?', '   ', 'Real?']), w).questions).toEqual([
      'How do I auth?',
      'Real?',
    ])
    expect(w.messages.join(' ')).toMatch(/empty/)
    expect(w.messages.join(' ')).toMatch(/repeats/)
  })

  it('drops a non-string entry instead of rendering [object Object]', () => {
    const w = collect()
    expect(resolveSuggestions(docPilot(['ok?', { label: 'x', question: 'y' }, 42]), w).questions).toEqual(['ok?'])
    expect(w.messages).toHaveLength(2)
  })

  it('falls back when the key is not an array at all', () => {
    const w = collect()
    expect(resolveSuggestions(docPilot('How do I auth?'), w).questions).toEqual([])
    expect(w.messages[0]).toMatch(/must be an array/)
  })

  // "No silent caps" — the component slices at three either way; what is being
  // tested is that the author is told which two vanished.
  it('caps at three and names what it dropped', () => {
    const w = collect()
    const five = ['a?', 'b?', 'c?', 'd?', 'e?']
    expect(resolveSuggestions(docPilot(five), w).questions).toEqual(['a?', 'b?', 'c?'])
    expect(w.messages[0]).toContain('"d?"')
    expect(w.messages[0]).toContain('"e?"')
  })
})

/**
 * `resolveUi` is called from three places — the build, the client store and two
 * components — and the whole reason it exists is that all three must agree. So
 * the properties asserted here are the ones the arrangement rests on: `'auto'`
 * is resolved exactly once, a resolved value survives a second pass unchanged,
 * and nothing outside the enum can reach a consumer.
 */
describe('resolveUi — trigger placement and panel shape', () => {
  const collect = () => {
    const out = []
    const fn = (m, v) => out.push(`${m} ${JSON.stringify(v)}`)
    fn.messages = out
    return fn
  }

  it('defaults to the floating button and the popup', () => {
    const err = collect()
    const expected = {
      // The WORD `'fab'` is one placement — deliberately, and unlike `'nav'`,
      // which is two: the floating button is on screen at every width already.
      trigger: ['fab'],
      panel: 'popup',
      showNavTrigger: false,
      showScreen: false,
      showFab: true,
      fabLabel: true,
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    }
    // Every shape a caller can hand it: absent settings, absent `ui`, an
    // explicit null. `session.configure` sees all three, because the
    // `{enabled: false}` payload carries no `ui` at all.
    for (const cfg of [undefined, null, {}, { ui: null }, { ui: {} }]) {
      expect(resolveUi(cfg, err)).toEqual(expected)
    }
    expect(err.messages).toEqual([])
  })

  it('resolves `auto` from the trigger, in both directions', () => {
    expect(resolveUi({ ui: { trigger: 'fab' } }).panel).toBe('popup')
    expect(resolveUi({ ui: { trigger: 'nav' } }).panel).toBe('drawer')
    // Spelling the default out loud must not change what it resolves to.
    expect(resolveUi({ ui: { trigger: 'fab', panel: 'auto' } }).panel).toBe('popup')
    expect(resolveUi({ ui: UI_DEFAULTS })).toEqual(resolveUi({}))
    // The floating button decides it even in company: the popup is anchored to
    // the corner it sits in, and the drawer is anchored to nothing.
    expect(resolveUi({ ui: { trigger: ['nav', 'fab'] } }).panel).toBe('popup')
    expect(resolveUi({ ui: { trigger: ['nav', 'screen'] } }).panel).toBe('drawer')
  })

  /**
   * `trigger` IS A LIST, and the three placements are not alternatives — the
   * navbar button and the mobile row only exist inside someone else's navbar,
   * and the floating button only exists outside it.
   *
   * The asymmetry between `'nav'` and `['nav']` is the whole of the
   * back-compatibility and is asserted rather than remembered: the word has
   * always meant the navbar button AND its mobile row, so a site that wrote it
   * keeps both, and only an author who spelled the list out gets it literally.
   */
  it('takes a list of placements, and a word as shorthand for one', () => {
    const err = collect()
    const trig = (value) => resolveUi({ ui: { trigger: value } }, err).trigger

    expect(trig('nav')).toEqual(['nav', 'screen'])
    expect(trig(['nav'])).toEqual(['nav'])
    expect(trig('fab')).toEqual(['fab'])
    expect(trig('screen')).toEqual(['screen'])
    expect(trig('both')).toEqual(['nav', 'screen', 'fab'])
    expect(trig('all')).toEqual(['nav', 'screen', 'fab'])
    expect(trig(['nav', 'fab'])).toEqual(['nav', 'fab'])
    // Sorted into document order and deduped, so two lists of the same
    // placements compare equal however they were typed.
    expect(trig(['fab', 'nav', 'fab'])).toEqual(['nav', 'fab'])
    expect(err.messages).toEqual([])
  })

  /**
   * An empty result is legal — but only when it was asked for.
   *
   * `'none'` is a real configuration: the hotkey still binds and a host that
   * places its own control wants exactly this. A list that ARRIVED non-empty and
   * was emptied by the filter is a typo instead, and a cosmetic setting must
   * never be able to leave a page with no way to open the panel.
   */
  it('separates "no trigger" from "every trigger was a typo"', () => {
    const err = collect()
    expect(resolveUi({ ui: { trigger: 'none' } }, err)).toMatchObject({
      trigger: [],
      showNavTrigger: false,
      showScreen: false,
      showFab: false,
    })
    expect(resolveUi({ ui: { trigger: [] } }, err).trigger).toEqual([])
    expect(err.messages).toEqual([])

    expect(resolveUi({ ui: { trigger: ['sidebar'] } }, err).trigger).toEqual(['fab'])
    expect(err.messages).toHaveLength(1)
  })

  // "No silent caps": a list that lost a member is a list whose author is about
  // to go looking for a button that never renders.
  it('names every member it dropped from a list, and keeps the rest', () => {
    const err = collect()
    expect(resolveUi({ ui: { trigger: ['fab', 'sidebar', 'nav'] } }, err).trigger).toEqual(['nav', 'fab'])
    expect(err.messages).toHaveLength(1)
    expect(err.messages[0]).toContain('ui.trigger')
    expect(err.messages[0]).toContain('"sidebar"')
  })

  /**
   * THE RESOLVER MAY NOT THROW. Not for a typo, not for a hostile value, not for
   * a word that happens to name something on `Object.prototype`.
   *
   * This is not a hypothetical. `UI_TRIGGER_WORDS` is a plain object literal, so
   * it inherits from `Object.prototype` — `UI_TRIGGER_WORDS['toString']` is a
   * FUNCTION and perfectly truthy, and `[...aFunction]` throws
   * `TypeError: not iterable`. `ui: { trigger: 'toString' }` took the whole docs
   * build down from inside the one resolver whose entire contract is that a
   * cosmetic setting cannot fail one. `Object.hasOwn` is the guard.
   *
   * The second half is the error MESSAGE, which names each dropped member:
   * `JSON.stringify` throws on a circular reference and on a BigInt, so naming
   * the value could cost more than the value did.
   */
  it('never throws — not on a prototype key, not on a value that cannot be stringified', () => {
    const circular = {}
    circular.self = circular
    const hostile = [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
      'isPrototypeOf',
      ['constructor'],
      ['fab', circular],
      ['fab', 1n],
      ['fab', () => {}],
      ['fab', Symbol('x')],
      ['fab', undefined],
      ['fab', ['nav']],
      { nav: true },
      42,
      true,
      Symbol('x'),
      () => {},
    ]
    // Labelled by INDEX. The obvious `JSON.stringify(trigger)` label throws on
    // the circular case — which is the case being tested, in the assertion that
    // says nothing may throw.
    for (const [i, trigger] of hostile.entries()) {
      /**
       * NOT `collect()`. That helper stringifies the offending VALUE into its
       * record, which is exactly the thing a circular reference kills — the
       * suite's own reporter would have thrown where the resolver did not, and
       * the failure would have read as the resolver's.
       *
       * `resolveUi` hands the raw value to `err` as a second argument on
       * purpose, so that the real default — `console.error` — can render it
       * however the host renders objects. What a caller's own reporter does
       * with it is that caller's business, which is what this stands in for.
       */
      const err = () => {}
      let out
      expect(() => {
        out = resolveUi({ ui: { trigger } }, err)
      }, `hostile[${i}] (${Object.prototype.toString.call(trigger)})`).not.toThrow()
      // And it still returns something a page can be opened with.
      expect(Array.isArray(out.trigger)).toBe(true)
      for (const t of out.trigger) expect(UI_TRIGGERS).toContain(t)
    }
  })

  // A word on `Object.prototype` is a TYPO, and gets a typo's treatment: named,
  // dropped, and the shipped default in its place.
  it('treats a prototype key as the typo it is', () => {
    const err = collect()
    expect(resolveUi({ ui: { trigger: 'toString' } }, err).trigger).toEqual(['fab'])
    expect(err.messages).toHaveLength(1)
    expect(err.messages[0]).toContain('ui.trigger')
    expect(resolveUi({ ui: { trigger: ['toString', 'fab'] } }, collect()).trigger).toEqual(['fab'])
  })

  // The resolved list is handed to the client and to three components. One
  // `.push()` anywhere must not be able to rewrite what the next call returns.
  it('hands out a list of its own, never the shared table', () => {
    const first = resolveUi({}, () => {})
    first.trigger.push('nav')
    expect(resolveUi({}, () => {}).trigger).toEqual(['fab'])
  })

  it('carries out the explicit combinations in silence', () => {
    const err = collect()
    expect(resolveUi({ ui: { trigger: 'nav', panel: 'popup' } }, err)).toEqual({
      trigger: ['nav', 'screen'],
      panel: 'popup',
      showNavTrigger: true,
      showScreen: true,
      showFab: false,
      fabLabel: true,
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    })
    expect(resolveUi({ ui: { trigger: 'fab', panel: 'drawer' } }, err)).toEqual({
      trigger: ['fab'],
      panel: 'drawer',
      showNavTrigger: false,
      showScreen: false,
      showFab: true,
      fabLabel: true,
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    })
    expect(err.messages).toEqual([])
  })

  /**
   * The floating button's two halves — ui-specs/005.
   *
   * `fabLabel` is the one setting in this resolver that is a UNION rather than
   * an enum, so the cases it has to separate are: absent, on, off, and words.
   */
  it('resolves the floating button label and icon', () => {
    const err = collect()
    const fab = (ui) => resolveUi({ ui: { trigger: 'fab', ...ui } }, err)

    expect(fab({})).toMatchObject({ fabLabel: true, fabIcon: true })
    expect(fab({ fabLabel: false })).toMatchObject({ fabLabel: false, fabIcon: true })
    expect(fab({ fabIcon: false })).toMatchObject({ fabLabel: true, fabIcon: false })
    // A string is the words themselves and is taken verbatim — never looked up.
    expect(fab({ fabLabel: 'Спросить ИИ' }).fabLabel).toBe('Спросить ИИ')
    // Blank is the same as absent-on-purpose: a label made of spaces is a label
    // the author deleted without saying so.
    expect(fab({ fabLabel: '   ' }).fabLabel).toBe(false)
    expect(err.messages).toEqual([])
  })

  // The one combination with no rendering. A cosmetic setting must never be
  // able to make the panel unopenable, so this is corrected rather than obeyed.
  it('refuses to leave the floating button with nothing on it', () => {
    const err = collect()
    expect(resolveUi({ ui: { trigger: 'fab', fabIcon: false, fabLabel: false } }, err)).toMatchObject({
      fabIcon: true,
      fabLabel: false,
    })
    expect(err.messages).toHaveLength(1)
    expect(err.messages[0]).toContain('cannot both be off')
  })

  it('reports a label that is neither a boolean nor a string', () => {
    const err = collect()
    expect(resolveUi({ ui: { fabLabel: 42 } }, err).fabLabel).toBe(true)
    expect(err.messages).toHaveLength(1)
    expect(err.messages[0]).toContain('ui.fabLabel')
  })

  it('reports a value outside the enum and falls back', () => {
    const err = collect()
    // The panel still resolves off the trigger that WAS given: a typo in one
    // key must not quietly undo the other.
    expect(resolveUi({ ui: { trigger: 'fab', panel: 'modal' } }, err)).toMatchObject({
      trigger: ['fab'],
      panel: 'popup',
    })
    expect(resolveUi({ ui: { trigger: 'sidebar' } }, err)).toMatchObject({
      trigger: ['fab'],
      panel: 'popup',
    })
    expect(err.messages).toHaveLength(2)
    expect(err.messages[0]).toContain('ui.panel')
    expect(err.messages[0]).toContain('"modal"')
    expect(err.messages[1]).toContain('ui.trigger')
  })

  /**
   * `ui.theme` — the one key where `'auto'` comes back out.
   *
   * `panel: 'auto'` names a SHAPE and the build settles it from the trigger
   * list, which is why nothing downstream may re-derive it. This names a
   * SIGNAL, and the signal is the reader's browser: there is nothing to settle
   * at build time, and a resolver that settled it anyway would pin every reader
   * to whichever scheme the machine that ran the build happened to prefer.
   */
  it('leaves the scheme unsettled, and pins the two that are settled', () => {
    const err = collect()
    expect(resolveUi({}, err).theme).toBe('auto')
    expect(resolveUi({ ui: { theme: 'auto' } }, err).theme).toBe('auto')
    expect(resolveUi({ ui: { theme: 'light' } }, err).theme).toBe('light')
    expect(resolveUi({ ui: { theme: 'dark' } }, err).theme).toBe('dark')
    expect(err.messages).toEqual([])
  })

  // The same thing said twice. Folded BEFORE the enum check, so the word never
  // reaches `pick` and the message it would have printed never fires — and so
  // the resolved value is one `UI_THEMES` names, which is what keeps the
  // browser's second pass a no-op.
  it('reads `system` as the word `auto`', () => {
    const err = collect()
    expect(resolveUi({ ui: { theme: 'system' } }, err).theme).toBe('auto')
    expect(err.messages).toEqual([])
  })

  it('reports a scheme outside the enum and falls back to the page', () => {
    const err = collect()
    expect(resolveUi({ ui: { theme: 'darkk' } }, err).theme).toBe('auto')
    expect(err.messages).toHaveLength(1)
    expect(err.messages[0]).toContain('ui.theme')
    expect(err.messages[0]).toContain('"darkk"')
  })

  // The property the two-sided call depends on: the build resolves and emits
  // under the same key, the browser resolves what it received. If a resolved
  // member were not itself legal input, the second pass would rewrite it.
  it('is idempotent across the build/browser round trip', () => {
    // Every input shape, because the resolved `trigger` is an array whichever
    // one went in — and an array is the shape the second pass reads back.
    for (const trigger of [
      undefined,
      'nav',
      'fab',
      'screen',
      'both',
      'none',
      [],
      ['nav'],
      ['nav', 'fab'],
      ['nav', 'screen', 'fab'],
    ]) {
      for (const panel of [undefined, 'auto', 'drawer', 'popup']) {
        // Every resolved value of the union is itself legal input, which is what
        // makes the second pass a no-op rather than a rewrite.
        for (const fabLabel of [undefined, true, false, 'Ask AI']) {
          for (const fabIcon of [undefined, true, false]) {
            // `'system'` is the one input in this suite whose resolved form is a
            // DIFFERENT word, so it is the one that would break the round trip
            // if the fold ever moved after the enum check instead of before it.
            for (const theme of [undefined, 'auto', 'light', 'dark', 'system']) {
              const once = resolveUi({ ui: { trigger, panel, fabLabel, fabIcon, theme } }, () => {})
              expect(
                resolveUi({ ui: once }),
                `${trigger}/${panel}/${fabLabel}/${fabIcon}/${theme}`,
              ).toEqual(once)
            }
          }
        }
      }
    }
  })

  /**
   * `ui.font` / `ui.fontMono` — the face, for a site the panel cannot inherit
   * one from.
   *
   * THE DEFAULT IS NOT IN THIS RESOLVER and the null cases below are what says
   * so: `--dp-font` is `inherit` in the stylesheet, so an unconfigured panel
   * already wears the page's own font and nothing is written to the document.
   */
  it('takes a family list, and grows a var() around a bare property name', () => {
    const err = collect()
    expect(resolveUi({ ui: { font: 'Inter, system-ui, sans-serif' } }, err).font).toBe(
      'Inter, system-ui, sans-serif',
    )
    // The spelling a site that already keeps the value in a variable reaches
    // for. The wrapper is the one part of it with no decision in it.
    expect(resolveUi({ ui: { font: '--brand-font' } }, err).font).toBe('var(--brand-font)')
    // Written out, fallback and all, and passed through untouched.
    expect(resolveUi({ ui: { font: 'var(--brand-font, Inter)' } }, err).font).toBe(
      'var(--brand-font, Inter)',
    )
    expect(resolveUi({ ui: { fontMono: '--brand-mono' } }, err).fontMono).toBe('var(--brand-mono)')
    expect(err.messages).toEqual([])
  })

  it('reads absent, false and a blank string as the page\'s own font', () => {
    const err = collect()
    for (const font of [undefined, null, false, '', '   ']) {
      expect(resolveUi({ ui: { font, fontMono: font } }, err), String(font)).toMatchObject({
        font: null,
        fontMono: null,
      })
    }
    // None of those is a mistake, so none of them is reported.
    expect(err.messages).toEqual([])
  })

  /**
   * The value is written onto `<html>` with `setProperty`, so what is refused is
   * the punctuation that could end that declaration or open another. Dropped
   * with a message rather than thrown, like every other value here: a typo in a
   * cosmetic setting must not be able to fail a docs build.
   */
  it('drops a value that could end the declaration, and says so', () => {
    const err = collect()
    for (const bad of [
      'Inter; position: fixed',
      'Inter } .docpilot { display: none',
      'url(https://example.com/f.woff2)',
      'Inter /* x */',
      '@import "x"',
      42,
      {},
    ]) {
      expect(resolveUi({ ui: { font: bad } }, err).font, String(bad)).toBe(null)
    }
    expect(err.messages.length).toBe(7)
    for (const m of err.messages) expect(m).toContain('ui.font')
  })

  it('is idempotent for the two faces too', () => {
    for (const font of [undefined, '--brand-font', 'var(--x, Inter)', 'Inter, sans-serif', 'bad;x']) {
      const once = resolveUi({ ui: { font, fontMono: font } }, () => {})
      expect(resolveUi({ ui: once }, () => {}), String(font)).toEqual(once)
    }
  })
})

/**
 * One shortcut, however many triggers are on the page.
 *
 * `docPilotSlots()` mounts two `DocPilotTrigger`s today and three once the floating
 * button exists, and each one used to add its own `keydown` listener — two
 * listeners toggle the panel twice, which reads as the key doing nothing. The
 * counting is asserted here rather than through a mounted component, because
 * what is being tested is the counter, not Vue.
 */
describe('hotkey — one listener behind a reference count', () => {
  const fakeWindow = () => ({
    added: [],
    addEventListener(type, fn) {
      this.added.push(fn)
    },
    removeEventListener(type, fn) {
      this.added = this.added.filter((f) => f !== fn)
    },
  })

  it('binds once for many mounts and releases on the last unmount', () => {
    const w = fakeWindow()
    const fired = []
    bindHotkey(() => fired.push(1), w)
    bindHotkey(() => fired.push(2), w)
    bindHotkey(() => fired.push(3), w)
    expect(w.added).toHaveLength(1)
    expect(hotkeyRefCount()).toBe(3)

    // Whichever callback won, the key fires exactly once per press.
    w.added[0]({ metaKey: true, key: 'I', preventDefault() {} })
    expect(fired).toHaveLength(1)

    unbindHotkey()
    unbindHotkey()
    expect(w.added).toHaveLength(1) // still one trigger alive
    unbindHotkey()
    expect(w.added).toHaveLength(0)
    expect(hotkeyRefCount()).toBe(0)
  })

  it('ignores an unmatched release rather than going negative', () => {
    const w = fakeWindow()
    unbindHotkey()
    unbindHotkey()
    expect(hotkeyRefCount()).toBe(0)
    // The next mount still gets a listener — this is the HMR case, where the
    // count going to -2 would leave the shortcut dead until a full reload.
    bindHotkey(() => {}, w)
    expect(w.added).toHaveLength(1)
    unbindHotkey()
  })

  it('fires on Cmd or Ctrl and on nothing else', () => {
    const w = fakeWindow()
    const fired = []
    bindHotkey(() => fired.push(1), w)
    const press = (e) => w.added[0]({ preventDefault() {}, ...e })
    press({ metaKey: true, key: 'i' })
    press({ ctrlKey: true, key: 'I' })
    expect(fired).toHaveLength(2)
    press({ key: 'i' })
    press({ metaKey: true, key: 'k' })
    press({ metaKey: true })
    expect(fired).toHaveLength(2)
    unbindHotkey()
  })
})

/**
 * The setting's whole path: settings object → merger → emitter → browser.
 *
 * Each hop has a different job and the suite pins which is which. The merger
 * fills defaults and keeps `'auto'` — resolving there would make the resolved
 * shape the input of the next merge. The emitter resolves, because the build is
 * where a bad value should be complained about. The browser resolves again,
 * because one reachable payload never went through the emitter at all.
 */
describe('ui — from settings to the browser', () => {
  // FIRST, deliberately: nothing else in this file touches the session store,
  // so this is the only place `state.config` is still the module's own
  // DEFAULTS. It is what the panel runs on between import and `configure`.
  it('starts the client on a RESOLVED default, not on `auto`', () => {
    expect(sessionState.config.ui).toEqual(resolveUi({}))
  })

  it('merges but does not resolve — `auto` survives resolveDocPilot', () => {
    expect(resolveDocPilot({}).ui).toEqual(UI_DEFAULTS)
    // Half an object in, a whole one out: the key the author left alone keeps
    // its default instead of vanishing.
    expect(resolveDocPilot({ ui: { trigger: 'fab' } }).ui).toEqual({
      trigger: 'fab',
      panel: 'auto',
      fabLabel: true,
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    })
  })

  it('emits the resolved structure, so no component re-derives it', () => {
    expect(themeDocPilot(resolveDocPilot({})).ui).toEqual({
      trigger: ['fab'],
      panel: 'popup',
      showNavTrigger: false,
      showScreen: false,
      showFab: true,
      fabLabel: true,
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    })
    expect(themeDocPilot(resolveDocPilot({ ui: { trigger: 'fab', fabLabel: 'Ask AI' } })).ui).toEqual({
      trigger: ['fab'],
      panel: 'popup',
      showNavTrigger: false,
      showScreen: false,
      showFab: true,
      fabLabel: 'Ask AI',
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    })
    // The combination this whole change exists for, end to end: both buttons on
    // the page, the popup chosen by the one placement with a geometric opinion.
    expect(
      themeDocPilot(resolveDocPilot({ ui: { trigger: ['nav', 'fab'], panel: 'popup', fabLabel: 'Ask AI' } })).ui,
    ).toEqual({
      trigger: ['nav', 'fab'],
      panel: 'popup',
      showNavTrigger: true,
      showScreen: false,
      showFab: true,
      fabLabel: 'Ask AI',
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    })
  })

  it('reaches the client through configure', () => {
    configure({ docPilot: themeDocPilot(resolveDocPilot({ ui: { trigger: 'fab', panel: 'drawer' } })) })
    expect(sessionState.config.ui).toEqual({
      trigger: ['fab'],
      panel: 'drawer',
      showNavTrigger: false,
      showScreen: false,
      showFab: true,
      fabLabel: true,
      fabIcon: true,
      layout: 'overlay',
      prefetch: 'hover',
      firstRunHint: false,
      background: 'notify',
      credit: true,
      theme: 'auto',
      font: null,
      fontMono: null,
    })
  })

  // src/index.js sends `{enabled: false}` and nothing else when the panel is
  // off. That payload never met `themeDocPilot`, so it carries no `ui` — and a
  // spread-based merge would leave the client reading `undefined.showFab`.
  it('leaves the disabled payload on the client defaults', () => {
    configure({ docPilot: { enabled: false } })
    expect(sessionState.config.enabled).toBe(false)
    expect(sessionState.config.ui).toEqual(resolveUi({}))
  })
})

/**
 * The whole class of bug the `suggestions` suite above is one instance of.
 *
 * A setting is added to DEFAULTS, documented, read by the panel — and never put
 * into the object the panel actually receives. Nothing throws, nothing warns,
 * and the built-in default is the only branch that can ever run. It had shipped
 * three more times than anyone noticed: `feedbackEndpoint`, `guard` and `scope`
 * were all read by session.js and all absent from themeDocPilot.
 *
 * So the rule is asserted instead of remembered: every key either reaches the
 * client or is named in SERVER_ONLY. Adding a setting without doing one of the
 * two fails here.
 */
describe('themeDocPilot — the client half is complete by construction', () => {
  // `chat` is the one setting that crosses under a different name: the browser
  // knows adapters and transports, not which brand answers.
  const RENAMED = { chat: 'llm' }
  const emitted = themeDocPilot(resolveDocPilot({}))

  // A dotted entry withholds one key inside a group whose others DO cross —
  // `chat.preferLocal`, an input to resolution whose OUTPUT is `llm.chain`.
  const TOP_ONLY = SERVER_ONLY.filter((k) => !k.includes('.'))
  const NESTED_ONLY = new Set(SERVER_ONLY.filter((k) => k.includes('.')))

  it('emits every top-level setting that is not explicitly server-only', () => {
    const unreachable = Object.keys(DEFAULTS).filter(
      (k) => !TOP_ONLY.includes(k) && !Object.hasOwn(emitted, RENAMED[k] ?? k),
    )
    expect(unreachable).toEqual([])
  })

  it('withholds every server-only setting — a key, not an oversight', () => {
    for (const k of TOP_ONLY) expect(Object.hasOwn(emitted, k)).toBe(false)
    for (const dotted of NESTED_ONLY) {
      const [group, key] = dotted.split('.')
      expect(Object.hasOwn(emitted[RENAMED[group] ?? group] ?? {}, key), dotted).toBe(false)
    }
  })

  it('carries every nested key of chat, prompt, guard and scope', () => {
    for (const [from, to] of [
      ['chat', 'llm'],
      ['prompt', 'prompt'],
      ['guard', 'guard'],
      ['scope', 'scope'],
      ['ui', 'ui'],
      ['history', 'history'],
      ['feedback', 'feedback'],
    ]) {
      for (const k of Object.keys(DEFAULTS[from])) {
        if (NESTED_ONLY.has(`${from}.${k}`)) continue
        expect(Object.hasOwn(emitted[to], k), `${from}.${k}`).toBe(true)
      }
    }
  })

  it('passes configured values through, not just the key names', () => {
    const out = themeDocPilot(
      resolveDocPilot({
        feedbackEndpoint: 'https://example.com/vote',
        guard: { tau: 0.42 },
        scope: { enabled: false },
        chat: { numCtx: 16384 },
      }),
    )
    expect(out.feedbackEndpoint).toBe('https://example.com/vote')
    expect(out.guard.tau).toBe(0.42)
    // The half the reader did not set keeps its default rather than vanishing.
    expect(out.guard.supportMinIdentifiers).toBe(3)
    expect(out.scope.enabled).toBe(false)
    expect(out.llm.numCtx).toBe(16384)
  })
})

/**
 * The production proxy contract — the same paths the browser actually posts to.
 *
 * `proxyContract` is read by a human building an nginx or Caddy config, and the
 * notes tell that human to match the paths EXACTLY. So a path here that the
 * adapter does not use is not a cosmetic defect: it is a 404 on every question,
 * in production only, on a configuration that passed `vitepress dev` — the dev
 * proxy matches `/ai` by prefix and covers the mistake.
 *
 * It shipped that way for Anthropic: the contract said `/ai/v1/chat/completions`
 * and the adapter posts to `/ai/v1/messages`. Two copies of one fact, so the
 * copy is gone — the contract asks the adapter — and this pins the two together
 * for every provider rather than for the one that was noticed.
 */
describe('proxy contract — paths come from the adapters, not a second list', () => {
  const env = {
    OPENAI_API_KEY: 'k',
    ANTHROPIC_API_KEY: 'k',
    GEMINI_API_KEY: 'k',
    GROQ_API_KEY: 'k',
    OPENROUTER_API_KEY: 'k',
  }

  const contractFor = (chat, embed) =>
    proxyContract(resolveDocPilot({ chat: { provider: chat, model: 'm' }, embed }, env), env)

  it.each([
    ['openai', undefined],
    ['gemini', undefined],
    ['anthropic', { provider: 'openai', model: 'text-embedding-3-small' }],
    ['groq', { provider: 'openai', model: 'text-embedding-3-small' }],
    ['openrouter', { provider: 'openai', model: 'text-embedding-3-small' }],
  ])('%s: the chat path is the one the adapter posts to', (chat, embed) => {
    const client = themeDocPilot(
      resolveDocPilot({ chat: { provider: chat, model: 'm' }, embed }, env),
      env,
    )
    const adapter = providerFor(client.llm.provider)
    const paths = contractFor(chat, embed).routes.map((r) => r.path)
    expect(paths).toContain(adapter.chatUrl(client.llm.baseURL))
  })

  it('the embeddings path is the one the embed adapter posts to', () => {
    const docPilot = resolveDocPilot({ chat: { provider: 'openai', model: 'm' } }, env)
    const client = themeDocPilot(docPilot, env)
    const adapter = providerFor(client.embed.provider)
    expect(proxyContract(docPilot, env).routes.map((r) => r.path)).toContain(
      adapter.embedUrl(client.embed.baseURL),
    )
  })

  it('rewrites onto the upstream path the provider actually serves', () => {
    const split = { provider: 'openai', model: 'text-embedding-3-small' }
    const contract = contractFor('anthropic', split)
    const [embed, chat] = contract.routes
    expect(embed.upstream + embed.rewrite).toBe('https://api.openai.com/v1/embeddings')
    expect(chat.upstream + chat.rewrite).toBe('https://api.anthropic.com/v1/messages')
    // The header NAME is printed so a config can attach it; the value never is.
    expect(chat.header).toBe('x-api-key')
    expect(chat.envKey).toBe('ANTHROPIC_API_KEY')
    // The key VALUE is 'k' in this env and appears nowhere in what is printed.
    expect(JSON.stringify(contract).split('"').includes('k')).toBe(false)
  })

  it('a fully local setup has nothing to proxy', () => {
    expect(contractFor('ollama').routes).toEqual([])
  })
})

/**
 * External provenance — the allowlist.
 *
 * This is a security boundary, not a convenience. A `source:` value travels into
 * `manifest.pages[].origin`, into `sourceRow()`, and out as an `href` rendered
 * inside the answer panel — so a hand-written `javascript:…` in any markdown
 * file in the repository would be stored XSS if the only gate were the tool that
 * happened to write that file.
 */
describe('external provenance — the allowlist', () => {
  const listOf = (...allow) => parseAllowlist({ allow }).entries

  it('admits only https, by allowlist rather than by denylist', () => {
    const ok = listOf('https://example.com')
    expect(checkSource('https://example.com/a', ok).href).toBe('https://example.com/a')
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'http://example.com/a',
      'vbscript:msgbox',
    ]) {
      expect(checkSource(bad, ok).error, bad).toBeTruthy()
    }
  })

  it('narrows to a path prefix at a SEGMENT boundary, not a string one', () => {
    const scoped = listOf('https://example.com/docs')
    expect(checkSource('https://example.com/docs', scoped).href).toBeTruthy()
    expect(checkSource('https://example.com/docs/guide', scoped).href).toBeTruthy()
    // `/docsecret` starts with `/docs` and is a different place entirely.
    expect(checkSource('https://example.com/docsecret', scoped).error).toBeTruthy()
    expect(checkSource('https://example.com/other', scoped).error).toBeTruthy()
  })

  it('compares ORIGINS, which is what defeats a look-alike host', () => {
    const ok = listOf('https://example.com')
    expect(checkSource('https://example.com.evil.test/a', ok).error).toBeTruthy()
    // userinfo: the URL parser reads the host as evil.test, and so does this.
    expect(checkSource('https://example.com@evil.test/a', ok).error).toBeTruthy()
    expect(checkSource('https://evil.test/?x=https://example.com', ok).error).toBeTruthy()
  })

  it('absent is legal and empty is not the same as absent', () => {
    // A repo with nothing imported needs no list at all…
    expect(parseAllowlist(undefined)).toEqual({ entries: [], errors: [] })
    expect(parseAllowlist(null)).toEqual({ entries: [], errors: [] })
    // …but a page that declares a source with no list is a page whose citation
    // would point somewhere nobody approved.
    expect(checkSource('https://example.com/a', []).error).toBeTruthy()
  })

  it('names every malformed entry rather than silently allowing nothing', () => {
    expect(parseAllowlist({ allow: 'https://example.com' }).errors).toHaveLength(1)
    expect(parseAllowlist({}).errors).toHaveLength(1)
    const errors = parseAllowlist({
      allow: ['not a url', 'http://example.com', 'https://example.com/?q=1'],
    }).errors
    expect(errors).toHaveLength(3)
    expect(errors.join(' ')).toMatch(/query or fragment/)
  })
})

/**
 * The llms.txt sidebar workaround. Its first version silently did nothing —
 * it walked a multi-sidebar as if it were a group, found no `link` and no
 * `items`, and returned the object untouched — so both shapes are tested.
 */
describe('absoluteSidebar', () => {
  it('prefixes a relative link with its group base and drops the base', () => {
    const out = absoluteSidebar([
      { text: 'Guide', base: '/guide/', items: [{ text: 'Start', link: 'start' }] },
    ])
    expect(out[0].items[0].link).toBe('/guide/start')
    expect(out[0].base).toBeUndefined()
  })

  it('walks a MULTI-sidebar, keyed by route prefix', () => {
    const out = absoluteSidebar({
      '/guide/': [{ base: '/guide/', items: [{ text: 'A', link: 'a' }] }],
      '/ref/': [{ base: '/ref/', items: [{ text: 'B', link: 'b' }] }],
    })
    expect(out['/guide/'][0].items[0].link).toBe('/guide/a')
    expect(out['/ref/'][0].items[0].link).toBe('/ref/b')
  })

  it('bases a leading-slash link, because VitePress does, and inherits down the tree', () => {
    const out = absoluteSidebar([
      {
        base: '/guide/',
        items: [
          { text: 'Abs', link: '/elsewhere' },
          { text: 'Nested', items: [{ text: 'Deep', link: 'deep' }] },
        ],
      },
    ])
    // theme-default/support/sidebar.js: `base + link.replace(/^\//, base
    // .endsWith('/') ? '' : '/')` — a leading slash is stripped, not respected.
    // Leaving it alone here printed /elsewhere in llms.txt for a page VitePress
    // serves at /guide/elsewhere.
    expect(out[0].items[0].link).toBe('/guide/elsewhere')
    expect(out[0].items[1].items[0].link).toBe('/guide/deep')
  })

  it('leaves an external link alone — VitePress skips those too', () => {
    const out = absoluteSidebar([
      {
        base: '/guide/',
        items: [
          { text: 'GitHub', link: 'https://github.com/cloflin/docpilot' },
          { text: 'Protocol-relative', link: '//example.com/x' },
        ],
      },
    ])
    // Without the isExternal check these became `/guide/https://…`.
    expect(out[0].items[0].link).toBe('https://github.com/cloflin/docpilot')
    expect(out[0].items[1].link).toBe('//example.com/x')
  })

  it('a group with no base leaves its links untouched', () => {
    const out = absoluteSidebar([{ items: [{ text: 'A', link: '/a' }, { text: 'B', link: 'b' }] }])
    expect(out[0].items[0].link).toBe('/a')
    expect(out[0].items[1].link).toBe('b')
  })

  it('does not mutate the object VitePress renders from', () => {
    const input = [{ base: '/guide/', items: [{ text: 'A', link: 'a' }] }]
    absoluteSidebar(input)
    expect(input[0].base).toBe('/guide/')
    expect(input[0].items[0].link).toBe('a')
  })
})

describe('config — sources and importDir', () => {
  it('assigns the allowlist whole; a half-merge would keep a deleted origin', () => {
    const resolved = resolveDocPilot({ sources: { allow: ['https://example.com'] } })
    expect(resolved.sources).toEqual({ allow: ['https://example.com'] })
    expect(resolveDocPilot({}).sources).toBeNull()
    expect(resolveDocPilot({}).importDir).toBeNull()
  })

  it('never sends the allowlist to the browser — the origin is baked into the index', () => {
    const out = themeDocPilot(resolveDocPilot({ sources: { allow: ['https://example.com'] } }))
    expect(Object.hasOwn(out, 'sources')).toBe(false)
    expect(JSON.stringify(out)).not.toContain('example.com')
  })

  it('readiness reports a malformed allowlist, because `docpilot index` will die on it', () => {
    const r = readiness(resolveDocPilot({ sources: { allow: ['http://example.com'] } }), {})
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => /allowlist/.test(m.what))).toBe(true)
  })

  it('a missing importDir is a note, not a blocker — every published page still answers', () => {
    const r = readiness(resolveDocPilot({ importDir: 'no-such-dir-here' }), {})
    expect(r.notes.join(' ')).toMatch(/no-such-dir-here/)
    expect(r.missing.some((m) => /no-such-dir-here/.test(m.what))).toBe(false)
  })
})

describe('external provenance — the frontmatter contract', () => {
  const page = (fm, body = '# Title\n\nSome text.') => `---\n${fm}\n---\n\n${body}`

  it('reads `source:` only at column 0 — a nested key belongs to its own key', () => {
    expect(normaliseMarkdown(page('title: T\nsource: https://example.com/a')).source).toBe(
      'https://example.com/a',
    )
    expect(normaliseMarkdown(page('title: T\nhead:\n  source: https://example.com/a')).source).toBeNull()
  })

  it('rides out of the chunker unvalidated, on both return paths', () => {
    const withText = chunkMarkdown({
      src: page('title: T\nsource: https://example.com/a'),
      path: '/p',
      kind: 'guide',
    })
    expect(withText.source).toBe('https://example.com/a')
    expect(withText.chunks.length).toBeGreaterThan(0)

    // `layout: home` returns early with no chunks, and provenance is a property
    // of the page rather than of any chunk — so it still has to come back.
    const home = chunkMarkdown({
      src: page('title: T\nlayout: home\nsource: https://example.com/a'),
      path: '/',
      kind: 'guide',
    })
    expect(home.chunks).toEqual([])
    expect(home.source).toBe('https://example.com/a')
  })

  it('is absent, not undefined-shaped, on a page that declares nothing', () => {
    expect(normaliseMarkdown('# Plain\n\ntext').source).toBeNull()
    expect(chunkMarkdown({ src: '# Plain\n\ntext', path: '/p', kind: 'guide' }).source).toBeNull()
  })
})

/**
 * The i18n layer.
 *
 * The rule the whole design rests on: overriding ONE string keeps the other
 * eighty. A shape that replaced a block wholesale would make translating a
 * button label silently delete every sibling label.
 */
describe('i18n — merge and fallback', () => {
  const tree = (i18n) => resolveI18n(validateI18n(i18n, () => {}))
  const T = (i18n, locale, path, vars, ui) => t(tree(i18n), locale, path, vars, ui)

  it('falls through to the shipped default when nothing is configured', () => {
    expect(T({}, 'en', 'empty.heading')).toBe('How can I help you today?')
    expect(T({}, 'ru', 'empty.heading')).toBe('How can I help you today?')
  })

  it('a locale block beats the root, and the root beats the shipped default', () => {
    const i18n = {
      translations: { empty: { heading: 'Root heading' } },
      locales: { ru: { translations: { empty: { heading: 'Заголовок' } } } },
    }
    expect(T(i18n, 'ru', 'empty.heading')).toBe('Заголовок')
    expect(T(i18n, 'de', 'empty.heading')).toBe('Root heading')
  })

  it('merges per LEAF — one override does not delete its siblings', () => {
    const i18n = { locales: { ru: { translations: { panel: { close: 'Закрыть' } } } } }
    expect(T(i18n, 'ru', 'panel.close')).toBe('Закрыть')
    expect(T(i18n, 'ru', 'panel.newChat')).toBe('New chat')
    expect(T(i18n, 'ru', 'empty.heading')).toBe('How can I help you today?')
  })

  it('interpolates {name} and picks a plural form on {n, one|many}', () => {
    expect(T({}, 'en', 'refusal.searched', { scope: 'the docs' })).toBe('Searched the docs')
    expect(T({}, 'en', 'refusal.searchedAndRead', { scope: 'the docs', n: 1 })).toBe(
      'Searched the docs and read 1 page',
    )
    expect(T({}, 'en', 'refusal.searchedAndRead', { scope: 'the docs', n: 4 })).toBe(
      'Searched the docs and read 4 pages',
    )
    // A slot with no value is left as written rather than rendered "undefined".
    expect(T({}, 'en', 'refusal.searched')).toBe('Searched {scope}')
  })

  it('normalises a regional tag onto the subtag the tree is keyed by', () => {
    expect(normaliseLocale('ru-RU', tree({}))).toBe('ru')
    expect(normaliseLocale('en-US', tree({}))).toBe('en')
    // A locale nobody ships and nobody configured is English, never empty.
    expect(normaliseLocale('cy-GB', tree({}))).toBe('en')
    // …unless it IS configured, in which case it is real.
    expect(normaliseLocale('cy', tree({ locales: { cy: { translations: {} } } }))).toBe('cy')
  })

  it('drops a key that is not a key, and says which one', () => {
    const warnings = []
    const out = validateI18n(
      { translations: { empty: { headng: 'typo' }, panel: { close: 'Close!' } } },
      (m) => warnings.push(m),
    )
    expect(out.translations.panel.close).toBe('Close!')
    expect(out.translations.empty).toBeUndefined()
    expect(warnings.join(' ')).toContain('empty.headng')
  })

  it('drops a non-string leaf rather than rendering [object Object]', () => {
    const warnings = []
    const out = validateI18n({ translations: { panel: { close: 42 } } }, (m) => warnings.push(m))
    expect(out.translations.panel?.close).toBeUndefined()
    expect(warnings.join(' ')).toMatch(/not a string/)
  })

  it('reaches the client half through themeDocPilot, validated', () => {
    const out = themeDocPilot(
      resolveDocPilot({
        i18n: { locales: { ru: { translations: { panel: { close: 'Закрыть' }, nope: 'x' } } } },
      }),
    )
    expect(out.i18n.locales.ru.translations.panel.close).toBe('Закрыть')
    expect(out.i18n.locales.ru.translations.nope).toBeUndefined()
  })

  it('deep-merges the option itself, so translations and locales coexist', () => {
    const r = resolveDocPilot({ i18n: { locales: { ru: { translations: {} } } } })
    expect(r.i18n.translations).toEqual({})
    expect(r.i18n.locales.ru).toBeDefined()
  })
})

/**
 * The gate that keeps the key table honest as the panel changes.
 *
 * Two ways this decays, both silent: a `T('…')` whose path does not exist
 * renders an empty string, and a new label written as a literal is simply never
 * translatable. Both are invisible in review and obvious here.
 */
describe('i18n — the components go through the table', () => {
  const FILES = [
    'src/theme/components/DocPilot.vue',
    'src/theme/components/DocPilotTrigger.vue',
    'src/theme/components/DocPilotCta.vue',
  ]
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

  it('every key the components ask for exists in the table', () => {
    for (const f of FILES) {
      for (const m of read(f).matchAll(/\bT\(\s*'([\w.-]+)'/g)) {
        expect(KEY_PATHS.has(m[1]), `${f}: ${m[1]}`).toBe(true)
      }
      // Template-literal paths — `reasons.${value}` — checked by their prefix.
      for (const m of read(f).matchAll(/\bT\(\s*`([\w.-]+)\$\{/g)) {
        expect([...KEY_PATHS].some((k) => k.startsWith(m[1])), `${f}: ${m[1]}*`).toBe(true)
      }
    }
  })

  it('no reader-facing string is left hard-coded in a component', () => {
    for (const f of FILES) {
      const src = read(f)
      // A STATIC aria-label is one nobody can translate.
      expect(src.match(/\saria-label="[^"{]/g) || [], f).toEqual([])
      // A bare text node between tags, outside a comment or an interpolation.
      const template = src.slice(0, src.indexOf('<script'))
      const stripped = template.replace(/<!--[\s\S]*?-->/g, '')
      expect(stripped.match(/>\s*[A-Z][a-z]+[^<{]*</g) || [], f).toEqual([])
    }
  })

  it('every shipped key is reachable — the table has no dead entries', () => {
    const used = new Set()
    for (const f of [...FILES, 'src/theme/docpilot/session.js']) {
      const src = read(f)
      // Any dotted path in a string literal, not only the ones written directly
      // as `T('…')` — half of them are inside a ternary: `T(cond ? 'a' : 'b')`.
      for (const m of src.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) used.add(m[1])
      for (const m of src.matchAll(/`([\w.-]+)\$\{/g)) used.add(m[1])
    }
    const unreachable = [...KEY_PATHS].filter(
      (k) =>
        !k.startsWith('reply.') && // read as blocks, from session.js
        !used.has(k) &&
        ![...used].some((u) => k.startsWith(u)),
    )
    expect(unreachable).toEqual([])
  })

  /**
   * Two rules moved out of `scripts/check-docpilot.sh`.
   *
   * They are the two worth running on every platform, and both were checked
   * there with `grep -P`, which BSD grep does not have — under a `2>/dev/null`
   * that turned the missing flag into a passing rule.
   */
  it('leaks no tool name, model id or threshold into the component', () => {
    const src = read('src/theme/components/DocPilot.vue')
    const surface = src.slice(0, src.indexOf('<style'))
    for (const token of [
      'search_docs',
      'fetch_section',
      'list_pages',
      'maxIterations',
      'qwen3',
      'threshold',
      'topK',
    ]) {
      expect(surface.includes(token), token).toBe(false)
    }
  })

  /**
   * The selection popover's contract — ui-specs/007.
   *
   * Every clause here is invisible to any other test in the suite: there is no
   * DOM in this environment, so the popover's tab position, its dismissal mode
   * and its capability probe can only be read off the source. Each one is a
   * decision that looks like a detail and is not.
   */
  it('keeps the selection popover’s contract', () => {
    const src = read('src/theme/components/DocPilot.vue')
    const template = src.slice(0, src.indexOf('<script'))

    // Between the thread and the composer, because THAT is the tab order: a
    // reader who selected inside the thread reaches "Ask AI" with one Tab.
    expect(template.indexOf('docpilot__ask')).toBeGreaterThan(template.indexOf('docpilot__thread'))
    expect(template.indexOf('docpilot__ask')).toBeLessThan(template.indexOf('docpilot__composer'))

    // `manual`, never `auto`: an auto popover light-dismisses on the pointerdown
    // that BEGINS the next selection, and Esc belongs to the cascade.
    expect(src).toContain("'manual'")
    expect(src).not.toContain('popover="auto"')

    // A capability probe, never a user-agent test. It MOVED to selection.js
    // with the rest of the mechanism — ui-specs/009 — and moved as one copy: a
    // second probe in the component is how the markup and the behaviour come to
    // disagree about which branch is live.
    const mechanism = read('src/theme/docpilot/selection.js')
    expect(mechanism).toContain("'popover' in HTMLElement.prototype")
    expect(src).not.toContain("'popover' in HTMLElement.prototype")

    // The whole list of platform failures 007 had to find lives in one place, so
    // the second mount cannot regress one of them on its own.
    for (const listener of ['selectionchange', 'pointercancel', 'blur']) {
      expect(mechanism).toContain(listener)
      expect(src).not.toContain(`addEventListener('${listener}'`)
    }

    // The turn a selection landed in is named on the node, not inferred from a
    // v-for index that reorders when a conversation is restored.
    expect(src).toContain(':data-turn="turn.id"')

    // Esc closes the popover FIRST, before any disclosure and before the panel.
    expect(src.match(/function onEsc\(\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(askOpen\.value\)/)).not.toBe(null)

    // Every re-submit path carries the quote. A retry that drops it re-runs a
    // question whose whole subject has gone missing, with no error attached.
    expect(src).toContain('submitText(turn.question, turn.quote)')
  })

  /**
   * The question row, the editor and the jump pill.
   *
   * Same reason as the popover's contract above: there is no DOM here, so tab
   * order, cascade position and the wiring between the component and
   * `session.editTurn` can only be read off the source. Each clause below is a
   * decision that a refactor would quietly undo.
   */
  it('keeps the question row’s contract', () => {
    const src = read('src/theme/components/DocPilot.vue')
    const template = src.slice(0, src.indexOf('<script'))

    // The row is UNDER the bubble, not above it: it acts on the question, and a
    // control above the thing it acts on reads as belonging to the turn before.
    expect(template.indexOf('docpilot__actions--ask')).toBeGreaterThan(
      template.indexOf('docpilot__question'),
    )

    // The pill is between the thread and the popover, so the popover keeps the
    // tab position ui-specs/007 gave it — one Tab from a selection in the thread.
    expect(template.indexOf('docpilot__jump-rail')).toBeGreaterThan(
      template.indexOf('docpilot__thread'),
    )
    expect(template.indexOf('docpilot__jump-rail')).toBeLessThan(template.indexOf('docpilot__ask'))

    // Hidden means out of the tab order, not merely faded: at the foot of the
    // thread "go to the foot of the thread" is not an action.
    expect(template).toContain(':tabindex="atBottom ? -1 : 0"')

    // Truncation goes through the session, which is the only place that can
    // stop a running turn and rewrite the archive together.
    expect(src).toContain('session.editTurn(turn, next)')
    expect(src).toContain('session.retryTurn(turn)')

    // Ask again is offered on an answer AND on a refusal, and withheld from the
    // two turns that settle from a template — asking those again returns the
    // identical words, and the credential turn has its own affirmative button.
    expect(src).toContain("turn.refusal?.cause !== 'credential'")
    expect(src).toContain("turn.refusal?.cause !== 'social'")

    // Esc still reaches the popover first; the editor's branch sits below it.
    expect(src.match(/function onEsc\(\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(askOpen\.value\)/)).not.toBe(
      null,
    )
    expect(src.indexOf('cancelTurnEdit()', src.indexOf('function onEsc()'))).toBeGreaterThan(
      src.indexOf('if (askOpen.value)'),
    )
  })

  it('contains no emoji', () => {
    const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
    // Both halves of the stylesheet by name: listing only the bundle entry
    // would leave every rule in the package uncovered the moment it became two
    // @use lines.
    for (const f of [
      ...FILES,
      'src/theme/styles/core.scss',
      'src/theme/styles/vitepress.scss',
      'src/theme/styles/docpilot.scss',
    ]) {
      expect(re.test(read(f)), f).toBe(false)
    }
  })

  it('summarises what was configured for the startup block', () => {
    expect(summariseI18n(validateI18n(null, () => {}))).toBeNull()
    const s = summariseI18n(
      validateI18n(
        { locales: { ru: { translations: { panel: { close: 'x' }, nope: 'y' } } } },
        () => {},
      ),
    )
    expect(s).toContain('ru')
    expect(s).toContain('1 unknown key ignored')
  })
})

/**
 * Two selectors, one key space. Conflating them regresses behaviour that ships:
 * one selector would either answer a Russian greeting in English or write
 * Russian into an English page's chrome.
 */
describe('i18n — the two selectors', () => {
  const tree = (i18n) => resolveI18n(validateI18n(i18n, () => {}))

  it('chrome follows the PAGE, reply copy follows the TYPED language', () => {
    // The panel is English; the reader typed Russian.
    expect(t(tree({}), 'en', 'empty.heading')).toBe('How can I help you today?')
    expect(t(tree({}), localeOf(detectLanguage('привет')), 'reply.social.greeting').lead).toBe(
      socialCopy('ru', 'greeting').lead,
    )
  })

  it('a reply in an unlisted language falls back to the PAGE locale, then to en', () => {
    const i18n = { locales: { ru: { translations: { reply: { credential: { lead: 'Стоп!' } } } } } }
    // Typed language unknown, page is Russian → the reader gets Russian.
    expect(t(tree(i18n), 'cy', 'reply.credential.lead', {}, 'ru')).toBe('Стоп!')
    // Neither known → English.
    expect(t(tree(i18n), 'cy', 'reply.credential.lead', {}, 'de')).toBe(
      "Don't paste keys or tokens here.",
    )
  })

  it('the whole reply block can be read at once, as the panel reads it', () => {
    const copy = t(tree({}), 'ru', 'reply.credential')
    expect(copy.lead).toBe('Не вставляйте сюда ключи и токены.')
    expect(typeof copy.action).toBe('string')
  })

  it('an override reaches the reply copy, one string at a time', () => {
    const i18n = {
      locales: { ru: { translations: { reply: { social: { greeting: { lead: 'Здорово!' } } } } } },
    }
    const copy = t(tree(i18n), 'ru', 'reply.social.greeting')
    expect(copy.lead).toBe('Здорово!')
    // …and the two strings beside it survive.
    expect(copy.body).toBe(socialCopy('ru', 'greeting').body)
    expect(copy.invite).toBe(socialCopy('ru', 'greeting').invite)
  })
})

/**
 * Social openers — the second local settlement, and the one that exists because
 * the gate's correct answer produces the wrong outcome.
 *
 * "Привет" carries no documented subject, so D and L are both ~0 and the turn
 * lands on `no-evidence`: a right verdict that tells the reader, on their very
 * first message, that the feature is broken.
 */
describe('social openers', () => {
  it('claims an input that is social and nothing else', () => {
    for (const s of ['привет', 'Hi!', 'hello there', 'Здравствуйте', 'buenos días', '你好']) {
      expect(detectSocial(s), s).not.toBeNull()
    }
  })

  it('classifies the four kinds, identity ahead of greeting', () => {
    expect(detectSocial('who are you?').kind).toBe('identity')
    // Both a greeting and an identity question; the identity answer is the more
    // useful of the two, so the order of PATTERNS decides it.
    expect(detectSocial('привет, кто ты').kind).toBe('identity')
    expect(detectSocial('спасибо!').kind).toBe('thanks')
    expect(detectSocial('пока').kind).toBe('farewell')
    expect(detectSocial('как дела?').kind).toBe('greeting')
  })

  it('does NOT claim a greeting attached to a real question', () => {
    // This is the load-bearing case. It runs BEFORE the gate, so a false
    // positive answers a real question with a wave — strictly worse than the
    // refusal this module exists to remove.
    expect(detectSocial('Привет, как подключить редактор?')).toBeNull()
    expect(detectSocial('hi, how do I authenticate requests?')).toBeNull()
  })

  it('does not claim an ordinary question', () => {
    for (const s of ['how do I authenticate?', 'что такое webhook', 'topK']) {
      expect(detectSocial(s), s).toBeNull()
    }
  })

  it('gives up past 64 characters — a long input is a question', () => {
    expect(detectSocial(`hello ${'!'.repeat(60)}`)).toBeNull()
    expect(detectSocial('   ')).toBeNull()
    expect(detectSocial(null)).toBeNull()
  })

  it('has all three strings for every kind in every language it claims', () => {
    for (const locale of SOCIAL_LANGUAGES) {
      for (const kind of ['greeting', 'identity', 'thanks', 'farewell']) {
        const c = socialCopy(locale, kind)
        expect(c.lead.trim().length, `${locale}.${kind}.lead`).toBeGreaterThan(0)
        expect(typeof c.body, `${locale}.${kind}.body`).toBe('string')
        expect(typeof c.invite, `${locale}.${kind}.invite`).toBe('string')
      }
      // A farewell that asks a follow-up question is not a farewell, and the
      // panel renders the suggestion rows off this field.
      expect(socialCopy(locale, 'farewell').invite, locale).toBe('')
    }
  })

  it('falls back to English for a language it does not speak', () => {
    expect(socialCopy('xx', 'greeting')).toEqual(socialCopy('en', 'greeting'))
    expect(socialCopy('ru', 'nonsense-kind')).toEqual(socialCopy('ru', 'greeting'))
  })

  it('is keyed by the same subtags the detector maps onto', () => {
    // One key space for the panel chrome and the reply copy, so a site with a
    // `ru` locale writes one override block rather than two.
    expect(localeOf('Russian')).toBe('ru')
    expect(SOCIAL_LANGUAGES).toContain(localeOf(detectLanguage('привет')))
    expect(SOCIAL_LANGUAGES).toContain(localeOf(detectLanguage('你好')))
  })

  it('names no product in the shipped copy, and interpolates one on request', () => {
    for (const locale of SOCIAL_LANGUAGES) {
      const c = socialCopy(locale, 'greeting')
      expect(`${c.lead}${c.body}${c.invite}`, locale).not.toMatch(/\{product\}|stripo/i)
    }
    // An override may still use a slot; the interpolation is always applied.
    expect(
      socialCopy('en', 'greeting', { product: 'Acme' }).lead.replace(
        'this documentation',
        'Acme',
      ),
    ).toContain('Acme')
  })
})

/**
 * This package ships to any VitePress site, so a shipped default naming
 * somebody else's product is not a default — it is a defect that reads as
 * working software. It was extracted from a project whose name reached the
 * system instruction, eighteen languages of credential copy and three empty
 * state suggestions; that is exactly the kind of thing that comes back one
 * string at a time unless something is watching.
 *
 * The repository URL in config.js is exempt and stays: it is a fact about where
 * this code lives, not copy shown to a reader.
 */
describe('brand neutrality of the shipped defaults', () => {
  const FILES = [
    'src/theme/docpilot/prompt.js',
    'src/theme/docpilot/credentials.js',
    'src/theme/components/DocPilot.vue',
    'src/theme/components/DocPilotTrigger.vue',
    'src/theme/components/DocPilotCta.vue',
  ]

  it('names no product of its own, in copy or in comments', () => {
    for (const f of FILES) {
      const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      expect(src.match(/stripo/gi) || [], f).toEqual([])
    }
  })

  it('renders the neutral instruction when no product is configured', () => {
    // The opening sentence is the only place the product appears; "this
    // documentation" also occurs in the credential rule, where it is prose.
    const opening = (text) => text.split('\n')[0]
    expect(opening(coreText())).toBe(
      'You answer questions about this documentation using only the excerpts you are given.',
    )
    expect(opening(coreText({}, 'Acme Editor'))).toBe(
      'You answer questions about Acme Editor using only the excerpts you are given.',
    )
  })

  it('leaves an override alone — it is the author\'s own words, not a template', () => {
    expect(coreText({ override: 'Be terse.' }, 'Acme Editor')).toBe('Be terse.')
  })

  it('makes the product part of the prompt hash, because it changes what is sent', () => {
    expect(promptHash(undefined, 'Acme Editor')).not.toBe(promptHash())
    expect(promptHash(undefined, 'Acme Editor')).toBe(promptHash(undefined, 'Acme Editor'))
  })

  it('reaches the client half, so the panel can say it too', () => {
    expect(themeDocPilot(resolveDocPilot({ product: 'Acme Editor' })).product).toBe('Acme Editor')
    expect(themeDocPilot(resolveDocPilot({})).product).toBeNull()
  })
})

describe('external provenance — how a citation renders', () => {
  const known = new Set(['/guide/auth'])
  const internal = { n: 1, href: '/guide/auth#tokens', title: 'Tokens', origin: null }
  const external = {
    n: 2,
    href: 'https://example.com/product',
    origin: 'https://example.com/product',
    title: 'Product overview',
  }

  it('an imported page\'s marker opens the ORIGINAL, in a new tab', () => {
    const html = renderAnswer('see [2]', known, [internal, external]).html
    expect(html).toContain('href="https://example.com/product"')
    expect(html).toContain('target="_blank"')
    // Not optional beside target=_blank: the answer is v-html, and a tab that
    // keeps window.opener can navigate the panel it was opened from.
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('leaves an ordinary citation as same-tab SPA navigation', () => {
    const html = renderAnswer('see [1]', known, [internal, external]).html
    expect(html).toContain('href="/guide/auth#tokens"')
    expect(html).not.toContain('target="_blank"')
  })

  it('de-links a model link to an external id, because that id is not a route', () => {
    // The id looks like a route and is not one. `knownPaths` excludes external
    // pages for exactly this reason; the sentence survives, the anchor does not.
    const html = renderAnswer('read [the overview](/knowledge-base/product)', known, []).html
    expect(html).not.toContain('<a')
    expect(html).toContain('the overview')
  })
})

/**
 * The archive — a durable, tab-safe store.
 *
 * Every case below runs on Map-backed fake stores, injected the way `hotkey.js`
 * takes its `window`: the module is deliberately written so that the only
 * browser thing it touches arrives as an argument, because vitest runs in node
 * and `localStorage` does not exist there. Two of these cases — the two-tab
 * archive and the delete-elsewhere resurrection — are the reason the module has
 * a read-modify-write shape at all, so they are asserted rather than reasoned
 * about in a comment.
 */
describe('history — a durable, tab-safe archive', () => {
  const fakeStore = (opts = {}) => {
    const m = new Map()
    let writes = 0
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem(k, v) {
        writes++
        if (opts.throwFor && opts.throwFor(writes)) {
          const e = new Error('QuotaExceededError')
          e.name = 'QuotaExceededError'
          throw e
        }
        m.set(k, String(v))
      },
      removeItem: (k) => m.delete(k),
      _map: m,
      get _writes() {
        return writes
      },
    }
  }

  const T0 = 1_755_000_000_000
  /** One tab: its own session store, a shared archive, a clock it controls. */
  const tab = (local, at = 0, limits) =>
    createHistory({ local, session: fakeStore(), now: () => T0 + at, limits })

  const turn = (over = {}) => ({
    id: 'm_1',
    question: 'How do I authenticate?',
    state: 'complete',
    answerText: 'Pass the key as a bearer token [1].',
    answerHtml: '<p>Pass the key as a bearer token</p>',
    sources: [{ n: 1, id: 'auth#t', href: '/guide/auth#t', origin: null, title: 'Tokens', tail: 'Auth' }],
    scope: { kind: 'all', label: 'All docs', paths: [] },
    startedAt: 1234.5,
    streaming: false,
    thought: 'x'.repeat(50_000),
    thoughtOpen: false,
    thoughtSeconds: 7,
    verdict: null,
    reasons: [],
    reasonOpen: false,
    latencyMs: 4210,
    iterations: 1,
    rejectedFetches: 0,
    support: 0.83,
    delinked: ['/gone'],
    notAnswerable: { chars: 12 },
    gate: {
      G: 0.71,
      threshold: 0.55,
      mode: 'calibrated',
      n: 5,
      channel: 'hybrid',
      wouldPassUnscoped: false,
      chunks: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, text: 'y'.repeat(400) })),
    },
    ...over,
  })

  // ── the projection ─────────────────────────────────────────────────────────

  it('drops the reasoning, the retrieved chunks and everything transient', () => {
    const t = turn()
    t.cited = [t.sources[0]]
    const slim = slimTurn(t)

    expect(Object.keys(slim).sort()).toEqual(
      [
        'citedIdx',
        'gate',
        'id',
        'iterations',
        'latencyMs',
        'question',
        'rejectedFetches',
        'scope',
        'sources',
        'state',
        'answerText',
        'support',
      ].sort(),
    )
    // The six the feedback record reads survive; the chunk TEXT does not.
    expect(Object.keys(slim.gate).sort()).toEqual(
      ['G', 'channel', 'mode', 'n', 'threshold', 'wouldPassUnscoped'].sort(),
    )
    expect(slim.gate.chunks).toBeUndefined()
    // The whole point of the projection, in one number.
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(t).length * 0.1)
  })

  // Without it a restored thread renders "what does this mean?" above an answer
  // with no `this` anywhere on screen. Written only when there is one, so the
  // projection of an ordinary turn does not grow a key.
  it('keeps the quote, and only when there is one', () => {
    expect(slimTurn(turn())).not.toHaveProperty('quote')
    expect(slimTurn(turn({ quote: '' }))).not.toHaveProperty('quote')
    expect(slimTurn(turn({ quote: 'the gate runs first' })).quote).toBe('the gate runs first')
  })

  it('keeps citation POSITION, so two citations into one section still resolve', () => {
    const t = turn()
    // One row, two citations — what the retriever produces for a long section.
    t.cited = [t.sources[0], t.sources[0]]
    expect(slimTurn(t).citedIdx).toEqual([0, 0])
  })

  it('keeps answerHtml for a legacy turn, and only for a legacy turn', () => {
    // `sources` and no `cited` is the pre-history payload, and the one case
    // re-rendering would strip markers from.
    const legacy = turn()
    delete legacy.cited
    expect(slimTurn(legacy).answerHtml).toBe('<p>Pass the key as a bearer token</p>')

    const modern = turn()
    modern.cited = [modern.sources[0]]
    expect(slimTurn(modern).answerHtml).toBeUndefined()
  })

  it('settles a turn caught mid-flight, and drops one that has nothing to show', () => {
    expect(slimTurn(turn({ state: 'thinking' })).state).toBe('aborted')
    expect(slimTurn(turn({ state: 'retrieving', answerText: '', refusal: null }))).toBe(null)
    // A transport failure renders as one fixed sentence; restored, it is a
    // mystery rather than an answer.
    expect(slimTurn(turn({ state: 'error', answerText: '', error: 'boom' }))).toBe(null)
    // A refusal, though, is the product's answer and is kept.
    const refused = slimTurn(turn({ state: 'no-answer', answerText: '', refusal: { cause: 'no-evidence' } }))
    expect(refused.refusal.cause).toBe('no-evidence')
  })

  /**
   * A daily limit that lands after text has been painted is a TERMINAL state of
   * its own, and the archive has to keep it as one. Coerced to 'aborted' — which
   * is what the missing entry in `TERMINAL` did — it restored under "Stopped.",
   * telling the reader they had ended a turn the service refused.
   *
   * `rateLimit` deliberately does not travel with it. The panel renders that
   * instant as a clock time, `slimTurn` is pure and has no clock to tell a live
   * reset from an expired one, and a reset that has already passed is worse than
   * the line being dropped — which is what `resetLine` already does when a 429
   * carried no reset at all.
   */
  it('keeps a spent daily limit as itself, without the hour it named', () => {
    const limited = turn({
      state: 'rate-limited',
      rateLimit: { resetAt: T0 + 3_600_000, limit: 50 },
    })
    const slim = slimTurn(limited)
    expect(slim.state).toBe('rate-limited')
    expect(slim).not.toHaveProperty('rateLimit')
    // And it still has to survive the archive it was written to.
    const h = tab(fakeStore())
    const id = h.save({ id: null, hash: 'h', turns: [limited] })
    expect(h.open(id).turns[0].state).toBe('rate-limited')
  })

  /** With nothing painted it is dropped, exactly as a transport error is: "the
   *  limit is used up" must not come back a week later on its own. */
  it('drops a spent daily limit that had nothing to show', () => {
    expect(slimTurn(turn({ state: 'rate-limited', answerText: '', refusal: null }))).toBe(null)
  })

  it('caps scope.paths at the same 20 the feedback record already caps at', () => {
    const wide = turn({
      scope: { kind: 'pages', label: '60 pages', paths: Array.from({ length: 60 }, (_, i) => `/p${i}`) },
    })
    expect(slimTurn(wide).scope.paths).toHaveLength(20)
  })

  // ── round trip ─────────────────────────────────────────────────────────────

  it('round-trips a conversation, title and all', () => {
    const local = fakeStore()
    const h = tab(local)
    const t = turn()
    t.cited = [t.sources[0]]
    const id = h.save({ id: null, hash: 'abc', turns: [t] })

    expect(h.list()).toEqual([
      { id, title: 'How do I authenticate?', createdAt: T0, updatedAt: T0, hash: 'abc', turnCount: 1 },
    ])
    expect(h.current()).toBe(null) // saving does not point the tab at it
    const opened = h.open(id)
    expect(h.current()).toBe(id)
    expect(opened.hash).toBe('abc')
    expect(opened.turns[0].answerText).toBe('Pass the key as a bearer token [1].')
    expect(opened.turns[0].citedIdx).toEqual([0])
  })

  it('keeps the first question as the title however long the conversation runs', () => {
    const local = fakeStore()
    const a = tab(local, 0)
    const id = a.save({ id: null, hash: 'h', turns: [turn()] })
    const b = tab(local, 60_000)
    b.save({ id, hash: 'h', turns: [turn(), turn({ id: 'm_2', question: 'And the rate limit?' })] })
    const [row] = b.list()
    expect(row.title).toBe('How do I authenticate?')
    expect(row.createdAt).toBe(T0) // created once, updated since
    expect(row.updatedAt).toBe(T0 + 60_000)
  })

  // ── two tabs ───────────────────────────────────────────────────────────────

  it('two tabs share the archive without clobbering each other', () => {
    const local = fakeStore()
    const a = tab(local, 0)
    const b = tab(local, 1000)

    const idA = a.save({ id: null, hash: 'h', turns: [turn({ question: 'Tab A question' })] })
    const idB = b.save({ id: null, hash: 'h', turns: [turn({ question: 'Tab B question' })] })
    a.open(idA)
    b.open(idB)
    // A writes again AFTER B — the read-modify-write is what keeps B's row.
    a.save({ id: idA, hash: 'h', turns: [turn({ question: 'Tab A question' }), turn({ id: 'm_2' })] })

    expect(a.list().map((c) => c.id).sort()).toEqual([idA, idB].sort())
    expect(a.current()).toBe(idA)
    expect(b.current()).toBe(idB)
    expect(a.list().find((c) => c.id === idB).title).toBe('Tab B question')
  })

  it('resurrects a conversation another tab deleted while this one was in it', () => {
    // The documented failure, pinned: the alternative is a tab that silently
    // stops persisting for the rest of its life.
    const local = fakeStore()
    const a = tab(local, 0)
    const b = tab(local, 0)
    const id = a.save({ id: null, hash: 'h', turns: [turn()] })
    a.open(id)
    b.remove(id)
    expect(b.list()).toEqual([])

    a.save({ id, hash: 'h', turns: [turn()] })
    expect(b.list().map((c) => c.id)).toEqual([id])
  })

  // ── the caps ───────────────────────────────────────────────────────────────

  it('keeps the newest N conversations and drops the oldest', () => {
    const local = fakeStore()
    const ids = []
    for (let i = 0; i < 22; i++) {
      const h = tab(local, i * 1000)
      ids.push(h.save({ id: null, hash: 'h', turns: [turn({ question: `Question ${i}` })] }))
    }
    const rows = tab(local).list()
    expect(rows).toHaveLength(20)
    expect(rows[0].title).toBe('Question 21')
    expect(rows.map((c) => c.id)).not.toContain(ids[0])
    expect(rows.map((c) => c.id)).not.toContain(ids[1])
  })

  it('prunes older conversations to stay inside the byte budget', () => {
    const local = fakeStore()
    const fat = () => turn({ answerText: 'z'.repeat(30_000) })
    for (let i = 0; i < 6; i++) {
      tab(local, i * 1000, { bytes: 100_000 }).save({
        id: null,
        hash: 'h',
        turns: [fat()],
      })
    }
    const h = tab(local, 0, { bytes: 100_000 })
    expect(h.bytes()).toBeLessThanOrEqual(100_000)
    expect(h.list().length).toBeGreaterThan(0)
    expect(h.list().length).toBeLessThan(6)
  })

  it('stores a single conversation that is bigger than the whole budget', () => {
    // Losing the thread the reader is sitting in is worse than overrunning a
    // self-imposed etiquette limit.
    const local = fakeStore()
    const h = tab(local, 0, { bytes: 1000 })
    const id = h.save({ id: null, hash: 'h', turns: [turn({ answerText: 'z'.repeat(5000) })] })
    expect(id).toBeTruthy()
    expect(h.list()).toHaveLength(1)
  })

  it('prunes once and retries when the store refuses the write', () => {
    const seed = fakeStore()
    tab(seed, 0).save({ id: null, hash: 'h', turns: [turn({ question: 'Older' })] })
    // The same data, behind a store whose FIRST write throws.
    const local = fakeStore({ throwFor: (n) => n === 1 })
    local._map.set('docpilot:history', seed._map.get('docpilot:history'))

    const h = tab(local, 5000)
    const id = h.save({ id: null, hash: 'h', turns: [turn({ question: 'Newer' })] })
    expect(id).toBeTruthy()
    expect(h.list().map((c) => c.title)).toEqual(['Newer'])
  })

  it('gives up silently when every write throws', () => {
    const local = fakeStore({ throwFor: () => true })
    const h = tab(local, 0)
    expect(() => h.save({ id: null, hash: 'h', turns: [turn()] })).not.toThrow()
    expect(h.list()).toEqual([])
  })

  it('survives a missing store entirely — private mode, or SSR', () => {
    const h = createHistory({ local: null, session: null, now: () => T0 })
    expect(() => h.save({ id: null, hash: 'h', turns: [turn()] })).not.toThrow()
    expect(h.list()).toEqual([])
    expect(h.current()).toBe(null)
    expect(h.open('c_x')).toBe(null)
    expect(h.bytes()).toBe(0)
  })

  // ── the schema gate ────────────────────────────────────────────────────────

  it('reads a payload from another version, and a broken one, as empty', () => {
    for (const raw of [
      JSON.stringify({ v: 2, conversations: [{ id: 'c_1' }] }),
      JSON.stringify({ conversations: [{ id: 'c_1' }] }),
      JSON.stringify({ v: 1, conversations: 'not an array' }),
      '{ not json',
    ]) {
      const local = fakeStore()
      local._map.set('docpilot:history', raw)
      const h = tab(local)
      expect(h.list(), raw).toEqual([])
      // …and the next write simply overwrites it, rather than throwing.
      expect(h.save({ id: null, hash: 'h', turns: [turn()] })).toBeTruthy()
      expect(h.list()).toHaveLength(1)
    }
  })

  // ── the pointer ────────────────────────────────────────────────────────────

  it('clears the pointer only when it pointed at what was removed', () => {
    const local = fakeStore()
    const h = tab(local)
    const one = h.save({ id: null, hash: 'h', turns: [turn({ question: 'One' })] })
    const two = h.save({ id: null, hash: 'h', turns: [turn({ question: 'Two' })] })
    h.open(one)
    h.remove(two)
    expect(h.current()).toBe(one)
    h.remove(one)
    expect(h.current()).toBe(null)
  })

  it('start() forgets the pointer and keeps the archive; clear() drops both', () => {
    const local = fakeStore()
    const h = tab(local)
    const id = h.save({ id: null, hash: 'h', turns: [turn()] })
    h.open(id)
    h.start()
    expect(h.current()).toBe(null)
    expect(h.list()).toHaveLength(1)
    h.clear()
    expect(h.list()).toEqual([])
    expect(h.current()).toBe(null)
  })

  it('forgets a pointer to a conversation that is no longer there', () => {
    const local = fakeStore()
    const h = tab(local)
    const id = h.save({ id: null, hash: 'h', turns: [turn()] })
    h.open(id)
    tab(local).remove(id) // another tab
    expect(h.open(id)).toBe(null)
    expect(h.current()).toBe(null)
  })

  // ── migration ──────────────────────────────────────────────────────────────

  it('imports the pre-history thread once, then removes its key', () => {
    const local = fakeStore()
    const session = fakeStore()
    const legacy = turn()
    delete legacy.cited
    session._map.set('docpilot:session', JSON.stringify({ hash: 'old', turns: [legacy] }))
    const h = createHistory({ local, session, now: () => T0 })

    const id = h.migrate()
    expect(id).toBeTruthy()
    expect(h.current()).toBe(id)
    expect(session._map.has('docpilot:session')).toBe(false)
    // A legacy turn has no `cited`, so its HTML rides along rather than being
    // re-rendered into markerless prose.
    expect(h.open(id).turns[0].answerHtml).toBe('<p>Pass the key as a bearer token</p>')
    expect(h.open(id).hash).toBe('old')

    expect(h.migrate()).toBe(null)
    expect(h.list()).toHaveLength(1)
  })

  it('does not import over a tab that already has a conversation', () => {
    const local = fakeStore()
    const session = fakeStore()
    session._map.set('docpilot:session', JSON.stringify({ hash: 'old', turns: [turn()] }))
    const h = createHistory({ local, session, now: () => T0 })
    const mine = h.save({ id: null, hash: 'h', turns: [turn({ question: 'Mine' })] })
    h.open(mine)
    expect(h.migrate()).toBe(null)
    expect(h.list()).toHaveLength(1)
  })

  it('an empty or absent legacy payload imports nothing', () => {
    const local = fakeStore()
    const session = fakeStore()
    const h = createHistory({ local, session, now: () => T0 })
    expect(h.migrate()).toBe(null)
    session._map.set('docpilot:session', JSON.stringify({ hash: 'old', turns: [] }))
    expect(h.migrate()).toBe(null)
    expect(h.list()).toEqual([])
  })

  // ── the two pure helpers ───────────────────────────────────────────────────

  it('titles a row from the first question, on a word boundary', () => {
    expect(conversationTitle('  How   do I\nauthenticate? ')).toBe('How do I authenticate?')
    const long = conversationTitle('word '.repeat(40))
    expect(long.length).toBeLessThanOrEqual(81)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toContain('  ')
    // No boundary to find: one very long token is cut where it must be.
    expect(conversationTitle('x'.repeat(200)).length).toBe(81)
    expect(conversationTitle('')).toBe('')
    expect(conversationTitle(null)).toBe('')
  })

  it('picks the unit a reader would say out loud', () => {
    const now = T0
    expect(relativeParts(now - 59_000, now)).toEqual({ value: 0, unit: 'second' })
    expect(relativeParts(now - 61_000, now)).toEqual({ value: -1, unit: 'minute' })
    expect(relativeParts(now - 3_601_000, now)).toEqual({ value: -1, unit: 'hour' })
    expect(relativeParts(now - 2 * 86_400_000, now)).toEqual({ value: -2, unit: 'day' })
    expect(relativeParts(now - 15 * 86_400_000, now)).toEqual({ value: -2, unit: 'week' })
    // A clock that was wrong reads as "now", not as "in three hours".
    expect(relativeParts(now + 3 * 3_600_000, now)).toEqual({ value: 0, unit: 'second' })
  })
})

/**
 * Switching the archive off is an ERASURE, not just a stop.
 *
 * The same rule `prompt.show: false` already applies to the reader's own
 * instruction, applied to a store that outlives the tab: a site that turns this
 * off for a privacy review must leave nothing behind on the next visit. Asserted
 * end to end — settings, merge, emit, client — because the failure it guards
 * against is a setting that only LOOKS like it did something.
 */
describe('history — the off switch clears', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  it('clears what is stored when the site sets history.enabled: false', () => {
    const local = fake()
    const store = createHistory({ local, session: fake(), now: () => 1 })
    store.save({
      id: null,
      hash: 'h',
      turns: [{ id: 'm_1', question: 'q', state: 'complete', answerText: 'a', sources: [] }],
    })
    expect(store.list()).toHaveLength(1)

    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({ history: { enabled: false } })) })
    expect(sessionState.config.history.enabled).toBe(false)
    expect(store.list()).toEqual([])
    expect(local._map.has('docpilot:history')).toBe(false)

    // …and the cap reaches the store when it is left on.
    configure({ docPilot: themeDocPilot(resolveDocPilot({ history: { maxConversations: 3 } })) })
    for (let i = 0; i < 5; i++) {
      store.save({
        id: null,
        hash: 'h',
        turns: [{ id: `m_${i}`, question: `q${i}`, state: 'complete', answerText: 'a', sources: [] }],
      })
    }
    expect(store.list()).toHaveLength(3)

    __setHistoryForTests(null)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
  })
})

/**
 * The store, driven through the panel's own actions.
 *
 * The projection is asserted above; this is the other half — that a stored turn
 * comes back as a turn the panel can render, with its citation markers intact
 * and its answer re-checked against the CURRENT index. The index is assigned
 * directly rather than loaded, because what is under test is the restore path,
 * not the fetch.
 */
describe('history — a stored conversation, restored into the panel', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  const INDEX = {
    manifest: {
      hash: 'h1',
      pages: [
        { path: '/guide/auth', title: 'Authentication', tail: 'Guide' },
        { path: '/guide/limits', title: 'Rate limits', tail: 'Guide' },
      ],
    },
  }

  const storedTurn = () => ({
    id: 'm_1',
    question: 'How do I authenticate?',
    state: 'complete',
    answerText: 'Use a bearer token [1], and mind the [rate limits](/gone).',
    sources: [
      { n: 1, id: 'auth#t', href: '/guide/auth#t', origin: null, title: 'Tokens', tail: 'Authentication' },
    ],
    cited: null,
    scope: { kind: 'all', label: 'All docs', paths: [] },
  })

  const seed = (store, hash = 'h1') => {
    const t = storedTurn()
    t.cited = [t.sources[0]]
    return store.save({ id: null, hash, turns: [t] })
  }

  it('rehydrates markers, and re-checks every other link against the live index', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)

    expect(sessionState.conversationId).toBe(id)
    expect(sessionState.turns).toHaveLength(1)
    const [turn] = sessionState.turns
    // The marker resolves to its row — the whole reason positions are stored.
    expect(turn.answerHtml).toContain('href="/guide/auth#t"')
    // And a link to a page that is not in this index comes back de-linked,
    // which storing the HTML would have prevented.
    expect(turn.answerHtml).not.toContain('href="/gone"')
    expect(turn.answerHtml).toContain('rate limits')
    // Not stored, so not restored: the disclosure simply is not there.
    expect(turn.thought).toBe('')
    expect(turn.streaming).toBe(false)
    expect(sessionState.conversationStale).toBe(false)

    __setHistoryForTests(null)
  })

  it('marks a conversation written against an older index, and renders it anyway', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store, 'h0')
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    expect(sessionState.conversationStale).toBe(true)
    expect(sessionState.turns).toHaveLength(1)
    expect(sessionState.turns[0].answerHtml).toContain('href="/guide/auth#t"')

    __setHistoryForTests(null)
  })

  it('empties the panel when the conversation on screen is deleted', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    session.removeConversation(id)
    expect(sessionState.turns).toEqual([])
    expect(sessionState.conversationId).toBe(null)
    expect(sessionState.history).toEqual([])

    __setHistoryForTests(null)
  })

  it('newChat lets go of the conversation without deleting it', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    session.newChat()
    expect(sessionState.turns).toEqual([])
    expect(sessionState.conversationId).toBe(null)
    expect(store.current()).toBe(null)
    // Still in the archive, and still in the switcher.
    expect(sessionState.history.map((c) => c.id)).toEqual([id])

    __setHistoryForTests(null)
  })

  it('clearHistory empties the archive and the panel together', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    session.clearHistory()
    expect(sessionState.turns).toEqual([])
    expect(sessionState.history).toEqual([])
    expect(store.list()).toEqual([])

    __setHistoryForTests(null)
    sessionState.index = null
  })
})

/**
 * Editing a question TRUNCATES the thread.
 *
 * The seam is `submit('hi')`: a greeting settles locally in `detectSocial`,
 * before the abort controller and before any network call, so a whole re-ask
 * runs here with no transport to stand in for. Everything after the truncation —
 * the push, `finishTurn`, `saveCurrent` — is the real code path.
 */
describe('a question, edited', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  const INDEX = { manifest: { hash: 'h1', pages: [{ path: '/guide/auth', title: 'Auth', tail: '' }] } }

  const storedTurn = (n, quote = '') => ({
    id: `m_${n}`,
    question: `Question ${n}?`,
    state: 'complete',
    answerText: `Answer ${n}.`,
    sources: [],
    cited: null,
    quote,
    scope: { kind: 'all', label: 'All docs', paths: [] },
  })

  // Three turns, opened into the panel — the shortest thread in which "and
  // everything after it" is a claim with something to check.
  const openThread = (turns) => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns })
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX
    sessionState.degraded = false
    sessionState.busy = false
    session.openConversation(id)
    return { store, id }
  }

  const settle = () => new Promise((r) => setTimeout(r, 0))

  afterEach(() => {
    __setHistoryForTests(null)
    sessionState.index = null
    sessionState.busy = false
  })

  it('drops the edited turn and everything after it, then asks again', async () => {
    openThread([storedTurn(1), storedTurn(2), storedTurn(3)])
    const [, second] = sessionState.turns

    expect(session.editTurn(second, 'hi')).toBe(true)
    await settle()

    expect(sessionState.turns).toHaveLength(2)
    // The turn above it is untouched — same object identity, not a re-render.
    expect(sessionState.turns[0].id).toBe('m_1')
    expect(sessionState.turns[1].question).toBe('hi')
    // A NEW turn, not the old one rewritten: the answer below it was about the
    // question that has gone, and reusing the id would carry a vote with it.
    expect(sessionState.turns[1].id).not.toBe('m_2')
  })

  it('carries the quote, like every other re-ask path', async () => {
    openThread([storedTurn(1, 'the passage that was selected')])
    const [only] = sessionState.turns

    expect(session.editTurn(only, 'hi')).toBe(true)
    await settle()

    expect(sessionState.turns.at(-1).quote).toBe('the passage that was selected')
  })

  it('refuses, and leaves the thread alone, when there is nothing to do', () => {
    openThread([storedTurn(1), storedTurn(2)])
    const [, second] = sessionState.turns

    expect(session.editTurn(second, '   ')).toBe(false)
    expect(session.editTurn(second, second.question)).toBe(false)
    expect(session.editTurn({ id: 'not-in-this-thread' }, 'hi')).toBe(false)
    expect(sessionState.turns).toHaveLength(2)

    // Busy is the one that would corrupt rather than no-op: `stop()` aborts the
    // controller but `state.busy` is cleared asynchronously, so the submit would
    // return early and leave the thread truncated with nothing in its place.
    sessionState.busy = true
    expect(session.editTurn(second, 'hi')).toBe(false)
    expect(sessionState.turns).toHaveLength(2)
    sessionState.busy = false

    sessionState.degraded = true
    expect(session.editTurn(second, 'hi')).toBe(false)
    expect(sessionState.turns).toHaveLength(2)
    sessionState.degraded = false
  })

  it('asks the same question again, in place of the answer it replaces', async () => {
    openThread([storedTurn(1), storedTurn(2), storedTurn(3)])
    const [, second] = sessionState.turns
    // A refusal is the case this exists for: the verdict is about one
    // retrieval, and the question itself was never the problem.
    second.question = 'hi'

    expect(session.retryTurn(second)).toBe(true)
    await settle()

    expect(sessionState.turns).toHaveLength(2)
    expect(sessionState.turns[0].id).toBe('m_1')
    // Same words, new turn: the answer being replaced carried a vote and a set
    // of sources that belong to the run that produced it.
    expect(sessionState.turns[1].question).toBe('hi')
    expect(sessionState.turns[1].id).not.toBe('m_2')
  })

  it('refuses to re-ask what it cannot truncate', () => {
    openThread([storedTurn(1)])
    const [only] = sessionState.turns

    expect(session.retryTurn({ id: 'not-in-this-thread' })).toBe(false)
    sessionState.busy = true
    expect(session.retryTurn(only)).toBe(false)
    sessionState.busy = false
    sessionState.degraded = true
    expect(session.retryTurn(only)).toBe(false)
    sessionState.degraded = false
    expect(sessionState.turns).toHaveLength(1)
  })

  it('writes the truncation to the archive without waiting for the answer', async () => {
    const { store, id } = openThread([storedTurn(1), storedTurn(2), storedTurn(3)])
    const [, second] = sessionState.turns

    session.editTurn(second, 'hi')
    // Before the re-ask settles: the deleted turns are already gone from disk,
    // so closing the panel mid-answer cannot bring them back.
    expect(store.open(id).turns.map((t) => t.id)).toEqual(['m_1'])

    await settle()
    const saved = store.open(id).turns
    expect(saved).toHaveLength(2)
    expect(saved[0].id).toBe('m_1')
    expect(saved[1].question).toBe('hi')
  })
})

/**
 * The row's title moves when the question it names is replaced, and not when
 * the conversation merely grows. Pure history, no session: the rule is one
 * comparison inside `save`.
 */
describe('history — the title of an edited conversation', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }
  const turn = (id, question) => ({ id, question, state: 'complete', answerText: 'a', sources: [] })

  it('keeps the title while the same first question is still there', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns: [turn('m_1', 'First?')] })
    store.save({ id, hash: 'h1', turns: [turn('m_1', 'First?'), turn('m_2', 'Second?')] })
    expect(store.list()[0].title).toBe(conversationTitle('First?', 80))
  })

  it('renames the row when the first question is replaced', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns: [turn('m_1', 'First?')] })
    // What `editTurn` leaves behind: the head of the thread is a different turn.
    store.save({ id, hash: 'h1', turns: [turn('m_9', 'Rewritten?')] })
    expect(store.list()[0].title).toBe(conversationTitle('Rewritten?', 80))
  })
})

/**
 * What leaves the device, and only what.
 *
 * The storage and the transport are both injected — the same seam
 * `createHistory({local, session, now})` opens, and for the same reason: this
 * module is read from Node during a docs build and from a browser at runtime,
 * so it cannot capture either at module load, and a suite that reached for a
 * global mock would be asserting the mock.
 */
describe('feedback — what leaves the device', () => {
  const fakeStorage = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }
  const capture = () => {
    const calls = []
    const fetchImpl = (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) })
      return Promise.resolve({ ok: true })
    }
    return { calls, fetchImpl }
  }
  const stored = (storage) => JSON.parse(storage.getItem('docpilot:feedback') || '[]')

  const entry = (over = {}) => ({
    ts: 1,
    sessionId: 's_1',
    messageId: 'm_1',
    revision: 0,
    question: 'How do I authenticate?',
    answer: 'Use a bearer token.',
    citations: [],
    verdict: 'down',
    reasons: [],
    comment: null,
    scope: { kind: 'all', label: 'All docs', paths: [] },
    promptStock: true,
    ...over,
  })

  it('sends the verdicts feedback.send names, and no others', () => {
    const cases = [
      ['down', ['down']],
      ['up', ['up']],
      ['both', ['up', 'down']],
      ['none', []],
    ]
    for (const [send, expected] of cases) {
      const sent = []
      for (const verdict of ['up', 'down']) {
        const storage = fakeStorage()
        const { calls, fetchImpl } = capture()
        recordFeedback(entry({ verdict, messageId: `m_${verdict}` }), {
          feedbackEndpoint: '/feedback',
          send,
          storage,
          fetchImpl,
        })
        if (calls.length) sent.push(verdict)
        // Stored locally either way: the reader's own thread has to stop showing
        // a thumb they took back, whatever the site transmits.
        expect(stored(storage), `${send}/${verdict} local`).toHaveLength(1)
      }
      expect(sent, `send: ${send}`).toEqual(expected)
    }
  })

  it("defaults to the shipped mode when send is a value this panel does not have", () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    expect(() =>
      recordFeedback(entry({ verdict: 'up' }), {
        feedbackEndpoint: '/f',
        send: 'everything',
        storage,
        fetchImpl,
      }),
    ).not.toThrow()
    // 'both' is the default, so an up-vote under a nonsense value still goes.
    expect(calls).toHaveLength(1)
  })

  it('sends nothing at all without an endpoint, whatever send says', () => {
    for (const send of FEEDBACK_SENDS) {
      const storage = fakeStorage()
      const { calls, fetchImpl } = capture()
      recordFeedback(entry({ verdict: 'down' }), { feedbackEndpoint: null, send, storage, fetchImpl })
      expect(calls, send).toHaveLength(0)
      expect(stored(storage), send).toHaveLength(1)
    }
  })

  it('transmits a withdrawn vote, so a reader can take back what they said', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    recordFeedback(entry({ verdict: null, retracted: 'down', revision: 2, comment: null }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].body.verdict).toBe(null)
    expect(calls[0].body.revision).toBe(2)
    // A routing hint, not part of the record the receiver stores.
    expect(calls[0].body).not.toHaveProperty('retracted')
  })

  it('does not transmit a withdrawal of a vote that was never sent', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    // send: 'up' — the down-vote never went, so neither does taking it back.
    recordFeedback(entry({ verdict: null, retracted: 'down' }), {
      feedbackEndpoint: '/f',
      send: 'up',
      storage,
      fetchImpl,
    })
    expect(calls).toHaveLength(0)
  })

  it('masks a pasted key in the stored row AND in the request body', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    recordFeedback(entry({ comment: `it rejects ${key} every time` }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    expect(calls[0].body.comment).toContain(MASK)
    expect(calls[0].body.comment).not.toContain(key)
    expect(calls[0].init.body).not.toContain(key)
    expect(stored(storage)[0].comment).not.toContain(key)
  })

  /**
   * The ordering test, and the only thing that catches it.
   *
   * Cap-then-redact leaves a fragment of a live key that no pattern matches, and
   * ships it. Redact-then-cap replaces the span first, so a cap that then
   * bisects MASK costs nothing.
   */
  it('redacts before it caps, so a cap cannot slice a key out of reach', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    // The cut lands 10 characters into the key. That fragment is BELOW the
    // minimum length the api-key pattern will match, so a cap that ran first
    // would hand the redactor something it cannot recognise and ship the head of
    // a live key. Choose the offset deliberately: at 19 characters the fragment
    // still matches, the redactor still fires, and this test passes under the
    // wrong order — which is how it was first written.
    const head = key.slice(0, 10)
    // The space matters and is not padding: the api-key pattern is anchored on
    // \b, so a key pasted flush against a word is not a key as far as the
    // detector is concerned. Real comments have spaces before their keys.
    const filler = 'x'.repeat(COMMENT_MAX - head.length - 1)
    recordFeedback(entry({ comment: `${filler} ${key}` }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    const body = calls[0].init.body
    expect(body).not.toContain(key)
    expect(body).not.toContain(head)
    expect(stored(storage)[0].comment).not.toContain(head)
  })

  it('caps a long comment and drops one that is only whitespace', () => {
    const storage = fakeStorage()
    recordFeedback(entry({ comment: 'y'.repeat(700) }), { storage })
    expect(stored(storage)[0].comment).toHaveLength(COMMENT_MAX)

    const s2 = fakeStorage()
    recordFeedback(entry({ comment: '   \n  ' }), { storage: s2 })
    expect(stored(s2)[0].comment).toBe(null)
  })

  it('keeps one row per message — the amendment replaces the thumb', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    const opts = { feedbackEndpoint: '/f', send: 'down', storage, fetchImpl }
    recordFeedback(entry({ revision: 0 }), opts)
    recordFeedback(entry({ revision: 1, reasons: ['wrong', 'bad-links'], comment: 'the link 404s' }), opts)

    const rows = stored(storage)
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toBe(1)
    expect(rows[0].reasons).toEqual(['wrong', 'bad-links'])
    // Both went out; the receiver upserts on messageId.
    expect(calls.map((c) => c.body.revision)).toEqual([0, 1])
  })

  it('withholds the answer on an instructed turn, on every revision', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    const opts = { feedbackEndpoint: '/f', send: 'down', storage, fetchImpl }
    recordFeedback(entry({ promptStock: false, addendum: 'restate my instruction', quote: 'a passage' }), opts)
    recordFeedback(entry({ promptStock: false, revision: 1, comment: 'nope' }), opts)
    for (const c of calls) {
      expect(c.body).not.toHaveProperty('answer')
      expect(c.body).not.toHaveProperty('addendum')
      // The quote is a slice of the answer, so it goes with it. Withholding the
      // answer while shipping five hundred characters of it under another key
      // would be the same leak with a longer path.
      expect(c.body).not.toHaveProperty('quote')
    }
    expect(stored(storage)[0]).not.toHaveProperty('answer')
    expect(stored(storage)[0]).not.toHaveProperty('quote')
  })

  it('sends the quote on a stock turn — a record without it describes a question nobody can read', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    recordFeedback(entry({ quote: 'the gate refuses before the model is called' }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    expect(calls[0].body.quote).toBe('the gate refuses before the model is called')
  })

  it('normalises a missing revision rather than sending undefined', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    const { revision, ...noRevision } = entry()
    void revision
    recordFeedback(noRevision, { feedbackEndpoint: '/f', send: 'down', storage, fetchImpl })
    expect(calls[0].body.revision).toBe(0)
  })
})

describe('feedback — the send mode is resolved, never trusted', () => {
  it('is idempotent, so the build and the browser agree', () => {
    const once = resolveFeedback({ feedback: { send: 'up' } })
    expect(resolveFeedback({ feedback: once })).toEqual(once)
  })

  it('reports a value outside the enum and carries on', () => {
    const said = []
    expect(resolveFeedback({ feedback: { send: 'sometimes' } }, (m) => said.push(m))).toEqual({
      send: 'both',
      comment: true,
      confirm: true,
    })
    expect(said.join(' ')).toContain('feedback.send')
  })

  it('keeps the half the site did not set', () => {
    expect(resolveDocPilot({ feedback: { send: 'down' } }).feedback).toEqual({
      send: 'down',
      comment: true,
      confirm: true,
    })
    // …and a site that only ever set the endpoint keeps working unchanged.
    expect(resolveDocPilot({ feedbackEndpoint: '/f' }).feedback).toEqual(DEFAULTS.feedback)
  })
})

/**
 * The bridge from a vote to a probe.
 *
 * Every suggestion is checked against the calibrator's own STRATA table, which
 * is why that table is exported: the two cannot drift apart into a file that
 * proposes a stratum `loadProbes` would then reject.
 */
describe('feedback CLI — what a vote is evidence of', () => {
  const gate = (over = {}) => ({
    G: 0.41,
    tau: 0.55,
    mode: 'hybrid',
    channel: 'raw',
    wouldPassUnscoped: false,
    ...over,
  })
  const all = { kind: 'all' }
  const scoped = { kind: 'section' }

  it('never proposes a stratum the calibrator would reject', () => {
    const cases = [
      { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['wrong'], scope: all },
      { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['wrong'], scope: scoped },
      { gate: gate(), refusal: 'out-of-scope', verdict: 'down', reasons: [], scope: scoped },
      { gate: gate({ channel: 'composed' }), refusal: null, verdict: 'up', reasons: [], scope: all },
      { gate: gate({ channel: 'composed' }), refusal: null, verdict: 'down', reasons: [], scope: all },
      { gate: gate({ G: 0.7 }), refusal: null, verdict: 'up', reasons: [], scope: all },
      { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['not-in-docs'], scope: all },
    ]
    for (const c of cases) {
      const s = suggest(c)
      expect(TARGETS).toContain(s.target)
      if (s.stratum != null) expect(Object.keys(STRATA)).toContain(s.stratum)
      for (const k of s.stratumOptions) expect(Object.keys(STRATA)).toContain(k)
    }
  })

  it('drops a turn that never reached the gate', () => {
    for (const refusal of ['credential', 'social']) {
      const s = suggest({ gate: null, refusal, verdict: 'down', reasons: [], scope: all })
      expect(s.target).toBe('none')
      expect(s.needsReview).toBe(false)
    }
  })

  it('refuses to score a degraded turn against tau', () => {
    const s = suggest({
      gate: gate({ mode: 'lexical-only' }),
      refusal: 'no-evidence',
      verdict: 'down',
      reasons: ['wrong'],
      scope: all,
    })
    expect(s.stratum).toBe(null)
    expect(s.needsReview).toBe(true)
    expect(s.note).toContain('degraded')
  })

  it('sends a post-model refusal to the golden set, not to the calibrator', () => {
    const s = suggest({
      gate: gate({ G: 0.7 }),
      refusal: 'not-answerable',
      verdict: 'down',
      reasons: [],
      scope: all,
    })
    expect(s.target).toBe('golden')
    expect(s.expect).toBe('refuse:no-evidence')
    expect(s.stratum).toBe(null)
  })

  it('offers the negative strata rather than guessing between them', () => {
    const s = suggest({
      gate: gate(),
      refusal: 'no-evidence',
      verdict: 'down',
      reasons: ['not-in-docs'],
      scope: all,
    })
    expect(s.stratum).toBe(null)
    expect(s.stratumOptions).toEqual(['N1', 'N2', 'N3', 'N4'])
    // N6 is an adversarial construction; nobody stumbles into it.
    expect(s.stratumOptions).not.toContain('N6')
  })

  /**
   * The invariant the selection feature breaks, and the branch that repairs it.
   *
   * `channel: 'composed'` used to mean one thing — a follow-up whose other half
   * is the previous question — and steps 4/5 file it as an F or N5 probe with
   * "add prev_question from the conversation". A quoted turn has no previous
   * question to add: its antecedent is a passage the corpus wrote. Left alone,
   * every quoted turn would enter the calibration set as a probe nobody can
   * complete, and F's looser over-refusal bound would be applied to a
   * population it was never measured on.
   */
  it('never turns a quoted follow-up into a tau probe', () => {
    const quoted = { gate: gate({ channel: 'composed', antecedent: 'quote' }), refusal: null, reasons: [], scope: all }
    const up = suggest({ ...quoted, verdict: 'up' })
    expect(up.target).toBe('none')
    expect(up.stratum).toBe(null)
    expect(up.note).toContain('quoted')

    const down = suggest({ ...quoted, verdict: 'down' })
    expect(down.target).toBe('golden')
    expect(down.expect).toBe('answer')
    expect(down.stratum).toBe(null)

    // The ordinary follow-up is untouched: same channel, a question behind it.
    const followUp = suggest({
      gate: gate({ channel: 'composed', antecedent: 'question' }),
      refusal: null,
      verdict: 'up',
      reasons: [],
      scope: all,
    })
    expect(followUp.stratum).toBe('F')
  })

  // A quote does not exempt a turn from every route — only from the one that
  // needs a previous question. Refused in scope is still an X probe.
  it('still files a quoted turn the raw channel carried', () => {
    const s = suggest({
      gate: gate({ channel: 'raw', antecedent: 'quote', wouldPassUnscoped: true }),
      refusal: 'out-of-scope',
      verdict: 'down',
      reasons: ['not-in-docs'],
      scope: scoped,
    })
    expect(s.stratum).toBe('X')
  })

  it('routes a citation defect away from the threshold', () => {
    const s = suggest({
      gate: gate({ G: 0.7 }),
      refusal: null,
      verdict: 'down',
      reasons: ['bad-links'],
      scope: all,
    })
    expect(s.target).toBe('docs')
    expect(s.stratum).toBe(null)
  })

  it('reads a scoped refusal as U or S depending on the scope', () => {
    const base = { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['incomplete'] }
    expect(suggest({ ...base, scope: all }).stratum).toBe('U')
    // Scoped and it would not have passed unscoped either: ambiguous by
    // construction, so it asks rather than answers.
    expect(suggest({ ...base, scope: scoped }).stratumOptions).toEqual(['P', 'S'])
  })
})

describe('feedback CLI — aggregation', () => {
  const row = (over = {}) => ({
    ts: 1755000000000,
    sessionId: 's_1',
    messageId: 'm_1',
    revision: 0,
    question: 'How do I rotate an API key?',
    verdict: 'down',
    reasons: [],
    comment: null,
    refusal: 'no-evidence',
    gate: { G: 0.41, tau: 0.55, mode: 'hybrid', n: 1191, channel: 'raw', wouldPassUnscoped: false },
    scope: { kind: 'all' },
    ...over,
  })

  it('collapses variants of one question, and counts messages not rows', () => {
    const out = aggregate([
      row(),
      row({ revision: 1, reasons: ['wrong'], comment: 'only creation is documented' }),
      row({ messageId: 'm_2', sessionId: 's_2', question: 'how do i rotate an api key' }),
    ])
    expect(out).toHaveLength(1)
    // Two messages, three rows: the amendment is not a second ask.
    expect(out[0].asked).toBe(2)
    expect(out[0].sessions).toBe(2)
    expect(out[0].variants).toHaveLength(2)
    expect(out[0].comments).toEqual(['only creation is documented'])
    expect(out[0].reasons).toEqual({ wrong: 1 })
  })

  it('keeps the highest revision per message', () => {
    const rows = dedupe([
      row({ revision: 1, comment: 'kept' }),
      row({ revision: 0, comment: 'stale' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].comment).toBe('kept')
  })

  it('normalises punctuation and case, but does not stem', () => {
    expect(normalise('How do I ROTATE  a key??')).toBe('how do i rotate a key')
    expect(normalise('rotating keys')).not.toBe(normalise('rotate key'))
  })

  it('keeps a review across a re-pull, and does not mistake its own guess for one', () => {
    const first = aggregate([row({ reasons: ['not-in-docs'] })])
    expect(first[0].needsReview).toBe(true)

    // A second run over the same data changes nothing and clears nothing.
    const untouched = merge(first, aggregate([row({ reasons: ['not-in-docs'] })]))
    expect(untouched[0].needsReview).toBe(true)

    // A person decides, and that decision survives.
    const reviewed = [{ ...first[0], stratum: 'N4', needsReview: false, note: 'off-domain' }]
    const after = merge(reviewed, aggregate([row({ reasons: ['not-in-docs'] })]))
    expect(after[0].stratum).toBe('N4')
    expect(after[0].needsReview).toBe(false)
    expect(after[0].note).toBe('off-domain')
  })

  it('does not drop a promoted question because the sample moved', () => {
    const promoted = [
      { question: 'gone from this export', target: 'calibration', stratum: 'U', promoted: true },
    ]
    const after = merge(promoted, aggregate([row()]))
    expect(after.map((c) => c.question)).toContain('gone from this export')
  })
})

describe('feedback CLI — the source contract', () => {
  it('reads JSONL and a JSON array alike', () => {
    expect(parseRows('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }])
    expect(parseRows('[{"a":1}]')).toEqual([{ a: 1 }])
    expect(parseRows('  ')).toEqual([])
    expect(() => parseRows('not json')).toThrow(/JSONL/)
  })

  it('takes the bearer from the environment and never from the config', async () => {
    const seen = []
    const fetchImpl = (url, init) => {
      seen.push({ url, init })
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/x-ndjson' },
        text: () => Promise.resolve('{"messageId":"m_1"}'),
      })
    }
    await fetchRows({
      from: 'https://example.com/feedback',
      env: { [TOKEN_ENV]: 'secret-token' },
      fetchImpl,
    })
    expect(seen[0].init.headers.authorization).toBe('Bearer secret-token')

    // No token in the environment means no header — not a token read from
    // anywhere else.
    seen.length = 0
    await fetchRows({ from: 'https://example.com/feedback', env: {}, fetchImpl })
    expect(seen[0].init.headers).not.toHaveProperty('authorization')
  })

  it('follows a cursor, stops when it runs out, and says when it stopped early', async () => {
    let page = 0
    const fetchImpl = () => {
      page++
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        text: () =>
          Promise.resolve(
            JSON.stringify({ items: [{ messageId: `m_${page}` }], cursor: page < 3 ? `c${page}` : null }),
          ),
      })
    }
    const rows = await fetchRows({ from: 'https://e.com/f', env: {}, fetchImpl })
    expect(rows).toHaveLength(3)

    page = 0
    const said = []
    const capped = await fetchRows({
      from: 'https://e.com/f',
      env: {},
      maxPages: 2,
      fetchImpl,
      log: (m) => said.push(m),
    })
    expect(capped).toHaveLength(2)
    expect(said.join(' ')).toContain('--max-pages')
  })

  it('never prints the query string, where a token could have been pasted', async () => {
    const fetchImpl = () => Promise.resolve({ ok: false, status: 403, headers: { get: () => '' } })
    await expect(
      fetchRows({ from: 'https://example.com/feedback?token=leaked', env: {}, fetchImpl }),
    ).rejects.toThrow(/403/)
    await expect(
      fetchRows({ from: 'https://example.com/feedback?token=leaked', env: {}, fetchImpl }),
    ).rejects.not.toThrow(/leaked/)
  })
})

describe('feedback CLI — the report says what it does not know', () => {
  const candidates = aggregate([
    {
      ts: 1,
      messageId: 'm_1',
      question: 'How do I rotate a key?',
      verdict: 'down',
      reasons: ['wrong'],
      comment: null,
      refusal: 'no-evidence',
      gate: { G: 0.4, tau: 0.55, mode: 'hybrid', channel: 'raw' },
      scope: { kind: 'all' },
    },
  ])

  it('warns that a down-only sample has no denominator', () => {
    const md = renderReport(candidates, { send: 'down' })
    expect(md).toContain('Only down-votes reached the endpoint')
    expect(md).toContain('biases tau toward refusing')
  })

  it('still warns about selection bias when both verdicts travel', () => {
    const md = renderReport(candidates, { send: 'both' })
    expect(md).toContain('votes, not turns')
  })

  it('says how many questions it left out of the worst-questions table', () => {
    const md = renderReport(candidates, { send: 'both' })
    expect(md).toMatch(/1 question\(s\) with fewer than 3 votes are not listed/)
  })
})

/**
 * The amendment, across a reload.
 *
 * A receiver is told to upsert on `messageId` and keep the higher revision. That
 * makes the counter part of the wire contract rather than a local convenience:
 * a restored turn that starts again from 0 is DROPPED by that guard, silently,
 * and the reader's second opinion never arrives. Nothing in the panel, the
 * console or the endpoint reports it — which is why it is asserted here.
 */
describe('feedback — a vote cast on a restored turn', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  const INDEX = { manifest: { hash: 'h1', pages: [{ path: '/guide/auth', title: 'Auth', tail: 'Guide' }] } }

  const liveTurn = () => ({
    id: 'm_1',
    question: 'How do I authenticate?',
    state: 'complete',
    answerText: 'Use a bearer token.',
    sources: [],
    cited: [],
    scope: { kind: 'all', label: 'All docs', paths: [] },
    verdict: 'down',
    reasons: ['wrong'],
    comment: 'the example is out of date',
    feedbackRevision: 2,
    promptStock: true,
    promptHash: 'ph1',
    // Present on a live turn, dropped by the archive on purpose.
    gate: { G: 0.7, threshold: 0.55, mode: 'hybrid', n: 10, channel: 'raw', chunks: [{ id: 'a#b' }] },
  })

  const withPanel = (fn) => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns: [liveTurn()] })
    __setHistoryForTests(store)
    configure({
      docPilot: themeDocPilot(resolveDocPilot({ feedbackEndpoint: '/feedback', feedback: { send: 'both' } })),
    })
    sessionState.index = INDEX
    const sent = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => {
      sent.push(JSON.parse(init.body))
      return Promise.resolve({ ok: true })
    }
    try {
      session.openConversation(id)
      fn(sent, store)
    } finally {
      globalThis.fetch = realFetch
      __setHistoryForTests(null)
      sessionState.index = null
      configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    }
  }

  it('carries the revision the archive kept, instead of starting over at 0', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      expect(turn.feedbackRevision).toBe(2)
      expect(turn.comment).toBe('the example is out of date')
      expect(turn.reasons).toEqual(['wrong'])

      session.vote(turn, 'up')
      expect(sent).toHaveLength(1)
      // NOT 0. A receiver keeping the higher revision would have dropped a 0.
      expect(sent[0].revision).toBe(2)
      expect(turn.feedbackRevision).toBe(3)
    })
  })

  it('omits retrievedIds it cannot re-derive, rather than sending an empty list', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      session.vote(turn, 'up')
      // An empty array would overwrite a good list under `coalesce`.
      expect(sent[0]).not.toHaveProperty('retrievedIds')
      expect(sent[0].restored).toBe(true)
      // The prompt this turn actually ran under, not whatever is set now.
      expect(sent[0].promptHash).toBe('ph1')
    })
  })

  it('clears the reasons and the sentence when the thumb flips away from down', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      session.vote(turn, 'up')
      expect(turn.reasons).toEqual([])
      expect(turn.comment).toBe('')
      expect(sent[0].verdict).toBe('up')
      expect(sent[0].reasons).toEqual([])
      expect(sent[0].comment).toBe(null)
    })
  })

  it('toggles reasons without posting, and posts once when the form is sent', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      turn.verdict = 'down'
      turn.reasonOpen = true
      turn.reasons = []

      session.toggleReason(turn, 'wrong')
      session.toggleReason(turn, 'bad-links')
      session.toggleReason(turn, 'wrong') // off again
      expect(turn.reasons).toEqual(['bad-links'])
      expect(sent).toHaveLength(0)

      session.submitFeedback(turn)
      expect(sent).toHaveLength(1)
      expect(sent[0].reasons).toEqual(['bad-links'])
      expect(turn.reasonOpen).toBe(false)
    })
  })

  it('does not re-post a form the reader added nothing to', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      turn.verdict = 'down'
      turn.reasonOpen = true
      turn.reasons = []
      turn.comment = '   '
      session.submitFeedback(turn)
      expect(sent).toHaveLength(0)
      expect(turn.reasonOpen).toBe(false)
    })
  })

  it('persists the sentence and the counter, so neither dies on reload', () => {
    withPanel((sent, store) => {
      const [turn] = sessionState.turns
      turn.verdict = 'down'
      turn.reasonOpen = true
      turn.reasons = ['incomplete']
      turn.comment = 'it stops halfway'
      session.submitFeedback(turn)
      void sent

      const [row] = store.open(sessionState.conversationId).turns
      expect(row.comment).toBe('it stops halfway')
      expect(row.reasons).toEqual(['incomplete'])
      expect(row.feedbackRevision).toBe(3)
    })
  })
})

/**
 * The key table in the guide, against the key tree that ships.
 *
 * Not pedantry: this table is how a translator decides what work there is, and
 * it had already drifted — 101 leaves in eighteen groups documented against 122
 * in twenty, with the whole `history` group missing and `announce` four short.
 * Nothing failed, because nothing was checking. This is what checks.
 */
describe('i18n — the documented key table matches the shipped one', () => {
  const doc = fs.readFileSync(new URL('../docs/guide/i18n.md', import.meta.url), 'utf8')
  const counts = () => {
    const m = new Map()
    for (const p of KEY_PATHS) {
      const g = p.split('.')[0]
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }

  it('states the real leaf and group totals', () => {
    const m = counts()
    // `[\w-]`, not `\w`: the word map below has always listed `twenty-one` and
    // `twenty-two`, and `\w` cannot match either — so the first hyphenated total
    // this table reached would have failed as a MISSING SENTENCE rather than as
    // a wrong count, which is the one failure mode this test exists to rule out.
    const said = doc.match(/^(\d+) leaves, in ([\w-]+) groups\./m)
    expect(said, 'the "N leaves, in M groups" sentence').not.toBe(null)
    expect(Number(said[1])).toBe(KEY_PATHS.size)
    const words = {
      eighteen: 18,
      nineteen: 19,
      twenty: 20,
      'twenty-one': 21,
      'twenty-two': 22,
      'twenty-three': 23,
      'twenty-four': 24,
      'twenty-five': 25,
    }
    expect(words[said[2]] ?? Number(said[2])).toBe(m.size)
  })

  it('gives every group a row, with the count it actually has', () => {
    for (const [group, n] of counts()) {
      const row = doc.match(new RegExp(`^\\| \`${group}\` \\| (\\d+) \\|`, 'm'))
      expect(row, `a table row for \`${group}\``).not.toBe(null)
      expect(Number(row[1]), `\`${group}\` count`).toBe(n)
    }
  })

  /**
   * THE FOUR OTHER PLACES THE SAME PAIR OF NUMBERS IS PRINTED.
   *
   * The two tests above hold `docs/guide/i18n.md`, which is the page a
   * translator opens. It is not the only page that quotes the totals: the
   * README, the comparison table, the panel guide and the landing page's
   * feature card all print "N strings … in M groups" as a selling point, and
   * none of them was checked. They had drifted to 158 in 22 against a tree of
   * 170 in 25 — the same failure, in the same shape, as the drift the block
   * above was written for, one file over.
   *
   * Held as substrings rather than by regex sweep: each page words the sentence
   * differently, and the wording is the part a test should not own.
   */
  it('every other page quoting the totals quotes the current ones', () => {
    const n = KEY_PATHS.size
    const g = new Set([...KEY_PATHS].map((p) => p.split('.')[0])).size
    const claims = [
      ['README.md', `Every reader-facing string — ${n} of them, in ${g} groups —`],
      ['docs/guide/comparison.md', `all ${n} of them, one at a time, in ${g} groups`],
      ['docs/guide/panel.md', `All ${n} reader-facing strings are replaceable one at a time, in ${g} groups`],
      ['docs/.vitepress/theme/ChatFeatures.vue', `'${n} strings, one at a time'`],
      ['docs/.vitepress/theme/ChatFeatures.vue', `replaceable, in ${g} groups.`],
    ]
    const stale = claims
      .filter(([f, claim]) => !fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').includes(claim))
      .map(([f, claim]) => `${f} no longer says "${claim}"`)
    expect(stale, `the key tree is ${n} leaves in ${g} groups — update the pages that print it`).toEqual([])
  })
})

/**
 * The fourth direction.
 *
 * `feedback.record` redacts the copy it stores and sends, which covers the
 * network and the feedback store. It does NOT cover `turn.comment`, and that
 * string is written to the conversation archive — including a draft the reader
 * abandoned with Escape. This was found in a browser, not here: every unit test
 * passed while a pasted key sat in localStorage in clear text.
 */
describe('feedback — a key in the comment never reaches the archive either', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }
  const KEY = 'sk-abcdefghijklmnopqrstuvwxyz012345'

  const withTurn = (fn) => {
    const local = fake()
    const store = createHistory({ local, session: fake(), now: () => 1 })
    const id = store.save({
      id: null,
      hash: 'h1',
      turns: [
        {
          id: 'm_1',
          question: 'How do I authenticate?',
          state: 'complete',
          answerText: 'Use a bearer token.',
          sources: [],
          scope: { kind: 'all', label: 'All docs', paths: [] },
          verdict: 'down',
        },
      ],
    })
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = { manifest: { hash: 'h1', pages: [] } }
    try {
      session.openConversation(id)
      fn(sessionState.turns[0], local, store)
    } finally {
      __setHistoryForTests(null)
      sessionState.index = null
      configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    }
  }

  it('masks an abandoned draft, which Escape still writes down', () => {
    withTurn((turn, local) => {
      turn.reasonOpen = true
      turn.comment = `it rejects ${KEY} every time`
      session.skipFeedback(turn)

      expect(turn.comment).toContain(MASK)
      expect(turn.comment).not.toContain(KEY)
      // The whole archive, as bytes: the string reaches disk through slimTurn.
      expect(local.getItem('docpilot:history')).not.toContain(KEY)
    })
  })

  it('masks a submitted comment on the turn, not only in the record', () => {
    withTurn((turn, local) => {
      turn.reasonOpen = true
      turn.reasons = ['wrong']
      turn.comment = `the token ${KEY} is rejected`
      session.submitFeedback(turn)

      expect(turn.comment).not.toContain(KEY)
      expect(local.getItem('docpilot:history')).not.toContain(KEY)
    })
  })
})

/**
 * The browser-side retrieval core.
 *
 * Until now nothing imported this module at all: the gate and the quantiser were
 * unit-tested, but the thing that actually answers "which chunks" — dense search
 * over the int8 index, the lexical channel, the scope filter and its GATE 2
 * post-condition — was covered by nothing. It is the choke point the whole scope
 * guarantee rests on, so it is tested here against a synthetic index small
 * enough to reason about by hand.
 */

/**
 * The shared excerpt cut.
 *
 * Small on purpose. A query-focused window was built here and measured off:
 * against the golden positives it recovered one gold identifier and lost one,
 * because a chunk starts at its heading and the definition lives under it.
 * excerpt.js carries the numbers. What survived is the part that earns its
 * bytes — one implementation for the harness and the bench, and a truncation
 * signal the model can act on.
 */
describe('excerptWindow', () => {
  it('leaves a chunk that fits alone, and says so', () => {
    const text = 'Guide — Auth\nShort enough to send whole.'
    expect(excerptWindow(text, { max: 1200 })).toEqual({ text, truncated: false })
  })

  it('cuts at the head and reports it', () => {
    const text = 'Guide — Auth\n' + 'x'.repeat(2000)
    const w = excerptWindow(text, { max: 100 })
    expect(w.text).toBe(text.slice(0, 100))
    expect(w.truncated).toBe(true)
  })

  it('survives the degenerate inputs a chunk can actually have', () => {
    expect(excerptWindow('', { max: 10 })).toEqual({ text: '', truncated: false })
    expect(excerptWindow(null, { max: 10 })).toEqual({ text: '', truncated: false })
    expect(excerptWindow('abc', { max: 0 }).truncated).toBe(true)
  })

  /**
   * The bench must build the observation the product builds. It used to hold a
   * hand-copy, and the two had already drifted on the budget constant.
   */
  it('is the only place either caller cuts an excerpt', () => {
    const harness = fs.readFileSync('src/theme/docpilot/harness.js', 'utf8')
    const bench = fs.readFileSync('src/eval/answer-bench.js', 'utf8')
    for (const src of [harness, bench]) {
      expect(src).toContain('excerptWindow')
      expect(src).not.toMatch(/\.slice\(0,\s*(SEARCH_CHARS|FETCH_CHARS)\)/)
    }
  })
})

describe('createRetrieval', () => {
  const DIMS = 4
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

  // A vector the quantiser would have produced: one axis at full scale, so a
  // query on the same axis scores exactly 1.0 and every other pair scores 0.
  const axis = (i) => {
    const v = new Array(DIMS).fill(0)
    v[i] = 127
    return v
  }

  /**
   * `hash` must differ per fixture: `miniSearchFor` memoises its MiniSearch
   * instance on `manifest.hash`, so two fixtures sharing one would have the
   * second search the first's chunks.
   *
   * `vectors` names the blob, and naming it is what makes this a vector-bearing
   * index: a null there is how a lexical-only build declares itself, so a
   * fixture that omits the key hands `createRetrieval` an index with no dense
   * channel at all. Most retrieval assertions still pass on BM25 alone, which is
   * exactly why the omission has to be spelled out rather than noticed.
   */
  let fixtureCount = 0
  const makeIndex = (rows, guard = GUARD, df = {}) => {
    const hash = `test-${++fixtureCount}`
    const vectors = new Int8Array(rows.length * DIMS)
    rows.forEach((r, i) => vectors.set(r.vec, i * DIMS))
    const chunks = rows.map(({ vec, ...c }) => ({ ...c }))
    const paths = [...new Set(chunks.map((c) => c.path))]
    return assembleIndex({
      manifest: {
        version: 3,
        hash,
        embedModel: 'test',
        dims: DIMS,
        chunkCount: chunks.length,
        vectors: `vectors.${hash}.bin`,
        pages: paths.map((p) => ({ path: p, title: `Page ${p}`, tail: 'Docs' })),
        guard,
      },
      shards: [chunks],
      vectorBuffer: vectors.buffer,
      dfDoc: { df },
    })
  }

  const CORPUS = () => [
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
      vec: axis(0),
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
      vec: axis(1),
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
      vec: axis(2),
    },
  ]

  const ALL = { kind: 'all', paths: [], label: 'All docs' }

  it('ranks by the dense channel: the chunk on the query vector comes first', () => {
    const r = createRetrieval({ index: makeIndex(CORPUS()), scope: ALL, guard: GUARD })
    expect(r.search({ query: 'alpha widget', queryVec: axis(0) })[0].id).toBe('a#one')
    expect(r.search({ query: 'beta gizmo', queryVec: axis(1) })[0].id).toBe('b#one')
  })

  it('answers without a query vector at all — the lexical-only fallback', () => {
    const r = createRetrieval({ index: makeIndex(CORPUS()), scope: ALL, guard: GUARD })
    const hits = r.search({ query: 'invoices refunds', queryVec: null })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].id).toBe('c#one')
  })

  /**
   * The asymmetric tokenizer, pinned from the outside.
   *
   * `terms()` keeps `.` inside a token, so a page that writes `window.initEditor`
   * indexes that compound as ONE term — and a reader who searches the bare
   * `initEditor` cannot reach it, because a prefix match walks from the start of
   * a term. Measured on the development corpus before the index side was split:
   * `initEditor` fell from 14 hits to 1. A `search_docs` argument is very often
   * exactly one bare identifier, so this is the common path.
   *
   * Both halves are asserted because either alone is a plausible-looking fix that
   * loses the other: index the parts only and the compound stops matching.
   */
  it('finds a compound identifier by either half or whole', () => {
    const rows = [
      {
        id: 'api#init',
        path: '/api',
        anchor: 'init',
        title: 'API',
        breadcrumb: 'Docs',
        kind: 'reference',
        text: 'Call window.initEditor once the container exists.',
        prev: null,
        next: null,
        vec: axis(0),
      },
      {
        id: 'other#one',
        path: '/other',
        anchor: 'one',
        title: 'Other',
        breadcrumb: 'Docs',
        kind: 'guide',
        text: 'Unrelated prose about billing plans and refunds.',
        prev: null,
        next: null,
        vec: axis(1),
      },
    ]
    const r = createRetrieval({ index: makeIndex(rows), scope: ALL, guard: GUARD })
    const ids = (q) => r.search({ query: q, queryVec: null }).map((c) => c.id)
    expect(ids('initEditor')).toContain('api#init')
    expect(ids('window')).toContain('api#init')
    expect(ids('window.initEditor')).toContain('api#init')
  })

  it('a scope is a hard filter, not a ranking preference', () => {
    const r = createRetrieval({
      index: makeIndex(CORPUS()),
      scope: { kind: 'page', paths: ['/b'], label: 'Beta' },
      guard: GUARD,
    })
    // The query points straight at /a, which is outside the scope.
    const hits = r.search({ query: 'alpha widget token', queryVec: axis(0) })
    expect(hits.every((c) => c.path === '/b')).toBe(true)
  })

  it('fetch cannot tell an unknown id from one outside the scope', () => {
    const r = createRetrieval({
      index: makeIndex(CORPUS()),
      scope: { kind: 'page', paths: ['/b'], label: 'Beta' },
      guard: GUARD,
    })
    expect(r.fetch('b#one').ok).toBe(true)
    // Both are refusals, and neither leaks which kind it was to the caller
    // beyond the reason the harness deliberately collapses.
    expect(r.fetch('a#one')).toEqual({ ok: false, reason: 'out-of-scope' })
    expect(r.fetch('nope#nope')).toEqual({ ok: false, reason: 'unknown-id' })
  })

  it('pages() is scope-filtered and prefix-normalised — otherwise it is an id oracle', () => {
    const index = makeIndex(CORPUS())
    const scoped = createRetrieval({
      index,
      scope: { kind: 'page', paths: ['/b'], label: 'Beta' },
      guard: GUARD,
    })
    expect(scoped.pages('/').map((p) => p.path)).toEqual(['/b'])
    const all = createRetrieval({ index, scope: ALL, guard: GUARD })
    expect(all.pages('/').map((p) => p.path)).toEqual(['/a', '/b', '/c'])
    expect(all.pages('a').map((p) => p.path)).toEqual(['/a'])
  })

  it('GATE 2 catches a section expansion that would leave the scope', () => {
    // A short chunk pulls in its `next`. Pointing that at another page is the
    // one way expansion can escape, and it is exactly what GATE 2 exists for.
    const rows = CORPUS()
    rows[1].text = 'Short.'
    rows[1].next = 'a#one'
    const index = makeIndex(rows)
    const scope = { kind: 'page', paths: ['/b'], label: 'Beta' }

    const escaped = []
    const quiet = createRetrieval({
      index,
      scope,
      guard: GUARD,
      onDebug: (kind, data) => kind === 'scope-escape' && escaped.push(...data),
    })
    const hits = quiet.search({ query: 'short', queryVec: axis(1) })
    expect(hits.every((c) => c.path === '/b')).toBe(true)
    expect(escaped).toContain('a#one')

    const strict = createRetrieval({ index, scope, guard: GUARD, dev: true })
    expect(() => strict.search({ query: 'short', queryVec: axis(1) })).toThrow(ScopeEscape)
  })

  it('a vector of the wrong width degrades to lexical rather than scoring garbage', () => {
    const seen = []
    const r = createRetrieval({
      index: makeIndex(CORPUS()),
      scope: ALL,
      guard: GUARD,
      onDebug: (kind, data) => seen.push([kind, data]),
    })
    const hits = r.search({ query: 'invoices refunds', queryVec: [1, 2] })
    expect(seen.find(([k]) => k === 'dim-mismatch')).toBeTruthy()
    expect(hits[0].id).toBe('c#one')
  })

  it('the gate passes on evidence and refuses without it, before any model call', () => {
    const r = createRetrieval({ index: makeIndex(CORPUS()), scope: ALL, guard: GUARD })
    const hit = r.evaluate({ question: 'how is the alpha widget configured?', queryVec: axis(0) })
    expect(hit.pass).toBe(true)
    expect(hit.G).toBeGreaterThanOrEqual(GUARD.tau)

    // Nothing in the corpus lies on this axis and no term overlaps.
    const miss = r.evaluate({ question: 'quarterly hiring headcount', queryVec: axis(3) })
    expect(miss.pass).toBe(false)
    expect(miss.G).toBeLessThan(GUARD.tau)
  })

  /**
   * ── the follow-up asked in another language — RAG-SPEC 3.4.5
   *
   * The reported failure end to end: turn one is answered, turn two says "and
   * can I style it?" in Russian, and the pronoun makes the raw question
   * retrieve nothing. The composed channel is what resolves it, and the term
   * veto used to discard the composed channel for every question in this
   * language — so the reader was told the docs do not cover styling by a gate
   * that had the styling chunk in hand.
   */
  const ENGLISH_DF = { alpha: 2, widget: 3, configured: 1, manifest: 1, token: 2, beta: 1 }

  it('admits the composed channel when the tail is in another script', () => {
    const r = createRetrieval({
      index: makeIndex(CORPUS(), GUARD, ENGLISH_DF),
      scope: ALL,
      guard: GUARD,
    })
    // The pronoun on its own lands on no axis and overlaps no term.
    const alone = r.evaluate({ question: 'а я могу его стилизировать?', queryVec: axis(3) })
    expect(alone.pass).toBe(false)

    const withPrevious = r.evaluate({
      question: 'а я могу его стилизировать?',
      previousQuestion: 'для чего нужен этот виджет?',
      queryVec: axis(3),
      composedVec: axis(0),
    })
    expect(withPrevious.channel).toBe('composed')
    expect(withPrevious.admissible).toBe(true)
    expect(withPrevious.admissibleBy).toBe('foreign-tail')
    expect(withPrevious.pass).toBe(true)
    // The chunk the model is primed with is the composed channel's, not the
    // raw channel's — abstaining decides what the model reads, not only whether
    // it is called.
    expect(withPrevious.chunks[0].id).toBe('a#one')
  })

  /**
   * ABSTAINING IS NOT PASSING, and these two are the whole safety argument.
   *
   * The first: the same foreign tail with nothing behind it. Admissibility no
   * longer stands in the way and the turn still refuses, because the dense
   * floor is what replaced it.
   *
   * The second: a topic switch in the corpus's own script, with the antecedent's
   * evidence sitting right there to inherit. The veto is measurable there, so it
   * applies, and the composed channel is dropped however high it scores.
   */
  it('refuses a foreign tail the composed channel cannot support either', () => {
    const r = createRetrieval({
      index: makeIndex(CORPUS(), GUARD, ENGLISH_DF),
      scope: ALL,
      guard: GUARD,
    })
    const g = r.evaluate({
      question: 'а где купить пиццу?',
      previousQuestion: 'для чего нужен этот виджет?',
      queryVec: axis(3),
      composedVec: axis(3),
    })
    expect(g.admissible).toBe(true)
    expect(g.channel).toBe('raw')
    expect(g.pass).toBe(false)
  })

  it('still vetoes a topic switch written in the corpus’s own script', () => {
    const r = createRetrieval({
      index: makeIndex(CORPUS(), GUARD, ENGLISH_DF),
      scope: ALL,
      guard: GUARD,
    })
    const g = r.evaluate({
      question: 'what is the weather in paris',
      previousQuestion: 'how is the alpha widget configured?',
      queryVec: axis(3),
      composedVec: axis(0),
    })
    expect(g.admissible).toBe(false)
    expect(g.admissibleBy).toBe(null)
    expect(g.channel).toBe('raw')
    expect(g.pass).toBe(false)
  })

  it('an empty corpus refuses instead of throwing', () => {
    const r = createRetrieval({ index: makeIndex([]), scope: ALL, guard: GUARD })
    expect(r.search({ query: 'anything', queryVec: axis(0) })).toEqual([])
    expect(r.evaluate({ question: 'anything', queryVec: axis(0) }).pass).toBe(false)
  })

  /**
   * The diversity the lexical-only path did not have.
   *
   * `mmr()` at the shipped λ=1.0 multiplies its redundancy term by (1 − λ) = 0, so
   * `simTo.pair` — which without a query vector IS the same-page indicator — was
   * dead code, and every slot could go to one page. The fixture is the shape that
   * exposes it: one page repeating the query's terms across six sections, against
   * two other pages that say the same thing once.
   */
  const REPETITIVE = () => {
    const filler = 'plans invoices refunds billing statements '.repeat(20)
    const rows = []
    for (let i = 1; i <= 6; i++) {
      rows.push({
        id: `big#${i}`,
        path: '/big',
        anchor: `${i}`,
        title: `Billing ${i}`,
        breadcrumb: 'Docs',
        kind: 'guide',
        text: `Billing section ${i}. ${filler}`,
        prev: null,
        next: null,
        vec: axis(0),
      })
    }
    for (const [n, p] of [
      [1, '/one'],
      [2, '/two'],
    ]) {
      rows.push({
        id: `s${n}#one`,
        path: p,
        anchor: 'one',
        title: `Side ${n}`,
        breadcrumb: 'Docs',
        kind: 'guide',
        text: `Side note ${n} about invoices and refunds. ${filler}`,
        prev: null,
        next: null,
        vec: axis(1),
      })
    }
    return rows
  }

  it('caps one page to PAGE_CAP slots when there is no query vector', () => {
    const r = createRetrieval({ index: makeIndex(REPETITIVE()), scope: ALL, guard: GUARD })
    const hits = r.search({ query: 'invoices refunds billing', queryVec: null, k: 5 })
    expect(hits).toHaveLength(5)
    const fromBig = hits.filter((c) => c.path === '/big')
    // The cap shapes the HEAD of the set: at most two before anything else is
    // offered. Backfill may return to /big afterwards rather than hand back a
    // short set, so the assertion is on the first three, not on the total.
    expect(hits.slice(0, 3).filter((c) => c.path === '/big')).toHaveLength(2)
    expect(new Set(hits.slice(0, 3).map((c) => c.path)).size).toBeGreaterThan(1)
    expect(fromBig.length).toBeLessThan(5)
  })

  it('backfills rather than returning a short set when the corpus is all one page', () => {
    // Every candidate is on one page, so a cap that only filtered would hand the
    // model three chunks where five were asked for — less evidence, not more
    // diverse evidence.
    const rows = REPETITIVE().filter((c) => c.path === '/big')
    const r = createRetrieval({ index: makeIndex(rows), scope: ALL, guard: GUARD })
    expect(r.search({ query: 'invoices refunds billing', queryVec: null, k: 5 })).toHaveLength(5)
  })

  it('leaves the hybrid path on MMR: a query vector still orders the set', () => {
    // The cap is the vectorless branch only. With a vector in hand the dense
    // re-rank decides, and the chunk on the query axis leads however repetitive
    // its page is.
    const r = createRetrieval({ index: makeIndex(REPETITIVE()), scope: ALL, guard: GUARD })
    const hits = r.search({ query: 'invoices refunds billing', queryVec: axis(0), k: 5 })
    expect(hits[0].path).toBe('/big')
    expect(hits.filter((c) => c.path === '/big').length).toBeGreaterThan(2)
  })

  /**
   * `pageCap` on its own, because the two properties it has to hold are easier to
   * state than to read out of a retrieval.
   */
  it('pageCap keeps pool order and never shortens the set', () => {
    const byId = new Map(
      [
        ['a', '/p1'],
        ['b', '/p1'],
        ['c', '/p1'],
        ['d', '/p2'],
        ['e', '/p3'],
      ].map(([id, path]) => [id, { id, path }]),
    )
    const pool = ['a', 'b', 'c', 'd', 'e']
    // Capped ids are deferred, not dropped: 'c' returns at the end.
    expect(pageCap(pool, byId, 5, 2)).toEqual(['a', 'b', 'd', 'e', 'c'])
    expect(pageCap(pool, byId, 5, 1)).toEqual(['a', 'd', 'e', 'b', 'c'])
    // k is respected before the backfill runs.
    expect(pageCap(pool, byId, 3, 2)).toEqual(['a', 'b', 'd'])
    // A cap of 1 over a single page is the degenerate case the backfill exists
    // for, and it still returns k.
    expect(pageCap(pool.slice(0, 3), byId, 3, 1)).toEqual(['a', 'b', 'c'])
    expect(pageCap([], byId, 5, 2)).toEqual([])
  })

  /**
   * `kind` intersects at candidate generation now, not after fusion.
   *
   * Filtering afterwards could only shrink a list already truncated to FUSED, so
   * a kind that was real but rare was answered out of whatever survived a search
   * that had never heard of it — and often out of the unfiltered fallback.
   */
  it('generates candidates of the requested kind instead of filtering the fused pool', () => {
    const filler = 'plans invoices refunds billing statements '.repeat(20)
    const rows = []
    for (let i = 1; i <= 14; i++) {
      rows.push({
        id: `g#${i}`,
        path: `/g${i}`,
        anchor: 'one',
        title: `Guide ${i}`,
        breadcrumb: 'Docs',
        kind: 'guide',
        text: `Guide ${i} on invoices and refunds. ${filler}`,
        prev: null,
        next: null,
        vec: axis(0),
      })
    }
    // One reference page, deliberately a weaker lexical match than any guide, so
    // it lands outside the fused window and a post-filter would never see it.
    rows.push({
      id: 'ref#one',
      path: '/ref',
      anchor: 'one',
      title: 'Reference',
      breadcrumb: 'Docs',
      kind: 'reference',
      text: `Refunds field reference. ${'unrelated tokens '.repeat(60)}`,
      prev: null,
      next: null,
      vec: axis(1),
    })
    const r = createRetrieval({ index: makeIndex(rows), scope: ALL, guard: GUARD })
    const got = r.search({ query: 'invoices refunds', queryVec: null, k: 3, kind: 'reference' })
    expect(got.map((c) => c.id)).toContain('ref#one')
    expect(got.every((c) => c.kind === 'reference')).toBe(true)
  })

  it('falls back to the unfiltered pool when the kind is genuinely absent', () => {
    // The intersect-only contract: a kind the corpus does not have under this
    // query must not silently widen into an empty answer.
    const r = createRetrieval({ index: makeIndex(CORPUS()), scope: ALL, guard: GUARD })
    const got = r.search({ query: 'invoices refunds', queryVec: null, k: 3, kind: 'extensions' })
    expect(got.length).toBeGreaterThan(0)
    expect(got.some((c) => c.kind !== 'extensions')).toBe(true)
  })

  /**
   * The per-search options MiniSearch is now handed must not clobber the ones the
   * constructor set. `{...globalSearchOptions, ...searchOptions}` is a SHALLOW
   * merge, so passing `boost`/`bm25`/`filter` has to leave `prefix`, `fuzzy` and
   * — most of all — the query-side `tokenize` in place. Losing that last one
   * would silently switch the asymmetric tokenizer off for queries only, which no
   * other assertion in this file would notice.
   */
  it('keeps prefix, fuzzy and the query tokenizer when scoring options are passed', () => {
    const rows = [
      {
        id: 'api#init',
        path: '/api',
        anchor: 'init',
        title: 'API',
        breadcrumb: 'Docs',
        kind: 'reference',
        text: 'Call window.initEditor once the container exists.',
        prev: null,
        next: null,
        vec: axis(0),
      },
      {
        id: 'other#one',
        path: '/other',
        anchor: 'one',
        title: 'Other',
        breadcrumb: 'Docs',
        kind: 'guide',
        text: 'Unrelated prose about billing plans and refunds.',
        prev: null,
        next: null,
        vec: axis(1),
      },
    ]
    const r = createRetrieval({ index: makeIndex(rows), scope: ALL, guard: GUARD })
    const ids = (q) => r.search({ query: q, queryVec: null }).map((c) => c.id)
    // The compound tokenizer survives (query side): both halves still reach it.
    expect(ids('initEditor')).toContain('api#init')
    expect(ids('window.initEditor')).toContain('api#init')
    // `prefix: true` survives.
    expect(ids('initEdi')).toContain('api#init')
    // `fuzzy: 0.2` survives.
    expect(ids('initEdotor')).toContain('api#init')
  })

  /**
   * The parts a compound is split into are stemmed like any other word, and this
   * is the one place the index/query asymmetry must NOT extend to.
   *
   * `terms()` returns a compound whole and `stemLite` refuses to touch a token
   * carrying a separator — correctly, because a name with its tail removed is a
   * different name. But the PARTS are ordinary words, and pushing them raw put a
   * form in the index that no query could produce: `plugin.settings` indexed
   * `settings` while a reader typing `settings` now asks for `setting`. The
   * compound tokenizer exists so either half of an identifier reaches the page;
   * unstemmed parts invert it.
   */
  it('stems the parts it splits out of a compound', () => {
    const rows = [
      {
        id: 'api#cfg',
        path: '/api',
        anchor: 'cfg',
        title: 'API',
        breadcrumb: 'Docs',
        kind: 'reference',
        text: 'Docs — API\nCall plugin.settings before the container exists.',
        prev: null,
        next: null,
        vec: axis(0),
      },
      {
        id: 'other#one',
        path: '/other',
        anchor: 'one',
        title: 'Other',
        breadcrumb: 'Docs',
        kind: 'guide',
        text: 'Docs — Other\nUnrelated prose about billing plans and refunds.',
        prev: null,
        next: null,
        vec: axis(1),
      },
    ]
    const r = createRetrieval({ index: makeIndex(rows), scope: ALL, guard: GUARD })
    const ids = (q) => r.search({ query: q, queryVec: null }).map((c) => c.id)
    // Both halves, and the whole, still reach it — the property the asymmetric
    // tokenizer was measured for, now under a stemmer.
    expect(ids('settings')).toContain('api#cfg')
    expect(ids('setting')).toContain('api#cfg')
    expect(ids('plugin')).toContain('api#cfg')
    expect(ids('plugin.settings')).toContain('api#cfg')
  })

  /**
   * The route and the heading slug, searchable — two fields every chunk has
   * carried since the first build and nothing ever indexed.
   */
  it('finds a page by its route or its heading slug', () => {
    const rows = [
      {
        id: 'guide/getting-started#roles',
        path: '/guide/getting-started',
        anchor: 'roles',
        title: 'Roles',
        breadcrumb: 'Docs',
        kind: 'guide',
        // Deliberately says nothing the queries below use: if this passes on the
        // body text, it is not testing the new fields.
        text: 'Docs — Roles\nEach account carries a badge that decides what it may open.',
        prev: null,
        next: null,
        vec: axis(0),
      },
      {
        id: 'other#one',
        path: '/other',
        anchor: 'one',
        title: 'Other',
        breadcrumb: 'Docs',
        kind: 'guide',
        text: 'Docs — Other\nUnrelated prose about billing plans and refunds.',
        prev: null,
        next: null,
        vec: axis(1),
      },
    ]
    const r = createRetrieval({ index: makeIndex(rows), scope: ALL, guard: GUARD })
    const ids = (q) => r.search({ query: q, queryVec: null }).map((c) => c.id)
    expect(ids('/guide/getting-started')).toContain('guide/getting-started#roles')
    expect(ids('roles')).toContain('guide/getting-started#roles')
    // A SEGMENT of the route reaches it too, through the parts `indexTokens`
    // splits out. The query side stays plain `terms()` — the asymmetry is
    // deliberate and measured — so this works because `guide` is a term in the
    // index, not because the query was taken apart.
    expect(ids('roles guide')).toContain('guide/getting-started#roles')
  })

  /**
   * The scope predicate moved into the search and must mean the same thing. It is
   * a filter either side of a sort by score, so the surviving order is identical
   * — and GATE 1 still holds: nothing outside the scope comes back.
   */
  it('scopes the lexical channel inside the search, with the same result', () => {
    const scoped = createRetrieval({
      index: makeIndex(CORPUS()),
      scope: { kind: 'page', paths: ['/a'], label: 'Alpha' },
      guard: GUARD,
    })
    expect(scoped.search({ query: 'invoices refunds', queryVec: null })).toEqual([])
    expect(
      scoped.search({ query: 'alpha widget token', queryVec: null }).map((c) => c.path),
    ).toEqual(['/a'])
  })
})

/**
 * The step budget.
 *
 * Three outcomes in `execute` cost nothing — a repeated `fetch_section`
 * rejection, a search that hits the cache, and a call to a tool that does not
 * exist. Each refund is right on its own; together they were an unbounded loop,
 * because a model stuck on one of them paid for nothing and `while (iterations <
 * maxIterations)` never came due. The only thing that ended such a turn was the
 * reader pressing stop, and every lap was a full chat() call.
 */
describe('runTurn — the free-step ceiling', () => {
  const DIMS = 4
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

  let n = 0
  const oneChunkIndex = () => {
    const chunk = {
      id: 'a#one',
      path: '/a',
      anchor: 'one',
      title: 'Alpha',
      breadcrumb: 'Docs',
      kind: 'guide',
      text: 'The alpha widget is configured with a manifest and a token.',
      prev: null,
      next: null,
    }
    const vectors = new Int8Array(DIMS)
    vectors[0] = 127
    return assembleIndex({
      manifest: {
        version: 3,
        hash: `harness-${++n}`,
        embedModel: 'test',
        dims: DIMS,
        chunkCount: 1,
        vectors: 'vectors.harness.bin',
        pages: [{ path: '/a', title: 'Alpha', tail: 'Docs' }],
        guard: GUARD,
      },
      shards: [[chunk]],
      vectorBuffer: vectors.buffer,
      dfDoc: { df: {} },
    })
  }

  const run = (toolCall) => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      // Every step answers with the same doomed tool call. Nothing here ever
      // advances the turn, which is exactly the situation being bounded.
      if (calls > 200) throw new Error('runaway: the loop is not bounded')
      return {
        ok: true,
        json: async () => ({ message: { tool_calls: [toolCall] } }),
      }
    })
    const index = oneChunkIndex()
    const retrieval = createRetrieval({
      index,
      scope: { kind: 'all', paths: [], label: 'All docs' },
      guard: GUARD,
    })
    return runTurn({
      retrieval,
      gateResult: { G: 1, pass: true, chunks: index.chunks },
      question: 'how is the alpha widget configured?',
      history: [],
      addendum: '',
      config: { llm: { provider: 'ollama', baseURL: 'http://x', model: 'm' }, maxIterations: 4 },
      fallback: false,
      queryVec: null,
    }).then((r) => ({ ...r, calls }))
  }

  afterEach(() => vi.unstubAllGlobals())

  it('an invented tool name cannot buy free steps forever', async () => {
    const r = await run({ function: { name: 'no_such_tool', arguments: '{}' } })
    // 4 charged steps plus at most MAX_FREE_STEPS refunds — a small constant,
    // not "until the reader gives up".
    expect(r.calls).toBeLessThanOrEqual(10)
  })

  it('the same rejected id cannot buy free steps forever', async () => {
    const r = await run({ function: { name: 'fetch_section', arguments: '{"id":"nope#nope"}' } })
    expect(r.calls).toBeLessThanOrEqual(10)
  })

  it('the same cached search cannot buy free steps forever', async () => {
    const r = await run({ function: { name: 'search_docs', arguments: '{"query":"alpha"}' } })
    expect(r.calls).toBeLessThanOrEqual(10)
  })

  /**
   * The lexical block reaches the wire, and only on the mode the gate named.
   *
   * `buildMessages` accepting the flag is the mechanism; this is the seam — the
   * harness reads `gateResult.mode`, which is the one field that is right in all
   * three ways of landing on lexical-only (declared, degraded, dim-mismatch).
   */
  it('tells the model search is lexical when the gate said so, and not otherwise', async () => {
    const bodies = []
    vi.stubGlobal('fetch', async (url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return {
        ok: true,
        json: async () => ({
          message: { tool_calls: [{ function: { name: 'answer', arguments: JSON.stringify({ text: 'x [1]', citations: ['a#one'], confidence: 1 }) } }] },
        }),
      }
    })
    const index = oneChunkIndex()
    const retrieval = createRetrieval({
      index,
      scope: { kind: 'all', paths: [], label: 'All docs' },
      guard: GUARD,
    })
    const turn = (mode) =>
      runTurn({
        retrieval,
        gateResult: { G: 1, pass: true, chunks: index.chunks, mode },
        question: 'how is the alpha widget configured?',
        history: [],
        addendum: '',
        config: { llm: { provider: 'ollama', baseURL: 'http://x', model: 'm' }, maxIterations: 4 },
        fallback: false,
        queryVec: null,
      })
    await turn('lexical-only')
    expect(bodies.at(-1).messages[0].content).toContain('matches words, not meaning')
    await turn('hybrid')
    expect(bodies.at(-1).messages[0].content).not.toContain('matches words, not meaning')
  })
})


// ─── merged from tests-chunker.js ───
/**
 * Paste this block into test/docpilot.test.js, next to `describe('chunker')`.
 * It adds no imports: `chunkMarkdown` is already imported at the top of that file.
 */

/**
 * The chunker used to be blind to markdown blocks, and each of the three
 * consequences was silent. A table over the ceiling was cut between rows and the
 * continuation carried no header and no delimiter — columns unlabelled in the
 * text that reaches the embedder. A fence over the ceiling was cut with no
 * repair: one part ended on an unterminated opener, the next opened on bare code.
 * And the fence warning was wrong in BOTH directions — it fired when the break
 * landed on the opener line (where the split is clean) and stayed quiet when it
 * landed on the closer (where the fence is genuinely broken), because the toggle
 * flipped before the overflow test rather than after it.
 *
 * The last two are pinned as biconditionals: a `code block split` warning fires
 * if and only if a fence actually spans more than one chunk.
 */
describe('chunker — block-aware splitting', () => {
  // The ceiling applies to the context line plus the body, so a fixture that
  // wants to overflow on a chosen line has to know what the body's budget is.
  const budget = (heading) => 8000 - `P — ${heading}`.length - 1
  const bodyOf = (c) => c.text.split('\n').slice(1).join('\n')
  const fenceLines = (c) => bodyOf(c).match(/^```.*$/gm) || []
  const chunk = (src) => chunkMarkdown({ src, path: '/p', kind: 'guide' })

  const tableRows = Array.from({ length: 60 }, (_, i) => `| r${i}-mark | ${'d'.repeat(200)} |`)
  const bigTable = ['| col a | col b |', '| --- | --- |', ...tableRows].join('\n')

  it('repeats the header and delimiter on every part of a split table', () => {
    const { chunks, warnings } = chunk(`# P\n\n## T\n\n${bigTable}`)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(8000)
      if (!/\| r\d+-mark \|/.test(c.text)) continue
      expect(c.text).toContain('| col a | col b |')
      expect(c.text.indexOf('| --- | --- |')).toBeLessThan(c.text.search(/\| r\d+-mark \|/))
    }
    expect(warnings).toContain('table split at row boundaries by MAX_CHUNK_CHARS in /p')
  })

  it('never cuts a table row in half', () => {
    const { chunks } = chunk(`# P\n\n## T\n\n${bigTable}`)
    for (const row of tableRows) {
      expect(chunks.filter((c) => c.text.includes(row)).length, row.slice(0, 12)).toBe(1)
    }
  })

  it('closes and reopens a fence it had to split, keeping the language', () => {
    const code = Array.from({ length: 60 }, (_, i) => `const a${i} = "${'x'.repeat(190)}"`)
    const { chunks, warnings } = chunk(`# P\n\n## Code\n\n\`\`\`js\n${code.join('\n')}\n\`\`\``)
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c, i) => {
      expect(c.text.length).toBeLessThanOrEqual(8000)
      expect(fenceLines(c).length % 2, `part ${i}`).toBe(0)
      if (i < chunks.length - 1) expect(bodyOf(c).endsWith('\n```')).toBe(true)
      if (i > 0) expect(bodyOf(c).startsWith('```js\n')).toBe(true)
    })
    expect(warnings).toContain('code block split by MAX_CHUNK_CHARS in /p')
    // the repair must not eat content: the last line of the sample is still there
    expect(chunks.map((c) => c.text).join('\n')).toContain('const a59 =')
  })

  /**
   * Regression: the break lands on the fence OPENER. The fence itself fits the
   * next chunk whole, so nothing about it is split — and the old toggle, which
   * flipped to `true` before the overflow test, warned anyway.
   */
  it('does not warn when the break lands on the opener line', () => {
    const fence = ['```js', 'const a = 1', '```'].join('\n')
    const prose = 'x'.repeat(budget('Code') - 2)
    const { chunks, warnings } = chunk(`# P\n\n## Code\n\n${prose}\n\n${fence}`)
    expect(warnings.some((w) => w.includes('code block split'))).toBe(false)
    expect(chunks.filter((c) => c.text.includes(fence)).length).toBe(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(8000)
  })

  /**
   * Regression: the break lands on the fence CLOSER. The old toggle had already
   * flipped back to `false` by then, so the one case that really did leave an
   * unterminated fence in one chunk and a bare closer in the next was the one
   * case that never warned.
   */
  it('never leaves a fence open across a seam, and warns exactly when it splits one', () => {
    const fence = ['```js', 'z'.repeat(budget('Code') - 108), '```'].join('\n')
    const { chunks, warnings } = chunk(`# P\n\n## Code\n\n${'y'.repeat(100)}\n\n${fence}`)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(8000)
      expect(fenceLines(c).length % 2).toBe(0)
    }
    const spans = chunks.filter((c) => fenceLines(c).length).length
    expect(warnings.some((w) => w.includes('code block split'))).toBe(spans > 1)
  })

  it('treats a fence as one unit when packing paragraphs, blank lines and all', () => {
    const fence = [
      '```js',
      `const a = "${'a'.repeat(400)}"`,
      '',
      `const b = "${'b'.repeat(400)}"`,
      '```',
    ].join('\n')
    const src = `# P\n\n## Mixed\n\n${'p'.repeat(1000)}\n\n${fence}\n\n${'q'.repeat(1000)}`
    const { chunks } = chunk(src)
    // over TARGET_MAX_TOKENS, so paragraphSplit ran — and the blank line inside
    // the sample used to make it two paragraphs it was free to separate.
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.filter((c) => c.text.includes(fence)).length).toBe(1)
  })

  it('keeps a table that is the section’s only paragraph intact', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| row${i} | ${'v'.repeat(50)} |`)
    const table = ['| k | v |', '| --- | --- |', ...rows].join('\n')
    const { chunks } = chunk(`# P\n\n## T\n\n${table}`)
    expect(chunks.length).toBe(1)
    for (const row of rows) expect(chunks[0].text).toContain(row)
  })

  /**
   * Overlap is prose only. A near-ceiling fence or table carried into the next
   * chunk doubles its embedding cost to say the same thing twice.
   */
  it('never duplicates a fence or a table as overlap', () => {
    const fence = ['```js', `// MARKER_FENCE ${'f'.repeat(800)}`, '```'].join('\n')
    const table = ['| k | v |', '| --- | --- |', `| MARKER_TABLE | ${'t'.repeat(800)} |`].join('\n')
    const src = `# P\n\n## Mixed\n\n${'p'.repeat(1500)}\n\n${fence}\n\n${'q'.repeat(1500)}\n\n${table}\n\n${'r'.repeat(1500)}`
    const all = chunk(src).chunks.map((c) => c.text).join('\n')
    expect(all.match(/MARKER_FENCE/g).length).toBe(1)
    expect(all.match(/MARKER_TABLE/g).length).toBe(1)
  })

  it('holds the ceiling on a single line, a single row and an unclosed fence', () => {
    const unclosed = Array.from({ length: 200 }, (_, i) => `line${i} = "${'c'.repeat(60)}"`)
    const cases = {
      'one 50k line': `# P\n\n## Big\n\n${'z'.repeat(50000)}`,
      'one 50k row': `# P\n\n## Big\n\n| a | b |\n| --- | --- |\n| ${'x'.repeat(50000)} | y |`,
      'unclosed fence': `# P\n\n## Big\n\n\`\`\`js\n${unclosed.join('\n')}`,
    }
    for (const [name, src] of Object.entries(cases)) {
      expect(() => chunk(src), name).not.toThrow()
      const { chunks } = chunk(src)
      expect(chunks.length, name).toBeGreaterThan(0)
      for (const c of chunks) expect(c.text.length, `${name} ${c.id}`).toBeLessThanOrEqual(8000)
    }
    // A row nothing can be done with is reported as its own kind of loss.
    expect(chunk(cases['one 50k row']).warnings).toContain(
      'table row longer than MAX_CHUNK_CHARS cut mid-row in /p',
    )
  })

  /**
   * normalise.js flips one boolean on /^\s*(```|~~~)/. The chunker cannot: a page
   * documenting markdown shows one fence style inside the other, and under the
   * loose toggle everything after the inner `~~~` read as unfenced — so a heading
   * quoted inside the sample opened a section that does not exist.
   */
  it('reads a ~~~ inside a ``` block as content, not as a fence', () => {
    const inner = ['```md', '~~~', '## Not a heading', '~~~', '```'].join('\n')
    const src = `# P\n\n## One\n\n${'o'.repeat(600)}\n\n${inner}\n\n## Two\n\n${'t'.repeat(600)}`
    const { chunks } = chunk(src)
    expect(chunks.map((c) => c.title)).toEqual(['One', 'Two'])
    expect(chunks.find((c) => c.title === 'One').text).toContain('## Not a heading')
  })
})


// ─── merged from tests-levels.js ───
describe('golden-set levels — cumulative tiers', () => {
  // One record per tier plus a legacy record with no `level` at all, which is
  // the shape every golden file has before anyone edits it.
  const mixed = [
    { id: 'l-1', level: 'low' },
    { id: 'l-2', level: 'low' },
    { id: 'm-1', level: 'medium' },
    { id: 'h-1', level: 'high' },
    { id: 'legacy-1' },
    { id: 'legacy-2' },
    { id: 'x-1', level: 'xhigh' },
    { id: 'mx-1', level: 'max' },
    { id: 'u-1', level: 'ultra' },
  ]

  it('orders the six tiers smallest first', () => {
    expect(LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    for (let i = 1; i < LEVELS.length; i++) {
      expect(levelRank(LEVELS[i])).toBeGreaterThan(levelRank(LEVELS[i - 1]))
    }
  })

  it('ranks anything that is not one of the six at -1', () => {
    for (const bad of ['LOW', 'huge', '', undefined, null, 3]) {
      expect(levelRank(bad), String(bad)).toBe(-1)
    }
  })

  it('reads a record with no level as high, and never rewrites an authored one', () => {
    expect(DEFAULT_RECORD_LEVEL).toBe('high')
    expect(recordLevel({ id: 'x' })).toBe('high')
    expect(recordLevel({ id: 'x', level: undefined })).toBe('high')
    // A typo survives so lint can name it; this file does not launder it.
    expect(recordLevel({ id: 'x', level: 'Medium' })).toBe('Medium')
    expect(recordLevel({ id: 'x', level: 'low' })).toBe('low')
  })

  it('nests the pools: every level contains every level below it', () => {
    const ids = (lvl) => filterByLevel(mixed, lvl).map((r) => r.id)
    expect(ids('low')).toEqual(['l-1', 'l-2'])
    expect(ids('medium')).toEqual(['l-1', 'l-2', 'm-1'])
    expect(ids('high')).toEqual(['l-1', 'l-2', 'm-1', 'h-1', 'legacy-1', 'legacy-2'])
    expect(ids('xhigh')).toEqual([...ids('high'), 'x-1'])
    expect(ids('max')).toEqual([...ids('xhigh'), 'mx-1'])
    expect(ids('ultra')).toEqual(mixed.map((r) => r.id))
    for (let i = 1; i < LEVELS.length; i++) {
      const below = new Set(ids(LEVELS[i - 1]))
      for (const id of below) expect(ids(LEVELS[i]), LEVELS[i]).toContain(id)
    }
  })

  it('runs the whole set when no level is given — today’s behaviour', () => {
    expect(DEFAULT_RUN_LEVEL).toBe('ultra')
    expect(filterByLevel(mixed, undefined)).toHaveLength(mixed.length)
    expect(filterByLevel(mixed, '')).toHaveLength(mixed.length)
  })

  it('scores a legacy file identically with --level=high and with no flag', () => {
    // The whole point of DEFAULT_RECORD_LEVEL: 60 records, none carrying a
    // level, must not move when the flag arrives.
    const legacy = Array.from({ length: 60 }, (_, i) => ({ id: `q-${i}`, question: '?' }))
    expect(filterByLevel(legacy, 'high')).toEqual(legacy)
    expect(filterByLevel(legacy, undefined)).toEqual(legacy)
    // …and the same records are OUT of the smoke pool, because high is not low.
    expect(filterByLevel(legacy, 'low')).toEqual([])
    expect(filterByLevel(legacy, 'medium')).toEqual([])
  })

  it('keeps a record with an unrecognised level in every pool, smoke included', () => {
    // Dropping it would make `ultra` mean "everything except the typos", which
    // is the one thing ultra may not mean. lint is what errors on it.
    const strays = [{ id: 'ok', level: 'high' }, { id: 'typo', level: 'hgih' }]
    expect(filterByLevel(strays, 'low').map((r) => r.id)).toEqual(['typo'])
    expect(filterByLevel(strays, 'ultra').map((r) => r.id)).toEqual(['ok', 'typo'])
  })

  it('rejects an unknown --level and names all six', () => {
    for (const bad of ['huge', 'lo', 'HIGHER', 'ultra2']) {
      let msg = ''
      try {
        parseLevelArg(bad)
      } catch (e) {
        msg = e.message
      }
      expect(msg, bad).toContain(`unknown level "${bad}"`)
      for (const l of LEVELS) expect(msg, `${bad} names ${l}`).toContain(l)
    }
  })

  it('accepts the six, trimming and case-folding what a shell hands over', () => {
    for (const l of LEVELS) expect(parseLevelArg(l)).toBe(l)
    expect(parseLevelArg(' medium ')).toBe('medium')
    expect(parseLevelArg('MAX')).toBe('max')
    expect(parseLevelArg(undefined)).toBe('ultra')
    expect(parseLevelArg('')).toBe('ultra')
    expect(parseLevelArg('   ')).toBe('ultra')
  })

  it('refuses to filter against a level it cannot parse', () => {
    // A silently empty pool reads as "the golden set is empty", which sends the
    // author to the wrong file.
    expect(() => filterByLevel(mixed, 'hgih')).toThrow(/unknown level/)
  })

  it('reports own counts and pool sizes that agree with the filter', () => {
    const h = levelHistogram(mixed)
    expect(h.total).toBe(9)
    expect(h.unknown).toBe(0)
    expect(h.levels.map((r) => [r.level, r.count, r.cumulative])).toEqual([
      ['low', 2, 2],
      ['medium', 1, 3],
      ['high', 3, 6], // one authored `high` plus the two legacy records
      ['xhigh', 1, 7],
      ['max', 1, 8],
      ['ultra', 1, 9],
    ])
    for (const row of h.levels) {
      expect(row.cumulative, row.level).toBe(filterByLevel(mixed, row.level).length)
    }
  })

  it('counts an unrecognised level under unknown and still balances the total', () => {
    const h = levelHistogram([...mixed, { id: 'typo', level: 'hgih' }])
    expect(h.unknown).toBe(1)
    expect(h.total).toBe(10)
    // The stray is in every pool, so every cumulative carries it and the last
    // one still equals the total.
    expect(h.levels[0].cumulative).toBe(3)
    expect(h.levels.at(-1).cumulative).toBe(h.total)
    expect(h.levels.reduce((n, r) => n + r.count, 0) + h.unknown).toBe(h.total)
  })

  it('survives an empty set', () => {
    const h = levelHistogram([])
    expect(h.total).toBe(0)
    expect(h.unknown).toBe(0)
    expect(h.levels).toHaveLength(6)
    expect(h.levels.every((r) => r.count === 0 && r.cumulative === 0)).toBe(true)
    expect(filterByLevel([], 'low')).toEqual([])
  })

  it('renders the summary line lint and run both print', () => {
    const h = levelHistogram(mixed)
    const line = h.levels
      .filter((r) => r.count)
      .map((r) => `${r.level} ${r.cumulative} (+${r.count})`)
      .join(' · ')
    expect(line).toBe(
      'low 2 (+2) · medium 3 (+1) · high 6 (+3) · xhigh 7 (+1) · max 8 (+1) · ultra 9 (+1)',
    )
  })
})


// ─── merged from tests-retriever-levers.js ───
// MERGE NOTE: this import adds only names the host file does not already bind.
// `createRetrieval` and `assembleIndex` are already imported at the top of
// test/docpilot.test.js; fold these three into that same import line if preferred.

/**
 * The delivery channel for a measured lever.
 *
 * Until this existed every lever was a module constant folded from `process.env`
 * at import time, and `globalThis.process` is undefined in the browser — so the
 * shipped bundle always got the literals and a value measured against a
 * consumer's own corpus had no way to reach the running retriever at all.
 */
describe('retrieval levers — the three-layer precedence', () => {
  /**
   * The literals as documented in retriever.js. Pinned from outside on purpose:
   * these are the numbers a browser bundle gets, and a sweep that quietly moves
   * one is a change to what every consumer ships, not a local edit.
   */
  const LITERALS = {
    RRF_K: 5,
    W_LEXICAL_RRF: 1.0,
    W_DENSE_RRF: 1.0,
    MMR_LAMBDA: 1.0,
    PAGE_CAP: 2,
    CANDIDATES: 30,
    FUSED: 12,
    EXPAND_BELOW_TOKENS: 150,
    GATE_K: 5,
    // MiniSearch's `defaultBM25params` and the constructor's own boosts, pinned
    // here for the same reason as the rest: they are what a browser bundle scores
    // with, and they were inherited rather than chosen, so the first time one
    // moves it should read as a decision and not as a dependency bump.
    BM25_K: 1.2,
    BM25_B: 0.7,
    BM25_D: 0.5,
    BOOST_TITLE: 2,
    BOOST_BREADCRUMB: 1.5,
    BOOST_PATH: 1.0,
    BOOST_ANCHOR: 1.25,
  }

  /**
   * The suite is one process, so an env var set here outlives the test that set
   * it unless it is removed on the way out — including when the assertion throws.
   */
  const withEnv = (name, value, fn) => {
    const key = `DOCPILOT_${name}`
    const had = Object.prototype.hasOwnProperty.call(process.env, key)
    const before = process.env[key]
    process.env[key] = value
    try {
      fn()
    } finally {
      if (had) process.env[key] = before
      else delete process.env[key]
    }
  }

  it('is the browser shape with no tuning and no env: every lever is its literal', () => {
    expect(resolveLevers()).toEqual(LITERALS)
    expect(resolveLevers(null)).toEqual(LITERALS)
    expect(new Set(LEVER_NAMES)).toEqual(new Set(Object.keys(LITERALS)))
  })

  it('takes a lever from the tuning object when the env is silent', () => {
    const t = resolveLevers({ MMR_LAMBDA: 0.85, GATE_K: 8 })
    expect(t.MMR_LAMBDA).toBe(0.85)
    expect(t.GATE_K).toBe(8)
    // Levers the tuning file does not mention keep the literal — a tuning object
    // is a patch over the defaults, never a replacement for the whole set.
    expect(t.CANDIDATES).toBe(LITERALS.CANDIDATES)
    expect(t.RRF_K).toBe(LITERALS.RRF_K)
  })

  /**
   * The env layer beats the tuning object, and it resolves to the value read
   * HERE — at call time, not at import.
   *
   * The distinction is the whole defect: every CLI entry point loads
   * `.env.local` into `process.env` after the module graph is already imported,
   * so a lever resolved from the import-time fold saw a clean environment and
   * pinned itself to the package literal — discarding the operator's variable
   * AND the committed tuning.json at once.
   */
  it('lets an explicitly-set env var win over the tuning object', () => {
    withEnv('MMR_LAMBDA', '0.7', () => {
      expect(resolveLevers({ MMR_LAMBDA: 0.5 }).MMR_LAMBDA).not.toBe(0.5)
      expect(resolveLevers({ MMR_LAMBDA: 0.5 }).MMR_LAMBDA).toBe(0.7)
      // One env var suspends one lever, not the whole tuning file.
      expect(resolveLevers({ MMR_LAMBDA: 0.5, GATE_K: 9 }).GATE_K).toBe(9)
    })
    expect(resolveLevers({ MMR_LAMBDA: 0.5 }).MMR_LAMBDA).toBe(0.5)
  })

  /**
   * A typo in a sweep script must not pin the corpus to our defaults while
   * looking exactly like a tuning file that did nothing — and it must never
   * resolve to NaN, which would take every downstream comparison with it.
   */
  it('falls through an unparseable env value to the tuning object, not to NaN', () => {
    for (const junk of ['high', '', 'null']) {
      withEnv('GATE_K', junk, () => {
        expect(resolveLevers({ GATE_K: 7 }).GATE_K).toBe(7)
        expect(resolveLevers().GATE_K).toBe(LITERALS.GATE_K)
      })
    }
  })

  it('reads only the eight lever names — a smuggled threshold resolves to nothing', () => {
    const t = resolveLevers({ tau: 0.01, tauLexical: 0.01, wDense: 1, GATE_K: 6 })
    expect(t.GATE_K).toBe(6)
    expect(t.tau).toBeUndefined()
    expect(Object.keys(t).sort()).toEqual([...LEVER_NAMES].sort())
  })
})

describe('mmr — what the two ends of lambda mean', () => {
  // Three candidates; `a` and `b` are two sections of one page, so they are
  // maximally redundant with each other and not at all with `c`.
  const simTo = {
    query: (id) => ({ a: 0.9, b: 0.8, c: 0.1 })[id],
    pair: (x, y) => (x !== y && [x, y].every((i) => i === 'a' || i === 'b') ? 1 : 0),
  }

  it('at lambda 1.0 orders by relevance alone and keeps the redundant pair', () => {
    expect(mmr(['a', 'b', 'c'], simTo, 2, 1.0)).toEqual(['a', 'b'])
    expect(mmr(['c', 'b', 'a'], simTo, 3, 1.0)).toEqual(['a', 'b', 'c'])
  })

  it('at lambda 0 the redundancy penalty evicts the same-page candidate', () => {
    // Relevance is out of the score entirely, so the second slot goes to the
    // only candidate that is not a second section of the page already picked —
    // even though it is the least relevant of the three.
    expect(mmr(['a', 'b', 'c'], simTo, 2, 0)).toEqual(['a', 'c'])
  })

  it('defaults to the module lambda when none is passed', () => {
    expect(mmr(['a', 'b', 'c'], simTo, 2)).toEqual(mmr(['a', 'b', 'c'], simTo, 2, 1.0))
  })
})

describe('createRetrieval — the gate k arrives per instance', () => {
  const DIMS = 8
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

  const axis = (i) => {
    const v = new Array(DIMS).fill(0)
    v[i] = 127
    return v
  }

  let leverFixtures = 0
  const makeIndex = (rows) => {
    const hash = `levers-${++leverFixtures}`
    const vectors = new Int8Array(rows.length * DIMS)
    rows.forEach((r, i) => vectors.set(r.vec, i * DIMS))
    const chunks = rows.map(({ vec, ...c }) => ({ ...c }))
    const paths = [...new Set(chunks.map((c) => c.path))]
    return assembleIndex({
      manifest: {
        version: 3,
        hash,
        embedModel: 'test',
        dims: DIMS,
        chunkCount: chunks.length,
        vectors: `vectors.${hash}.bin`,
        pages: paths.map((p) => ({ path: p, title: `Page ${p}`, tail: 'Docs' })),
        guard: GUARD,
      },
      shards: [chunks],
      vectorBuffer: vectors.buffer,
      dfDoc: { df: {} },
    })
  }

  // Six pages, every one of them lexically and densely reachable from the same
  // question, so the fused pool is always six and the only thing deciding how
  // many excerpts come back is k.
  const CORPUS = () =>
    ['a', 'b', 'c', 'd', 'e', 'f'].map((letter, i) => ({
      id: `${letter}#one`,
      path: `/${letter}`,
      anchor: 'one',
      title: `Page ${letter.toUpperCase()}`,
      breadcrumb: 'Docs',
      kind: 'guide',
      text: `The ${letter} widget is configured with a manifest and a token. `.repeat(12),
      prev: null,
      next: null,
      vec: axis(i),
    }))

  const ALL = { kind: 'all', paths: [], label: 'All docs' }
  const ASK = { question: 'how is the widget configured with a token?', queryVec: axis(0) }

  const primed = (tuning) =>
    createRetrieval({ index: makeIndex(CORPUS()), scope: ALL, guard: GUARD, tuning }).evaluate(ASK)
      .chunks.length

  it('primes the gate with GATE_K excerpts, and with the literal when untuned', () => {
    expect(primed(null)).toBe(5)
    expect(primed(undefined)).toBe(5)
  })

  it('primes more or fewer excerpts when the manifest carries a tuned GATE_K', () => {
    expect(primed({ GATE_K: 2 })).toBe(2)
    expect(primed({ GATE_K: 3 })).toBe(3)
    expect(primed({ GATE_K: 6 })).toBe(6)
  })

  /**
   * The model's own k is NOT this lever. It is a tool argument clamped 1..8 —
   * a model-facing contract, not something a corpus sweep gets to move.
   */
  it('leaves the model-facing tool clamp alone', () => {
    const r = createRetrieval({
      index: makeIndex(CORPUS()),
      scope: ALL,
      guard: GUARD,
      tuning: { GATE_K: 2 },
    })
    expect(r.search({ query: 'widget token', queryVec: axis(0), k: 4 }).length).toBe(4)
    expect(r.search({ query: 'widget token', queryVec: axis(0), k: 99 }).length).toBe(6)
    expect(r.search({ query: 'widget token', queryVec: axis(0), k: 0 }).length).toBe(1)
  })

  it('a tuned FUSED narrows the pool the gate can draw from', () => {
    const r = createRetrieval({
      index: makeIndex(CORPUS()),
      scope: ALL,
      guard: GUARD,
      tuning: { FUSED: 2, GATE_K: 6 },
    })
    expect(r.evaluate(ASK).chunks.length).toBe(2)
  })
})


// ─── merged from tests-levels-consumers.js ───
// ── imports: these two lines belong in the header of test/docpilot.test.js.
// `fs`, `os`, `path` and `vi` are already imported there — do not add them again.


/**
 * The level field only pays for itself if the things that READ reports refuse to
 * compare across pools — a `--level=low` run and a full one measure different
 * question lists, so every delta between them is attributed to whatever was
 * changed in between and none of it is real.
 */
describe('golden-set levels — report comparability and lint (W3 consumers)', () => {
  const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-levels-'))

  const meta = (over = {}) => ({
    indexHash: 'abc12345',
    model: 'm1',
    provider: 'ollama',
    promptHash: 'p1',
    records: 60,
    maxIterations: 4,
    chunkCount: 100,
    embedModel: 'e5',
    numCtx: 8192,
    fallback: false,
    thinkSupported: true,
    levers: { MMR_LAMBDA: 0.7 },
    guard: {
      denseMode: 'cosine',
      tau: 0.42,
      tauLexical: 0.21,
      source: 'calibrated',
      calibratedAt: 'abc12345',
    },
    ...over,
  })
  const summary = (over = {}) => ({ retrievalF1: 0.5, hallucinated: 0, misses: [], ...over })

  /** A report already on disk. `mtime` is explicit so "newest" is not a race. */
  const put = (dir, name, m, mtime = 1e9) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, JSON.stringify({ meta: m, summary: summary() }))
    fs.utimesSync(p, mtime, mtime)
    return p
  }

  /** writeReport prints; the suite does not need to read it. */
  const quietly = (fn) => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      return fn()
    } finally {
      spy.mockRestore()
    }
  }

  it('never pairs two reports that measured different pools', () => {
    const dir = fresh()
    put(dir, 'report-abc12345-m1-smoke.json', meta({ level: 'low', records: 10 }))

    expect(previousReport(dir, meta({ level: 'ultra' }))).toBeNull()
    expect(previousReport(dir, meta({ level: 'max' }))).toBeNull()
    expect(previousReport(dir, meta({ level: 'low', records: 10 })).meta.level).toBe('low')
  })

  // The single highest-risk line in the feature: every report ever written
  // predates `meta.level` and every one of them measured the whole set. Read the
  // absence as anything but `ultra` and the comparison history of every existing
  // consumer goes dark on the upgrade — silently, because a report with no
  // "changes since the previous run" section looks like the first run of a new
  // index.
  it('reads a report with no meta.level as the full set, so history survives', () => {
    const dir = fresh()
    const legacy = meta()
    delete legacy.level
    put(dir, 'report-abc12345-m1-legacy.json', legacy)

    expect(previousReport(dir, meta({ level: 'ultra' }))).not.toBeNull()
    // and the same file is invisible to a filtered run, which is the point
    expect(previousReport(dir, meta({ level: 'high' }))).toBeNull()
  })

  it('still calls a golden set that grew inside one level incomparable', () => {
    const dir = fresh()
    put(dir, 'report-abc12345-m1-old.json', meta({ level: 'low', records: 10 }), 1e9)

    const name = 'report-abc12345-m1-new.json'
    quietly(() =>
      writeReport({
        dir,
        name,
        meta: meta({ level: 'low', records: 12 }),
        summary: summary(),
        rows: [],
      }),
    )
    const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    expect(doc.incomparable).toContain('Golden changed: 10 → 12 records')
  })

  it('does not report a cross-level run as a mismatched sibling', () => {
    const dir = fresh()
    // Same index, same prompt, same record COUNT — different pool. Without the
    // level skip this reads as three comparable models measured on two different
    // question lists.
    put(dir, 'report-abc12345-m2-other.json', meta({ model: 'm2', level: 'medium', numCtx: 2048 }))

    const run = (name, m) => {
      quietly(() => writeReport({ dir, name, meta: m, summary: summary(), rows: [] }))
      return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).incomparable
    }

    const across = run('report-abc12345-m1-a.json', meta({ level: 'ultra' }))
    expect(across.some((l) => l.startsWith('Not comparable with'))).toBe(false)

    // …while inside the same pool the num_ctx mismatch is still reported, so the
    // skip above is a partition and not a silencer.
    const within = run('report-abc12345-m1-b.json', meta({ level: 'medium' }))
    expect(within.some((l) => l.includes('Not comparable with m2') && l.includes('num_ctx'))).toBe(true)
  })

  describe('lint', () => {
    const index = { ids: new Set(['guide/a#x']), pages: new Set(['/guide/a']), indexHash: 'abc12345' }
    const negative = (over = {}) => ({ id: 'n-01', question: 'who?', expect: 'refuse:no-evidence', ...over })
    const lint = (rec) => lintRecords([rec], index)

    it('errors on a level that is not one of the six, and names all six', () => {
      const { errors, warnings } = lint(negative({ level: 'smoke' }))
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('n-01')
      expect(errors[0]).toContain('level "smoke"')
      expect(errors[0]).toContain('low | medium | high | xhigh | max | ultra')
      expect(warnings).toEqual([])
    })

    // Every golden file in the wild lacks the field. If this were an error the
    // upgrade would fail lint for every consumer before it fixed anything.
    it('warns on an absent level and lints green', () => {
      const { errors, warnings } = lint(negative())
      expect(errors).toEqual([])
      expect(warnings).toEqual(['n-01: no level — runs as "high"'])
    })

    it('says nothing about a level that is one of the six', () => {
      const { errors, warnings } = lint(negative({ level: 'low' }))
      expect(errors).toEqual([])
      expect(warnings).toEqual([])
    })

    it('summarises the tiers as pool sizes, not as counts', () => {
      const at = (level, n) => Array.from({ length: n }, () => ({ level }))
      expect(levelSummary([...at('low', 10), ...at('medium', 15), ...at('high', 35)]))
        .toBe('low 10 (+10) · medium 25 (+15) · high 60 (+35) · ultra 60')
      // a legacy file: 60 unlabelled records are the `high` pool, and `ultra`
      // still prints, because it is what a run with no --level scores
      expect(levelSummary([{}, {}, {}])).toBe('high 3 (+3) · ultra 3')
      expect(levelSummary([])).toBe('ultra 0')
      // a stray tier sits in EVERY pool, so it is inside both numbers below and
      // named once more on its own
      expect(levelSummary([{ level: 'low' }, { level: 'nope' }])).toBe('low 2 (+1) · ultra 2 · unknown 1')
    })
  })
})


// ─── merged from tests-tuning-channel.js ───
/**
 * W4b — the tuning artifact channel. Paste into test/docpilot.test.js.
 *
 * `fs`, `os` and `path` come from the host file's own imports (top of
 * docpilot.test.js); everything under src/ is imported dynamically inside the
 * tests so this block carries no import statements of its own.
 */

describe('tuning — what the build inlines from tuning.json (RAG-SPEC 7)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-tuning-'))
  const write = (doc) => {
    const p = path.join(dir, 't.json')
    fs.writeFileSync(p, JSON.stringify(doc))
    return p
  }
  const tuned = (over = {}) => ({
    version: 1,
    tunedAt: 'abc12345',
    embedModel: 'bge-m3',
    level: 'high',
    records: 60,
    levers: { MMR_LAMBDA: 0.9, GATE_K: 8 },
    ...over,
  })
  // Every call collects its own warnings, because "said nothing at all" is a
  // behaviour this channel is specified on: a site that never ran `docpilot
  // tune` is not misconfigured and must not be warned at it on every build.
  const run = async (hash, doc, opts = {}) => {
    const { tuningFor } = await import('../src/build/build-rag-index.js')
    const warnings = []
    const notes = []
    const out = tuningFor(hash, {
      file: doc === null ? path.join(dir, 'nothing-here.json') : write(doc),
      embedModel: 'bge-m3',
      warn: (m) => warnings.push(m),
      note: (m) => notes.push(m),
      ...opts,
    })
    return { out, warnings: warnings.join(' '), notes: notes.join(' '), count: warnings.length }
  }

  it('inlines the allowlisted levers when tunedAt matches the hash being built', async () => {
    const { out, notes } = await run('abc12345', tuned())
    expect(out).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' })
    // The note is where an operator reads which numbers this build is shipping.
    expect(notes).toContain('GATE_K 8')
  })

  it('says nothing at all when there is no tuning.json — it is optional, the guard is not', async () => {
    const { out, count } = await run('abc12345', null)
    expect(out).toBeNull()
    expect(count).toBe(0)
  })

  it('refuses a tuning measured on another index, and names both hashes', async () => {
    const { out, warnings } = await run('deadbeef', tuned())
    expect(out).toBeNull()
    expect(warnings).toContain('abc12345')
    expect(warnings).toContain('deadbeef')
  })

  /**
   * The chunk hash covers the CORPUS — sha256 over chunk text — so an embedder
   * swap leaves it identical while every cosine underneath it moves. MMR_LAMBDA
   * weighs relevance against similarity in that vector space, so a lambda swept
   * on bge-m3 describes nothing about text-embedding-3-small.
   */
  it('refuses a tuning swept with a different embedding model', async () => {
    const swapped = await run('abc12345', tuned(), { embedModel: 'text-embedding-3-small' })
    expect(swapped.out).toBeNull()
    expect(swapped.warnings).toContain('bge-m3')
    expect(swapped.warnings).toContain('text-embedding-3-small')
    // …and the same file is still accepted by the embedder that swept it.
    expect((await run('abc12345', tuned())).out.GATE_K).toBe(8)
  })

  /**
   * `docpilot tune` on a vectorless index writes `embedModel: null`, which must
   * pair with the vectorless build that produced it and with nothing else — a
   * lexical-only sweep never scored a cosine, so it has no opinion about lambda.
   */
  it('pairs a vectorless tuning with a vectorless build and no other', async () => {
    const doc = tuned({ embedModel: null })
    expect((await run('abc12345', doc, { embedModel: null })).out.GATE_K).toBe(8)
    expect((await run('abc12345', doc, { embedModel: 'bge-m3' })).out).toBeNull()
  })

  /**
   * The structural half of "thresholds are calibrate's, levers are tune's".
   * A hand-edited tuning.json rides into the same manifest the guard rides in,
   * so a `tau` in there must not be able to move a refusal threshold — and the
   * levers beside it are still good measurements, so the file is not thrown away
   * over one smuggled key.
   */
  it('drops a smuggled guard threshold loudly and keeps the real levers', async () => {
    const { out, warnings } = await run(
      'abc12345',
      tuned({ levers: { MMR_LAMBDA: 0.9, GATE_K: 8, tau: 0.05, wLexical: 0.9 } }),
    )
    expect(out.tau).toBeUndefined()
    expect(out.wLexical).toBeUndefined()
    expect(out).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' })
    expect(warnings).toContain('tau')
    expect(warnings).toContain('calibrate')
  })

  it('lets nothing through that resolveLevers would not read', async () => {
    const { LEVER_NAMES } = await import('../src/theme/docpilot/retriever.js')
    const { out } = await run(
      'abc12345',
      tuned({ levers: { MMR_LAMBDA: 0.9, GATE_K: 8, tauLexical: 0.9, denseMode: 'zscore' } }),
    )
    for (const key of Object.keys(out)) {
      if (key === 'source' || key === 'tunedAt') continue
      expect(LEVER_NAMES, key).toContain(key)
    }
  })

  // `resolveLevers` reads `tuning?.[name] ?? FALLBACK[name]`, which only rejects
  // null and undefined: a string would ride through and turn every comparison it
  // touches into NaN, in the browser, where there is nobody to tell.
  it('drops a lever that is not a number', async () => {
    const { out, warnings } = await run('abc12345', tuned({ levers: { MMR_LAMBDA: '0.9', GATE_K: 8 } }))
    expect(out).toEqual({ GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' })
    expect(warnings).toContain('MMR_LAMBDA')
  })

  it('refuses a document whose version it does not read', async () => {
    expect((await run('abc12345', tuned({ version: 2 }))).out).toBeNull()
  })

  it('survives a corrupt tuning file', async () => {
    const { tuningFor } = await import('../src/build/build-rag-index.js')
    const p = path.join(dir, 'bad.json')
    fs.writeFileSync(p, '{ not json')
    const warnings = []
    expect(tuningFor('abc12345', { file: p, embedModel: 'bge-m3', warn: (m) => warnings.push(m), note: () => {} })).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  // `source: 'tuned'` on an empty object would be a claim that this corpus was
  // measured while every value resolved to the module literal anyway.
  it('returns null rather than an empty tuning when nothing survives the allowlist', async () => {
    expect((await run('abc12345', tuned({ levers: { tau: 0.1 } }))).out).toBeNull()
    expect((await run('abc12345', tuned({ levers: {} }))).out).toBeNull()
  })
})

describe('tuning — config topK over the manifest levers', () => {
  const levers = async (topK, manifestTuning) => {
    const s = await import('../src/theme/docpilot/session.js')
    s.configure({ docPilot: topK === undefined ? {} : { topK } })
    s.state.index = manifestTuning === undefined ? null : { manifest: { tuning: manifestTuning } }
    return s.tuning.value
  }
  const TUNED = { MMR_LAMBDA: 0.9, GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' }

  afterEach(async () => {
    const s = await import('../src/theme/docpilot/session.js')
    s.state.index = null
    s.configure({ docPilot: {} })
  })

  it('passes the manifest levers through untouched when topK is unset', async () => {
    expect(await levers(undefined, TUNED)).toEqual(TUNED)
    // The documented default is null, so an author who wrote it out by hand gets
    // the same answer as one who left the key alone.
    expect(await levers(null, TUNED)).toEqual(TUNED)
  })

  it('lets a hand-set topK override the measured GATE_K and stamps source config', async () => {
    const t = await levers(7, TUNED)
    expect(t.GATE_K).toBe(7)
    // Only the k is the author's; a lambda they never measured stays measured.
    expect(t.MMR_LAMBDA).toBe(0.9)
    expect(t.source).toBe('config')
    expect(t.tunedAt).toBe('abc12345')
  })

  it('clamps topK to the swept band at both ends', async () => {
    expect((await levers(99, TUNED)).GATE_K).toBe(12)
    expect((await levers(0, TUNED)).GATE_K).toBe(1)
    expect((await levers(-4, TUNED)).GATE_K).toBe(1)
    // A fractional k slices to an integer anyway; it must not be reported as one
    // thing and applied as another.
    expect((await levers(3.6, TUNED)).GATE_K).toBe(4)
  })

  it('is null with no manifest tuning and no topK, so the retriever keeps its literals', async () => {
    expect(await levers(undefined, undefined)).toBeNull()
    expect(await levers(undefined, null)).toBeNull()
  })

  it('is a config-only tuning when the author sets topK on an untuned index', async () => {
    expect(await levers(4, null)).toEqual({ GATE_K: 4, source: 'config' })
  })

  it('resolves to a GATE_K the retriever actually reads', async () => {
    const { resolveLevers } = await import('../src/theme/docpilot/retriever.js')
    expect(resolveLevers(await levers(4, TUNED)).GATE_K).toBe(4)
    expect(resolveLevers(await levers(undefined, TUNED)).MMR_LAMBDA).toBe(0.9)
    expect(resolveLevers(await levers(undefined, null)).GATE_K).toBe(5)
  })
})


// ─── merged from tests-run-level.js ───
describe('eval run.js — --level and the lever fingerprint', () => {
  /**
   * A fresh module graph per case, and the env has to still be set when the
   * assertion runs.
   *
   * `resolveLevers` reads its env layer out of `process.env` at CALL time, so a
   * variable set after the module graph is imported still wins — which is the
   * whole point, since every entry point loads `.env.local` after its imports.
   * The reset is here because run.js itself reads argv and env at module scope:
   * the fingerprint under test is built during import, not during the call.
   */
  const withRun = async (env, fn) => {
    const before = {}
    for (const [k, v] of Object.entries(env)) {
      before[k] = process.env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.resetModules()
    try {
      return await fn(await import('../src/eval/run.js'))
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      // So the next dynamic importer folds the real environment rather than
      // whatever this case pinned.
      vi.resetModules()
    }
  }

  /** The hash run.js names every report with — computed the way run.js does. */
  const promptHashOfThisProject = async () => {
    const { promptHash } = await import('../src/theme/docpilot/prompt.js')
    const { settings } = await import('../src/cli-context.js')
    return promptHash(settings.prompt, settings.product)
  }

  const NAMED = { indexHash: 'abc123', model: 'qwen3:8b', vectorlessIndex: false }

  it('leaves an unfiltered run under exactly the name it has always had', async () => {
    // The reason `ultra` adds no segment: every report already on disk was
    // written under this name, and `previousReport` pairs a run with its
    // predecessor by filename. A segment here would end every history on the day
    // levels landed.
    await withRun({}, async ({ reportName }) => {
      const hash = await promptHashOfThisProject()
      expect(reportName({ ...NAMED, level: 'ultra' })).toBe(`report-abc123-qwen3_8b-${hash}.json`)
      // Same for a caller that passes no level at all.
      expect(reportName(NAMED)).toBe(`report-abc123-qwen3_8b-${hash}.json`)
    })
  })

  it('files a narrowed run apart, with the prompt hash still last', async () => {
    await withRun({}, async ({ reportName }) => {
      const hash = await promptHashOfThisProject()
      expect(reportName({ ...NAMED, level: 'medium' })).toBe(
        `report-abc123-qwen3_8b-lvl-medium-${hash}.json`,
      )
      // The level joins the other run-shape segments rather than displacing one.
      expect(reportName({ indexHash: 'h', model: 'm', vectorlessIndex: true, level: 'low' })).toBe(
        `report-h-m-novec-lvl-low-${hash}.json`,
      )
    })
  })

  it('reports the levers the manifest actually tuned, not the package defaults', async () => {
    await withRun({ DOCPILOT_GATE_K: undefined, DOCPILOT_MMR_LAMBDA: undefined }, ({ leverFingerprint }) => {
      const base = leverFingerprint(null)
      const tuned = leverFingerprint({ GATE_K: base.GATE_K + 3, MMR_LAMBDA: 0.42 })
      expect(tuned.GATE_K).toBe(base.GATE_K + 3)
      expect(tuned.MMR_LAMBDA).toBe(0.42)
      // A lever the tuning file says nothing about keeps the shipped value.
      expect(tuned.CANDIDATES).toBe(base.CANDIDATES)
      expect(tuned.RRF_K).toBe(base.RRF_K)
    })
  })

  it('refuses a guard threshold that reached the tuning object', async () => {
    // Only calibrate may set tau. A report that fingerprinted one would say a
    // threshold was in force that the guard never agreed to.
    await withRun({}, ({ leverFingerprint }) => {
      const fp = leverFingerprint({ tau: 0.9, tauLexical: 0.4, GATE_K: 6 })
      expect(fp).not.toHaveProperty('tau')
      expect(fp).not.toHaveProperty('tauLexical')
      expect(fp.GATE_K).toBe(6)
    })
  })

  it('lets an env override outrank the manifest, the way the retriever does', async () => {
    // A sweep running on this shell is the newest statement about a lever, and
    // the run really does use it — so the report has to say so.
    await withRun({ DOCPILOT_GATE_K: '9' }, ({ leverFingerprint }) => {
      expect(leverFingerprint({ GATE_K: 6 }).GATE_K).toBe(9)
      expect(leverFingerprint(null).GATE_K).toBe(9)
    })
  })

  it('serialises to one string whatever order the tuning keys arrive in', async () => {
    // report.js raises `Levers changed` on a JSON string mismatch, so key order
    // is load-bearing: two runs on identical levers must not read as different
    // measurements because a hand-edited tuning.json listed them differently.
    await withRun({}, ({ leverFingerprint }) => {
      const a = leverFingerprint({ GATE_K: 7, MMR_LAMBDA: 0.8 })
      const b = leverFingerprint({ MMR_LAMBDA: 0.8, GATE_K: 7 })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))

      const keys = Object.keys(a)
      expect(keys).toEqual([...keys].sort())
      // The key SET does not depend on the tuning object either — an absent
      // lever is still fingerprinted, at the value that was used.
      expect(Object.keys(leverFingerprint(null))).toEqual(keys)
      expect(keys).toContain('maxIterations')
      expect(keys).toContain('numCtx')
    })
  })

  it('selects the pool before --limit truncates it', async () => {
    // The composition run.js performs, in the order it performs it. Reversed,
    // `--level=low --limit=2` would take the first two records OF THE FILE and
    // keep whichever of those happen to be `low` — here, none of them — and
    // report a pool that was never the pool.
    const { filterByLevel } = await import('../src/eval/levels.js')
    const golden = [
      { id: 'a' },
      { id: 'b', level: 'high' },
      { id: 'c', level: 'low' },
      { id: 'd', level: 'low' },
    ]
    expect(filterByLevel(golden, 'low').slice(0, 2).map((r) => r.id)).toEqual(['c', 'd'])
    expect(golden.slice(0, 2).filter((r) => r.level === 'low')).toHaveLength(0)
    // A set authored before levels existed is whole at `high` and empty below
    // it — which is what run.js's empty-pool message names as the likely cause.
    expect(filterByLevel([{ id: 'a' }, { id: 'b' }], 'medium')).toHaveLength(0)
    expect(filterByLevel([{ id: 'a' }, { id: 'b' }], 'high')).toHaveLength(2)
  })
})


// ─── merged from tests-tune.js ───
// MERGE NOTE — the host file needs two import lines this block does not carry:
//   import { parseRange, chooseCell, buildTuningDoc } from '../src/eval/tune.js'
//   and `tuningFor` added to the existing `../src/build/build-rag-index.js` import
//   (which already brings in `guardFor`).
// `fs`, `os` and `path` are already imported by test/docpilot.test.js.
describe('docpilot tune — the pure half of the lever sweep', () => {
  /**
   * The grid parser. Every one of these is a flag a person types, and the
   * failure mode of a lenient parser here is not an exception — it is a two
   * minute sweep over a grid nobody asked for, whose winner then gets committed
   * and inlined into a bundle.
   */
  describe('parseRange', () => {
    it('reads lo:hi:step, and its own documented default lands on hi', () => {
      const l = parseRange('0.5:1.0:0.05', { name: 'lambda', step: 0.05, min: 0, max: 1 })
      expect(l.length).toBe(11)
      expect(l[0]).toBe(0.5)
      // 0.5 + 10 × 0.05 is 0.9999999999999999 in binary floating point, so an
      // exact `<= hi` on an unrounded accumulator drops the top row of the
      // default grid — the value the whole command exists to be able to choose.
      expect(l[l.length - 1]).toBe(1)
      expect(l).toContain(0.85)
    })

    it('reads lo:hi with the axis default step', () => {
      expect(parseRange('4:12', { name: 'k', step: 1, min: 1, max: 12, integer: true })).toEqual([
        4, 5, 6, 7, 8, 9, 10, 11, 12,
      ])
      expect(parseRange('4:12:2', { name: 'k', step: 1, min: 1, max: 12, integer: true })).toEqual([
        4, 6, 8, 10, 12,
      ])
    })

    it('reads a bare lo as a one-point axis — the way one lever is pinned', () => {
      expect(parseRange('0.9', { name: 'lambda', step: 0.05, min: 0, max: 1 })).toEqual([0.9])
    })

    it('never yields a point outside lo..hi, even when the step overshoots', () => {
      const v = parseRange('4:11:2', { name: 'k', step: 1, min: 1, max: 12, integer: true })
      expect(v).toEqual([4, 6, 8, 10])
    })

    it('throws on every malformed spelling instead of falling back to a default', () => {
      const bad = (raw, opts = {}) =>
        expect(() => parseRange(raw, { name: 'lambda', step: 0.05, min: 0, max: 1, ...opts })).toThrow()
      bad('a:b')
      bad('')
      bad(undefined)
      bad('0.5:')
      bad('0.5:1.0:0.05:2')
      bad('0.5:1.0:0') // a zero step is an infinite grid
      bad('0.5:1.0:-0.05')
      bad('1.0:0.5') // hi below lo
      bad('0.5:1.5') // above max
      bad('-0.5:1.0') // below min
      bad('4:12:0.5', { name: 'k', step: 1, min: 1, max: 12, integer: true })
    })

    it('names the flag and the fix in the message, not just the fault', () => {
      let msg = ''
      try {
        parseRange('4:13', { name: 'k', step: 1, min: 1, max: 12, integer: true, example: '4:12' })
      } catch (e) {
        msg = e.message
      }
      expect(msg).toContain('[docpilot] --k=')
      expect(msg).toContain('1..12')
      expect(msg).toContain('--k=4:12')
    })

    it('refuses a grid so fine it is a sweep, rather than running it', () => {
      expect(() => parseRange('0:1:0.001', { name: 'lambda', min: 0, max: 1 })).toThrow(/1001|sweep/)
    })
  })

  /**
   * The chooser. Four rules in order, and the fourth one exists to stop a tie
   * churning a committed file, a rebuilt index and a redeployed bundle.
   */
  describe('chooseCell', () => {
    const cell = (MMR_LAMBDA, GATE_K, retrievalF1, recall8 = 0.5, mrr = 0.5) => ({
      MMR_LAMBDA,
      GATE_K,
      retrievalF1,
      recall8,
      mrr,
    })
    const base = { MMR_LAMBDA: 1, GATE_K: 5 }

    it('takes the argmax of mean retrieval F1', () => {
      const c = chooseCell([cell(0.5, 4, 0.31), cell(0.9, 8, 0.44), cell(1, 5, 0.4)], base)
      expect([c.MMR_LAMBDA, c.GATE_K]).toEqual([0.9, 8])
    })

    it('breaks an F1 tie on recall@8', () => {
      const c = chooseCell([cell(0.5, 4, 0.4, 0.8), cell(0.9, 8, 0.4, 0.9)], base)
      expect(c.MMR_LAMBDA).toBe(0.9)
    })

    it('breaks an F1 + recall tie on MRR', () => {
      const c = chooseCell([cell(0.5, 4, 0.4, 0.8, 0.6), cell(0.9, 8, 0.4, 0.8, 0.7)], base)
      expect(c.MMR_LAMBDA).toBe(0.9)
    })

    it('breaks a total tie towards the levers already in force', () => {
      const cells = [cell(0.5, 4, 0.4), cell(0.95, 5, 0.4), cell(0.7, 12, 0.4)]
      const c = chooseCell(cells, base)
      expect([c.MMR_LAMBDA, c.GATE_K]).toEqual([0.95, 5])
    })

    it('normalises the two axes, or k (span 8) drowns lambda (span 0.5)', () => {
      // Over the documented grid λ spans 0.5 and k spans 8, so a raw
      // `|Δλ| + |Δk|` is sixteen times more sensitive to k. Against the baseline
      // (0.5, 4) below, the whole λ axis end to end scores 0.5 while THREE steps
      // of k score 6 — so unnormalised, "nearest" degenerates into "same k, any
      // lambda", and it would keep λ 1.0 over a cell one third of the k axis
      // away. Per-axis, the k move is the smaller one and wins.
      const cells = [cell(1, 4, 0.4), cell(0.5, 10, 0.4), cell(1, 12, 0.3)]
      const c = chooseCell(cells, { MMR_LAMBDA: 0.5, GATE_K: 4 })
      expect([c.MMR_LAMBDA, c.GATE_K]).toEqual([0.5, 10])
    })

    it('treats float noise as a tie, so nothing moves for a difference of zero', () => {
      const cells = [cell(1, 5, 0.4), cell(0.5, 12, 0.4 + 1e-13)]
      const c = chooseCell(cells, base)
      expect([c.MMR_LAMBDA, c.GATE_K]).toEqual([1, 5])
    })

    it('lets a real difference beat the stability preference', () => {
      const cells = [cell(1, 5, 0.4), cell(0.5, 12, 0.41)]
      expect(chooseCell(cells, base).MMR_LAMBDA).toBe(0.5)
    })

    it('ranks an unmeasurable cell below every measured one', () => {
      const cells = [cell(0.5, 4, null, null, null), cell(0.9, 8, 0.01)]
      expect(chooseCell(cells, base).MMR_LAMBDA).toBe(0.9)
      // and it still answers when NOTHING was measurable, rather than throwing
      expect(chooseCell([cell(0.5, 4, null, null, null)], base).MMR_LAMBDA).toBe(0.5)
    })

    it('keeps grid order on a full tie, so two runs of one sweep agree', () => {
      const cells = [cell(0.5, 4, 0.4), cell(0.6, 6, 0.4)]
      const off = { MMR_LAMBDA: 0.55, GATE_K: 5 } // equidistant from both
      expect(chooseCell(cells, off)).toBe(chooseCell(cells, off))
      expect(chooseCell(cells, off).MMR_LAMBDA).toBe(0.5)
    })

    it('returns null for an empty grid rather than a cell of undefineds', () => {
      expect(chooseCell([], base)).toBe(null)
    })
  })

  /**
   * The document, and the contract it has with `tuningFor()` on the other side
   * of `docpilot index`. A schema that only this file understands is a schema
   * that gets dropped at build time with a warning nobody reads.
   */
  describe('buildTuningDoc', () => {
    const chosen = {
      MMR_LAMBDA: 0.9,
      GATE_K: 8,
      retrievalF1: 0.4444444,
      recall8: 0.85,
      mrr: 0.7123456,
      n: 44,
    }
    const baseline = { MMR_LAMBDA: 1, GATE_K: 5, retrievalF1: 0.33, recall8: 0.8, mrr: 0.7 }
    const cells = [
      { MMR_LAMBDA: 0.9, GATE_K: 8, retrievalF1: 0.4444444, recall8: 0.85, mrr: 0.7123456 },
      { MMR_LAMBDA: 1, GATE_K: 5, retrievalF1: 0.33, recall8: 0.8, mrr: 0.7 },
    ]
    const doc = (over = {}) =>
      buildTuningDoc({
        indexHash: 'abc12345',
        embedModel: 'bge-m3',
        level: 'high',
        records: 60,
        chosen,
        baseline,
        cells,
        sweptAt: '2026-08-24T00:00:00.000Z',
        ...over,
      })

    it('writes the schema build-rag-index reads back', () => {
      const d = doc()
      expect(d.version).toBe(1)
      expect(d.tunedAt).toBe('abc12345')
      expect(d.embedModel).toBe('bge-m3')
      expect(d.level).toBe('high')
      expect(d.records).toBe(60)
      expect(d.levers).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8 })
      expect(d.sweptAt).toBe('2026-08-24T00:00:00.000Z')
    })

    it('carries only the two levers it measured, never the six it did not', () => {
      // The absent six are not an omission: a key here CLAIMS the number was
      // measured on this corpus, and writing `RRF_K` at its current value would
      // freeze an unmeasured constant into a consumer's manifest and make a
      // later change to the shipped default invisible.
      expect(Object.keys(doc().levers).sort()).toEqual(['GATE_K', 'MMR_LAMBDA'])
    })

    it('reports the chosen cell against the baseline it was measured beside', () => {
      const m = doc().metrics
      expect(m.retrievalF1).toBe(0.4444)
      expect(m.recall8).toBe(0.85)
      expect(m.mrr).toBe(0.7123)
      expect(m.n).toBe(44)
      expect(m.baseline).toEqual({
        MMR_LAMBDA: 1,
        GATE_K: 5,
        retrievalF1: 0.33,
        recall8: 0.8,
        mrr: 0.7,
      })
    })

    it('writes embedModel null on a vectorless sweep, so it can never cross', () => {
      // MMR_LAMBDA is cosine geometry. `tuningFor` compares embedModel strictly,
      // and null matches only the vectorless build this was measured on — which
      // is the point: a lambda measured over BM25 order describes nothing about
      // where an embedder puts its cosines.
      expect(doc({ embedModel: null }).embedModel).toBe(null)
      expect(doc({ embedModel: undefined }).embedModel).toBe(null)
    })

    it('rounds the grid, so a re-run that measured the same thing diffs empty', () => {
      const g = doc().grid
      expect(g).toHaveLength(2)
      expect(g[0]).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8, retrievalF1: 0.4444, recall8: 0.85, mrr: 0.7123 })
      // the grid is the shape of the surface; the levers are not re-rounded
      expect(g.some((c) => c.MMR_LAMBDA === 1 && c.GATE_K === 5)).toBe(true)
    })

    it('keeps a null metric null rather than rounding it to 0', () => {
      const d = doc({ chosen: { ...chosen, retrievalF1: null, recall8: null, mrr: null } })
      expect(d.metrics.retrievalF1).toBe(null)
      expect(d.metrics.recall8).toBe(null)
    })

    /**
     * The round trip. `tune` writes this file and `index` inlines it, and the
     * two are in different halves of the package — the only thing that keeps
     * them agreeing is a test that runs both.
     */
    it('is accepted by tuningFor and reaches the manifest as source "tuned"', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-tuning-'))
      const file = path.join(dir, 'tuning.json')
      fs.writeFileSync(file, JSON.stringify(doc()))
      const t = tuningFor('abc12345', {
        file,
        embedModel: 'bge-m3',
        warn: () => {},
        note: () => {},
      })
      expect(t).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' })

      // and the two rejections that matter, from the same document
      expect(tuningFor('deadbeef', { file, embedModel: 'bge-m3', warn: () => {}, note: () => {} })).toBe(null)
      expect(
        tuningFor('abc12345', { file, embedModel: 'text-embedding-3-small', warn: () => {}, note: () => {} }),
      ).toBe(null)
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('round-trips a vectorless sweep into a vectorless build and nothing else', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-tuning-'))
      const file = path.join(dir, 'tuning.json')
      fs.writeFileSync(file, JSON.stringify(doc({ embedModel: null })))
      const silent = { warn: () => {}, note: () => {} }
      expect(tuningFor('abc12345', { file, embedModel: null, ...silent })?.GATE_K).toBe(8)
      expect(tuningFor('abc12345', { file, embedModel: 'bge-m3', ...silent })).toBe(null)
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })
})


// ─── merged from tests-fixes.js ───
/**
 * Paste this block into test/docpilot.test.js, next to
 * `describe('chunker — block-aware splitting')`. The two imports above collapse
 * to nothing there: `chunkMarkdown` is already imported at the top of that file,
 * and `TUNING_OUT`/`CALIBRATION_OUT` come from `../src/cli-context.js`.
 */

/**
 * The block scanner asked the HEADER line to prove it was a table: leading pipe,
 * two or more columns. GFM asks neither. `a | b` over `--|--` is a table and so
 * is a one-column `| a |`, and both were read as prose — which means both could
 * be cut with no header re-emitted on the continuation, the exact defect the
 * block-aware splitter exists to remove. The proof is now the DELIMITER row
 * alone, and these tests pin both halves of that: the two forms it must now
 * accept, and the prose it must still refuse.
 */
describe('chunker — GFM table forms the block scanner has to recognise', () => {
  const chunk = (src) => chunkMarkdown({ src, path: '/p', kind: 'guide' })
  const cell = 'd'.repeat(200)

  /**
   * The outer pipes are optional in GFM, and a hand-written table is where they
   * go missing. Read as prose this splits at line boundaries like any paragraph,
   * and every part after the first is a grid of values with unnamed columns.
   */
  it('re-emits the header of a leading-pipe-less table split by the ceiling', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `r${i}-mark | ${cell}`)
    const { chunks, warnings } = chunk(`# P\n\n## T\n\ncol a | col b\n--|--\n${rows.join('\n')}`)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(8000)
      if (!/r\d+-mark \|/.test(c.text)) continue
      expect(c.text).toContain('col a | col b')
      expect(c.text.indexOf('--|--')).toBeLessThan(c.text.search(/r\d+-mark \|/))
    }
    expect(warnings).toContain('table split at row boundaries by MAX_CHUNK_CHARS in /p')
    // and the rows themselves survive whole, exactly once each
    for (const r of rows) expect(chunks.filter((c) => c.text.includes(r)).length).toBe(1)
  })

  /** A single-column table is a table. `width < 2` was a rule about layout HTML. */
  it('re-emits the header of a single-column table split by the ceiling', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| r${i}-mark ${cell} |`)
    const { chunks, warnings } = chunk(`# P\n\n## T\n\n| col a |\n| --- |\n${rows.join('\n')}`)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(8000)
      if (!/\| r\d+-mark /.test(c.text)) continue
      expect(c.text).toContain('| col a |')
      expect(c.text.indexOf('| --- |')).toBeLessThan(c.text.search(/\| r\d+-mark /))
    }
    expect(warnings).toContain('table split at row boundaries by MAX_CHUNK_CHARS in /p')
    for (const r of rows) expect(chunks.filter((c) => c.text.includes(r)).length).toBe(1)
  })

  /**
   * `html-to-md.js` writes `\|` for a pipe inside a cell. If the scanner counted
   * that as a separator, the header of a table this project imported itself would
   * be two cells wide against a two-cell delimiter and the pair would not match.
   */
  it('does not count an escaped pipe as a column boundary', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| r${i}-mark | ${cell} |`)
    const { chunks, warnings } = chunk(
      `# P\n\n## T\n\n| a \\| b | c |\n| --- | --- |\n${rows.join('\n')}`,
    )
    expect(warnings).toContain('table split at row boundaries by MAX_CHUNK_CHARS in /p')
    for (const c of chunks) {
      if (!/\| r\d+-mark \|/.test(c.text)) continue
      expect(c.text).toContain('| a \\| b | c |')
    }
  })

  /**
   * The false-positive that the widening had to not become. Both lines are prose;
   * the run of pipe-bearing lines under them is prose too. Were the pair read as
   * a header and a delimiter, that run would be swallowed as rows, the block
   * would go over the ceiling, and the first line would be stamped onto every
   * part as a column header — text the page never contained.
   *
   * Measured on the two real corpora (205 pages): dropping the pipe requirement
   * and the cell-count match from the delimiter turns 39 prose lines into table
   * headers. With both in place, block-for-block output is byte-identical.
   */
  it('does not read a pipe-bearing prose line over a dash-bearing one as a table', () => {
    const head = 'Run docpilot index | tee build.log before you ask anything'
    const dash = 'Then read the summary - it names every shard it wrote'
    const tail = Array.from({ length: 60 }, (_, i) => `Line ${i} mentions a | pipe and ${cell}`)
    const { chunks, warnings } = chunk(`# P\n\n## S\n\n${[head, dash, ...tail].join('\n')}`)

    expect(warnings.some((w) => w.includes('table'))).toBe(false)
    expect(chunks.filter((c) => c.text.includes(head)).length).toBe(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(8000)
  })

  /**
   * A setext heading is the commonest form of the same trap: one cell over one
   * all-dashes cell agrees on shape AND on count. The pipe requirement is the
   * only thing standing between `## Heading` written the underline way and a
   * table header.
   */
  it('leaves a setext heading a heading', () => {
    const tail = Array.from({ length: 60 }, (_, i) => `Line ${i} mentions a | pipe and ${cell}`)
    const { chunks, warnings } = chunk(`# P\n\n## S\n\nOverview\n---\n${tail.join('\n')}`)
    expect(warnings.some((w) => w.includes('table'))).toBe(false)
    expect(chunks.filter((c) => c.text.includes('Overview')).length).toBe(1)
  })

  /** Three columns over two delimiter cells is not a table in GFM and is not one here. */
  it('refuses a delimiter row whose cell count disagrees with the header', () => {
    const tail = Array.from({ length: 60 }, (_, i) => `| r${i}-mark | ${cell} |`)
    const { chunks, warnings } = chunk(
      `# P\n\n## S\n\n| a | b | c |\n| --- | --- |\n${tail.join('\n')}`,
    )
    expect(warnings.some((w) => w.includes('table'))).toBe(false)
    expect(chunks.filter((c) => c.text.includes('| a | b | c |')).length).toBe(1)
  })
})

/**
 * One path, one home. `docpilot tune` writes tuning.json and `docpilot index`
 * reads it back, and each end had derived the path for itself — the drift that
 * once made `index` report "no calibration" after every successful `calibrate`.
 */
describe('cli-context — the tuning path is stated once', () => {
  it('puts tuning.json beside calibration.json under the eval directory', () => {
    expect(TUNING_OUT.endsWith('/tuning.json')).toBe(true)
    expect(TUNING_OUT.replace(/tuning\.json$/, 'calibration.json')).toBe(CALIBRATION_OUT)
  })
})


// ─── merged from tests-fix-levers.js ───
// ─── merged from tests-fix-levers.js ───
// MERGE NOTE — this block needs NO new import lines. It uses `fs`, `os`, `path`,
// `vi`, `assembleIndex` and `LEVER_NAMES`, all of which test/docpilot.test.js
// already imports, and reaches everything else through `await import(...)`.
//
// MERGE NOTE 2 — the existing case `retrieval levers — the three-layer
// precedence › lets an explicitly-set env var win over the tuning object` PINS
// THE DEFECT these tests fix. Its second assertion,
//     expect(resolveLevers({ MMR_LAMBDA: 0.5 }).MMR_LAMBDA).toBe(LITERALS.MMR_LAMBDA)
// asserts that a set env var resolves to the MODULE LITERAL. That was the bug.
// It has to become `.toBe(0.7)` — the value the variable actually holds — and
// its docblock ("It resolves to the MODULE CONSTANT rather than to the string
// read here") has to go with it.

describe('resolveLevers — the env layer is read at CALL time', () => {
  const LITERALS = {
    RRF_K: 5,
    W_LEXICAL_RRF: 1.0,
    W_DENSE_RRF: 1.0,
    MMR_LAMBDA: 1.0,
    PAGE_CAP: 2,
    CANDIDATES: 30,
    FUSED: 12,
    EXPAND_BELOW_TOKENS: 150,
    GATE_K: 5,
    BM25_K: 1.2,
    BM25_B: 0.7,
    BM25_D: 0.5,
    BOOST_TITLE: 2,
    BOOST_BREADCRUMB: 1.5,
    BOOST_PATH: 1.0,
    BOOST_ANCHOR: 1.25,
  }

  /**
   * The `.env.local` ordering, reproduced exactly — and the reproduction IS the
   * test, because the defect was invisible under any other ordering.
   *
   * Every CLI entry point imports the module graph first and only then loads
   * `.env.local` into `process.env`. So: clear the variables, reset the module
   * registry, import (the constants fold a CLEAN environment, the way a real run
   * folds it), and only THEN set the variables. A test that sets them before the
   * import folds them into the constants too, and the two layers agree by
   * accident — which is precisely why the bug shipped.
   *
   * The suite is one process, so everything is restored on the way out including
   * when the assertion throws, and the registry is reset again so the next
   * dynamic importer folds the real environment rather than this case's.
   */
  const afterImport = async (env, fn) => {
    const names = Object.keys(env).map((n) => `DOCPILOT_${n}`)
    const before = {}
    for (const key of names) {
      before[key] = process.env[key]
      delete process.env[key]
    }
    vi.resetModules()
    try {
      const mod = await import('../src/theme/docpilot/retriever.js')
      // The fold has happened against a clean environment. NOW the file lands.
      for (const [n, v] of Object.entries(env)) process.env[`DOCPILOT_${n}`] = v
      return await fn(mod)
    } finally {
      for (const key of names) {
        if (before[key] === undefined) delete process.env[key]
        else process.env[key] = before[key]
      }
      vi.resetModules()
    }
  }

  it('lets a variable set after import win, and carries the value it actually read', async () => {
    // The defect: `envIsSet(name) ? FALLBACK[name] : …` checked `process.env` at
    // call time but ANSWERED out of constants folded at import time. With
    // `DOCPILOT_GATE_K=9` in `.env.local` — where every DocPilot doc says to put
    // it — the env layer went true the moment the file landed and resolved to 5,
    // discarding the env value AND the tuning object, and pinning the lever to
    // the package literal on the one path the documentation recommends.
    await afterImport({ MMR_LAMBDA: '0.7', GATE_K: '9' }, ({ resolveLevers }) => {
      const t = resolveLevers({ MMR_LAMBDA: 0.5, GATE_K: 3 })
      expect(t.MMR_LAMBDA).toBe(0.7)
      expect(t.GATE_K).toBe(9)
      // Not the literal, which is what it used to be — stated separately so a
      // regression names itself rather than reading as "0.7 !== 0.5".
      expect(t.MMR_LAMBDA).not.toBe(LITERALS.MMR_LAMBDA)
      expect(t.GATE_K).not.toBe(LITERALS.GATE_K)

      // With no tuning object at all it is still the env value, not the literal.
      expect(resolveLevers().GATE_K).toBe(9)
      expect(resolveLevers(null).MMR_LAMBDA).toBe(0.7)

      // One variable suspends one lever. The rest of the tuning file survives.
      expect(resolveLevers({ MMR_LAMBDA: 0.5, CANDIDATES: 40 }).CANDIDATES).toBe(40)
      expect(resolveLevers({ GATE_K: 3 }).RRF_K).toBe(LITERALS.RRF_K)
    })
  })

  it('reaches the running retrieval: the primed excerpt count follows the env', async () => {
    // `resolveLevers` returning the wrong number is only a defect because
    // something ranks on it. This is that something — the executed proof, at the
    // level a reader would notice: five excerpts primed the turn instead of ten.
    await afterImport({ GATE_K: '10' }, async ({ createRetrieval }) => {
      const { assembleIndex } = await import('../src/theme/docpilot/store.js')
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
      const letters = 'abcdefghijkl'.split('')
      const chunks = letters.map((letter) => ({
        id: `${letter}#one`,
        path: `/${letter}`,
        anchor: 'one',
        title: `Page ${letter.toUpperCase()}`,
        breadcrumb: 'Docs',
        kind: 'guide',
        // Long enough that `sectionExpand` never fires, so the count below is
        // exactly GATE_K and not GATE_K plus whatever expansion added.
        text: `The ${letter} widget is configured with a manifest and a token. `.repeat(12),
        prev: null,
        next: null,
      }))
      const index = assembleIndex({
        manifest: {
          version: 3,
          hash: 'env-gate-k',
          embedModel: null,
          dims: null,
          chunkCount: chunks.length,
          vectors: null,
          pages: letters.map((l) => ({ path: `/${l}`, title: `Page ${l}`, tail: 'Docs' })),
          guard: GUARD,
        },
        shards: [chunks],
        vectorBuffer: null,
        dfDoc: { df: {} },
      })
      const primed = (tuning) =>
        createRetrieval({
          index,
          scope: { kind: 'all', paths: [], label: 'All docs' },
          guard: GUARD,
          tuning,
        }).evaluate({ question: 'how is the widget configured with a token?' }).chunks.length

      // Before the fix this was 5 — GATE_K's module literal — for both calls.
      expect(primed({ GATE_K: 3 })).toBe(10)
      expect(primed(null)).toBe(10)
    })
  })

  it('is the browser shape when there is no `process` at all', async () => {
    // `globalThis.process?.env?.[…]` is the whole browser story, and moving the
    // read from import time to call time must not have changed it: no bundler
    // defines anything, and the rule collapses to `tuning ?? literal`.
    const { resolveLevers } = await import('../src/theme/docpilot/retriever.js')
    let noProcess
    let noProcessTuned
    vi.stubGlobal('process', undefined)
    try {
      // Computed under the stub, asserted after it — `expect` itself is allowed
      // to want a `process`.
      noProcess = resolveLevers()
      noProcessTuned = resolveLevers({ MMR_LAMBDA: 0.85, GATE_K: 8 })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(noProcess).toEqual(LITERALS)
    expect(noProcessTuned.MMR_LAMBDA).toBe(0.85)
    expect(noProcessTuned.GATE_K).toBe(8)
    expect(noProcessTuned.CANDIDATES).toBe(LITERALS.CANDIDATES)
    expect(Object.keys(noProcess).sort()).toEqual([...LEVER_NAMES].sort())
  })

  it('falls through an unparseable env value to the tuning object, never to NaN', async () => {
    // The call-time read must keep the same idea of "set" the fold had, or a
    // typo in a sweep script resolves to NaN and takes every comparison
    // downstream with it — silently, in the browser, where nobody is watching.
    for (const junk of ['high', '', 'null', '0.9x', 'NaN']) {
      await afterImport({ GATE_K: junk, MMR_LAMBDA: junk }, ({ resolveLevers }) => {
        expect(resolveLevers({ GATE_K: 7 }).GATE_K).toBe(7)
        expect(resolveLevers().GATE_K).toBe(LITERALS.GATE_K)
        expect(resolveLevers().MMR_LAMBDA).toBe(LITERALS.MMR_LAMBDA)
        expect(Number.isNaN(resolveLevers().GATE_K)).toBe(false)
        expect(Number.isNaN(resolveLevers({ MMR_LAMBDA: 0.5 }).MMR_LAMBDA)).toBe(false)
      })
    }
  })

  it('exposes the pin as one question with one answer, for tune.js to ask', async () => {
    // Exported so `docpilot tune` does not re-derive the parse. Two copies of a
    // precedence rule are two answers to "which runs are degenerate".
    await afterImport({ GATE_K: '9', MMR_LAMBDA: 'high' }, ({ envPin, resolveLevers }) => {
      expect(envPin('GATE_K')).toEqual({ env: 'DOCPILOT_GATE_K', value: 9 })
      // Garbage is not a pin — the same rule `resolveLevers` applies, from the
      // same read, so the guard and the retrieval can never disagree.
      expect(envPin('MMR_LAMBDA')).toBeNull()
      expect(envPin('CANDIDATES')).toBeNull()
      expect(resolveLevers({ GATE_K: 3 }).GATE_K).toBe(envPin('GATE_K').value)
    })
  })
})

describe('docpilot tune — the sweep refuses what it cannot honestly measure', () => {
  const TUNE = path.resolve('src/eval/tune.js')

  /**
   * A child process, because every one of these is a property of the COMMAND —
   * argv parsing, an exit code, and which files exist afterwards — and none of
   * them is reachable by importing a module whose flags were fixed at import.
   *
   * The environment is scrubbed of every `DOCPILOT_*` key: the suite is one
   * process, other cases set them, and a stray one would pin the very axis these
   * tests are about.
   */
  const cleanEnv = (extra = {}) => {
    const env = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('DOCPILOT_')) env[k] = v
    }
    return { ...env, ...extra }
  }
  const runTune = async (args, { cwd, env = {} } = {}) => {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [TUNE, ...args], {
      cwd,
      env: cleanEnv(env),
      encoding: 'utf8',
    })
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
  }

  /** Somewhere with no index and no golden set — enough for the argv guards. */
  let bare
  beforeEach(() => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-tune-bare-'))
  })
  afterEach(() => {
    fs.rmSync(bare, { recursive: true, force: true })
  })

  it('is reachable — the command file this block shells out to exists', () => {
    expect(fs.existsSync(TUNE)).toBe(true)
  })

  /**
   * DEFECT 2. `env > tuning object` is the right rule for a running retriever
   * and exactly the wrong one for the command that VARIES that object: a set
   * `DOCPILOT_MMR_LAMBDA` outranks all ~99 per-cell tuning objects, every cell
   * measures the identical retrieval, all three metrics tie, `chooseCell` falls
   * through to its proximity tie-break, and the winner it writes to
   * `tuning.json` — which `docpilot index` inlines into every reader's bundle —
   * is a value nothing on the grid ever scored. This survives the fix above; it
   * is a second defect, not a symptom of the first.
   */
  it('dies on a swept axis pinned by the environment, naming the variable', async () => {
    for (const [name, value] of [
      ['DOCPILOT_MMR_LAMBDA', '0.3'],
      ['DOCPILOT_GATE_K', '9'],
    ]) {
      const r = await runTune([], { cwd: bare, env: { [name]: value } })
      expect(r.status, `${name} must abort the sweep`).toBe(1)
      expect(r.out).toContain(name)
      expect(r.out).toContain('pins the axis this command sweeps')
      // It names the way OUT, and the way out is never "we unset it for you":
      // the environment belongs to whatever launched this process.
      expect(r.out).toContain(`unset ${name}`)
      expect(r.out).toContain('.env.local')
    }
  })

  it('offers the grid as the legitimate way to pin an axis', async () => {
    // Nothing is lost by refusing: a bare `lo` is a one-point axis, which is the
    // command's own first-class way of holding a lever still.
    const lam = await runTune([], { cwd: bare, env: { DOCPILOT_MMR_LAMBDA: '0.3' } })
    expect(lam.out).toContain('--lambda=0.3')
    const k = await runTune([], { cwd: bare, env: { DOCPILOT_GATE_K: '9' } })
    expect(k.out).toContain('--k=9')
  })

  it('refuses before it loads an index, let alone embeds anything', async () => {
    // A run that is going to be refused must be refused while it is still free.
    // The control proves the guard is what fired: with the variable absent, the
    // same empty directory gets the ordinary "no index" message instead.
    const pinned = await runTune([], { cwd: bare, env: { DOCPILOT_GATE_K: '9' } })
    expect(pinned.out).not.toContain('no index')
    const clean = await runTune([], { cwd: bare })
    expect(clean.status).toBe(1)
    expect(clean.out).toContain('no index')
    expect(clean.out).not.toContain('pins the axis')
  })

  it('does not refuse a lever it is not sweeping — it reports it', async () => {
    // `DOCPILOT_FUSED=20` widens the pool the sweep selects from, which is a real
    // thing to want to measure. It gets a line, not a refusal — `tuning.json`
    // records only λ and k, so the answer was measured under a pool the file
    // does not mention.
    const r = await runTune([], { cwd: bare, env: { DOCPILOT_FUSED: '20' } })
    expect(r.out).not.toContain('pins the axis')
    expect(r.out).toContain('no index') // it got past the guard to the real work
  })

  it('does not treat an unparseable value as a pin', async () => {
    // Same rule as `resolveLevers`: garbage is not "set". Refusing here would
    // block a sweep over a lever that is in fact falling through to the literal.
    const r = await runTune([], { cwd: bare, env: { DOCPILOT_MMR_LAMBDA: 'high' } })
    expect(r.out).not.toContain('pins the axis')
    expect(r.out).toContain('no index')
  })

  /**
   * DEFECT 4. `arg('level')` only ever matched `--level=`, so `--level low` left
   * `low` as a stray positional, handed `parseLevelArg` the `undefined` that
   * means "no preference", and swept the WHOLE pool while the author read the
   * report as the smoke tier they had asked for.
   */
  it('rejects a bare --level instead of silently meaning ultra', async () => {
    const r = await runTune(['--level', 'low'], { cwd: bare })
    expect(r.status).toBe(1)
    expect(r.out).toContain('--level takes a value: --level=low')
    // And it never reached the work, so no report was written under a pool
    // nobody asked for.
    expect(r.out).not.toContain('no index')
  })

  it('rejects every value flag given bare, and shows the = form of each', async () => {
    for (const [flag, shown] of [
      ['--lambda', '--lambda=0.5:1.0:0.05'],
      ['--k', '--k=4:12'],
      ['--limit', '--limit=10'],
    ]) {
      const r = await runTune([flag, '5'], { cwd: bare })
      expect(r.status, flag).toBe(1)
      expect(r.out).toContain(`${flag} takes a value: ${shown}`)
    }
  })

  it('rejects a flag it does not recognise, and lists the ones it does', async () => {
    for (const bad of ['--levl=low', '--gate-only', '--verbose']) {
      const r = await runTune([bad], { cwd: bare })
      expect(r.status, bad).toBe(1)
      expect(r.out).toContain('unknown flag')
      expect(r.out).toContain(bad)
      expect(r.out).toContain('--level=low')
    }
  })

  it('will not let --limit fail open, because --limit decides whether it may write', async () => {
    // `Number('abc')` is NaN, NaN is falsy, and both `slice(0, NaN)` and the
    // narrowing test read that as "no limit" — so a typo swept the whole pool AND
    // wrote the shipped artefact, which is both surprises at once.
    for (const bad of ['abc', '0', '2.5', '-3']) {
      const r = await runTune([`--limit=${bad}`], { cwd: bare })
      expect(r.status, bad).toBe(1)
      expect(r.out).toContain('must be a positive whole number')
    }
  })

  it('does not mistake an inherited object key for a flag it knows', async () => {
    // `'constructor' in {}` is true. `Object.hasOwn` is what keeps the allowlist
    // an allowlist.
    for (const bad of ['--constructor=x', '--toString']) {
      const r = await runTune([bad], { cwd: bare })
      expect(r.status, bad).toBe(1)
      expect(r.out).toContain('unknown flag')
    }
  })

  it('still accepts every flag it documents', async () => {
    // The guard must not have narrowed the command. Each of these gets past argv
    // parsing and dies on the missing index instead.
    const r = await runTune(
      ['--level=low', '--lambda=0.9', '--k=4:6', '--limit=3', '--dry'],
      { cwd: bare },
    )
    expect(r.out).toContain('no index')
    expect(r.out).not.toContain('unknown flag')
    expect(r.out).not.toContain('takes a value')
  })
})

describe('docpilot tune — a narrowed sweep may not overwrite the shipped artefact', () => {
  const TUNE = path.resolve('src/eval/tune.js')
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

  /**
   * A whole project on disk, because the property under test is "which files
   * exist afterwards, and what is in them" — and `tuning.json` is written by
   * `main()` at a path `cli-context.js` derives from `process.cwd()`.
   *
   * `--no-embed` shape (`vectors: null`): stage A then contacts no endpoint at
   * all, so this runs offline and deterministically.
   */
  let proj
  const RAG = () => path.join(proj, 'docs', 'public', 'rag')
  const EVAL = () => path.join(proj, 'docpilot')
  const read = (f) => fs.readFileSync(path.join(EVAL(), f), 'utf8')
  const exists = (f) => fs.existsSync(path.join(EVAL(), f))

  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-tune-proj-'))
    fs.mkdirSync(RAG(), { recursive: true })
    fs.mkdirSync(EVAL(), { recursive: true })

    const letters = 'abcdefgh'.split('')
    const chunks = letters.map((letter) => ({
      id: `${letter}#one`,
      path: `/${letter}`,
      anchor: 'one',
      title: `Page ${letter.toUpperCase()}`,
      breadcrumb: 'Docs',
      kind: 'guide',
      text: `The ${letter} widget is configured with a manifest and a token. `.repeat(12),
      prev: null,
      next: null,
    }))
    fs.writeFileSync(path.join(RAG(), 'chunks-00.json'), JSON.stringify(chunks))
    fs.writeFileSync(path.join(RAG(), 'df.json'), JSON.stringify({ df: {} }))
    fs.writeFileSync(
      path.join(RAG(), 'manifest.json'),
      JSON.stringify({
        version: 3,
        hash: 'narrowfix',
        embedModel: null,
        dims: null,
        chunkCount: chunks.length,
        shards: ['chunks-00.json'],
        vectors: null,
        df: 'df.json',
        pages: letters.map((l) => ({ path: `/${l}`, title: `Page ${l}`, tail: 'Docs' })),
        guard: GUARD,
      }),
    )

    // Two records in the smoke tier, four above it, so `low` is a strict subset
    // — the whole reason a narrowed answer is not the corpus's answer.
    const rec = (id, letter, level) => ({
      id,
      question: `how is the ${letter} widget configured with a token?`,
      expect: 'answer',
      level,
      gold_answer: 'x',
      gold_chunks: [`${letter}#one`],
      identifiers: [],
      lang: 'en',
    })
    fs.writeFileSync(
      path.join(EVAL(), 'golden.jsonl'),
      [
        rec('q-1', 'a', 'low'),
        rec('q-2', 'b', 'low'),
        rec('q-3', 'c', 'high'),
        rec('q-4', 'd', 'high'),
        rec('q-5', 'e', 'high'),
        rec('q-6', 'f', 'high'),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
  })
  afterEach(() => {
    fs.rmSync(proj, { recursive: true, force: true })
  })

  const runTune = async (args) => {
    const { spawnSync } = await import('node:child_process')
    const env = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('DOCPILOT_')) env[k] = v
    }
    const r = spawnSync(process.execPath, [TUNE, ...args, '--lambda=0.9:1.0:0.1', '--k=4:5'], {
      cwd: proj,
      env,
      encoding: 'utf8',
    })
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
  }

  it('writes tuning.json for a full-pool run — the refusal below is narrow', async () => {
    const r = await runTune([])
    expect(r.status).toBe(0)
    expect(exists('tuning.json')).toBe(true)
    expect(exists('tuning.report.md')).toBe(true)
    const doc = JSON.parse(read('tuning.json'))
    expect(doc.level).toBe('ultra')
    expect(doc.records).toBe(6)
    expect(typeof doc.levers.GATE_K).toBe('number')
    expect(r.out).toContain('run npx docpilot index to inline the tuned levers')
  })

  /**
   * DEFECT 3. `--level` and `--limit` both wrote to the fixed `tuning.json` /
   * `tuning.report.md`, so a ten-record smoke sweep silently replaced levers
   * that took the whole golden file to earn — and `tuningFor` waved the result
   * through, because the version, the index hash and the embed model all still
   * matched. `eval` and `bench emit` were both given level-suffixed outputs to
   * prevent exactly this; tune was not.
   *
   * The sentinel is deliberately not the full run's own answer: this asserts
   * BYTE-IDENTITY of a file the narrowed run has no business touching, which
   * holds whether or not the two pools happen to choose the same cell.
   */
  it('leaves tuning.json byte-identical under --level, and files its report apart', async () => {
    const SENTINEL = JSON.stringify({ version: 1, levers: { MMR_LAMBDA: 0.11, GATE_K: 11 } }) + '\n'
    fs.writeFileSync(path.join(EVAL(), 'tuning.json'), SENTINEL)
    fs.writeFileSync(path.join(EVAL(), 'tuning.report.md'), '# the full-pool report\n')

    const r = await runTune(['--level=low'])
    expect(r.status).toBe(0)
    expect(read('tuning.json')).toBe(SENTINEL)
    // The full-set report is an artefact of the same run and just as clobberable.
    expect(read('tuning.report.md')).toBe('# the full-pool report\n')
    // Filed apart, the way run.js files `-lvl-<level>`.
    expect(exists('tuning-lvl-low.report.md')).toBe(true)
    expect(read('tuning-lvl-low.report.md')).toContain('Narrowed pool')
    expect(read('tuning-lvl-low.report.md')).toContain('no `tuning.json` was written')
  })

  it('treats --limit as the same hazard by a different flag', async () => {
    const SENTINEL = JSON.stringify({ version: 1, levers: { MMR_LAMBDA: 0.11, GATE_K: 11 } }) + '\n'
    fs.writeFileSync(path.join(EVAL(), 'tuning.json'), SENTINEL)

    const r = await runTune(['--limit=3'])
    expect(r.status).toBe(0)
    expect(read('tuning.json')).toBe(SENTINEL)
    expect(exists('tuning-n3.report.md')).toBe(true)
    // A head-slice of the default tier is not the tier, and the header keyed its
    // reassurance off `--level` alone — so it called three of six records "the
    // whole pool, which is what tuning wants". Matched on that exact clause: the
    // report-only notice legitimately says "written from the whole pool or not
    // at all", and a looser assertion catches its own fix.
    expect(r.out).not.toContain('the whole pool, which is what tuning wants')
    expect(r.out).toContain('3 of 6 records (--limit=3)')
  })

  it('stops the completion line from implying an unqualified result', async () => {
    const r = await runTune(['--level=low'])
    // The line a full run prints — the one that reads as "this is the answer".
    expect(r.out).not.toContain('run npx docpilot index to inline the tuned levers')
    expect(r.out).toContain('report only')
    expect(r.out).toContain('narrowed pool')
    // And it says how to get a real one.
    expect(r.out).toContain('re-run `npx docpilot tune`')
  })

  it('names the withheld artefact before the sweep runs, not only after', async () => {
    // Two minutes of grid is a long time to find out the run produces nothing
    // shippable.
    const r = await runTune(['--level=low'])
    const banner = r.out.indexOf('REPORT ONLY')
    const stageB = r.out.indexOf('stage B')
    expect(banner).toBeGreaterThan(-1)
    expect(banner).toBeLessThan(stageB)
  })
})


// ─── merged from tests-fix-eval.js ───
// ─── merged from tests-fix-eval.js ───
// MERGE NOTE — every import this block needs is already in the header of
// test/docpilot.test.js: `fs`, `os`, `path`, `vi`, `writeReport` (from
// ../src/eval/report.js), `assembleIndex` (../src/theme/docpilot/store.js) and
// `createRetrieval` (../src/theme/docpilot/retriever.js). `run.js` is reached by
// dynamic import inside the case that needs it, for the reason the neighbouring
// `eval run.js — --level and the lever fingerprint` block states: importing it
// statically is safe, but the flags it reads are folded at import time and a
// case that pins one wants its own module graph.
//
// The four defects below were found by adversarial review of the change that let
// corpus-measured levers travel `tune` → `tuning.json` → `manifest.tuning` →
// `createRetrieval({tuning})` → the browser. Three of them are the same mistake:
// a consumer of the manifest that reads everything in it except the levers.

/**
 * `latest.json` is the ONE artefact the level partition missed.
 *
 * Everything else this change touched was filed apart the moment a run narrowed
 * its pool — `-lvl-<level>` in run.js's `reportName`, `.<level>` in `bench emit`'s
 * task path — because a `--level=low` run scores a different POPULATION and its
 * numbers sit wherever ten easy questions put them. `latest.json` was rewritten
 * unconditionally, which is the worst place for that rule to be missing: it is
 * the path report.js documents as the stable entry point, so it is the one an
 * external consumer reads without ever looking at `meta.level`.
 */
describe('eval reports — latest.json means the last UNFILTERED run', () => {
  const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-latest-'))

  const meta = (over = {}) => ({
    indexHash: 'abc12345',
    model: 'm1',
    provider: 'ollama',
    promptHash: 'p1',
    records: 60,
    maxIterations: 4,
    chunkCount: 100,
    embedModel: 'e5',
    numCtx: 8192,
    fallback: false,
    thinkSupported: true,
    level: 'ultra',
    levers: { GATE_K: 5 },
    guard: { denseMode: 'cosine', tau: 0.42, tauLexical: 0.21, source: 'calibrated', calibratedAt: 'abc12345' },
    ...over,
  })
  const summary = (over = {}) => ({ answerF1: 0.5, hallucinated: 0, misses: [], ...over })

  /** writeReport prints; the suite does not need to read it. */
  const quietly = (fn) => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      return fn()
    } finally {
      spy.mockRestore()
    }
  }

  const run = (dir, name, m, s) =>
    quietly(() => writeReport({ dir, name, meta: m, summary: s, rows: [] }))

  const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))

  it('leaves the full-set score in latest.json when a smoke run follows it', () => {
    const dir = fresh()
    // The documented order of operations, and the one that broke it:
    //   npx docpilot eval            → 60 records, the project's actual number
    //   npx docpilot eval --level=low → 10 smoke lookups, minutes later
    // The second used to overwrite the first, leaving the stable path holding
    // 0.95 over ten questions where the project's number was 0.50 over sixty.
    run(dir, 'report-abc12345-m1-p1.json', meta(), summary({ answerF1: 0.5 }))
    run(dir, 'report-abc12345-m1-lvl-low-p1.json', meta({ level: 'low', records: 10 }), summary({ answerF1: 0.95 }))

    const latest = read(dir, 'latest.json')
    expect(latest.meta.level).toBe('ultra')
    expect(latest.meta.records).toBe(60)
    expect(latest.summary.answerF1).toBe(0.5)
  })

  it('files the narrowed run beside it, under its own tier', () => {
    const dir = fresh()
    run(dir, 'report-abc12345-m1-lvl-low-p1.json', meta({ level: 'low', records: 10 }), summary({ answerF1: 0.95 }))
    run(dir, 'report-abc12345-m1-lvl-medium-p1.json', meta({ level: 'medium', records: 22 }), summary({ answerF1: 0.7 }))

    // Not lost — findable, by the same `.<level>` rule the task files use.
    expect(read(dir, 'latest.low.json').summary.answerF1).toBe(0.95)
    expect(read(dir, 'latest.medium.json').meta.records).toBe(22)
    // …and each tier keeps its own, rather than the tiers overwriting each other.
    expect(fs.existsSync(path.join(dir, 'latest.json'))).toBe(false)
  })

  /**
   * The asymmetry that keeps every existing consumer working: `ultra` is what
   * "no flag" means, so it adds no segment anywhere — not to `reportName`, not to
   * the bench task path, and not here.
   */
  it('keeps the unfiltered path byte-for-byte the one consumers already hard-code', () => {
    const dir = fresh()
    run(dir, 'report-abc12345-m1-p1.json', meta(), summary())
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('latest'))).toEqual(['latest.json'])
  })

  // Same `??` rule `levelOf` exists for. A report written before levels existed
  // carries no `meta.level` and measured the whole set; reading the absence as
  // anything else would file it under `latest.undefined.json` and leave the path
  // every existing consumer reads empty on the upgrade.
  it('reads a run with no meta.level as the full set', () => {
    const dir = fresh()
    const legacy = meta()
    delete legacy.level
    run(dir, 'report-abc12345-m1-legacy.json', legacy, summary({ answerF1: 0.44 }))
    expect(read(dir, 'latest.json').summary.answerF1).toBe(0.44)
  })
})

/**
 * A value-taking flag written without its `=`.
 *
 * `arg()` matches `--name=` and nothing else, so `--level low` leaves `low` as a
 * stray positional and the flag reads as ABSENT — and absent means `ultra`. So
 * `docpilot eval --level low` scored all sixty records, stamped
 * `meta.level: 'ultra'`, overwrote the full-set baseline (ultra adds no segment)
 * and diffed itself against it, with the header line that names the pool
 * suppressed for exactly that tier. `docpilot bench emit --config=base --level low`
 * wrote its sixty tasks over `base.tasks.jsonl` the same way.
 *
 * cli.md: "An unknown tier is refused rather than defaulted, by every command
 * that takes the flag." A bare flag is that promise; `parseLevelArg` cannot keep
 * it, because by the time it is called the flag is already gone.
 */
describe('the eval commands — a value-taking flag written without its =', () => {
  it('run.js names the flag and shows the = form', async () => {
    const { VALUE_FLAGS, bareValueFlag } = await import('../src/eval/run.js')

    expect(bareValueFlag(['node', 'run.js', '--level', 'low'])).toBe('level')
    expect(bareValueFlag(['node', 'run.js', '--limit', '5'])).toBe('limit')
    expect(bareValueFlag(['node', 'run.js', '--num-ctx', '4096'])).toBe('num-ctx')
    expect(bareValueFlag(['node', 'run.js', '--models', 'a,b'])).toBe('models')
    expect(bareValueFlag(['node', 'run.js', '--model', 'qwen3:8b'])).toBe('model')

    // The example in the message is the wording the sibling commands use, so a
    // reader who hits this in `eval` and again in `tune` reads one sentence.
    expect(`--level takes a value: --level=${VALUE_FLAGS.level}`).toBe(
      '--level takes a value: --level=low',
    )
  })

  it('lets the = form, the boolean flags and a longer name through', async () => {
    const { bareValueFlag } = await import('../src/eval/run.js')

    // The whole point: `--level=low` must still reach `parseLevelArg`, which is
    // what refuses `--level=hgih`.
    expect(bareValueFlag(['node', 'run.js', '--level=low'])).toBeNull()
    expect(bareValueFlag(['node', 'run.js', '--limit=5', '--num-ctx=8192'])).toBeNull()
    // `has()` reads these, and for them the bare form IS the form.
    expect(bareValueFlag(['node', 'run.js', '--gate-only', '--lexical', '--resume'])).toBeNull()
    // Exact match, not a prefix: `--levels` is a different (unknown) flag and
    // this check is not the place that has an opinion about it.
    expect(bareValueFlag(['node', 'run.js', '--levels'])).toBeNull()
    expect(bareValueFlag([])).toBeNull()
  })

  // `bareValueFlag` being right is half of it; the module has to CALL it, before
  // `parseLevelArg` runs at module scope and defaults the tier away.
  it('run.js refuses at module scope, above the flags it guards', () => {
    const src = fs.readFileSync('src/eval/run.js', 'utf8')
    const check = src.indexOf('const BARE = bareValueFlag(process.argv)')
    expect(check).toBeGreaterThan(-1)
    expect(src).toContain('die(`--${BARE} takes a value: --${BARE}=${VALUE_FLAGS[BARE]}`)')
    // Above `RUN_LEVEL`, or the default has already been chosen by then.
    expect(check).toBeLessThan(src.indexOf('RUN_LEVEL = parseLevelArg('))
  })

  /**
   * The bench is checked by RUNNING it. Importing answer-bench.js starts a CLI —
   * it dispatches on `process.argv[2]` at the top level and `die`s into
   * `process.exit` — which is why the rest of this suite reads it as source.
   */
  describe('bench emit, as a process', () => {
    const bench = async (...args) => {
      const { spawnSync } = await import('node:child_process')
      const r = spawnSync(process.execPath, ['src/eval/answer-bench.js', ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }

    it('refuses a bare --level with the = form, and exits 1', async () => {
      const r = await bench('emit', '--config=base', '--level', 'low')
      expect(r.out).toContain('--level takes a value: --level=low')
      expect(r.status).toBe(1)
      // It never got as far as emitting anything.
      expect(r.out).not.toContain('task(s) →')
    })

    it('refuses every other flag that takes a value, not just --level', async () => {
      // `--out` is the one with the same silent shape: bare, it falls through to
      // the default task path and overwrites the file the last comparison was
      // scored on.
      expect((await bench('emit', '--config=base', '--out')).out).toContain('--out takes a value: --out=')
      expect((await bench('score', '--tasks', 'a.jsonl')).out).toContain('--tasks takes a value: --tasks=')
    })

    it('still lets the = form reach parseLevelArg, which refuses a typo', async () => {
      const r = await bench('emit', '--config=base', '--level=hgih')
      expect(r.out).toContain('unknown level "hgih"')
      expect(r.out).toContain('low, medium, high, xhigh, max, ultra')
      expect(r.status).toBe(1)
    })

    it('still prints its usage when no mode is given', async () => {
      expect((await bench()).out).toContain('usage: answer-bench.js emit|shard|score|runs')
    })
  })
})

/**
 * Every command that MEASURES this deployment builds its retrieval from this
 * deployment's levers.
 *
 * `run.js` was given `tuning: index.manifest.tuning` when the levers learned to
 * travel; its two siblings were not. Read from the source because all three
 * start a CLI on import — and asserted over EVERY `createRetrieval` call in each
 * file rather than a known line, since the defect was one call site of two in
 * calibrate.js and the next one added would be the same bug again.
 */
describe('the eval commands — retrieval is built from the manifest levers', () => {
  const FILES = ['run.js', 'calibrate.js', 'answer-bench.js']

  it.each(FILES)('%s passes manifest.tuning at every createRetrieval', (file) => {
    const src = fs.readFileSync(`src/eval/${file}`, 'utf8')
    const calls = src.match(/createRetrieval\(\{[^}]*\}/g) || []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).toContain('tuning: index.manifest.tuning')
  })

  /**
   * WHAT THE OMISSION COST, on the fixture the neighbouring lever suite uses:
   * six pages, all of them reachable, so the only thing deciding how many
   * excerpts are primed is `GATE_K`.
   *
   * Those excerpts are not a detail of the bench — they become the `search_docs`
   * observation, the `citable` set and `sources` in `<config>.tasks.jsonl`. So
   * every answer-quality, support and citation number scored off that file was
   * measured against a context the shipped page never sends, and filed under the
   * tuned index's hash: the two indexes agree on it, because the hash is sha256
   * over chunk id and text and says nothing about levers.
   */
  it('the package literal and a tuned manifest prime different evidence', () => {
    const DIMS = 8
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
    const chunks = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => ({
      id: `${letter}#one`,
      path: `/${letter}`,
      anchor: 'one',
      title: `Page ${letter.toUpperCase()}`,
      breadcrumb: 'Docs',
      kind: 'guide',
      text: `The ${letter} widget is configured with a manifest and a token. `.repeat(12),
      prev: null,
      next: null,
    }))
    const index = assembleIndex({
      manifest: {
        version: 3,
        hash: 'same-hash-either-way',
        embedModel: null,
        dims: null,
        chunkCount: chunks.length,
        // A vectorless fixture: the gate runs lexical-only, so this case needs no
        // embedder and no network to make the point.
        vectors: null,
        pages: chunks.map((c) => ({ path: c.path, title: c.title, tail: 'Docs' })),
        guard: GUARD,
        tuning: { GATE_K: 6 },
      },
      shards: [chunks],
      vectorBuffer: null,
      dfDoc: { df: {} },
    })

    const scope = { kind: 'all', paths: [], label: 'All docs' }
    const ask = { question: 'how is the widget configured with a token?', queryVec: null }
    const primed = (over) =>
      createRetrieval({ index, scope, guard: index.manifest.guard, ...over }).evaluate(ask).chunks
        .length

    // What the bench did: the manifest says 6, the module literal says 5.
    expect(primed({})).toBe(5)
    // What it does now.
    expect(primed({ tuning: index.manifest.tuning })).toBe(6)
  })
})

/**
 * A bench result has to carry the configuration it measured — run.js's
 * `leverFingerprint`, in the one place a `.jsonl` has to put it.
 *
 * Run end to end against a throwaway project: a vectorless index needs no
 * embedder, so this is the whole `emit` path — loader, level filter, gate,
 * observation, `buildMessages` — with nothing stubbed and nothing on the wire.
 */
describe('bench emit — the emitted tasks carry the levers they were primed under', () => {
  const CHUNKS = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => ({
    id: `${letter}#one`,
    path: `/${letter}`,
    anchor: 'one',
    title: `Page ${letter.toUpperCase()}`,
    breadcrumb: 'Docs',
    kind: 'guide',
    text: `The ${letter} widget is configured with a manifest and a token. `.repeat(12),
    prev: null,
    next: null,
  }))

  /**
   * A project on disk, laid out where the CLI's own defaults look: `docs/public/rag`
   * for the index, `docpilot/` for the eval artefacts. Run directly rather than
   * through `bin/docpilot.js`, so `cli-context` falls back to those defaults and
   * no config file has to exist.
   */
  const project = (tuning) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-bench-'))
    const rag = path.join(dir, 'docs', 'public', 'rag')
    fs.mkdirSync(rag, { recursive: true })
    fs.mkdirSync(path.join(dir, 'docpilot'), { recursive: true })
    fs.writeFileSync(path.join(rag, 'chunks-00.json'), JSON.stringify(CHUNKS))
    fs.writeFileSync(path.join(rag, 'df.json'), JSON.stringify({ df: {} }))
    fs.writeFileSync(
      path.join(rag, 'manifest.json'),
      JSON.stringify({
        version: 3,
        hash: 'same-hash-either-way',
        embedModel: null,
        dims: null,
        chunkCount: CHUNKS.length,
        vectors: null,
        shards: ['chunks-00.json'],
        df: 'df.json',
        pages: CHUNKS.map((c) => ({ path: c.path, title: c.title, tail: 'Docs' })),
        guard: {
          tau: 0.3,
          tauLexical: 0.3,
          wDense: 0.75,
          wLexical: 0.25,
          denseMode: 'cosine',
          cosFloor: 0.44,
          cosCeil: 0.64,
          zexp: null,
          source: 'provisional',
          calibratedAt: null,
        },
        ...(tuning ? { tuning } : {}),
      }),
    )
    fs.writeFileSync(
      path.join(dir, 'docpilot', 'golden.jsonl'),
      `${JSON.stringify({
        id: 'q-1',
        question: 'how is the widget configured with a token?',
        expect: 'answer',
        gold_answer: 'With a manifest and a token.',
        gold_chunks: ['a#one'],
        identifiers: [],
        lang: 'en',
      })}\n`,
    )
    return dir
  }

  const emit = async (dir, config) => {
    const { spawnSync } = await import('node:child_process')
    const entry = path.resolve(process.cwd(), 'src/eval/answer-bench.js')
    const r = spawnSync(process.execPath, [entry, 'emit', `--config=${config}`], {
      cwd: dir,
      encoding: 'utf8',
    })
    if (r.status !== 0) throw new Error(`bench emit exited ${r.status}: ${r.stdout}${r.stderr}`)
    const tasks = fs
      .readFileSync(path.join(dir, 'docpilot', 'bench', `${config}.tasks.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    return { tasks, out: `${r.stdout}${r.stderr}` }
  }

  it('primes the tuned number of excerpts, and says which number it was', async () => {
    const tuned = await emit(project({ GATE_K: 6, MMR_LAMBDA: 0.85 }), 'tuned')
    const untuned = await emit(project(null), 'untuned')

    // The observation, the citable set and `sources` are all this list.
    expect(tuned.tasks[0].citable).toHaveLength(6)
    expect(tuned.tasks[0].sources).toHaveLength(6)
    expect(untuned.tasks[0].citable).toHaveLength(5)

    // Same corpus, same hash, same prompt — the levers are the only thing that
    // separates the two files, so they are the thing the file has to say.
    expect(tuned.tasks[0].levers.GATE_K).toBe(6)
    expect(tuned.tasks[0].levers.MMR_LAMBDA).toBe(0.85)
    expect(untuned.tasks[0].levers.GATE_K).toBe(5)
    expect(tuned.out).toContain('levers  k=6 lambda=0.85')
  })

  it('stamps a complete, stably ordered fingerprint on every task', async () => {
    const { tasks } = await emit(project({ GATE_K: 6 }), 'stamped')
    const levers = tasks[0].levers
    // Every lever, not only the tuned ones: a file that names the two that moved
    // and stays silent on the other six is not a record of a configuration.
    for (const name of LEVER_NAMES) expect(levers).toHaveProperty(name)
    // The excerpt ceiling belongs with them — it is what cuts each primed
    // excerpt, so it moves the evidence the answerer is scored on.
    expect(levers.searchChars).toBe(1200)
    // Sorted, for the reason run.js sorts `leverFingerprint`: a consumer that
    // compares two of these on a JSON string must not read a key reordering as a
    // lever move.
    expect(Object.keys(levers)).toEqual([...Object.keys(levers)].sort())
    // On every line, because a `.jsonl` has no header and `cell()` and `shard()`
    // both read it strictly one task per line. A file whose first task alone
    // carried the levers would lose them to `--stage=2` filtering.
    for (const t of tasks) expect(t.levers).toEqual(levers)
  })
})


// ─── merged from tests-fix-allowlist.js ───
// ── merged from tests-fix-allowlist.js ───────────────────────────────────────
// `fs`, `os`, `path` are already imported in the header of test/docpilot.test.js
// — do not add them again.

/**
 * The manifest-inlinable set is NOT the lever set (RAG-SPEC 7).
 *
 * `tuning.json` is a file a consumer commits and may hand-edit, and it rides into
 * the same manifest the guard rides in. `tuningFor` used to allowlist all eight
 * `LEVER_NAMES`, which left a hole the size of `CANDIDATES`: it sizes the lexical
 * candidate list, `evaluate()` derives the gate's lexical evidence from
 * `lexIds.slice(0, 3)`, so a hand-edited `CANDIDATES: 1` flipped a documented,
 * answerable question from pass to refuse — no threshold named, no model called,
 * and no warning printed. `docpilot tune` writes MMR_LAMBDA and GATE_K and nothing
 * else, so those two are the only claims the file can honestly make.
 */
describe('tuning — only what `docpilot tune` measures may cross into the manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-allowlist-'))
  const doc = (levers) => ({
    version: 1,
    tunedAt: 'abc12345',
    embedModel: 'bge-m3',
    level: 'high',
    records: 60,
    levers,
  })
  const run = async (levers) => {
    const { tuningFor } = await import('../src/build/build-rag-index.js')
    const p = path.join(dir, 't.json')
    fs.writeFileSync(p, JSON.stringify(doc(levers)))
    const warnings = []
    const out = tuningFor('abc12345', {
      file: p,
      embedModel: 'bge-m3',
      warn: (m) => warnings.push(m),
      note: () => {},
    })
    return { out, warnings: warnings.join(' '), count: warnings.length }
  }

  // The whole defect in one assertion: the levers beside it are good, so the file
  // is not thrown away — but the value that could move a verdict does not ship.
  it('drops a hand-edited CANDIDATES loudly and keeps the measured levers', async () => {
    const { out, warnings, count } = await run({ MMR_LAMBDA: 0.6, GATE_K: 9, CANDIDATES: 1 })
    expect(out).toEqual({ MMR_LAMBDA: 0.6, GATE_K: 9, source: 'tuned', tunedAt: 'abc12345' })
    expect(out.CANDIDATES).toBeUndefined()
    expect(count).toBe(1)
    expect(warnings).toContain('CANDIDATES')
  })

  // The warning has to say WHY, or the operator reads it as a typo and re-adds the
  // key: the point is that the number in this file was never measured on this corpus.
  it('says the dropped lever is not something `docpilot tune` measures', async () => {
    const { warnings } = await run({ MMR_LAMBDA: 0.6, GATE_K: 9, CANDIDATES: 1 })
    expect(warnings).toContain('docpilot tune')
    expect(warnings).toMatch(/not measured|never measured/i)
    // …and it does not misfile it as a spelling mistake.
    expect(warnings).not.toContain('unknown lever')
  })

  /**
   * `CANDIDATES` is the one with a proven path to a flipped verdict, but the rule
   * is the set, not the one key: every `LEVER_NAMES` name the sweep does not write
   * is an unmeasured claim, and a later reader must not have to re-derive which of
   * the six happens to be dangerous today.
   */
  it('drops every lever the sweep does not write, one warning each', async () => {
    const { LEVER_NAMES } = await import('../src/theme/docpilot/retriever.js')
    const unmeasured = LEVER_NAMES.filter((n) => n !== 'MMR_LAMBDA' && n !== 'GATE_K')
    expect(unmeasured).toContain('CANDIDATES')
    // The lexical scoring levers and the lexical-only diversity cap are sweepable
    // from the environment and NOT writable from a manifest. Every one of them can
    // move `L`, and `L` is half of `G` — so a hand-edited tuning.json is exactly
    // the road from a file nobody calibrated to a verdict nobody measured.
    for (const name of [
      'PAGE_CAP',
      'BM25_K',
      'BM25_B',
      'BM25_D',
      'BOOST_TITLE',
      'BOOST_BREADCRUMB',
      'BOOST_PATH',
      'BOOST_ANCHOR',
    ])
      expect(unmeasured).toContain(name)
    expect(unmeasured.length).toBe(14)
    for (const name of unmeasured) {
      const { out, warnings, count } = await run({ MMR_LAMBDA: 0.6, GATE_K: 9, [name]: 3 })
      expect(out, name).toEqual({ MMR_LAMBDA: 0.6, GATE_K: 9, source: 'tuned', tunedAt: 'abc12345' })
      expect(count, name).toBe(1)
      expect(warnings, name).toContain(name)
    }
  })

  // The file `docpilot tune` actually writes is the one case that must be silent:
  // warning at a correct file on every build is how the warn column stops being read.
  it('passes a legitimate {MMR_LAMBDA, GATE_K} file through untouched and unwarned', async () => {
    const { out, count } = await run({ MMR_LAMBDA: 0.9, GATE_K: 8 })
    expect(out).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' })
    expect(count).toBe(0)
  })

  // What `buildTuningDoc` writes must be exactly what `tuningFor` accepts: if the
  // sweep grows a third lever and this allowlist does not, `tune` starts writing a
  // measured value that `index` silently drops.
  it('accepts precisely the keys buildTuningDoc writes', async () => {
    const { buildTuningDoc } = await import('../src/eval/tune.js')
    const cell = { MMR_LAMBDA: 0.7, GATE_K: 6, retrievalF1: 0.5, recall8: 0.5, mrr: 0.5, n: 10 }
    const written = buildTuningDoc({
      indexHash: 'abc12345',
      embedModel: 'bge-m3',
      level: 'high',
      records: 60,
      chosen: cell,
      baseline: cell,
      cells: [cell],
      sweptAt: '2026-01-01',
    })
    const { out, count } = await run(written.levers)
    expect(count).toBe(0)
    expect(Object.keys(written.levers).sort()).toEqual(['GATE_K', 'MMR_LAMBDA'])
    expect(out).toEqual({ MMR_LAMBDA: 0.7, GATE_K: 6, source: 'tuned', tunedAt: 'abc12345' })
  })

  // The wall the narrower allowlist was modelled on, unchanged: thresholds are
  // `calibrate`'s and the message still says so by name.
  it('still drops the guard thresholds with the calibrate warning', async () => {
    const { out, warnings, count } = await run({
      MMR_LAMBDA: 0.9,
      GATE_K: 8,
      tau: 0.05,
      tauLexical: 0.9,
      wDense: 0.7,
      wLexical: 0.9,
    })
    expect(out).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' })
    expect(count).toBe(4)
    expect(warnings).toContain('guard threshold')
    expect(warnings).toContain('calibrate')
    // A threshold is not merely unmeasured — it is forbidden, and keeps its own line.
    expect(warnings).not.toContain('unmeasured lever')
  })

  // A typo is still a typo and still reads as one.
  it('still names an unrecognised key an unknown lever', async () => {
    const { out, warnings } = await run({ MMR_LAMBDA: 0.9, GATE_K: 8, denseMode: 3 })
    expect(out).toEqual({ MMR_LAMBDA: 0.9, GATE_K: 8, source: 'tuned', tunedAt: 'abc12345' })
    expect(warnings).toContain('unknown lever')
    expect(warnings).toContain('denseMode')
  })

  // `source: 'tuned'` on an empty object claims the corpus was measured while every
  // value resolves to the module literal anyway — so an all-unmeasured file is null.
  it('returns null when only unmeasured levers were offered', async () => {
    const { out } = await run({ CANDIDATES: 1, FUSED: 2 })
    expect(out).toBeNull()
  })
})


// ─── merged from tests-fix-ids.js ───
// ─── merged from tests-fix-ids.js ───

/**
 * Paste this block into test/docpilot.test.js, next to `describe('chunker')`.
 * `chunkMarkdown`, `slug`, `underPath` and `retrievalF1Loose` are all already
 * imported at the top of that file; only `recallAtK` is new, and the import
 * above folds into the existing `../src/eval/metrics.js` block.
 *
 * CHUNK IDENTITY. A chunk id is `<path>#<anchor>` plus, for the second and later
 * parts of one long section, a suffix. That suffix used to be `-N` — which is
 * also how a REPEATED HEADING is disambiguated, VitePress-style, so the two
 * meanings shared one namespace and collided. Every case below is an executed
 * reproduction of what that cost, plus the three smaller identity defects found
 * with it.
 *
 * NOTE FOR WHOEVER MERGES THIS: the existing assertion
 *   expect(underPath('guide/auth#request-2', 'guide/auth#request')).toBe(true)
 * in `describe('metrics')` encodes the OLD spelling and must become `#request~2`
 * (see the last `it` here, which pins both halves of the new rule).
 */
describe('chunker — the two things `-N` used to mean', () => {
  const chunk = (src, path = '/p') => chunkMarkdown({ src, path, kind: 'guide' })
  const ids = (src, path) => chunk(src, path).chunks.map((c) => c.id)

  // Bodies have to clear MERGE_BELOW_TOKENS or rule 4 folds the sections into
  // one and there is no second heading left to disambiguate.
  const long = Array.from({ length: 26 }, (_, i) => `Paragraph ${i} ${'x'.repeat(220)}`).join('\n\n')
  const mid = Array.from({ length: 6 }, (_, i) => `Other ${i} ${'y'.repeat(200)}`).join('\n\n')

  /**
   * The build-death case. Three `## Parameters` on one page, the first long
   * enough to pack into five parts, used to produce
   * `[parameters, parameters-2 … parameters-5, parameters-1, parameters-2]` and
   * kill `build-rag-index.js` with `duplicate chunk id: api#parameters-2` — an
   * id that appears nowhere in the author's source.
   */
  it('does not collide a split section with a repeated heading', () => {
    const src = `# API\n\n## Parameters\n\n${long}\n\n## Parameters\n\n${mid}\n\n## Parameters\n\n${mid}`
    const out = ids(src, '/api')
    expect(out).toEqual([
      'api#parameters',
      'api#parameters~2',
      'api#parameters~3',
      'api#parameters~4',
      'api#parameters~5',
      'api#parameters-1',
      'api#parameters-2',
    ])
    expect(new Set(out).size).toBe(out.length)
  })

  /** `-N` keeps VitePress's meaning, and only that meaning. */
  it('still disambiguates repeated headings with -N', () => {
    const src = `# P\n\n## Use cases\n\n${'x'.repeat(600)}\n\n## Use cases\n\n${'y'.repeat(600)}`
    const anchors = chunk(src).chunks.map((c) => c.anchor)
    expect(anchors).toContain('use-cases')
    expect(anchors).toContain('use-cases-1')
    expect(new Set(anchors).size).toBe(anchors.length)
  })

  /**
   * The separator has to be one `slug()` can never emit, or the disambiguation
   * path would start producing it and the namespaces would merge again.
   */
  it('uses a separator slug() strips', () => {
    expect(slug('a ~ b')).not.toContain('~')
    expect(slug('~~~')).toBe('')
    const parts = ids(`# P\n\n## Long\n\n${long}`)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.slice(1).every((id) => /~\d+$/.test(id))).toBe(true)
  })

  /**
   * The suffix lives in the ID only. `session.js` builds the citation href from
   * the `anchor` FIELD, so a `~` must never reach a URL — which is what lets the
   * separator be chosen for id-uniqueness rather than for link syntax.
   */
  it('keeps the suffix out of the anchor every part shares', () => {
    const { chunks } = chunk(`# P\n\n## Long\n\n${long}`)
    expect(chunks.length).toBeGreaterThan(1)
    expect(new Set(chunks.map((c) => c.anchor))).toEqual(new Set(['long']))
    expect(chunks.some((c) => c.anchor.includes('~'))).toBe(false)
  })

  /**
   * DEFECT 2 — VitePress custom anchors. `## Title {#custom-id}` is consumed by
   * markdown-it-attrs and rendered as `id="custom-id"`. Reading the line whole
   * left the markup in the citation label and slugged it into the anchor:
   * artificial-intelligence.md:215 produced
   * `how-to-get-api-keys-for-ai-models-how-to-get-api-keys-for-ai-models`, a
   * fragment matching no element, so the citation landed at the top of the page.
   */
  it('takes a VitePress custom anchor verbatim and off the title', () => {
    const src =
      '# AI\n\nlead\n\n### How to Get API Keys for AI Models {#how-to-get-api-keys-for-ai-models}\n\nBody.'
    const [, section] = chunk(src, '/ai').chunks
    expect(section.anchor).toBe('how-to-get-api-keys-for-ai-models')
    expect(section.title).toBe('How to Get API Keys for AI Models')
    expect(section.id).toBe('ai#how-to-get-api-keys-for-ai-models')
    expect(section.text).not.toContain('{#')
  })

  /** Verbatim means verbatim — never re-slugged, or the href stops resolving. */
  it('does not slug a custom anchor', () => {
    const { chunks } = chunk('# P\n\n## Whatever It Says {#POST_v1--Items}\n\nBody.')
    expect(chunks[chunks.length - 1].anchor).toBe('POST_v1--Items')
  })

  /**
   * A heading ABOUT the syntax ends in a backtick, not a brace, so the
   * end-anchored pattern leaves it alone. A heading that is nothing BUT an id
   * stays untouched too: an empty title reads downstream as the lead section.
   */
  it('leaves a heading that only mentions the syntax alone', () => {
    const { chunks } = chunk('# P\n\n## The `{#id}` shorthand\n\nBody.')
    const last = chunks[chunks.length - 1]
    expect(last.title).toBe('The `{#id}` shorthand')
    expect(last.anchor).toBe('the-id-shorthand')
  })

  /** Two headings claiming the same custom id still get distinct chunk ids. */
  it('disambiguates a repeated custom anchor rather than failing the build', () => {
    const src = `# P\n\n## One {#dup}\n\n${'x'.repeat(600)}\n\n## Two {#dup}\n\n${'y'.repeat(600)}`
    const out = ids(src)
    expect(out).toContain('p#dup')
    expect(out).toContain('p#dup-1')
    expect(new Set(out).size).toBe(out.length)
  })

  /**
   * A disambiguated anchor is RESERVED, not merely counted. Two `## Parameters`
   * take `parameters` and `parameters-1`; a custom `{#parameters-1}` — now
   * reachable verbatim — and a literal `## Parameters 1` both want that same
   * string, and a bare per-base counter would hand it out twice.
   */
  it('reserves a disambiguated anchor against a heading that spells it directly', () => {
    const two = `# P\n\n## Parameters\n\n${'x'.repeat(600)}\n\n## Parameters\n\n${'y'.repeat(600)}`
    for (const third of ['## Parameters 1', '## Anything {#parameters-1}']) {
      const out = ids(`${two}\n\n${third}\n\n${'z'.repeat(600)}`)
      expect(out).toContain('p#parameters')
      expect(out).toContain('p#parameters-1')
      expect(new Set(out).size).toBe(out.length)
    }
  })

  /**
   * DEFECT 3 — a heading with no letters and no digits. `slug()` keeps only
   * `\p{L}\p{N}\s-`, so `## 🚀` slugs to '' — the anchor an untitled lead section
   * already carries. Skipping the `anchorSeen` bookkeeping for that one value
   * gave both chunks the id `p#`, pointed the lead's `next` at itself, and killed
   * the build with `duplicate chunk id: /p#`.
   */
  it('registers the empty slug like any other anchor', () => {
    const { chunks } = chunk('Lead paragraph here.\n\n## 🚀\n\nRocket section body.\n')
    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.id)).toEqual(['p#', 'p#-1'])
    expect(chunks[0].next).toBe('p#-1')
    expect(chunks[1].next).toBeNull()
  })

  /** With no lead section to collide with, the emoji heading keeps the clean id. */
  it('leaves the first empty-slug section a fragment-less page link', () => {
    const { chunks } = chunk('## 🚀\n\nRocket section body.\n')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].id).toBe('p#')
    expect(chunks[0].anchor).toBe('')
  })

  /**
   * DEFECT 4 — FAQ answers bypassed every splitter. Appended after `hardSplit`
   * had run, an oversized FaqAccordion answer met nothing but the assertion at
   * the end of `chunkMarkdown` and killed `docpilot index` with
   * `chunk exceeds MAX_CHUNK_CHARS after rule 7: p#faq-1 (8109)` — blaming a rule
   * that never ran on this path.
   */
  it('runs FAQ answers through the same ceiling as a section', () => {
    const faq = (answer) => `Intro.\n\n<FaqAccordion :items="[{ question: 'Why?', answer: '${answer}' }]" />\n`
    expect(() => chunk(faq('word '.repeat(3000)))).not.toThrow()
    const parts = chunk(faq('word '.repeat(3000))).chunks.filter((c) => c.kind === 'faq')
    expect(parts.length).toBeGreaterThan(1)
    for (const c of parts) expect(c.text.length).toBeLessThanOrEqual(8000)
    expect(parts.map((c) => c.id)).toEqual(['p#faq-1', 'p#faq-1~2'])
    // One anchor for the whole answer, exactly as a split section keeps one.
    expect(new Set(parts.map((c) => c.anchor))).toEqual(new Set(['faq-1']))
  })

  /** An answer that fits keeps the id it always had — no drift for real corpora. */
  it('leaves a normal FAQ answer as one chunk with its old id', () => {
    const src = `Intro.\n\n<FaqAccordion :items="[{ question: 'Why?', answer: 'Because.' }]" />\n`
    const { chunks } = chunk(src)
    const parts = chunks.filter((c) => c.kind === 'faq')
    expect(parts.map((c) => c.id)).toEqual(['p#faq-1'])
    expect(parts[0].text).toBe('/p — Why?\nBecause.')
  })

  /** Nothing this function emits may ever repeat an id — that is the build gate. */
  it('never emits a duplicate id on a page that stresses every rule', () => {
    const src = [
      'Lead.',
      '## 🚀',
      'Rocket.',
      '## Parameters',
      long,
      '## Parameters',
      mid,
      '## Parameters {#parameters-1}',
      mid,
      `<FaqAccordion :items="[{ question: 'Q?', answer: '${'word '.repeat(3000)}' }]" />`,
    ].join('\n\n')
    const out = ids(src)
    expect(new Set(out).size).toBe(out.length)
  })
})

describe('underPath — a split section is the same section, a repeated heading is not', () => {
  /**
   * The metric half of the same defect. While continuations were `-N`, gold
   * pinned at `api/users#parameters` was credited for retrieving
   * `api/users#parameters-1` — a DIFFERENT endpoint's Parameters section, which
   * the answer could not have used. `recallAtK` returned 1 and
   * `retrievalF1Loose` returned {p:1,r:1,f1:1} on a miss, inflating recall@8,
   * MRR, retrieval F1 and citation precision together — and `docpilot tune`
   * sweeps against exactly that objective.
   */
  it('accepts ~N continuations and rejects -N repeats', () => {
    expect(underPath('api/users#parameters~2', 'api/users#parameters')).toBe(true)
    expect(underPath('api/users#parameters~10', 'api/users#parameters')).toBe(true)
    expect(underPath('api/users#parameters-1', 'api/users#parameters')).toBe(false)
    expect(underPath('api/users#parameters-manually', 'api/users#parameters')).toBe(false)
    expect(underPath('api/users#parameters', 'api/users#parameters')).toBe(true)
  })

  it('scores a repeated heading as the miss it is', () => {
    const gold = ['api/users#parameters']
    expect(recallAtK(['api/users#parameters-1'], gold, 8)).toBe(0)
    expect(retrievalF1Loose(['api/users#parameters-1'], gold)).toEqual({ p: 0, r: 0, f1: 0 })
    // ...and still credits the real continuation part.
    expect(recallAtK(['api/users#parameters~2'], gold, 8)).toBe(1)
  })

  /** The suffix rule stays off bare paths: a sibling page must never match. */
  it('never matches a bare page path through a suffix', () => {
    expect(underPath('guide/auth~2', 'guide/auth')).toBe(false)
    expect(underPath('guide/auth-2#x', 'guide/auth')).toBe(false)
    expect(underPath('guide/authorisation#x', 'guide/auth')).toBe(false)
    expect(underPath('guide/auth/oauth#step', 'guide/auth')).toBe(true)
  })

  /** FAQ ordinals live in the `-N` namespace, so `faq-1` must not swallow `faq-11`. */
  it('keeps FAQ ordinals distinct from FAQ continuations', () => {
    expect(underPath('p#faq-1~2', 'p#faq-1')).toBe(true)
    expect(underPath('p#faq-11', 'p#faq-1')).toBe(false)
  })
})


// ─── merged from tests-fix-normalise.js ───
/**
 * Paste this block into test/docpilot.test.js, next to `describe('normalise —
 * llm content tags')`. It adds no imports: `normaliseMarkdown` and
 * `chunkMarkdown` are already imported at the top of that file.
 */

/**
 * Three ways the pipeline used to publish a Q&A the page never asserted, or
 * point a citation at a fragment that does not exist.
 *
 * 1. The FAQ was extracted from the RAW page, before `applyLlmTags` ran. An
 *    `<llm-exclude>` wrapped around a FaqAccordion island therefore excluded
 *    nothing: the tag pass never saw the island, `stripVue` deleted the tag from
 *    the prose stream a step later so the page looked redacted, and the Q&A was
 *    already in `faq[]` on its way to an indexed, citable `#faq-n` chunk.
 * 2. The same scan read fenced code, so a page DOCUMENTING the component turned
 *    its own `<FaqAccordion :items="[…]" />` sample into a real FAQ chunk —
 *    fabricated content, indistinguishable downstream from an authored answer.
 * 3. `flattenLinks` appended the route to a heading whose text is a link, so the
 *    chunker slugged the destination into the anchor. VitePress builds its
 *    anchor from the heading's rendered TEXT, so every such citation pointed at
 *    a fragment that exists nowhere — four sections of one real page — under a
 *    label with the raw route printed inside it.
 *
 * The fence tests underneath pin the scan those first two now depend on: it
 * closes a fence on CommonMark's rule instead of flipping a boolean, because a
 * fence shown inside another inverted the boolean and inverted the meaning of
 * every line after the sample.
 */
describe('normalise — FAQ islands, heading links and nested fences', () => {
  const island = (q, a) => `<FaqAccordion :items="[{ question: '${q}', answer: '${a}' }]" />`
  const chunk = (src) => chunkMarkdown({ src, path: '/p', kind: 'guide' })

  it('honours <llm-exclude> around a FaqAccordion island', () => {
    const src = [
      '# Page',
      '',
      'Public intro.',
      '',
      '<llm-exclude>',
      island('What is the internal rate limit?', 'Do not publish: 50/day on the internal key.'),
      '</llm-exclude>',
      '',
      '## Next',
      '',
      'after',
    ].join('\n')

    expect(normaliseMarkdown(src).faq).toEqual([])
    const { chunks } = chunk(src)
    // The exclusion has to hold on the OUTPUT, not just in faq[]: the whole
    // point of the tag is that nothing downstream ever sees the text.
    expect(chunks.map((c) => c.kind)).not.toContain('faq')
    expect(chunks.map((c) => c.id)).not.toContain('p#faq-1')
    for (const c of chunks) expect(c.text).not.toContain('Do not publish')
    // Excluding the island must not have taken the page with it.
    expect(chunks.map((c) => c.title)).toEqual(['Page', 'Next'])
  })

  it('does not turn a fenced sample of the component into a real FAQ chunk', () => {
    const src = [
      '# Page',
      '',
      'Drop the component into any page:',
      '',
      '```vue',
      island('Sample question?', 'Sample answer.'),
      '```',
      '',
      '## Next',
      '',
      'after',
    ].join('\n')

    expect(normaliseMarkdown(src).faq).toEqual([])
    const { chunks } = chunk(src)
    expect(chunks.map((c) => c.kind)).not.toContain('faq')
    // The sample is documentation and stays in the prose chunk verbatim — the
    // fix is that it is not ALSO read as an assertion the page made.
    expect(chunks[0].text).toContain("question: 'Sample question?'")
  })

  it('still extracts a real <script setup> island, which is how the corpus writes one', () => {
    const src = [
      '# Plugin',
      '',
      '<script setup>',
      'const faqItems = [',
      "  { question: 'Is the plugin free?', answer: 'There is a free tier.' },",
      "  { question: 'Can I customize it?', answer: 'Yes, through the theme.' },",
      ']',
      '</script>',
      '',
      '## FAQ',
      '',
      '<FaqAccordion :items="faqItems" :single-open="true" />',
    ].join('\n')

    expect(normaliseMarkdown(src).faq).toEqual([
      { question: 'Is the plugin free?', answer: 'There is a free tier.' },
      { question: 'Can I customize it?', answer: 'Yes, through the theme.' },
    ])
    const faq = chunk(src).chunks.filter((c) => c.kind === 'faq')
    expect(faq.map((c) => c.id)).toEqual(['p#faq-1', 'p#faq-2'])
    expect(faq[0].text).toBe('Plugin — Is the plugin free?\nThere is a free tier.')
  })

  // The pattern tolerates 40 characters between `question:` and `answer:`, so the
  // unfenced text is matched in RUNS. Joining the prose either side of a skipped
  // fence would pair a question with an answer the document never put near it.
  it('never pairs a question with an answer from the other side of a fence', () => {
    const src = [
      '# Page',
      '',
      "<FaqAccordion :items=\"[{ question: 'Left?' }]\" />",
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      "<FaqAccordion :items=\"[{ answer: 'Right.' }]\" />",
    ].join('\n')
    expect(normaliseMarkdown(src).faq).toEqual([])
  })

  it('slugs a linked heading to the anchor VitePress actually renders', () => {
    const src = [
      '# Tutorials and Examples',
      '',
      '## Available How-To Guides',
      '',
      'g'.repeat(600),
      '',
      '### [Template Modifications](/extensions/tutorials/how-to/template-modifications)',
      '',
      'Learn how to modify templates, and see [Auth](/getting-started/authentication).',
      'x'.repeat(600),
    ].join('\n')

    const { chunks } = chunk(src)
    const c = chunks.find((x) => x.title === 'Template Modifications')
    expect(c).toBeDefined()
    expect(c.anchor).toBe('template-modifications')
    expect(c.id).toBe('p#template-modifications')
    // The route must be nowhere in the anchor, the id, or the label a citation
    // row prints — all three came from the heading line.
    for (const x of chunks) {
      expect(x.anchor).not.toContain('extensionstutorialshow-to')
      expect(x.title).not.toContain('/extensions/')
    }
    // A link in the BODY is unchanged: that route is content the model cites.
    expect(c.text).toContain('Auth (/getting-started/authentication)')
  })

  it('keeps the surrounding words of a partly linked heading, and drops only the route', () => {
    const src = `# P\n\n## See [the guide](/guide) first\n\n${'y'.repeat(600)}`
    const c = chunk(src).chunks[0]
    expect(c.title).toBe('See the guide first')
    expect(c.anchor).toBe('see-the-guide-first')
  })

  it('leaves a linked heading inside a fenced sample verbatim', () => {
    const src = ['# P', '', '```md', '## [Linked](/route)', '```', '', 'tail'].join('\n')
    expect(normaliseMarkdown(src).text).toContain('## [Linked](/route)')
  })

  /**
   * A ```` ```` ```` wrapper around a ``` sample is what every page documenting
   * this pipeline contains. The old toggle flipped on the inner fence, so the
   * lines after the sample read as code and `applyLlmTags` copied an
   * `<llm-exclude>` block straight through — the same class of failure as the
   * FAQ leak above, from the other direction.
   */
  it('honours <llm-exclude> after a fence shown inside another fence', () => {
    const src = [
      '# P',
      '',
      '````md',
      '```vue',
      '<script setup>',
      'const x = 1',
      '````',
      '',
      '## Two',
      '',
      '<llm-exclude>',
      'SECRET rate limit',
      '</llm-exclude>',
      '',
      'public tail',
    ].join('\n')
    const { text } = normaliseMarkdown(src)
    expect(text).not.toContain('SECRET')
    expect(text).toContain('public tail')
  })

  // The other parity: the sample's body read as page markup, so `stripVue` took
  // an unterminated `<script>` in a snippet as a real island opener and dropped
  // every line to end of file — two whole sections, silently.
  it('does not read a documented <script> snippet as a real island', () => {
    const src = [
      '# P',
      '',
      '````md',
      '```vue',
      '<script setup>',
      '```',
      '````',
      '',
      '## Two',
      '',
      'body two',
      '',
      '## Three',
      '',
      'body three',
    ].join('\n')
    const { text } = normaliseMarkdown(src)
    expect(text).toContain('body two')
    expect(text).toContain('body three')
  })
})
