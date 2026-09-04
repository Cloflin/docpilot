<script setup>
/*
 * What the browser ends up fetching — THE REAL FILENAMES, checked against
 * `docs/public/rag/` and against what `build-rag-index.js` writes.
 *
 * This list used to read `docpilot-index.json` and `docpilot-vectors.bin`.
 * Neither string exists anywhere in this repository; they were plausible names
 * for files that are actually called something else, printed on the homepage as
 * if a reader could go and look at them. A made-up filename on a page arguing
 * that the index is just files is the worst possible place to be wrong, so the
 * hash placeholder is spelled `<hash>` rather than pinned to a build: the
 * content hash changes every time the corpus does, and a stale one here would
 * be the same failure wearing a different coat.
 */
const artifacts = [
  { name: 'manifest.json', note: 'dims, guard, shards' },
  { name: 'chunks-NN.<hash>.json', note: '250 chunks per shard' },
  { name: 'vectors.<hash>.bin', note: 'int8 embeddings' },
  { name: 'df.<hash>.json', note: 'document frequencies' },
]

// The two citations the turn in the hero produced, and one the host dropped.
const citations = [
  { marker: '1', target: 'guide/indexing', state: 'checked' },
  { marker: '2', target: 'reference/cli', state: 'checked' },
  { marker: '3', target: 'guide/deploying', state: 'dropped' },
]

/*
 * The fused ranking, as ranks rather than as scores — which is what RRF
 * actually consumes (`src/theme/docpilot/retriever.js:331-346`). The ids are
 * illustrative; the SHAPE is not: both channels always run, both carry weight
 * 1.0 (`retriever.js:102-103`), and a chunk ranked well by either one surfaces.
 *
 * DELIBERATELY NO 75/25 ANYWHERE ON THIS PAGE. `wDense: 0.75 / wLexical: 0.25`
 * are the refusal gate's weights (`gate.js:147`), not the fusion's, and
 * `retriever.js:60-61` says so in as many words. Printing them beside the word
 * "fused" would be a factual error about the one mechanism this card explains.
 */
const channels = [
  { label: 'bm25', ranks: ['c4', 'c1', 'c7', 'c2'], fused: false },
  { label: 'dense', ranks: ['c1', 'c9', 'c4', 'c3'], fused: false },
  { label: 'rrf', ranks: ['c1', 'c4', 'c9', 'c7'], fused: true },
]

/*
 * This site's own index, and the figures are the served file rather than a
 * rounded boast: 570 chunks × 1536 dims × 1 byte = 875,520 bytes, which is
 * exactly what `ls -l docs/public/rag/vectors.*.bin` prints. The float32 row is
 * the same array at 4 bytes a dimension.
 *
 * THESE MOVE WHEN THE CORPUS DOES. Adding a page changes the chunk count, and
 * the moment it does these two rows are a claim about a file that no longer
 * exists — `docs/guide/comparison.md`, `docs/guide/indexing.md` and the README
 * carry the same pair. The check is one line:
 *   node -e "const m=require('./docs/public/rag/manifest.json');console.log(m.chunkCount*m.dims)"
 * against `ls -l docs/public/rag/vectors.*.bin`.
 */
const sizes = [
  { label: 'float32', bytes: '3.3 MB', width: '100%', dim: true },
  { label: 'int8', bytes: '855 KB', width: '25%', dim: false },
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
          The index is a static file built at deploy time, so the panel goes
          wherever your pages already go
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
          serving your site &mdash; a docs site, a landing page, or an app you
          already ship.
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

    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-white">Two channels, fused</h5>
        <p class="max-w-[30rem] text-pretty">
          Keywords and meaning are different questions, so both are asked and the
          answers are merged by rank
        </p>
      </div>
      <div class="p-5 sm:p-15 flex flex-col gap-5">
        <ul class="flex flex-col gap-2 list-none">
          <li
            v-for="channel in channels"
            :key="channel.label"
            class="flex items-center gap-3"
            :class="channel.fused ? 'pt-2 border-t border-nickel' : ''"
          >
            <span
              class="font-mono text-xs w-12 shrink-0"
              :class="channel.fused ? 'text-dp-violet' : 'text-grey'"
              >{{ channel.label }}</span
            >
            <span class="flex gap-1.5">
              <span
                v-for="(id, position) in channel.ranks"
                :key="position"
                class="font-mono text-xs rounded px-2 py-1"
                :class="channel.fused ? 'bg-white/10 text-white' : 'bg-slate text-grey'"
                >{{ id }}</span
              >
            </span>
          </li>
        </ul>
        <p class="text-sm">
          BM25 over the chunk text and cosine over the vectors, fused with
          <span class="font-mono text-white">Reciprocal Rank Fusion</span> and then
          re-ranked by cosine. With no embedder, or one that cannot be reached, the
          keyword channel runs alone and the gate switches to its lexical threshold.
        </p>
      </div>
    </div>

    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-white">Vectors a browser can afford</h5>
        <p class="max-w-[28rem] text-pretty">
          Quantised to one byte per dimension at build time, with the error
          measured rather than assumed
        </p>
      </div>
      <div class="p-5 sm:p-15 flex flex-col gap-5">
        <ul class="flex flex-col gap-2.5 list-none">
          <li v-for="size in sizes" :key="size.label" class="flex flex-col gap-1">
            <div class="flex items-baseline justify-between gap-4 font-mono text-xs">
              <span :class="size.dim ? 'text-grey' : 'text-white'">{{ size.label }}</span>
              <span :class="size.dim ? 'text-grey' : 'text-white'">{{ size.bytes }}</span>
            </div>
            <div class="h-2 rounded-full bg-slate overflow-hidden">
              <div
                class="h-full rounded-full"
                :class="size.dim ? 'bg-nickel' : 'size-bar'"
                :style="{ width: size.width }"
              ></div>
            </div>
          </li>
        </ul>
        <p class="text-sm">
          This site's own index &mdash; 570 chunks at 1536 dimensions, one signed
          byte each, no per-vector scale to unpack. The build measures the
          round-trip against the exact cosines and
          <span class="text-white">refuses to ship above 0.01 mean |&Delta;cos|</span>;
          this one comes in under 0.003.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * The int8 bar is a quarter of the float32 bar because the ratio is exactly
 * four — one signed byte a dimension against four. The gradient spans the bar
 * rather than the track behind it, so the short bar is the whole brand ramp
 * compressed and not a blue stub that reads as a different colour.
 */
.gate-pass,
.size-bar {
  background-image: linear-gradient(90deg, #476be3, #9277c7 55%, #c56161);
}
</style>
