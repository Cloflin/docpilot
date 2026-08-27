/**
 * OpenAPI → synthetic chunks — RAG-SPEC 2.1.
 *
 * `docs/reference/*.md` are generated stubs containing <ReferenceContent> and no
 * prose, so indexing them would index 16 empty pages. The YAML they render is
 * indexed instead, one chunk per operation, at the same route the stub occupies.
 */

import { slug } from './chunker.js'
import { MAX_CHUNK_CHARS } from './normalise.js'

function fieldLines(schema, prefix = '', depth = 0, out = []) {
  if (!schema || depth > 3) return out
  if (schema.type === 'array' && schema.items) return fieldLines(schema.items, `${prefix}[]`, depth + 1, out)
  const required = new Set(schema.required || [])
  for (const [name, prop] of Object.entries(schema.properties || {})) {
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

  for (const [route, item] of Object.entries(schema.paths || {})) {
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
        codeLangs: [],
        text,
      })
    }
  }

  chunks.forEach((c, i) => {
    c.prev = i > 0 ? chunks[i - 1].id : null
    c.next = i < chunks.length - 1 ? chunks[i + 1].id : null
  })

  return { chunks, title }
}
