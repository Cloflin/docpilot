/**
 * The two descriptions of this package, checked against each other.
 *
 * `types/` is hand-written and is what `exports` names; the declarations `tsc`
 * emits into `dist/` are what it inferred from the code. Neither is redundant —
 * the hand-written one says
 * what is PROMISED and the generated one says what is THERE — but they have to
 * agree, and until 0.6.0 nothing made them. Seven places where they had drifted
 * apart were found the day this file was written, including a `nodeEmbedTarget`
 * declared twice with different return types and a `scope.filter` union that
 * named two string values the code drops.
 *
 * ASSIGNABILITY, NOT EQUALITY. The generated side is allowed to be narrower —
 * that is the whole point of a hand-written surface that keeps its options open.
 * What it may not be is a different shape.
 *
 * Not shipped, and not in `tsconfig.json`: `dist/` is gitignored, so a fresh
 * clone has nothing to compare against. `npm run typecheck:dist` builds first
 * and then runs this through `tsconfig.conformance.json`.
 */
import type * as Hand from '../types/index.js'
import type * as Gen from '../dist/index.js'
import type * as HandConfig from '../types/config.js'
import type * as GenConfig from '../dist/config.js'
import type * as HandHost from '../types/host.js'
import type * as GenHost from '../dist/theme/docpilot/host.js'
import type * as HandMount from '../types/mount.js'
import type * as GenMount from '../dist/mount.js'
import type * as HandHighlight from '../types/highlight.js'
import type * as GenHighlight from '../dist/theme/docpilot/highlight.js'

type Assert<_T extends true> = never

/** The generated value is usable wherever the promised one is. */
type Satisfies<Generated, Promised> = [Generated] extends [Promised] ? true : false

// The entry point.
type _defineDocPilot = Assert<Satisfies<typeof Gen.defineDocPilot, typeof Hand.defineDocPilot>>
type _docPilotPlugin = Assert<Satisfies<typeof Gen.docPilotPlugin, typeof Hand.docPilotPlugin>>

// The config surface — the largest of the five and the one that drifted most.
type _DEFAULTS = Assert<Satisfies<typeof GenConfig.DEFAULTS, typeof HandConfig.DEFAULTS>>
type _resolveDocPilot = Assert<
  Satisfies<Parameters<typeof HandConfig.resolveDocPilot>[0], Parameters<typeof GenConfig.resolveDocPilot>[0]>
>
type _nodeEmbedTarget = Assert<
  Satisfies<ReturnType<typeof GenConfig.nodeEmbedTarget>, ReturnType<typeof HandConfig.nodeEmbedTarget>>
>
type _resolveEmbed = Assert<
  Satisfies<ReturnType<typeof GenConfig.resolveEmbed>, ReturnType<typeof HandConfig.resolveEmbed>>
>
type _indexDirOf = Assert<Satisfies<typeof GenConfig.indexDirOf, typeof HandConfig.indexDirOf>>
type _assertGuard = Assert<Satisfies<typeof GenConfig.assertGuard, typeof HandConfig.assertGuard>>

// The host binding — `HOST_KEY` was a bare `symbol` here until 0.6.0.
type _HOST_KEY = Assert<Satisfies<typeof GenHost.HOST_KEY, typeof HandHost.HOST_KEY>>
type _useHost = Assert<Satisfies<ReturnType<typeof GenHost.useHost>, ReturnType<typeof HandHost.useHost>>>
type _hostConfig = Assert<
  Satisfies<ReturnType<typeof GenHost.hostConfig>, ReturnType<typeof HandHost.hostConfig>>
>

// The two entry points a non-VitePress host uses.
type _mountDocPilot = Assert<
  Satisfies<Parameters<typeof HandMount.mountDocPilot>[0], Parameters<typeof GenMount.mountDocPilot>[0]>
>
type _setHighlighter = Assert<
  Satisfies<Parameters<typeof HandHighlight.setHighlighter>[0], Parameters<typeof GenHighlight.setHighlighter>[0]>
>
