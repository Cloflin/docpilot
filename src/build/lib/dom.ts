/**
 * An HTML parser, without making one a dependency of every consumer.
 *
 * This package is a docs plugin: the overwhelming majority of installs never
 * parse HTML at all, and a DOM implementation sitting in their tree to support a
 * command they do not run is exactly the kind of weight that gets a dependency
 * removed. So it is OPTIONAL AND UNDECLARED — this package ships no peer block
 * at all, see the 'declares no peer dependencies' gate in test/packaging.test.js
 * — imported at the moment it is needed, with the install line in the error
 * rather than in a stack trace.
 *
 * THIS FILE EXISTS BECAUSE THERE ARE NOW TWO CALLERS. It was a private function
 * inside `import.js` while `docpilot import <url>` was the only thing that read
 * HTML; `index --html-dir` is the second, and a second copy of the try/catch is
 * a second copy of the install message, which is the one string a consumer who
 * hits this actually needs to be correct. `packaging.test.js` names this file as
 * the place linkedom is reached from, so a third caller that reimplements it is
 * a test failure rather than a drifting error message.
 */

/**
 * @param {string} html
 * @returns {Promise<any>} the parsed `document`
 */
export async function parseDocument(html) {
  let parseHTML
  try {
    ;({ parseHTML } = await import('linkedom'))
  } catch {
    throw new Error(
      'DocPilot needs an HTML parser, which is an optional dependency:\n' +
        '      npm i -D linkedom',
    )
  }
  return parseHTML(html).document
}
