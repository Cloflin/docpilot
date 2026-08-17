/**
 * The markdown a site already publishes, preferred over anything derived.
 *
 * A growing number of documentation sites serve `page.md` beside `page` — every
 * VitePress site running `vitepress-plugin-llms` does, and so do the Docusaurus
 * and Mintlify equivalents. When that file exists it is not an approximation of
 * the page: it is what the page was BUILT FROM. Converting the rendered HTML
 * instead throws away the authored structure and then tries to reconstruct it
 * from the markup that survived a template, a theme and a CSS framework.
 *
 * So the order is: use the published markdown; convert the HTML only when there
 * is none.
 *
 * TWO WAYS TO FIND IT, because sites do both.
 *
 *   · DECLARED — `<link rel="alternate" type="text/markdown" href="…">`. The
 *     honest one, and rare.
 *   · DERIVED — from `<link rel="canonical">`, or from the URL that was asked
 *     for. Measured on a real site: `vitepress-plugin-llms` emits
 *     `/reference/authentication-api.md` and declares nothing at all, so a
 *     tool that only reads link tags finds nothing on the sites most likely to
 *     have it. Canonical is what the guess is built from rather than the
 *     requested URL, because that is the address without the tracking
 *     parameters, the trailing slash and the redirect.
 *
 * A DERIVED URL IS A GUESS, and it is treated as one: the response has to come
 * back 200, non-empty, and not be HTML. A single-page app answers every unknown
 * path with its own index document, so "the fetch succeeded" proves nothing —
 * `looksLikeMarkdown` is what decides, and it defaults to no.
 */

/** `<link rel="alternate">` types that mean markdown. */
const MARKDOWN_TYPES = ['text/markdown', 'text/x-markdown', 'application/markdown']

/** Content types a served `.md` comes back as. Plain text is the common one. */
const MARKDOWN_CONTENT = /^(text\/(markdown|x-markdown|plain)|application\/(markdown|octet-stream))/i

/**
 * Markdown alternates the page declares, absolute, in document order.
 *
 * `type` is checked first and the `.md` extension second, because a site that
 * sets `rel="alternate"` without a type is still telling us something and the
 * extension is unambiguous.
 */
export function declaredAlternates(document, base) {
  const out = []
  for (const link of document.querySelectorAll?.('link[rel~="alternate"]') || []) {
    const type = (link.getAttribute('type') || '').toLowerCase().split(';')[0].trim()
    const href = link.getAttribute('href') || ''
    if (!href) continue
    const isMarkdown = MARKDOWN_TYPES.includes(type) || /\.md(\?|#|$)/i.test(href)
    if (!isMarkdown) continue
    const abs = absolute(href, base)
    if (abs) out.push(abs)
  }
  return out
}

/** The page's canonical address, or the one that was asked for. */
export function canonicalOf(document, requested) {
  const href = document.querySelector?.('link[rel="canonical"]')?.getAttribute('href') || ''
  return absolute(href, requested) || requested
}

/**
 * Where a `.md` would live for this page, best guess first.
 *
 * `/a/b` → `/a/b.md`. A directory-shaped URL — `/a/b/` or `/` — has no last
 * segment to extend, so it gets `index.md`, which is what a static host serves
 * there. Query strings and fragments are dropped: they address a state of the
 * page, and there is no state in a file.
 */
export function derivedCandidates(canonical) {
  let url
  try {
    url = new URL(canonical)
  } catch {
    return []
  }
  url.search = ''
  url.hash = ''
  const path = url.pathname

  if (/\.md$/i.test(path)) return [url.href]
  if (path.endsWith('/')) {
    // Both, because hosts disagree about what a directory URL means: a static
    // host serves `index.md` there, and a site whose canonical merely carries a
    // trailing slash names the file after the segment.
    const bare = path.replace(/\/$/, '')
    return bare
      ? [`${url.origin}${path}index.md`, `${url.origin}${bare}.md`]
      : [`${url.origin}${path}index.md`]
  }
  // An HTML extension is replaced rather than appended: `/a/b.html.md` is a
  // path no site serves.
  if (/\.html?$/i.test(path)) return [`${url.origin}${path.replace(/\.html?$/i, '.md')}`]
  return [`${url.origin}${path}.md`, `${url.origin}${path}/index.md`]
}

/**
 * Is this actually markdown?
 *
 * The guard exists because of what a miss looks like: an SPA answers an unknown
 * path with its own shell, 200 and all, and a tool that trusted the status code
 * would import the site's navigation as the body of a documentation page.
 */
export function looksLikeMarkdown(body, contentType = '') {
  const text = String(body || '')
  const head = text.trimStart().slice(0, 400).toLowerCase()
  if (!text.trim()) return false
  if (contentType && /text\/html/i.test(contentType)) return false
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    return false
  }
  // A page that opens with a tag is a page, whatever it was served as. One
  // leading `<` is not proof on its own — a markdown file may legitimately open
  // with an HTML block — so the test is for a document-shaped opening.
  if (/^<(head|body|div|main|nav|script)\b/.test(head)) return false
  if (contentType && !MARKDOWN_CONTENT.test(contentType)) return false
  return true
}

/**
 * `---\nkey: value\n---\nbody` → its two halves.
 *
 * Deliberately shallow — this reads `title` and `description` off a file that
 * has them, and nothing else. A full YAML parser would be a dependency, and
 * every other key here is one this command overwrites anyway.
 *
 * BLOCK SCALARS ARE NOT OPTIONAL, though, and that was measured rather than
 * anticipated: the first live import of a published `.md` — vitepress.dev's own
 * — carries `description: >-` with the sentence on the following lines, and a
 * parser that reads the value at the colon writes `>-` into the frontmatter of
 * the imported page. That value lands in the first chunk, which is the strongest
 * dense lever the corpus has.
 */
export function splitFrontmatter(md) {
  const text = String(md || '').replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: {}, body: text.trim() }

  const data = {}
  const lines = m[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    // Column 0 only, and one level deep: a `title:` indented under some other
    // key belongs to that key. Same rule the indexer applies to `source:`.
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const [, key, inline] = kv
    const block = /^([|>])([-+]?)\s*$/.exec(inline.trim())
    if (!block) {
      data[key] = inline.trim().replace(/^['"]|['"]$/g, '')
      continue
    }
    // `>` folds the following indented lines into one line, `|` keeps them as
    // lines. The chomp indicator only affects trailing newlines, which the trim
    // below removes either way.
    const collected = []
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) {
      collected.push(lines[++i].trim())
    }
    data[key] = collected.join(block[1] === '>' ? ' ' : '\n').trim()
  }
  return { data, body: text.slice(m[0].length).trim() }
}

/** `[text](/a/b)` → `[text](https://host/a/b)`, for links and images alike. */
export function absolutiseLinks(md, base) {
  return String(md || '').replace(
    /(!?\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?(\))/g,
    (whole, open, href, title, close) => {
      const abs = absolute(href, base)
      return abs ? `${open}${abs}${title || ''}${close}` : whole
    },
  )
}

/**
 * The published markdown, ready to be the body of an imported page.
 *
 * The leading `# Heading` goes: the file this becomes has its own `#` from the
 * frontmatter title, and two of them makes the chunker's first section a
 * duplicate of the page title.
 */
export function prepareMarkdown(raw, { base }) {
  const { data, body } = splitFrontmatter(raw)
  const withoutTitle = body.replace(/^#\s+.*(\r?\n)+/, '')
  return {
    title: data.title || '',
    description: data.description || '',
    markdown: absolutiseLinks(withoutTitle, base).trim(),
  }
}

/** Absolute http(s) only — the same rule the converter applies to an href. */
function absolute(href, base) {
  if (!href) return null
  try {
    const url = new URL(String(href).trim(), base || undefined)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Try every candidate until one answers with markdown.
 *
 * @param {object} o
 * @param {string[]} o.urls candidates, best first
 * @param {(url: string) => {href: string}|{error: string}} o.allow the allowlist check — a
 *   derived URL is a URL this tool decided to request, so it passes the same
 *   boundary the one the user typed did
 * @param {Function} o.fetchImpl
 * @param {Record<string, string>} [o.headers]
 * Always returns the attempt list, found or not: "it looked and found nothing"
 * and "it never looked" are different facts, and only one of them is a reason to
 * go and publish a `.md`.
 *
 * @returns {Promise<{url: string|null, body: string, tried: {url: string, why: string}[]}>}
 */
export async function findMarkdown({ urls, allow, fetchImpl, headers = {} }) {
  const tried = []
  for (const url of urls) {
    const verdict = allow(url)
    if ('error' in verdict) {
      tried.push({ url, why: 'outside the allowlist' })
      continue
    }
    let res
    try {
      res = await fetchImpl(url, { headers, redirect: 'follow' })
    } catch (e) {
      tried.push({ url, why: String(e?.message || e) })
      continue
    }
    // Same reason as `readHtml`: the per-candidate check above covers the URL
    // requested, and redirects are followed, so the response can have come from
    // somewhere the list never approved.
    if (res.url && res.url !== url && 'error' in allow(res.url)) {
      tried.push({ url, why: `redirected outside the allowlist (${res.url})` })
      continue
    }
    if (!res.ok) {
      tried.push({ url, why: `${res.status}` })
      continue
    }
    const body = await res.text()
    const type = res.headers?.get?.('content-type') || ''
    if (!looksLikeMarkdown(body, type)) {
      tried.push({ url, why: `not markdown (${type || 'no content-type'})` })
      continue
    }
    return { url, body, tried }
  }
  return { url: null, body: '', tried }
}
