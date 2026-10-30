# 041 — Source documents and the pipeline

> **Кратко.** `docpilot index` читает четыре источника четырьмя кусками кода
> прямо в `main()`: Markdown, `--html-dir`, `--kb` и OpenAPI. Общего вида у
> документа нет, поэтому коннектору из Фазы 3 некуда встать. Потолки размера
> (манифест 64 КБ, 3 МБ предупреждение, 5 МБ отказ) одни для всех, и корпус
> серверного рантайма они отвергают, хотя браузер его не скачивает. Эта
> спецификация вводит внутренний тип `SourceDoc` (id, источник, url, заголовок,
> тело, `updatedAt`, язык, видимость, хлебные крошки, теги, `contentHash`),
> проверку `assertPublic` с запретом по умолчанию и функцию `limitsFor(runtime)`:
> потолки действуют только в браузерном рантайме. `shellManifest` переезжает в
> свой модуль, чтобы сборка могла напечатать размер оболочки, не подключая
> сервер. Ни один байт вывода `docpilot index` не меняется.

## Problem

Three things stand in the way of a second kind of source.

**Four readers are written inline in `main()`.** Each one walks its own files,
builds its own page row and calls its own chunker:

| source | reader | chunker |
|---|---|---|
| docs Markdown | `walkMarkdown(DOCS)`, the owner rule, `EXCLUDE` | `chunkMarkdown` |
| `--html-dir` | `readHtmlDir`, which hands back Markdown already assembled by `pageFromHtml` | `chunkMarkdown` |
| `--kb` | `walkMarkdown(KB)`, id `EXTERNAL_PREFIX/rel`, `source:` required | `chunkMarkdown` |
| OpenAPI | `specFiles()`, the YAML text | `chunkOpenapi`, which builds chunks itself |

Nothing names what these four have in common. A fifth reader — a service with an
API — would be a fifth copy of the same skeleton.

**The size ceilings are global.** The manifest may not pass 64 KB, the artefacts
warn at 3 MB and fail at 5 MB. They protect a reader who downloads the manifest
on the first question. In `runtime: 'server'` nobody downloads it: the browser
gets the shell manifest, and the index is read once by `docpilot serve`. Yet a
server-runtime project with 900 small pages stops with `manifest is 178268
bytes, over the 65536 ceiling`. The config is accepted and the runtime is
ignored.

**Privacy has no place to be decided.** Every file the indexer reads is public by
construction, because the author put it in `docs/`. A connector will read
documents that are drafts or restricted. If the type has no field for that, the
first connector decides it alone, and a missing field reads as "public".

## The SourceDoc shape

`src/build/lib/source-doc.ts` defines one internal type. It is **not** in
`types/` and **not** in `package.json#exports`: a public type is a promise, and
the connector contract is designed in Phase 3 against real connectors.

| field | Phase 1 value, per reader | hashed |
|---|---|---|
| `id` | today's chunk `path`: the route (`/guide/x`); `EXTERNAL_PREFIX/rel` for `--kb`; `/reference/<name>` for OpenAPI | yes |
| `source` | `'markdown'`, `'kb'`, `'html-dir'` or `'openapi'` | no |
| `url` | `--kb`: the allow-checked `source:` href. Others: `null`, the route is the URL | no |
| `title` | what the reader passes to the chunker; the chunker still derives the final title | no |
| `body` | `{ format: 'markdown', markdown }` or `{ format: 'openapi', yaml }` | yes |
| `updatedAt` | `undefined` for files. Never read from mtime: it differs on every checkout | never |
| `locale` | `undefined`. No locale key exists and no front-matter key is added | no |
| `visibility` | `'public'` | no |
| `breadcrumb`, `tags` | `[]` | no |
| `contentHash` | computed by the pipeline, in memory only | — |

`openapi` is a body format of its own because OpenAPI bypasses the Markdown
chunker. `chunkOpenapi` builds its chunks from the YAML. A shape with only a
Markdown body would force the OpenAPI reader to render Markdown that nothing
parses back.

## Stages

```
read ─▶ assertPublic ─▶ normalise ─▶ chunk ─▶ embed (cached) ─▶ quantise ─▶ static writer
```

| stage | in Phase 1 |
|---|---|
| read | extracted: one reader per source returns `SourceDoc[]`, with no chunking, no network and no embedding |
| assertPublic | extracted: runs before any chunking |
| normalise, chunk | extracted: `documentsToChunks` calls `chunkMarkdown` and `chunkOpenapi` unchanged |
| embed with cache, quantise, static writer | stay in `main()`: they are coupled to the module-scope embedder settings, and no consumer needs them apart before Phases 4–5 |

The stage contract is written here so Phases 3–5 can cite it. Moving the later
stages is that phase's work, done when the sync engine needs them.

## contentHash

```
sha256( UTF-8 JSON of [id, title, description, text] )      Markdown, after normaliseMarkdown
sha256( UTF-8 JSON of [id, yaml text] )                      OpenAPI
```

`updatedAt` is not an input, so two documents that differ only in `updatedAt`
hash equal. A document that did not change must not look changed to the sync
engine.

In Phase 1 the hash lives in memory and is written nowhere. It is **not** a
fourth corpus hash: `manifest.hash` keeps its single definition (the first eight
hex digits of the sha256 over chunk id and text), and the shard names stay
content addresses of their own bytes.

## Visibility

`visibility` is `'public' | 'internal'` and the field is required. No type in the
module lets a document become public by omission. A reader sets it. The static
writer takes public documents only: `assertPublic` throws `NonPublicDocument`,
and the message names every refused document.

Anything that is not the literal `'public'` is refused, including a missing
value. A document that cannot say it is public is not public.

Phase 3 connectors map the source's own state onto this field: drafts are
dropped, and restricted documents are marked `'internal'`. The server runtime may
read internal documents later; the static index never does.

## Per-runtime limits

`limitsFor(runtime)` returns the three ceilings for the runtime in
`docPilot.runtime`.

| runtime | manifest | warn | fail |
|---|---|---|---|
| `browser` (default) | 64 KB | 3 MB | 5 MB |
| `server` | none | none | none |

The browser ceilings keep their reason: a reader downloads the manifest on the
first question, and the shards after it. In `server` runtime the index is read
only by `docpilot serve`. The browser downloads the shell manifest, so the build
prints the shell's size as information — not as a warning — and the ceilings are
lifted.

Only the literal `'server'` lifts them. `undefined`, a typo and any other value
read as the browser, which is the safe side to fail toward.

`docPilot.runtime` is the only switch. There is no flag and no environment
variable, so a build cannot lift the ceilings on a project whose config says
`browser`. Sizes count UTF-8 bytes, which is what the network carries, never
UTF-16 code units.

To print the shell size the build imports `shellManifest`. It moves from
`src/server/index.ts` into `src/server/shell.ts`, which has no imports, because
`index.ts` pulls in the turn, the limiter and the log. `index.ts` re-exports it,
so the `./server` entry keeps its export.

## Byte identity

Nothing here may change what `docpilot index` writes. The committed `rag/` and
`rag-local/` must rebuild with no diff. Six things keep that true when the
readers move:

1. The order of the chunk array and of the `pages` Map: Markdown, HTML,
   knowledge base, OpenAPI; within a source, the walk order.
2. The key order of every page row. `JSON.stringify` follows insertion order and
   the manifest bytes include `pages[]`.
3. The key order of a chunk record, and `embedText` staying non-enumerable.
   `chunkMarkdown` is called untouched.
4. The text of `warn()` messages and their counters. Tests match the prefix
   `manifest is N bytes, over the 65536 ceiling`; a change extends the wording
   and keeps the prefix.
5. `rawBytes` counts characters of the raw source: the file text for Markdown,
   the assembled Markdown for HTML, the YAML for OpenAPI.
6. The allowlist check runs for every `source:`. A front-matter `source` becomes
   an `href`, and Markdown is content, never trusted with a URL scheme.

Three layers hold them:

| layer | what it proves | where it runs |
|---|---|---|
| committed corpus | the reader and chunk stage, run on the repo's own `docs/`, give the shard names and page rows in `manifest.json` | offline, in CI |
| four-source fixture | the three sources the committed corpus does not exercise (`--kb`, `--html-dir`, OpenAPI) give the same per-file hashes as the builder did before the refactor | offline, in CI |
| local rebuild | `rag-local` and `rag` rebuild from the embed cache with `git status --short docs/public` empty | on one machine, before the phase closes |

The fixture layer is the four-source characterisation written before the
refactor. `test/docs-links.test.js` keeps its own corpus walker and chunker as an
independent oracle and is left alone.

## What Phase 3 adds

A `Connector` and a pull: a reader whose documents come from a service's API
instead of a directory, which returns `SourceDoc[]` with `updatedAt`, `locale`,
`breadcrumb`, `tags` and `visibility` filled in from the service. The type then
becomes public, with a migration note, in the spec that introduces it
(042).
