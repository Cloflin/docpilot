---
title: TypeScript
---

# TypeScript

Every entry point ships hand-written declarations. There is nothing to install and
no `@types/` package.

```bash
npm i @cloflin/docpilot
```

On Yarn, pnpm, Bun or Deno, take that line from
[Installing](/install/#installing-it) instead.

```ts
import { defineDocPilot, type DocPilotSettings } from '@cloflin/docpilot'

const docPilot: DocPilotSettings = {
  product: 'Acme Editor',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
  host: { base: '/docs/', search: false },
}

const ai = defineDocPilot(docPilot, process.env)
```

`provider` is a union of the fourteen adapters the package speaks, so a typo is a
compile error rather than a runtime one — which matters, because the runtime one
is a panel that refuses every question with a message about the corpus.

## The types you will actually name

| type | from | what it is |
|---|---|---|
| `DocPilotSettings` | `@cloflin/docpilot` | what you pass to `defineDocPilot` |
| `DocPilotThemeConfig` | `@cloflin/docpilot` | the client half — no key, no upstream host |
| `MountOptions`, `DocPilotInstance` | `@cloflin/docpilot/mount` | mounting and the handle |
| `Highlighter` | `@cloflin/docpilot/highlight` | the adapter contract |
| `HostBinding`, `HostSelectors` | `@cloflin/docpilot/host` | what a host supplies |
| `DocPilotDocusaurusOptions` | `@cloflin/docpilot/docusaurus` | the plugin's options |
| `DocPilotPanelProps` | `@cloflin/docpilot/react` | the React component |

## Mounting, typed

```ts
import { mountDocPilot, type DocPilotInstance } from '@cloflin/docpilot/mount'

const panel: DocPilotInstance = mountDocPilot({
  config: ai.themeConfig,
  route: location.pathname,
  trigger: 'fab',
})
```

## A highlighter of your own

`Highlighter` is the type worth reading, because it is the API this package asks
you to implement:

```ts
import { setHighlighter, type Highlighter } from '@cloflin/docpilot/highlight'

const mine: Highlighter = {
  id: 'mine',
  loaded: () => ['ts', 'js'],
  render: (code, lang) => `<pre tabindex="0"><code>${escape(code)}</code></pre>`,
}

setHighlighter(mine)
```

`render` is typed `(code: string, lang: string) => string | null` and the
declaration says why it may not be async: the answer is re-rendered on a timer
while it streams. The rest of the contract is on
[Syntax highlighting](/reference/highlighting).

## Module resolution

The declarations are wired through conditional exports:

```json
"./mount": { "types": "./types/mount.d.ts", "default": "./dist/mount.js" }
```

Which means your `tsconfig.json` needs a resolver that reads `exports`:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"
  }
}
```

`"bundler"`, `"node16"` and `"nodenext"` all work. **`"node"` (the classic
resolver) does not** — it ignores `exports` entirely, and every subpath import
resolves to `any`. The top-level `types` field keeps `@cloflin/docpilot` itself
working there, but nothing below it.

## Why hand-written and not generated

The source is TypeScript and `tsc` does emit declarations, into `dist/`. They are
not what you import: `exports` names `types/` for every subpath, and those files
are written by hand.

The reason is that the two describe different things. A generated declaration
states the whole internal shape of whatever produced it — a 3000-line component,
a resolver with fourteen private helpers — and pins it, so a rename inside the
package becomes a breaking change to somebody's build. The hand-written surface
says only what this package promises. `DocPilot` is `DefineComponent<{}>` there
on purpose.

What changed at 0.6.0 is that the code now has to AGREE with it. Each module
imports its own published interface and attaches it at the point of definition —
`useHost(): HostBinding`, `resolveDocPilot(settings: DocPilotSettings)` — so
`npm run typecheck` compares the implementation against the contract rather than
against itself. Seven places where the two had drifted apart were found and
fixed in the commit that introduced the rule.
