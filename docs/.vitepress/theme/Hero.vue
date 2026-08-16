<script setup>
import markIcon from './assets/docpilot-mono.svg'
</script>

<template>
  <div class="wrapper wrapper--ticks grid md:grid-cols-2 w-full border-nickel divide-x">
    <div class="flex flex-col p-10 justify-between items-center md:items-start">
      <div class="flex flex-col gap-5 text-center md:text-left items-center md:items-start">
        <span class="text-grey text-xs font-mono uppercase tracking-wide">
          MIT licensed &middot; no server
        </span>
        <h1 class="text-white text-pretty max-w-[40rem]">
          Grounded AI answers<br />inside your VitePress docs
        </h1>
        <p class="text-white/70 text-lg max-w-[30rem] text-pretty">
          Retrieval runs in the browser against a static index, and a calibrated
          gate refuses before the model is ever called
        </p>
        <div class="flex items-center gap-5 mt-6">
          <a href="/guide/getting-started" class="button button--primary inline-block w-fit">
            <span>Get Started</span>
          </a>
          <a
            href="https://github.com/cloflin/docpilot"
            target="_blank"
            rel="noopener noreferrer"
            class="button inline-flex items-center gap-2 w-fit"
          >
            <span>View on GitHub</span>
            <svg class="size-3" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M3.18228 2.81797L9.54624 2.81797L9.54624 9.18193"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
              <path
                d="M9.5459 2.81799L3.18194 9.18195"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
            </svg>
          </a>
        </div>
      </div>
      <div class="px-3 py-1.5 bg-slate rounded w-fit flex gap-2 items-center mt-10">
        <a href="/concepts/guarantees">
          <figure class="project-icon gap-3">
            <img class="size-5" loading="lazy" :src="markIcon" alt="" />
            <figcaption class="text-sm">Read what it guarantees</figcaption>
            <svg class="size-3" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M3.18228 2.81797L9.54624 2.81797L9.54624 9.18193"
                stroke="#9277C7"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
              <path
                d="M9.5459 2.81799L3.18194 9.18195"
                stroke="#9277C7"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
            </svg>
          </figure>
        </a>
      </div>
    </div>

    <div class="flex flex-col min-h-[22rem] sm:min-h-[30rem]">
      <div
        class="relative px-6 sm:px-16 h-full flex flex-col justify-center overflow-clip py-8 sm:py-16 hero-background"
      >
        <!-- A rendering of one turn, not a screenshot: it stays honest when the
             panel's markup changes, and it costs no image bytes. -->
        <div
          class="w-full max-w-[32rem] rounded-xl bg-primary/85 outline outline-white/15 p-5 flex flex-col gap-4 shadow-2xl"
        >
          <div class="flex items-center gap-2">
            <span class="size-2 rounded-full bg-dp-violet"></span>
            <span class="font-mono text-xs uppercase tracking-wide text-white/50">DocPilot</span>
          </div>

          <p class="text-white text-base">How do I rebuild the index in CI?</p>

          <div class="h-px bg-white/10"></div>

          <p class="text-white/75 text-sm leading-relaxed">
            Run the CLI as a build step before
            <span class="font-mono text-white">vitepress build</span>. It writes the
            index next to the site's static assets, so the browser fetches it like
            any other file.<sup class="text-dp-violet">1</sup>
          </p>

          <div class="flex flex-wrap gap-2">
            <span class="font-mono text-xs text-white/70 bg-white/10 rounded px-2 py-1">
              1 &middot; guide/indexing
            </span>
            <span class="font-mono text-xs text-white/70 bg-white/10 rounded px-2 py-1">
              2 &middot; reference/cli
            </span>
            <span class="font-mono text-xs text-white/40 rounded px-2 py-1">
              2 chunks retrieved
            </span>
          </div>
        </div>
      </div>

      <a href="/concepts/a-turn" class="p-5 flex gap-5 items-center relative group">
        <div
          class="h-16 aspect-[244/144] rounded bg-slate flex flex-col items-center justify-center gap-0.5 group-hover:opacity-75 group-hover:scale-105 transition-[scale,opacity]"
        >
          <span class="font-mono text-[11px] leading-tight text-dp-violet">retrieve</span>
          <span class="font-mono text-[11px] leading-tight text-dp-violet">&darr; gate</span>
          <span class="font-mono text-[11px] leading-tight text-dp-violet">&darr; cite</span>
        </div>
        <div>
          <h5 class="text-white">How a turn works</h5>
          <p class="text-base">Every step, in the order it runs</p>
        </div>
      </a>
    </div>
  </div>
</template>

<style scoped>
.hero-background {
  background-color: #476be3;
  background-image:
    radial-gradient(60% 80% at 12% 18%, rgba(126, 155, 242, 0.6), transparent 70%),
    radial-gradient(70% 90% at 92% 92%, rgba(140, 59, 87, 0.65), transparent 70%),
    linear-gradient(135deg, #476be3 0%, #9277c7 55%, #c56161 100%);
  background-size: cover;
  background-position: center;
}
</style>
