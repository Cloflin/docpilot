import { computed } from 'vue'
import { useData } from 'vitepress'

/**
 * This site's own index figures, from `themeConfig.figures` (config.mjs reads
 * them out of the committed manifest). Null-safe: with no index built the
 * demos print dashes rather than numbers nobody measured.
 */
export function useFigures() {
  const { theme } = useData()
  return computed(() => {
    const f = theme.value.figures
    return (
      f ?? { chunks: '—', dims: '—', pages: '—', bytes: 0, kb: '—', int8: '—', float32: '—', tau: null, embedModel: '—' }
    )
  })
}
