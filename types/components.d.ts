/**
 * The five single-file components, for a project that composes them by hand.
 *
 * Loosely typed on purpose: their props are few and the panel's real surface is
 * the config, which `config.d.ts` describes in full. A generated declaration
 * here would state the whole internal shape of a 2000-line component and pin it.
 */
import type { DefineComponent } from 'vue'

export declare const DocPilot: DefineComponent<{}>
export declare const DocPilotTrigger: DefineComponent<{ variant?: 'nav' | 'fab' | 'screen' }>
export declare const DocPilotCta: DefineComponent<{}>
export declare const DocPilotIcons: DefineComponent<{}>
export declare const DocPilotQuote: DefineComponent<{}>
