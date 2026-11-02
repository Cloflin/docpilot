/**
 * Build-time data for `roadmap-3.md`: the GitHub pre-release `roadmap-3.0`,
 * rendered to HTML. Why the roadmap is not Markdown under `docs/`, and how the
 * committed snapshot stands in when GitHub cannot be reached, is written in
 * `docs/.vitepress/roadmap-source.mjs`.
 */
import { createMarkdownRenderer, defineLoader } from 'vitepress'
import { fileURLToPath } from 'node:url'
import { loadRoadmap, readSnapshot, renderRoadmap, ROADMAP_URL } from '../.vitepress/roadmap-source.mjs'

const DOCS = fileURLToPath(new URL('..', import.meta.url))

export default defineLoader({
  watch: ['../.vitepress/roadmap-3.snapshot.json'],
  async load() {
    const roadmap = await loadRoadmap({ snapshot: readSnapshot() })
    // `html: false`: the note comes from outside the repository, so a tag in it is text.
    const md = await createMarkdownRenderer(DOCS, { html: false, linkify: false })
    return {
      html: renderRoadmap(roadmap.body, md),
      source: roadmap.source,
      capturedAt: roadmap.capturedAt,
      url: ROADMAP_URL,
    }
  },
})
