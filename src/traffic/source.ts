/**
 * Where turn logs, votes, golden records and the index come from. The IO half
 * shared by `docpilot traffic` and `docpilot dataset`.
 *
 * `--from` is a file, a directory of `turns-YYYY-MM-DD.jsonl`, or a URL. The
 * URL path reuses `fetchRows` from the feedback command — same token variable,
 * same paging, same refusal to cap silently.
 */

import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs'
import path from 'node:path'
import {indexDirOf} from '../config.js'
import {fetchRows, parseRows, TOKEN_ENV} from '../feedback/source.js'
import {setTokenizer, setVocabulary} from '../theme/docpilot/text.js'
import {splitRows, type Malformed, type RowEntry} from './turns.js'
import type {DfDoc} from './cluster.js'

export const isUrl = (s: string | null | undefined) => /^https?:\/\//i.test(s || '')

/** `${evalDir}`, resolved against the working directory. */
export const evalDirOf = (docPilot: any, cwd = process.cwd()) =>
  path.resolve(cwd, docPilot?.evalDir || 'docpilot')

/** Where the server writes its day files by default. */
export const turnLogDir = (docPilot: any, cwd = process.cwd()) => path.join(evalDirOf(docPilot, cwd), 'turns')

const DAY_FILE = /^turns-(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * Every turn row from a file, a directory, or a URL. Never throws on a bad
 * line; throws only when the source itself cannot be read.
 */
export async function readTurnRows({
  from,
  since = null,
  env = {},
  log = () => {},
  fetchImpl,
}: {
  from: string
  since?: string | null
  env?: Record<string, string | undefined>
  log?: (m: string) => void
  fetchImpl?: typeof fetch
}): Promise<{rows: RowEntry[]; malformed: Malformed[]; files: string[]}> {
  if (isUrl(from)) {
    if (!env[TOKEN_ENV]) log(`[docpilot] ${TOKEN_ENV} is not set — the request goes out unauthenticated`)
    const items = await fetchRows({from, env, since, log, fetchImpl})
    return {rows: items.map((row, i) => ({row, line: i + 1})), malformed: [], files: [from]}
  }
  const p = path.resolve(from)
  if (!existsSync(p)) throw new Error(`no such file or directory: ${p}`)
  let files: string[]
  if (statSync(p).isDirectory()) {
    const names = readdirSync(p).filter((n) => n.endsWith('.jsonl') || n.endsWith('.ndjson')).sort()
    const days = names.filter((n) => DAY_FILE.test(n))
    // Day files when there are any; a directory of other exports otherwise.
    files = (days.length ? days : names)
      .filter((n) => {
        const m = DAY_FILE.exec(n)
        return !since || !m || m[1] >= since
      })
      .map((n) => path.join(p, n))
  } else files = [p]

  const rows: RowEntry[] = []
  const malformed: Malformed[] = []
  for (const f of files) {
    const split = splitRows(readFileSync(f, 'utf8'), path.basename(f))
    rows.push(...split.rows)
    malformed.push(...split.malformed)
  }
  return {rows, malformed, files}
}

/** Feedback rows, from a file or a URL — the `docpilot feedback` reader as is. */
export async function readFeedbackRows({
  from,
  since = null,
  env = {},
  log = () => {},
  fetchImpl,
}: {
  from: string
  since?: string | null
  env?: Record<string, string | undefined>
  log?: (m: string) => void
  fetchImpl?: typeof fetch
}): Promise<any[]> {
  if (isUrl(from)) return fetchRows({from, env, since, log, fetchImpl})
  const p = path.resolve(from)
  if (!existsSync(p)) throw new Error(`no such file: ${p}`)
  return parseRows(readFileSync(p, 'utf8'))
}

/** A JSONL file of records, or `[]` when it does not exist. */
export function readJsonl(file: string): any[] {
  if (!existsSync(file)) return []
  return parseRows(readFileSync(file, 'utf8'))
}

export interface IndexBits {
  dir: string
  manifest: any | null
  df: DfDoc | null
  /** chunk id → chunk row (id, path, title, text …). */
  chunks: Map<string, any> | null
  /** chunk id → page path. */
  paths: Map<string, string> | null
  why: string | null
}

/**
 * The parts of the built index these commands read — manifest, df, shards.
 *
 * Installs the index's tokenizer and vocabulary into `text.ts`, so `terms()`
 * here produces the keys the df was built with. Missing pieces come back null
 * with a reason; nothing here throws.
 */
export function loadIndexBits(docPilot: any, {chunks: wantChunks = true} = {}): IndexBits {
  const dir = path.resolve(indexDirOf({...docPilot, docsDir: docPilot?.docsDir || 'docs'}))
  const none = (why: string): IndexBits => ({dir, manifest: null, df: null, chunks: null, paths: null, why})
  const mf = path.join(dir, 'manifest.json')
  if (!existsSync(mf)) return none(`no index at ${dir}`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(mf, 'utf8'))
  } catch (e) {
    return none(`${mf} does not parse — ${e.message}`)
  }
  setTokenizer(manifest.tokenizer)
  setVocabulary(manifest.vocabulary)
  let df: DfDoc | null = null
  try {
    if (manifest.df) df = JSON.parse(readFileSync(path.join(dir, manifest.df), 'utf8'))
  } catch {
    df = null
  }
  let chunks: Map<string, any> | null = null
  let paths: Map<string, string> | null = null
  if (wantChunks && Array.isArray(manifest.shards)) {
    try {
      chunks = new Map()
      paths = new Map()
      for (const s of manifest.shards) {
        for (const c of JSON.parse(readFileSync(path.join(dir, s), 'utf8'))) {
          chunks.set(c.id, c)
          if (c.path) paths.set(c.id, c.path)
        }
      }
    } catch {
      chunks = null
      paths = null
    }
  }
  return {dir, manifest, df, chunks, paths, why: df ? null : 'the index has no readable df'}
}
