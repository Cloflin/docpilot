<script setup>
/** The last line of every page: licence, and who built it. */
</script>

<template>
  <footer class="sf-foot">
    <span>Released under the MIT License.</span>
    <span>
      Built by
      <a href="https://github.com/Cloflin" target="_blank" rel="noreferrer">oponamarchuk</a>
    </span>
  </footer>
</template>

<style scoped>
.sf-foot {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 16px;
  padding: 28px 16px 40px;
  font-size: 12.5px;
  color: var(--cf-muted-foreground);
  border-top: 1px solid var(--cf-border);
}
.sf-foot a {
  color: var(--cf-foreground);
  text-decoration: underline;
  text-decoration-color: var(--cf-border);
  text-underline-offset: 3px;
  transition: text-decoration-color 0.2s;
}
.sf-foot a:hover {
  text-decoration-color: currentColor;
}
</style>
