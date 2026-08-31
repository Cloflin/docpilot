/**
 * See DocPilot.d.vue.ts for why this file exists.
 *
 * The one component with a prop. The union is stated HERE and not in the SFC:
 * the component degrades on an unknown variant with a console error rather than
 * throwing, and a union inside `defineProps` would make that branch unreachable
 * for TypeScript callers while JavaScript callers still reach it.
 */
import type { DefineComponent } from 'vue'
declare const component: DefineComponent<{ variant?: 'nav' | 'fab' | 'screen' }>
export default component
