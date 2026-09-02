/**
 * Where a CLI run gets its settings and its paths.
 *
 * Inside the project this was extracted from, every tool imported the site's
 * own config and resolved paths relative to its own file. Both stop working the
 * moment the code lives in node_modules: `import.meta.dirname` points at the
 * package, and there is no `../docs` above it.
 *
 * So the contract inverts. `bin/docpilot.js` resolves the consumer's settings
 * once and puts them here; every path below is relative to the directory the
 * command was RUN from, which is the project root by construction — the config
 * file the settings came from was found relative to the same cwd.
 *
 * Importing it outside a CLI run is not an error, but it is not useful either:
 * see the note on `settings` for why the fallback is safe.
 */
import path from 'node:path'
import type {ResolvedDocPilot} from '../types/config.js'
import { indexDirOf, resolveDocPilot } from './config.js'

/**
 * `bin/docpilot.js` puts the resolved settings here before importing any command,
 * so by the time a command reads this the answer is always the project's own.
 *
 * Falling back to defaults rather than throwing is deliberate but narrow: unit
 * tests import pure helpers out of the same modules that read these paths, and
 * a throw at module scope would make them untestable without a fake global.
 * Nothing here WRITES anything — every command resolves its output path from
 * these values inside its own main(), which only a real CLI run reaches.
 */
/**
 * RESOLVED settings, not the author's. The distinction is real and it used to be
 * unwritten: `chat.chain` arrives as `'auto' | false | member[]` and leaves as
 * the resolved selection, and `resolveChat` adds `providerAuto`, `modelAuto` and
 * `searchOnly`, none of which a project ever writes. `ResolvedDocPilot` is that
 * shape; `DocPilotSettings` remains what goes IN.
 */
export const settings: ResolvedDocPilot =
    globalThis.__DOCPILOT_SETTINGS__ ?? (resolveDocPilot({}, process.env) as ResolvedDocPilot)

/** The directory the command was run from — the project root, by construction. */
export const ROOT = process.cwd()

/** The VitePress site: where markdown and `public/` live. */
export const DOCS = path.resolve(ROOT, settings.docsDir)

/** Where the built index is written and read. */
export const RAG = path.resolve(ROOT, indexDirOf(settings))

/**
 * The config file the settings were read FROM — `bin/docpilot.js` found it, so
 * this is the same file rather than a second guess at where it lives.
 *
 * The commands that need it need the DEFAULT export, for the sidebar the
 * sections are grouped by. The fallback is the VitePress default path, for the
 * one caller that is not the CLI: `import.meta.url` inside the package points
 * at node_modules, so there is nothing better to fall back to.
 */
export const CONFIG = globalThis.__DOCPILOT_CONFIG__
  ? path.resolve(ROOT, globalThis.__DOCPILOT_CONFIG__)
  : path.join(DOCS, '.vitepress', 'config.mjs')

/**
 * `.env` and `.env.local` moved to `src/cli-env.ts`, and the law with them.
 *
 * Re-exported here because five modules imported it from this file, and because
 * the reason it left is worth finding from the file it left: this module
 * resolves `settings` at line 38 out of a global the launcher writes LATER, so
 * anything that imports it merely to read an environment variable runs that
 * resolution against an empty config and caches the answer. The launcher is
 * exactly such a caller — it applies the file once, before it dispatches.
 */
export { fileEnv, applyFileEnv } from './cli-env.js'

/**
 * Evaluation artefacts live in the PROJECT, not the package: a golden set is a
 * statement about one corpus, and a report is a measurement of one index. Both
 * belong in the repository whose docs they describe, under version control,
 * next to the change that moved a number.
 */
export const DOCPILOT_DIR = path.resolve(ROOT, settings.evalDir)
export const GOLDEN = path.join(DOCPILOT_DIR, 'golden.jsonl')
export const CALIBRATION_SET = path.join(DOCPILOT_DIR, 'calibration.jsonl')
export const REPORTS = path.join(DOCPILOT_DIR, 'reports')
export const CALIBRATION_OUT = path.join(DOCPILOT_DIR, 'calibration.json')

/**
 * What `docpilot tune` writes and `docpilot index` reads back.
 *
 * A separate file from `CALIBRATION_OUT` because the two have independent
 * lifecycles and, more importantly, independent AUTHORITY: thresholds are
 * `calibrate`'s alone, levers are `tune`'s alone (RAG-SPEC 7). One document
 * holding both would be one hand-edit away from moving a refusal threshold.
 *
 * It is stated HERE, once, for the reason every path above is: two modules
 * derived it independently — the writer in `eval/tune.js` and the reader in
 * `build/build-rag-index.js` — and two spellings of one path is precisely the
 * drift that made `index` report "no calibration" after every successful
 * `calibrate` for weeks (see `guardFor`).
 */
export const TUNING_OUT = path.join(DOCPILOT_DIR, 'tuning.json')

/**
 * What `docpilot vocabulary` writes and `docpilot index` reads back.
 *
 * A third sidecar rather than a key in one of the two above, for the authority
 * reason `TUNING_OUT` gives: thresholds are `calibrate`'s, levers are `tune`'s,
 * and the names a reader calls the product by are a statement about the PRODUCT
 * — proposed by a model, edited by a person, and owned by neither of the other
 * two commands. One document holding all three would be one hand-edit away from
 * moving a refusal threshold.
 */
export const VOCABULARY_OUT = path.join(DOCPILOT_DIR, 'vocabulary.json')

/**
 * Where `docpilot index` keeps the vectors it has already bought.
 *
 * A DIRECTORY beside the three files above, and deliberately NOT under
 * `indexDir`: that one is wiped whole by `fs.rmSync` at the top of every write,
 * and it is the directory the reader downloads. A megabytes-large build cache
 * published to every visitor and deleted on every run is both halves of wrong.
 *
 * Re-derivable, large, and rewritten every run — the same three properties that
 * put `calibration.raw.jsonl` in `docpilot/.gitignore`, and `docpilot init`
 * writes this one there for the same reason.
 */
export const EMBED_CACHE_DIR = path.join(DOCPILOT_DIR, 'embed-cache')
