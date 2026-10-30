import { parseHTML } from 'linkedom'

/**
 * The HTML parser, reached from one place.
 *
 * 3.0 makes HTML a first-class source (engine-spec 043, D-01): `docpilot import`
 * and `index --html-dir` have to work after `npm i @cloflin/docpilot` with
 * nothing else installed, so linkedom is a regular dependency, pinned to an
 * exact version in package.json, and the hint to install it by hand is gone.
 *
 * IT NEVER ENTERS THE BROWSER BUNDLE. This module is build-side: the reader's
 * IIFE imports nothing under `src/build/`, and `test/bundle-report.test.js`
 * fails if a parser module ever shows up in its composition (D-04).
 *
 * THIS FILE STAYS THE ONE PLACE linkedom IS IMPORTED. It was a private function
 * inside `import.js` while `docpilot import <url>` was the only thing that read
 * HTML; `index --html-dir` is the second reader, and a second import is a
 * second place to change when the parser changes. `test/packaging.test.js` names
 * this file as the only importer, so a third caller that reaches around it is a
 * test failure rather than a drifting copy.
 *
 * The version is pinned exactly in package.json, and `PARSER_PINS` below states
 * the versions of the parser's own dependencies the extractor was measured with.
 */

/**
 * linkedom declares caret ranges for its own dependencies (research P-11), so a
 * fresh install could resolve a different tokenizer and change the Markdown
 * that comes out of the same HTML. This is the set the extractor was measured
 * with. Changing any value is an EXTRACTOR_VERSION bump in
 * src/build/lib/extract-html.ts (D-16), because the corpus hash of an HTML
 * source has to move when the text it indexes can move.
 *
 * `entities` is htmlparser2's copy, resolved from htmlparser2's directory; the
 * one markdown-it brings is a different package line and is not pinned here.
 * `test/packaging.test.js` compares these with what is installed.
 */
export const PARSER_PINS = {
  linkedom: '0.18.14',
  htmlparser2: '10.1.0',
  'css-select': '7.0.0',
  entities: '7.0.1',
} as const

/**
 * Still async, so the callers that awaited the old lazy import need no change.
 */
export async function parseDocument(html: string): Promise<any> {
  return parseHTML(html).document
}
