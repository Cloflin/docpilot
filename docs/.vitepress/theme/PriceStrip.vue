<script setup>
/*
 * The price, directly under the hero.
 *
 * ONE RULE GOVERNS THIS FILE, and it is stricter than the one on
 * `Comparison.vue`: every figure in `rivals` is quoted from the vendor's OWN
 * pricing page, and a vendor who does not publish a figure gets the words
 * `not published` rather than a number sourced from a blog. Three consequences
 * that look like omissions and are not:
 *
 *   · Mintlify's Pro plan price is NOT here. Their pricing page renders it as
 *     an animated digit counter, so it cannot be quoted from the page. What IS
 *     here — 10,000 credits included, $0.01 per credit over, an assistant
 *     response averaging 23 credits — is published on `mintlify.com/pricing`
 *     and `mintlify.com/docs/credits`, and ~$0.23 an answer is those two
 *     numbers multiplied. The monthly figure lives on `/guide/comparison`,
 *     marked as third-party reported, where a caveat can be a sentence.
 *   · kapa.ai has no number at all. Growth and Enterprise are both "Talk to
 *     us", and inventing a range from a review site would be the one thing
 *     this section exists to avoid.
 *   · Algolia's row is the OVERAGE rate, not a plan price, because Ask AI is
 *     not line-itemed on their pricing page — it rides on the Algolia plan the
 *     search requests are metered against, plus an LLM key of your own.
 *
 * The `$0` opposite them is the software, and the small print under it is not
 * decoration: `docs/guide/why.md` opens its cost section with "It is worth
 * being clear about the price, because there is one", and a homepage that
 * printed a bare "absolutely free" would be contradicting the project's own
 * documentation two clicks away.
 */
const rivals = [
  {
    name: 'Algolia Ask AI',
    price: '$0.50',
    unit: 'per 1K search requests',
    note: 'the Grow overage rate — plus your own LLM key',
  },
  {
    name: 'Mintlify AI',
    price: '≈$0.23',
    unit: 'an answer',
    note: '23 credits at $0.01 over the 10,000 included',
  },
  {
    name: 'kapa.ai',
    price: 'not published',
    unit: '',
    note: '14-day trial, then “Talk to us”',
  },
  {
    name: 'Inkeep',
    price: 'free',
    unit: 'self-hosted',
    note: 'the open-source core; enterprise not published',
  },
  {
    name: 'Orama',
    price: 'free',
    unit: 'self-hosted',
    note: 'OramaJS, Apache 2.0; cloud price not published',
  },
]
</script>

<template>
  <section class="wrapper wrapper--ticks border-t grid lg:grid-cols-2 divide-x divide-nickel">
    <div class="p-5 sm:p-15 flex flex-col justify-between gap-8">
      <div class="flex flex-col gap-4">
        <span class="text-grey text-xs font-mono uppercase tracking-wide">What it costs</span>
        <div class="flex items-baseline gap-4">
          <span class="dp-figure text-white">$0</span>
          <span class="font-mono text-sm text-dp-violet">forever</span>
        </div>
        <p class="text-white text-lg text-pretty max-w-[26rem]">
          MIT &middot; no vendor &middot; no plan &middot; no per-answer fee
        </p>
      </div>

      <div class="flex flex-col gap-4">
        <p class="text-sm max-w-[30rem] text-pretty">
          <span class="text-white">You pay your model provider directly</span> — or run the
          whole thing on OpenRouter's free tier: one key, no card, and a ceiling of
          50 requests a day that also covers rebuilding the index.
        </p>
        <div class="flex flex-wrap gap-3">
          <a href="/guide/free-tier" class="button button--sm w-fit">
            <span>Living on the free tier</span>
          </a>
          <a
            href="https://github.com/Cloflin/docpilot/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            class="button button--sm w-fit"
          >
            <span>MIT License</span>
          </a>
        </div>
      </div>
    </div>

    <div class="p-5 sm:p-15 flex flex-col gap-5">
      <span class="text-grey text-xs font-mono uppercase tracking-wide">
        What the others ask
      </span>
      <ul class="flex flex-col gap-2 list-none">
        <li
          v-for="rival in rivals"
          :key="rival.name"
          class="bg-slate rounded px-3 py-2.5 flex flex-col gap-1"
        >
          <div class="flex items-baseline justify-between gap-4">
            <span class="text-white text-sm">{{ rival.name }}</span>
            <span class="font-mono text-sm shrink-0" :class="rival.unit ? 'text-white' : 'text-grey'">
              {{ rival.price }}
              <span v-if="rival.unit" class="text-grey">{{ rival.unit }}</span>
            </span>
          </div>
          <span class="font-mono text-[11px] text-grey leading-tight">{{ rival.note }}</span>
        </li>
      </ul>
      <p class="text-sm text-pretty">
        Published prices, checked August 2026, quoted from each vendor's own
        pricing page. <span class="text-white">Where a vendor publishes no
        figure, this says so</span> rather than repeating one from a review site
        — the monthly plan prices, and what each of them buys, are on
        <a href="/guide/comparison#price" class="text-dp-violet">the comparison page</a>.
      </p>
    </div>
  </section>
</template>

<style scoped>
/*
 * Bigger than any heading the theme defines, because the number IS the
 * argument and `h2` at this size still reads as a section title. Clamped
 * rather than stepped: it sits beside a `text-sm` word at every width, and a
 * breakpoint jump would break that pairing halfway through the range.
 */
.dp-figure {
  font-family: var(--font-heading, inherit);
  font-size: clamp(3.5rem, 9vw, 6rem);
  font-weight: 500;
  line-height: 0.9;
  letter-spacing: -0.04em;
}
</style>
