/**
 * Where a CLI run gets its settings and its paths.
 *
 * Inside the project this was extracted from, every tool imported the site's
 * own config and resolved paths relative to its own file. Both stop working the
 * moment the code lives in node_modules: `import.meta.dirname` points at the
 * package, and there is no `../docs` above it.
 *
 * So the contract inverts. `bin/ask-ai.js` resolves the consumer's settings
 * once and puts them here; every path below is relative to the directory the
 * command was RUN from, which is the project root by construction — the config
 * file the settings came from was found relative to the same cwd.
 *
 * Importing it outside a CLI run is not an error, but it is not useful either:
 * see the note on `settings` for why the fallback is safe.
 */
import path from 'node:path'
import { indexDirOf, resolveAskAI } from './config.js'

/**
 * `bin/ask-ai.js` puts the resolved settings here before importing any command,
 * so by the time a command reads this the answer is always the project's own.
 *
 * Falling back to defaults rather than throwing is deliberate but narrow: unit
 * tests import pure helpers out of the same modules that read these paths, and
 * a throw at module scope would make them untestable without a fake global.
 * Nothing here WRITES anything — every command resolves its output path from
 * these values inside its own main(), which only a real CLI run reaches.
 */
export const settings = globalThis.__ASK_AI_SETTINGS__ ?? resolveAskAI({}, process.env)

/** The directory the command was run from — the project root, by construction. */
export const ROOT = process.cwd()

/** The VitePress site: where markdown and `public/` live. */
export const DOCS = path.resolve(ROOT, settings.docsDir)

/** Where the built index is written and read. */
export const RAG = path.resolve(ROOT, indexDirOf(settings))

/**
 * Evaluation artefacts live in the PROJECT, not the package: a golden set is a
 * statement about one corpus, and a report is a measurement of one index. Both
 * belong in the repository whose docs they describe, under version control,
 * next to the change that moved a number.
 */
export const ASK_AI_DIR = path.resolve(ROOT, settings.evalDir || 'ask-ai')
export const GOLDEN = path.join(ASK_AI_DIR, 'golden.jsonl')
export const CALIBRATION_SET = path.join(ASK_AI_DIR, 'calibration.jsonl')
export const REPORTS = path.join(ASK_AI_DIR, 'reports')
export const CALIBRATION_OUT = path.join(ASK_AI_DIR, 'calibration.json')
