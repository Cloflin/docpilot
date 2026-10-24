<script setup>
import { withBase } from 'vitepress'

/** A grid of linked cards: `items` is `[{ title, body, link }]`. */
defineProps({ items: { type: Array, required: true } })
</script>

<template>
  <div class="cd">
    <a v-for="i in items" :key="i.link" class="cd-card" :href="withBase(i.link)">
      <span class="cd-t">{{ i.title }}</span>
      <span class="cd-b">{{ i.body }}</span>
      <span class="cd-go">→</span>
    </a>
  </div>
</template>

<style scoped>
.cd {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin: 1.25rem 0 2rem;
}
.cd-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px 16px;
  border: 1px solid var(--cf-border);
  border-radius: 12px;
  background: var(--cf-background);
  text-decoration: none !important;
  color: var(--cf-foreground) !important;
  transition: border-color 0.2s, transform 0.2s, background-color 0.2s;
}
.cd-card:hover {
  border-color: color-mix(in oklab, var(--cf-accent) 50%, var(--cf-border));
  background: var(--cf-surface);
  transform: translateY(-1px);
}
.cd-t {
  font-weight: 600;
  font-size: 14.5px;
}
.cd-b {
  font-size: 13px;
  line-height: 1.5;
  color: var(--cf-muted-foreground);
}
.cd-go {
  position: absolute;
  top: 12px;
  right: 14px;
  color: var(--cf-muted-foreground);
  transition: transform 0.2s, color 0.2s;
}
.cd-card:hover .cd-go {
  transform: translateX(3px);
  color: var(--cf-accent);
}
</style>
