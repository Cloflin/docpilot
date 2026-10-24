<script setup>
import { withBase } from 'vitepress'
import InstallTabs from './InstallTabs.vue'
import ScopeDemo from '../demos/ScopeDemo.vue'
import SourcesDemo from '../demos/SourcesDemo.vue'
import QuoteDemo from '../demos/QuoteDemo.vue'
import FallbackDemo from '../demos/FallbackDemo.vue'
import MemoryDemo from '../demos/MemoryDemo.vue'
import I18nDemo from '../demos/I18nDemo.vue'
import GateDemo from '../demos/GateDemo.vue'
import HistoryDemo from '../demos/HistoryDemo.vue'

/*
 * The landing page, after unlumen UI's: a quiet full-height hero, a short note,
 * then the real thing — the feature mock-ups, live, each linking to its page.
 */
const pieces = [
  { c: QuoteDemo, title: 'Ask about a selection', link: '/features/quote', wide: true },
  { c: SourcesDemo, title: 'Sources and passages', link: '/features/sources' },
  { c: ScopeDemo, title: 'Search scope', link: '/features/scope' },
  { c: MemoryDemo, title: 'Conversation memory', link: '/features/memory', wide: true },
  { c: FallbackDemo, title: 'Model fallback', link: '/features/fallback' },
  { c: HistoryDemo, title: 'Conversation history', link: '/features/history', wide: true },
  { c: GateDemo, title: 'Relevance gate', link: '/features/gate', wide: true },
  { c: I18nDemo, title: 'Every language', link: '/features/i18n' },
]
</script>

<template>
  <div class="hm">
    <section class="hm-hero">
      <div class="hm-eyebrow hm-in" style="--d: 0ms">Open source · MIT · any site</div>
      <h1 class="hm-title hm-in" style="--d: 80ms">An AI assistant for any site<span class="hm-dot">.</span></h1>
      <p class="hm-sub hm-in" style="--d: 160ms">
        A chat widget that answers from <a :href="withBase('/introduction#rag-in-plain-words')">your own pages</a>, cites
        <a :href="withBase('/features/sources')">every claim</a>, and keeps your
        <a :href="withBase('/guide/security')">model key</a> off the page — on VitePress, Docusaurus, React, Vue or a
        single script tag.
      </p>
      <div class="hm-cta hm-in" style="--d: 240ms">
        <a class="hm-btn primary" :href="withBase('/guide/')">Get started</a>
        <a class="hm-btn" :href="withBase('/introduction')">Introduction</a>
      </div>
      <div class="hm-install hm-in" style="--d: 320ms">
        <InstallTabs />
      </div>
    </section>

    <section class="hm-note">
      <div class="hm-note-h">
        <span>Why it exists</span>
      </div>
      <p>
        Hosted answer services keep your content, your readers' questions and the price. DocPilot keeps none of them:
        the search index is a static file you build, the search runs in the reader's browser, and the only server is the
        one already serving your site.
      </p>
      <p>
        It is built for <em>grounded</em> answers — every claim numbered, every citation checked against what was
        actually retrieved, and a plain “I couldn’t find this” when your pages don’t say.
      </p>
      <p>
        Start with the <a :href="withBase('/introduction')">introduction</a>, read why it is
        <a :href="withBase('/guide/security')">safe to ship</a>, or try the pieces below.
      </p>
    </section>

    <section class="hm-pieces">
      <h2 class="hm-h2">A few pieces you can try<span class="hm-dot">.</span></h2>
      <div class="hm-grid">
        <a v-for="p in pieces" :key="p.title" :href="withBase(p.link)" class="hm-card" :class="{ wide: p.wide }">
          <div class="hm-stage"><component :is="p.c" /></div>
          <div class="hm-label">{{ p.title }} <span>→</span></div>
        </a>
      </div>
      <div class="hm-more">
        <a class="hm-btn" :href="withBase('/features/')">All features</a>
      </div>
    </section>

  </div>
</template>

<style scoped>
.hm {
  color: var(--cf-foreground);
}
.hm a {
  color: inherit;
  text-decoration: none;
}
.hm-hero {
  min-height: calc(100dvh - 4rem);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 48px 16px 64px;
  text-align: center;
}
.hm-eyebrow {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cf-muted-foreground);
}
.hm-title {
  margin: 0;
  font-family: var(--font-serif, serif);
  font-weight: 400;
  font-size: clamp(40px, 7vw, 76px);
  line-height: 1.02;
  letter-spacing: -0.01em;
  max-width: 14ch;
}
.hm-dot {
  color: var(--cf-accent);
}
.hm-sub {
  max-width: 560px;
  margin: 0;
  font-size: 17px;
  line-height: 1.6;
  color: var(--cf-muted-foreground);
}
.hm-sub a,
.hm-note a {
  color: var(--cf-accent);
}
.hm-sub a:hover,
.hm-note a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.hm-cta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}
.hm-btn {
  display: inline-flex;
  align-items: center;
  height: 40px;
  padding: 0 18px;
  border-radius: 10px;
  border: 1px solid var(--cf-border);
  font-size: 14px;
  font-weight: 500;
  transition: transform 0.15s, background-color 0.2s, opacity 0.2s;
}
.hm-btn:hover {
  background: var(--cf-accent-bg);
}
.hm-btn:active {
  transform: scale(0.97);
}
.hm-btn.primary {
  background: var(--cf-primary);
  color: var(--cf-primary-foreground) !important;
  border-color: transparent;
}
.hm-btn.primary:hover {
  opacity: 0.88;
}
.hm-install {
  width: 100%;
  display: flex;
  justify-content: center;
  margin-top: 12px;
}
.hm-in {
  animation: hm-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: var(--d);
}
@keyframes hm-up {
  from {
    opacity: 0;
    transform: translateY(12px);
    filter: blur(4px);
  }
}
:root[data-cf-motion='off'] .hm-in {
  animation: none;
}

.hm-note {
  max-width: 600px;
  margin: 0 auto;
  padding: 40px 16px 72px;
  font-size: 15.5px;
  line-height: 1.7;
  color: var(--cf-muted-foreground);
}
.hm-note p {
  margin: 0 0 14px;
}
.hm-note em {
  font-family: var(--font-serif, serif);
  font-size: 1.1em;
  color: var(--cf-foreground);
}
.hm-note-h {
  margin-bottom: 14px;
  font-weight: 500;
  color: var(--cf-foreground);
}

.hm-pieces {
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px 16px 64px;
}
.hm-h2 {
  margin: 0 0 28px;
  text-align: center;
  font-family: var(--font-serif, serif);
  font-weight: 400;
  font-size: clamp(30px, 4vw, 42px);
}
.hm-grid {
  display: grid;
  gap: 12px;
}
@media (min-width: 900px) {
  .hm-grid {
    grid-template-columns: repeat(3, 1fr);
    grid-auto-flow: dense;
  }
  .hm-card.wide {
    grid-column: span 2;
  }
}
.hm-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cf-border);
  border-radius: 16px;
  overflow: hidden;
  background: var(--cf-surface);
  transition: border-color 0.2s;
}
.hm-card:hover {
  border-color: color-mix(in oklab, var(--cf-accent) 45%, var(--cf-border));
}
.hm-stage {
  flex: 1;
  min-height: 420px;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background-image: radial-gradient(color-mix(in oklab, var(--cf-muted-foreground) 25%, transparent) 1px, transparent 1px);
  background-size: 16px 16px;
  pointer-events: none;
}
.hm-label {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--cf-muted-foreground);
  border-top: 1px solid var(--cf-border);
  background: var(--cf-background);
}
.hm-card:hover .hm-label {
  color: var(--cf-foreground);
}
.hm-more {
  display: flex;
  justify-content: center;
  margin-top: 28px;
}
</style>
