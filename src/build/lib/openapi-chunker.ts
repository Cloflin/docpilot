/**
 * OpenAPI → synthetic chunks — RAG-SPEC 2.1.
 *
 * `docs/reference/*.md` are generated stubs containing <ReferenceContent> and no
 * prose, so indexing them would index 16 empty pages. The YAML they render is
 * indexed instead, one chunk per operation, at the same route the stub occupies.
 */

import fs from 'node:fs'
import path from 'node:path'

import { slug } from './chunker.js'
import { MAX_CHUNK_CHARS } from './normalise.js'

/**
 * Which files are specs — `docPilot.openapi`, or the one directory that was
 * hard-coded before it existed.
 *
 * `${docsDir}/public/openapi/` is a fine default and was the only answer: a
 * project whose spec lives in `api/openapi.yaml`, which is where most of them
 * live, could not index it without moving the file into the docs site's public
 * assets. The setting is a LIST OF PATHS rather than a glob library, because
 * three shapes cover every real layout and none of them needs a dependency:
 *
 *   'api'                a directory — every .yaml and .yml directly inside it
 *   'api/openapi.yaml'   one file
 *   'specs/v*.yaml'      a `*` in the BASENAME, matched against that directory
 *
 * A `*` in a directory segment is not supported and says so, rather than
 * silently matching nothing — a spec that was configured and never indexed is
 * an empty `/reference/` route on a live site.
 *
 * @param {string[] | null | undefined} configured `docPilot.openapi`
 * @param {string} fallbackDir used when nothing is configured
 * @param {string} root the project root every entry is relative to
 * @returns {{ files: string[], errors: string[] }} absolute paths, sorted
 */
export function specFiles(configured, fallbackDir, root = process.cwd()) {
  const errors: string[] = []
  const entries = Array.isArray(configured) && configured.length ? configured : [fallbackDir]
  const isSpec = (name) => /\.ya?ml$/i.test(name)
  const found = new Set<string>()

  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(`docPilot.openapi holds ${JSON.stringify(raw)}, which is not a path`)
      continue
    }
    const rel = raw.trim()
    const abs = path.resolve(root, rel)
    const base = path.basename(abs)

    // The `*` branch is entered by the ENTRY containing one, not by the basename
    // containing one. Keyed on the basename, `spec*/api.yaml` fell through to the
    // plain-path branch and was reported as "does not exist" — a true sentence
    // about a path that was never going to be looked up, and the wrong thing to
    // tell somebody who wrote a pattern this does not support.
    if (rel.includes('*')) {
      const dir = path.dirname(abs)
      if (dir.includes('*')) {
        errors.push(`docPilot.openapi entry "${rel}" puts a * in a directory name, which is not supported`)
        continue
      }
      if (!fs.existsSync(dir)) {
        errors.push(`docPilot.openapi entry "${rel}" names a directory that does not exist`)
        continue
      }
      // `*` matches within one segment, like a shell does — the only
      // metacharacter, and every other character is itself.
      const re = new RegExp(`^${base.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
      for (const name of fs.readdirSync(dir)) {
        if (re.test(name) && isSpec(name)) found.add(path.join(dir, name))
      }
      continue
    }

    if (!fs.existsSync(abs)) {
      // The default directory is allowed to be absent — most projects publish no
      // spec at all. A path somebody WROTE is not: it is a typo, and a silent one
      // leaves a documented reference route with nothing behind it.
      if (rel !== fallbackDir) errors.push(`docPilot.openapi entry "${rel}" does not exist`)
      continue
    }

    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        if (isSpec(name)) found.add(path.join(abs, name))
      }
    } else if (isSpec(abs)) {
      found.add(abs)
    } else {
      errors.push(`docPilot.openapi entry "${rel}" is not a .yaml or .yml file`)
    }
  }

  return { files: [...found].sort(), errors }
}

type SchemaNode = Record<string, any>

function fieldLines(
  schema: SchemaNode,
  prefix = '',
  depth = 0,
  out: string[] = [],
) {
  if (!schema || depth > 3) return out
  if (schema.type === 'array' && schema.items) return fieldLines(schema.items, `${prefix}[]`, depth + 1, out)
  const required = new Set(schema.required || [])
  for (const [name, prop] of Object.entries<SchemaNode>(schema.properties || {})) {
    const path = prefix ? `${prefix}.${name}` : name
    const type = prop.type || (prop.oneOf ? 'oneOf' : prop.enum ? 'enum' : 'object')
    const req = required.has(name) ? ' (required)' : ''
    const desc = prop.description ? ` — ${String(prop.description).replace(/\s+/g, ' ').trim()}` : ''
    out.push(`- ${path}: ${type}${req}${desc}`)
    if (prop.type === 'object' || prop.properties) fieldLines(prop, path, depth + 1, out)
    if (prop.type === 'array' && prop.items?.properties) fieldLines(prop.items, `${path}[]`, depth + 1, out)
  }
  return out
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

/**
 * @param {string} yamlText raw spec
 * @param {string} name file basename → route /reference/<name>
 */
export async function chunkOpenapi(yamlText, name) {
  // Imported here rather than at module scope, and optional on purpose: a docs
  // site with no OpenAPI files should not have to install a spec parser to
  // build an index, and the failure when it is absent should name the fix
  // rather than arrive as an unresolved import three frames up.
  let dereference
  try {
    // @ts-ignore — an optional peer the catch below reports as missing.
    ;({ dereference } = await import('@scalar/openapi-parser'))
  } catch {
    throw new Error(
      `[docpilot] found an OpenAPI file (${name}) but @scalar/openapi-parser is not installed.\n` +
        '  npm i -D @scalar/openapi-parser   — or remove the YAML from your public/ directory.\n' +
        '  Any version from 0.18 up: this file uses `dereference(yaml) → {schema}` and\n' +
        '  nothing else, and that contract is unchanged across 0.18, 0.22 and 0.28.',
    )
  }
  const { schema } = await dereference(yamlText)
  if (!schema) return { chunks: [], title: name }

  const path = `/reference/${name}`
  const title = schema.info?.title || name
  const chunks = []

  for (const [route, item] of Object.entries<SchemaNode>(schema.paths || {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op) continue

      const head = `${method.toUpperCase()} ${route}`
      const lines = [`${title} — ${head}`]
      if (op.summary) lines.push(op.summary)
      if (op.description) lines.push(String(op.description).replace(/\s+/g, ' ').trim())

      const params = [...(item.parameters || []), ...(op.parameters || [])]
      if (params.length) {
        lines.push('Parameters:')
        for (const p of params) {
          const t = p.schema?.type || 'string'
          const req = p.required ? ' (required)' : ''
          const d = p.description ? ` — ${String(p.description).replace(/\s+/g, ' ').trim()}` : ''
          lines.push(`- ${p.name} (${p.in}): ${t}${req}${d}`)
        }
      }

      const body = op.requestBody?.content
      const json = body && (body['application/json'] || Object.values(body)[0])
      if (json?.schema) {
        const fields = fieldLines(json.schema)
        if (fields.length) lines.push('Request body:', ...fields)
      }

      const codes = Object.keys(op.responses || {})
      if (codes.length) {
        lines.push(
          'Responses: ' +
            codes
              .map((c) => {
                const d = op.responses[c]?.description
                return d ? `${c} ${String(d).replace(/\s+/g, ' ').trim()}` : c
              })
              .join('; '),
        )
      }

      const text = lines.join('\n').slice(0, MAX_CHUNK_CHARS)
      const anchor = slug(`${method}-${route}`)
      chunks.push({
        id: `reference/${name}#${anchor}`,
        path,
        anchor,
        title: op.summary || head,
        breadcrumb: title,
        kind: 'reference',
        text,
      })
    }
  }

  // Forward only, same page only — the same contract `chunker.js` states, and
  // the backward half is derived at load rather than shipped.
  chunks.forEach((c, i) => {
    c.next = i < chunks.length - 1 ? chunks[i + 1].id : null
  })

  return { chunks, title }
}
