<script setup>
/**
 * The body of "Roadmap to 3.0": HTML that `docs/guide/roadmap-3.data.js` renders
 * at build time from the GitHub pre-release. It is a component, not Markdown,
 * so that the indexer never reads it — see `docs/.vitepress/roadmap-source.mjs`.
 */
import { data } from '../../../guide/roadmap-3.data.js'
</script>

<template>
  <section class="roadmap" aria-label="The 3.0 roadmap">
    <p class="roadmap__source">
      <template v-if="data.source === 'github'">
        Read from the GitHub pre-release <a :href="data.url">roadmap-3.0</a> when this site was built.
      </template>
      <template v-else>
        A copy of the GitHub pre-release <a :href="data.url">roadmap-3.0</a>, saved on {{ data.capturedAt }}:
        the pre-release could not be read when this site was built.
      </template>
    </p>
    <div class="roadmap__body" v-html="data.html" />
  </section>
</template>

<style scoped>
.roadmap__source {
  font-size: 13px;
  color: var(--cf-muted-foreground);
}
.roadmap__body :deep(table) {
  display: block;
  overflow-x: auto;
}
</style>
