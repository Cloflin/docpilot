/**
 * Where the "Roadmap to 3.0" page gets its text, and how it becomes HTML.
 *
 * THE BODY IS NOT PART OF THE DOCS CORPUS, ON PURPOSE. The roadmap describes
 * 3.0 features that are not published, and the panel of this site answers from
 * the 2.x docs: if the roadmap were Markdown under `docs/`, the assistant would
 * cite plans as if they were features. So `docs/guide/roadmap-3.md` holds a
 * short intro and a component, and the component prints HTML that the data
 * loader `docs/guide/roadmap-3.data.js` builds here at BUILD time. The indexer
 * reads Markdown files only, so it never sees the body. The library's own
 * `EXCLUDE` set in `src/build/build-rag-index.ts` is not touched: consumers
 * share it.
 *
 * THE TEXT IS THE GITHUB PRE-RELEASE `roadmap-3.0`, read from the public API
 * with no token, so the page shows the note as it is after every deploy, and a
 * phase update costs no reindex. A build with no network (or a rate-limited or
 * changed answer) falls back to `roadmap-3.snapshot.json`, which is committed.
 *
 * REFRESH THE SNAPSHOT when the note changes and you want the fallback to follow:
 *
 *   node docs/.vitepress/roadmap-source.mjs --refresh
 *
 * No imports from `vitepress` here, so the unit tests load this file alone.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROADMAP_TAG = 'roadmap-3.0'
export const ROADMAP_API = `https://api.github.com/repos/Cloflin/docpilot/releases/tags/${ROADMAP_TAG}`
export const ROADMAP_URL = `https://github.com/Cloflin/docpilot/releases/tag/${ROADMAP_TAG}`

/** A build waits this long for GitHub, then uses the snapshot. A slow API must not hold a deploy. */
export const FETCH_TIMEOUT_MS = 10_000

/**
 * A note shorter than this is an empty or a cut answer, not a roadmap. The
 * real one is 46 KB; the floor only has to stand below any real note and above
 * a blank body or an error message.
 */
export const MIN_BODY_CHARS = 500

export const SNAPSHOT_PATH = fileURLToPath(new URL('./roadmap-3.snapshot.json', import.meta.url))

/** The saved copy: `{ tag, url, capturedAt, body }`. */
export function readSnapshot(file = SNAPSHOT_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The body of a release answer, or an Error that says what was wrong with it. */
export function bodyOf(release) {
  if (!release || release.tag_name !== ROADMAP_TAG) {
    throw new Error(`the answer is not the release ${ROADMAP_TAG}`)
  }
  if (typeof release.body !== 'string' || release.body.trim().length < MIN_BODY_CHARS) {
    throw new Error('the release body is empty or too short to be the roadmap')
  }
  return release.body
}

/**
 * The roadmap text and where it came from. NEVER THROWS: a build that cannot
 * reach GitHub still has a page. No token is sent, so the request is the same
 * for a stranger's clone and for the deploy.
 */
export async function loadRoadmap({
  snapshot,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  warn = console.warn,
} = {}) {
  try {
    const res = await fetchImpl(ROADMAP_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'docpilot-docs-build' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const body = bodyOf(await res.json())
    return { body, source: 'github', capturedAt: now().toISOString().slice(0, 10) }
  } catch (e) {
    warn(`[docpilot] ${ROADMAP_TAG} was not read from GitHub (${e?.message || e}); the page uses the committed snapshot`)
    return { body: snapshot.body, source: 'snapshot', capturedAt: snapshot.capturedAt }
  }
}

/**
 * The note opens with a header paragraph ("This is not a release: ..."). The
 * page writes its own header in Markdown, and two would say the same thing
 * twice, so that one paragraph is dropped when it is there. Anything else the
 * note opens with is kept.
 */
export function withoutHeader(body) {
  const end = body.indexOf('\n\n')
  if (end < 0) return body
  const first = body.slice(0, end)
  return /^\*\*DocPilot 3\.0[^\n]*not a release/.test(first) ? body.slice(end + 2).replace(/^\n+/, '') : body
}

/**
 * Markdown to HTML with one change, made on tokens so that nothing is patched in
 * the output: after the note's own `#` heading, headings go one level down, so
 * the page keeps one `<h1>` and the note's "Latest update" and "Roadmap" are both
 * second-level sections.
 *
 * The caller builds the renderer with `html: false`, so a tag in the note is
 * shown as text: this text comes from outside the repository. Task lists need
 * nothing here, because VitePress's renderer draws `- [x]` as a disabled checkbox.
 */
export function renderRoadmap(body, md) {
  const env = {}
  const tokens = md.parse(withoutHeader(body), env)

  let shift = 0
  let level = 0
  for (const t of tokens) {
    if (t.type === 'heading_open') {
      const n = Number(t.tag.slice(1))
      if (n === 1) shift = 1
      level = Math.min(6, n + shift)
      t.tag = `h${level}`
    } else if (t.type === 'heading_close') {
      t.tag = `h${level}`
    }
  }
  return md.renderer.render(tokens, md.options, env)
}

/** `node docs/.vitepress/roadmap-source.mjs --refresh` rewrites the committed snapshot from GitHub. */
async function refresh() {
  const res = await fetch(ROADMAP_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'docpilot-docs-build' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body = bodyOf(await res.json())
  const snapshot = { tag: ROADMAP_TAG, url: ROADMAP_URL, capturedAt: new Date().toISOString().slice(0, 10), body }
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`[docpilot] ${SNAPSHOT_PATH} written, ${body.length} characters`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--refresh')) {
  refresh().catch((e) => {
    console.error(`[docpilot] ${e.message}`)
    process.exit(1)
  })
}
