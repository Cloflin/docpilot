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
 * The version is pinned exactly in package.json.
 */

/**
 * Still async, so the callers that awaited the old lazy import need no change.
 */
export async function parseDocument(html: string): Promise<any> {
  return parseHTML(html).document
}
