<script setup>
// What the browser ends up fetching, so the numbers below stay checkable.
const artifacts = [
  { name: 'docpilot-index.json', note: 'chunks + postings' },
  { name: 'docpilot-vectors.bin', note: 'quantised embeddings' },
]

// The two citations the turn in the hero produced, and one the host dropped.
const citations = [
  { marker: '1', target: 'guide/indexing', state: 'checked' },
  { marker: '2', target: 'reference/cli', state: 'checked' },
  { marker: '3', target: 'guide/deploying', state: 'dropped' },
]
</script>

<template>
  <section
    class="wrapper wrapper--ticks border-t grid lg:grid-cols-2 divide-x divide-y divide-nickel"
  >
    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-balance sm:text-pretty text-white">No infrastructure</h5>
        <p class="sm:max-w-[30rem] text-pretty">
          The index is a static file built at deploy time and fetched by the
          browser
        </p>
      </div>
      <div class="p-5 sm:p-15 flex flex-col gap-6">
        <ul class="flex flex-col gap-2 list-none">
          <li
            v-for="file in artifacts"
            :key="file.name"
            class="flex items-center justify-between gap-4 bg-slate rounded px-3 py-2"
          >
            <span class="font-mono text-sm text-white">{{ file.name }}</span>
            <span class="font-mono text-xs text-grey">{{ file.note }}</span>
          </li>
        </ul>
        <p class="text-sm">
          No vector database, no search service, no server beyond the one already
          serving your site.
        </p>
      </div>
    </div>

    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-white">Refuses before it spends</h5>
        <p class="max-w-[30rem] text-pretty">
          A calibrated relevance floor settles off-topic questions with zero model
          calls
        </p>
      </div>
      <div class="p-5 sm:p-15 flex flex-col gap-5">
        <div class="flex flex-col gap-2">
          <div class="relative h-3 rounded-full overflow-hidden bg-slate">
            <div class="absolute inset-y-0 left-0 w-[38%] bg-nickel"></div>
            <div class="absolute inset-y-0 left-[38%] right-0 gate-pass"></div>
            <div class="absolute inset-y-0 left-[38%] w-px bg-white"></div>
          </div>
          <div class="flex justify-between font-mono text-xs text-grey">
            <span>refused &middot; 0 tokens</span>
            <span class="text-white">threshold</span>
            <span>answered</span>
          </div>
        </div>
        <p class="text-sm">
          The threshold is measured against your corpus by
          <span class="font-mono text-white">docpilot calibrate</span>, not copied
          from ours.
        </p>
      </div>
    </div>

    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-white">Citations you can check</h5>
        <p class="max-w-[26rem] text-pretty">
          Every marker resolves to a chunk the host put in front of the model
        </p>
      </div>
      <div class="p-5 sm:p-15 flex flex-col gap-5">
        <ul class="flex flex-col gap-2 list-none">
          <li
            v-for="citation in citations"
            :key="citation.marker"
            class="flex items-center gap-3 bg-slate rounded px-3 py-2"
            :class="citation.state === 'dropped' ? 'opacity-50' : ''"
          >
            <span
              class="font-mono text-xs rounded px-1.5 py-0.5"
              :class="
                citation.state === 'checked'
                  ? 'bg-white/10 text-dp-violet'
                  : 'bg-white/5 text-grey line-through'
              "
              >{{ citation.marker }}</span
            >
            <span
              class="font-mono text-sm"
              :class="citation.state === 'checked' ? 'text-white' : 'text-grey line-through'"
              >{{ citation.target }}</span
            >
            <span class="font-mono text-xs text-grey ml-auto">
              {{ citation.state === 'checked' ? 'in context' : 'not retrieved' }}
            </span>
          </li>
        </ul>
        <p class="text-sm">
          A marker pointing at a page the model invented never reaches the reader.
        </p>
      </div>
    </div>

    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-white">Honest about its limits</h5>
        <p class="max-w-[25rem] text-pretty">
          A control against a weak or injected model, not a security boundary
        </p>
      </div>
      <div class="p-5 sm:p-15 flex flex-col gap-5">
        <blockquote class="border-l-2 border-dp-violet pl-4 py-1">
          <p class="text-white text-base text-pretty">
            &ldquo;It is a control against a weak or injected model, not a security
            boundary.&rdquo;
          </p>
        </blockquote>
        <p class="text-sm">
          That sentence appears in the same words in the README, the reference and
          the guarantees page &mdash; because a caveat that gets softened in one
          place stops being a caveat.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.gate-pass {
  background-image: linear-gradient(90deg, #476be3, #9277c7 55%, #c56161);
}
</style>
