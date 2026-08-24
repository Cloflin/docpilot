/**
 * `@cloflin/docpilot/react` — the panel in a React application.
 *
 * It imports the prebuilt bundle, because no React bundler compiles a `.vue`
 * file. `react` is an optional peer.
 */
import type { ReactElement } from 'react'
import type { MountOptions } from './mount.js'

export interface DocPilotPanelProps extends Omit<MountOptions, 'target'> {
  /** The current route, base-less. Pushed in on change; it does not remount. */
  route?: string
  lang?: string
}

export declare function DocPilotPanel(props?: DocPilotPanelProps): ReactElement

/** Open, close and ask, from anywhere under a mounted panel. */
export declare function useDocPilot(): {
  open(): void
  close(): void
  toggle(): void
  ask(question: string): void
}

export { mountDocPilot } from './mount.js'
