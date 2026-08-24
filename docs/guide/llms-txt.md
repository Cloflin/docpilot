# llms.txt and the crawler surface

DocPilot answers from a private index it builds itself. This is the other half: the plain-text surface that an agent which is **not** this panel can read — someone else's assistant, a crawler, a colleague piping your docs into a model.

The two share a corpus and nothing else. Improving one does not improve the other, and no metric in any DocPilot report moves when you change this.

## The generator plugin is VitePress's, DocPilot is not

DocPilot mounts on six hosts — VitePress, Docusaurus, Vue, React, any bundler with the Vue plugin, and a bare `<script>` tag — and it answers from an index `npx docpilot index` builds by walking markdown files, which knows nothing about the generator that renders them. See [Installing](/install/).

What is VitePress-only is the plugin in the next section. `vitepress-plugin-llms` is one generator's Vite plugin, so on Docusaurus, Mintlify, Starlight or MkDocs you need that generator's equivalent; the config shapes do not transfer, and a plugin API guessed at produces a build that silently emits nothing. The rest of this page — serving the files, `robots.txt`, the sitemap — is generator-independent.

## Generating it

`vitepress-plugin-llms` is the one to use, and it is **not** a dependency of this package. Adding a build-time dependency to your docs site is your decision:

```bash
npm i -D vitepress-plugin-llms
```

```js
// docs/.vitepress/config.mjs
import llmstxt from 'vitepress-plugin-llms'
import { absoluteSidebar } from '@cloflin/docpilot/sidebar'

export default defineConfig({
  vite: {
    plugins: [
      llmstxt({
        domain: 'https://docs.example.com',
        generateLLMsTxt: true,
        generateLLMsFullTxt: true,
        generateLLMFriendlyDocsForEachPage: true,
        stripHTML: true,
        sidebar: (s) => absoluteSidebar(s),
      }),
    ],
  },
})
```

That produces three things: `llms.txt` (a sidebar-ordered index with each page's `description`), `llms-full.txt` (everything, concatenated), and a `.md` beside every route.

## `absoluteSidebar` is not decoration

VitePress prefixes a sidebar group's items with the group's `base`. The llms plugin builds its index from the same object and joins the two differently, producing links like:

```
/getting-started/getting-started/creating-an-application.md
```

llms.txt exists so that another agent can **follow** those links. A doubled segment is not cosmetic there — it is the whole file failing at its one job.

`absoluteSidebar` resolves every `base` into the links themselves and hands the plugin a sidebar with nothing left to join. It is pure and non-mutating, so the object VitePress renders from is untouched.

**This is a workaround for someone else's bug.** It is exported from this package rather than pasted into every consumer's config because a workaround copied into twenty projects outlives the bug by years. Delete the import the moment the join is fixed upstream.

## Serving it

Generating the files is half the job. See [Production](/guide/production) — a host that serves `.md` as `application/octet-stream` makes an agent download your documentation instead of reading it.

## robots.txt

A `robots.txt` that names the AI crawlers you want, and your sitemap:

```
User-agent: *
Allow: /

User-agent: GPTBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: Claude-Web
Allow: /
User-agent: anthropic-ai
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Applebot
Allow: /
User-agent: CCBot
Allow: /
User-agent: cohere-ai
Allow: /

Sitemap: https://docs.example.com/sitemap.xml
```

For public documentation this is a two-minute edit with no downside: the pages are already public, and being absent from an assistant's answer is a worse outcome than being present in it. It is still your decision — a wildcard `Allow` is not the same statement as naming each agent, and the named form is the one you can revise per crawler later.

Put it at `docs/public/robots.txt`. VitePress copies `public/` verbatim.

## sitemap.xml

VitePress generates one from `themeConfig.sitemap`:

```js
sitemap: { hostname: 'https://docs.example.com' }
```

Imported pages never appear in it — they have no route, which is the point. See [Imported pages](/guide/imported-pages).
