<script setup>
import { computed, onMounted, ref } from 'vue'
import { useFigures } from './figures.js'

/*
 * The same vectors at three widths. The bars are drawn to scale (float32 is
 * 32 times the 1-bit blob), and grow in when the box first scrolls into view.
 */
const fig = useFigures()
const rows = computed(() => [
  { label: 'float32', bytes: fig.value.float32, w: 1, note: 'what the embedder returns' },
  { label: 'int8', bytes: fig.value.int8, w: 1 / 4, note: 'a byte per dimension' },
  { label: '1-bit', bytes: fig.value.kb, w: 1 / 32, note: 'what the browser downloads', ours: true },
])
const shown = ref(false)
const root = ref(null)
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') return (shown.value = true)
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting) {
      shown.value = true
      io.disconnect()
    }
  })
  io.observe(root.value)
})
</script>

<template>
  <div ref="root" class="cz">
    <div v-for="r in rows" :key="r.label" class="cz-row" :class="{ ours: r.ours }">
      <div class="cz-k"><code>{{ r.label }}</code><span>{{ r.note }}</span></div>
      <div class="cz-track"><div class="cz-bar" :style="{ width: shown ? Math.max(r.w * 100, 1.2) + '%' : '0%' }" /></div>
      <div class="cz-v">{{ r.bytes }}</div>
    </div>
    <div class="cz-foot">
      {{ fig.chunks }} chunks × {{ fig.dims }} dims × 1 bit = {{ fig.bytes.toLocaleString('en-US') }} bytes · <b>32× smaller</b> than float32, 8× smaller than int8
    </div>
  </div>
</template>

<style scoped>
.cz {
  margin: 1.25rem 0 2rem;
  padding: 18px 20px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-background);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cz-row {
  display: grid;
  grid-template-columns: 170px 1fr 70px;
  align-items: center;
  gap: 14px;
}
@media (max-width: 560px) {
  .cz-row {
    grid-template-columns: 1fr 70px;
  }
  .cz-track {
    grid-column: 1 / -1;
    order: 3;
  }
}
.cz-k {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--cf-muted-foreground);
}
.cz-k code {
  align-self: flex-start;
  font-size: 13px;
  color: var(--cf-foreground);
}
.cz-track {
  height: 14px;
  border-radius: 999px;
  background: var(--cf-surface);
  overflow: hidden;
}
.cz-bar {
  height: 100%;
  border-radius: 999px;
  background: color-mix(in oklab, var(--cf-muted-foreground) 55%, transparent);
  transition: width 1.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.ours .cz-bar {
  background: var(--cf-accent);
}
.cz-v {
  text-align: right;
  font-family: var(--font-mono, monospace);
  font-size: 13px;
}
.ours .cz-v {
  color: var(--cf-accent);
  font-weight: 600;
}
.cz-foot {
  padding-top: 10px;
  border-top: 1px solid var(--cf-border);
  font-size: 13px;
  color: var(--cf-muted-foreground);
}
.cz-foot b {
  color: var(--cf-foreground);
}
</style>
