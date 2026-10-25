/**
 * `docpilot serve` — the server runtime on a port, engine-spec 028.
 *
 * TWO JOBS, BOTH SMALL. It mounts `createDocPilotServer` at `server.endpoint`
 * and, with `--dir`, serves a built site beside it — which is everything a
 * same-origin deployment needs and nothing a production one should rely on
 * alone: there is no TLS, no compression and no rate limit here. In production
 * put it behind the reverse proxy that already serves the site, and route
 * `server.endpoint` to it (`docs/guide/server.md`).
 *
 * It reads the index once at start. A rebuilt index is a restart.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { USAGE, FAILED } from './cli-exit.js'
import { flagErrors, flagValue, flagGiven, helpFor } from './cli-flags.js'
import { indexDirOf } from './config.js'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.xml': 'application/xml',
}

/**
 * A static file under `root`, or null. VitePress's clean URLs are tried in its
 * own order — the path, `.html`, `/index.html` — and nothing outside `root` can
 * be named, however many `..` the request carries.
 */
export function staticFile(root, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null
  }
  // NO DOTFILES — engine-spec 033. `serve --dir .` published `.env.local`, `.git`
  // and every other file a project keeps out of sight by its name. Only
  // `.well-known/` is public by convention (security.txt, the ACME challenge).
  if (rel.split('/').some((seg) => seg.startsWith('.') && seg !== '.well-known')) return null
  const base = path.resolve(root)
  for (const candidate of [rel, `${rel}.html`, path.posix.join(rel, 'index.html')]) {
    const full = path.resolve(base, `.${path.posix.normalize(`/${candidate}`)}`)
    if (full !== base && !full.startsWith(base + path.sep)) continue
    try {
      if (fs.statSync(full).isFile()) return full
    } catch {
      /* next candidate */
    }
  }
  return null
}

/**
 * Every built index under `root` — a directory holding a `manifest.json` that
 * names shards. A site built from `public/` copies its index into the output,
 * and serving it would hand the reader the corpus the server runtime exists to
 * keep: so `serve` withholds it, whatever else the directory publishes.
 */
export function indexDirsUnder(root, depth = 3) {
  const out = []
  const walk = (dir, d) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === 'manifest.json')) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
        if (Array.isArray(m.shards)) out.push(path.resolve(dir))
      } catch {
        /* not ours */
      }
    }
    if (d <= 0) return
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), d - 1)
  }
  walk(root, depth)
  return out
}

/** Does `dir` hold a built index — a `manifest.json` that names shards? */
function holdsIndex(dir) {
  try {
    return Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).shards)
  } catch {
    return false
  }
}

/**
 * Is `file` inside a built index? Asked of the FILESYSTEM at request time, not
 * of a list of names.
 *
 * The list from `indexDirsUnder` was compared with a case-sensitive
 * `startsWith`, and `staticFile` keeps the case the client sent — so on APFS
 * or NTFS `/RAG/manifest.json` (or `/rag./…` on Windows) opened the real
 * `rag/` and matched nothing on the list. It also missed an index under a
 * symlink, a dot-directory or past depth 3. Walking the file's real parents
 * and reading each one's `manifest.json` cannot be spelled around: the
 * filesystem answers in whatever case it matches. A path that will not
 * resolve is refused.
 */
export function inIndex(root, file) {
  let real
  let top
  try {
    real = fs.realpathSync.native(file)
    top = fs.realpathSync.native(root)
  } catch {
    return true
  }
  for (let d = path.dirname(real); ; d = path.dirname(d)) {
    if (holdsIndex(d)) return true
    if (d === top || path.dirname(d) === d) return false
  }
}

export async function runServe({ docPilot, settings = null, argv = [], env = process.env }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(helpFor('serve'))
    return 0
  }
  const errors = flagErrors('serve', argv)
  if (errors.length) {
    for (const e of errors) console.error(`[docpilot] ${e}`)
    return USAGE
  }
  if (docPilot.runtime !== 'server') {
    console.error(
      "[docpilot] serve needs runtime: 'server' in your docPilot settings — under 'browser' the panel\n" +
        '  never calls it, and a second process answering nobody is a bill with no reader.',
    )
    return USAGE
  }

  const port = Number(flagValue('serve', argv, 'port') ?? 8787)
  const host = flagValue('serve', argv, 'host') ?? '127.0.0.1'
  const dir = flagValue('serve', argv, 'dir')
  const logDir = flagValue('serve', argv, 'log')
  const retention = flagValue('serve', argv, 'retention-days')
  const index = flagValue('serve', argv, 'index') ?? indexDirOf(docPilot)

  const { createDocPilotServer } = await import('./server/index.js')
  let dp
  try {
    dp = await createDocPilotServer({
      // The author's settings when the launcher has them: the server resolves
      // them itself, and the resolved object carries `server.endpoint` alone.
      settings: settings ?? docPilot,
      env,
      index,
      log: logDir
        ? { dir: logDir, prompts: flagGiven('serve', argv, 'log-prompts'), retentionDays: retention ? Number(retention) : null }
        : null,
    })
  } catch (e) {
    console.error(`[docpilot] could not start the server runtime: ${e?.message || e}`)
    return FAILED
  }

  // For the startup line only; the refusal itself is `inIndex`, per request.
  const withheld = dir ? indexDirsUnder(dir) : []
  const server = http.createServer((req, res) =>
    dp
      .node(req, res, () => {
        let file = dir ? staticFile(dir, new URL(req.url || '/', 'http://x').pathname) : null
        if (file && inIndex(dir, file)) file = null
        if (!file) {
          res.statusCode = 404
          return res.end('not found')
        }
        res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream')
        // The two headers that cost nothing and break nothing: no MIME sniffing
        // of an uploaded `.txt` into HTML, no full URL leaked to other origins.
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
        // A file gone between `stat` and `open` emits `error`, and an
        // unhandled `error` event stops the process.
        fs.createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res)
      })
      // `node()` answers its own failures; this is the second wall, because a
      // dropped rejection here is the whole site down.
      .catch(() => {
        if (res.headersSent) return res.destroy()
        res.statusCode = 500
        res.end()
      }),
  )
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()))
  console.log(
    `[docpilot] serve     http://${host}:${port}${dp.endpoint}  (index ${dp.index.manifest.hash}, ${dp.index.manifest.chunkCount} chunks)` +
      (dir ? `\n[docpilot] static    ${path.resolve(dir)}` : '') +
      (withheld.length
        ? `\n[docpilot] withheld  ${withheld.map((d) => path.relative(path.resolve(dir), d)).join(', ')} — an index is the corpus; the server runtime keeps it`
        : '') +
      (logDir ? `\n[docpilot] turn log  ${path.resolve(logDir)}` : ''),
  )
  // Resolves only on a signal, so the launcher's `process.exit` waits for it.
  return new Promise((resolve) => {
    const stop = () => server.close(() => resolve(0))
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
