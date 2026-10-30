/**
 * What the browser downloads in server runtime — engine-spec 028 §2.
 *
 * ITS OWN MODULE, with no imports, so the build can measure it. `docpilot
 * index` prints the shell's size beside the manifest's when the runtime is
 * `'server'` (engine-spec 041, D-13), and importing `./index.js` for that would
 * pull the turn, the limiter and the log into the indexer. `./index.js`
 * re-exports it, so the `./server` entry is unchanged.
 */

/**
 * The manifest minus everything that is the server's business — engine-spec
 * 028 §2. Pages and sections are what the scope picker and the link checker
 * need, and they are the site's own navigation already. Thresholds, levers,
 * vocabulary and the names of the files that hold the corpus are not.
 */
export function shellManifest(manifest) {
  return {
    version: manifest.version,
    hash: manifest.hash,
    chunkCount: manifest.chunkCount,
    pages: manifest.pages,
    sections: manifest.sections,
    orphanPages: manifest.orphanPages || [],
  }
}
