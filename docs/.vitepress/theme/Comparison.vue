<script setup>
/*
 * The comparison table, on the marketing page.
 *
 * THE HARD PART IS NOT THE LAYOUT, it is that five of the six columns describe
 * somebody else's product. Three rules hold this file honest, and they are the
 * reason the data is a literal here rather than prose in the template:
 *
 *   1. A cell nobody has published reads `not documented` — never `no`. The
 *      absence of a claim in a vendor's docs is not a claim about the vendor,
 *      and a marketing table that treats it as one is a table that gets a
 *      correction issued against it.
 *   2. Every non-DocPilot cell is sourced on `/guide/comparison`, which carries
 *      the links and the date this was checked. The footer under the table is
 *      not decoration; it is the citation.
 *   3. DocPilot's own column states only settings that exist or guarantees
 *      that have tests. `docs/guide/comparison.md` carries the same claims in
 *      the same words, and the honest half — `What DocPilot is worse at` — is
 *      linked from here rather than buried.
 *
 * `tone` drives colour only. `own` is this project's column, `dim` is an
 * unpublished fact, and everything else is a plain statement about a product
 * that is not ours — rendered in the same weight as every other, because a
 * competitor's row set in a quieter grey is an argument made with CSS.
 */
const products = [
  { name: 'DocPilot', note: 'MIT', own: true },
  { name: 'Algolia Ask AI', note: 'SaaS' },
  { name: 'kapa.ai', note: 'SaaS' },
  { name: 'Inkeep', note: 'fair-code' },
  { name: 'Mintlify AI', note: 'platform' },
  { name: 'Orama', note: 'Apache 2.0' },
]

const groups = [
  /*
   * PRICE FIRST, and it was not always. The table used to open on architecture
   * and reach cost two screens down, which is the order the author finds
   * interesting rather than the order a reader evaluates in.
   *
   * `Published price` is quoted from each vendor's own pricing page and nowhere
   * else — see the sourcing note in `PriceStrip.vue`, which carries the same
   * five figures and must not drift from these. Mintlify's monthly plan price
   * is absent on purpose: their pricing page renders it as an animated counter,
   * so it is on `/guide/comparison` marked as third-party reported instead.
   */
  {
    title: 'Price',
    rows: [
      {
        label: 'Published price',
        cells: [
          '$0 — MIT, no vendor',
          '$0.50 per 1K search requests (Grow overage)',
          'not published',
          'free self-hosted; enterprise not published',
          '≈$0.23 an answer over the included credits',
          'free self-hosted; cloud price not published',
        ],
      },
      {
        label: 'Paid to the vendor',
        cells: [
          'nothing — there is no vendor',
          'your Algolia plan',
          'platform fee plus answer volume',
          'quoted; the self-hosted core is free',
          'your plan, plus AI credits per answer',
          'your Orama plan; the OSS core is free',
        ],
      },
      {
        label: 'Whose model key',
        cells: ['yours', 'yours', "kapa's", 'yours', "Mintlify's", 'yours'],
      },
      {
        label: 'An off-topic question costs',
        cells: [
          'zero model calls, zero tokens',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
        ],
      },
      {
        label: 'Free path to a running panel',
        cells: [
          'yes — one OpenRouter key, no card',
          'DocSearch is free for qualifying public docs',
          '14-day trial',
          'yes — self-host the OSS core',
          'no — the Starter plan has no AI',
          'yes — OramaJS with your own key',
        ],
      },
    ],
  },
  {
    title: 'Architecture',
    rows: [
      {
        label: 'Index the reader downloads',
        cells: [
          'int8, one byte per dimension — 942 KB for 471 chunks',
          'n/a — the index is theirs',
          'n/a — the index is theirs',
          'n/a — the index is theirs',
          'n/a — the index is theirs',
          'n/a, unless you ship an OSS bundle',
        ],
      },
      {
        label: 'Where retrieval runs',
        cells: [
          "the reader's browser",
          "Algolia's cloud",
          "kapa's cloud",
          'their cloud, or yours',
          "Mintlify's cloud",
          'their cloud, or the browser',
        ],
      },
      {
        label: 'Where the index lives',
        cells: [
          'a static file on the host already serving your site',
          'an Algolia index',
          'their platform',
          'their platform, or self-hosted',
          'the Mintlify platform',
          'their cloud, or a bundle you ship',
        ],
      },
      {
        label: 'Server you must run',
        cells: [
          'one proxy route that attaches the model key',
          'none',
          'none',
          'none, unless you self-host',
          'none',
          'none',
        ],
      },
      {
        label: 'Self-hostable',
        cells: [
          'there is nothing to host',
          'no',
          'no',
          'yes',
          'no',
          'yes — the OSS core',
        ],
      },
      {
        label: 'Mounts on a page that is not a docs site',
        cells: ['yes', 'yes', 'yes', 'yes', 'no', 'yes'],
      },
    ],
  },
  {
    title: 'Grounding',
    rows: [
      {
        label: 'Refuses before the model is called',
        cells: [
          'yes — a calibrated relevance floor',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
        ],
      },
      {
        label: 'Threshold measured against your corpus',
        cells: [
          'yes — docpilot calibrate',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
        ],
      },
      {
        label: 'Every citation checked against what was retrieved',
        cells: [
          'yes, by host code no message can reach',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
        ],
      },
      {
        label: 'Offline A/B and sweep of the retrieval levers',
        cells: [
          'yes — bench, tune, eval',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
          'not documented',
        ],
      },
    ],
  },
]

/*
 * Three tones, and only one of them is a judgement.
 *
 * `dim` is reserved for the cells that are an ABSENCE — a mechanism the vendor
 * publishes nothing about, a price they do not print, a row that does not apply
 * because the index is theirs. It is quieter so the eye does not read those
 * three words as a finding; it is not there to make a competitor look worse,
 * which is why an actual published price or an actual documented behaviour is
 * set in the same weight as ours.
 */
const ABSENT = /^(not documented|not published|n\/a\b)/

const toneOf = (cell, index) => {
  if (index === 0) return 'own'
  return ABSENT.test(cell) ? 'dim' : 'plain'
}
</script>

<template>
  <section class="wrapper wrapper--ticks border-t">
    <div class="p-5 sm:p-15 flex flex-col gap-8">
      <p class="lg:hidden font-mono text-[11px] text-grey -mb-4">
        Scroll the table sideways &rarr;
      </p>
      <!--
        THE SCROLLER, NOT THE PAGE. `.wrapper` is `overflow-x-clip`, so a table
        wider than the column would be silently cut rather than reachable; this
        box is exactly as wide as the content column and scrolls inside itself,
        which is the same contract the reference tables have in `styles.css`.

        And no full-bleed. The negative margin that would let the table use the
        section's own padding also moves the scrollport's left edge, and
        `position: sticky; left: 0` is measured from THAT edge — so the row
        labels would come to rest flush against the section border while every
        other line on the page starts 20px in. The width is not worth the one
        column that is on screen the whole time being the one misaligned thing.
      -->
      <div class="dp-scroller overflow-x-auto">
        <table class="dp-table w-full min-w-[62rem] border-collapse text-left">
          <caption class="sr-only">
            DocPilot compared with five hosted documentation answer services, on
            architecture, grounding and cost. Checked August 2026.
          </caption>
          <thead>
            <tr>
              <!-- A `td`, not an empty `th`: the corner cell heads nothing, and
                   a header cell with no text is announced as one. -->
              <td class="dp-head-label"></td>
              <th
                v-for="product in products"
                :key="product.name"
                class="dp-head"
                :class="product.own ? 'dp-head--own' : ''"
                scope="col"
              >
                <span class="block text-white text-sm font-medium">{{ product.name }}</span>
                <span class="block font-mono text-[11px] text-grey mt-0.5">{{ product.note }}</span>
              </th>
            </tr>
          </thead>

          <tbody v-for="group in groups" :key="group.title">
            <tr>
              <th class="dp-group" :colspan="products.length + 1" scope="colgroup">
                <span class="font-mono text-[11px] uppercase tracking-wide text-dp-violet">
                  {{ group.title }}
                </span>
              </th>
            </tr>
            <tr v-for="row in group.rows" :key="row.label">
              <th class="dp-label" scope="row">{{ row.label }}</th>
              <td
                v-for="(cell, index) in row.cells"
                :key="index"
                class="dp-cell"
                :class="`dp-cell--${toneOf(cell, index)}`"
              >
                {{ cell }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
        <p class="text-sm max-w-[38rem]">
          Checked August 2026, and every column but the first describes somebody
          else's product. <span class="text-white">Not documented is not the same
          as no</span> — where a vendor publishes nothing, this table says so
          rather than guessing.
        </p>
        <a href="/guide/comparison" class="button button--sm w-fit shrink-0">
          <span>Sources, and where the others win</span>
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * A scroller with no visible edge reads as a table that has been cut off. The
 * mask fades the trailing 2rem while there is more to reach, and `animation-
 * timeline: scroll(self inline)` turns it off at the end of the scroll — so a
 * table that fits, or one scrolled to its last column, has no fade at all.
 * Everything here degrades to a plain scroller where the timeline is not
 * supported.
 */
@supports (animation-timeline: scroll()) {
  /*
   * THREE STOPS ON BOTH SIDES, and that is the whole reason the end state
   * carries a `transparent` it does not need: a gradient interpolates only
   * against a gradient of the same shape, and a two-stop `to` would snap
   * instead of fading.
   */
  @keyframes dp-unfade {
    to {
      mask-image: linear-gradient(to right, #000 0, #000 100%, transparent 100%);
    }
  }

  .dp-scroller {
    mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 2.5rem), transparent 100%);
    /*
     * Longhands, and no `animation-duration`. A scroll timeline needs the
     * duration left at its initial `auto`, and the shorthand is the easy way to
     * set it to `0s` by accident and end up with a fade that never moves.
     */
    animation-name: dp-unfade;
    animation-timing-function: linear;
    animation-fill-mode: both;
    animation-timeline: scroll(self inline);
    animation-range: 85% 100%;
  }
}

.dp-table {
  border-color: var(--color-nickel);
}

.dp-head,
.dp-head-label {
  padding: 0 0 0.75rem;
  vertical-align: bottom;
  border-bottom: 1px solid var(--color-nickel);
}

.dp-head {
  padding-left: 0.875rem;
  padding-right: 0.875rem;
}

/*
 * The corner cell is pinned for the same reason its column is: without it, the
 * DocPilot header slides out from under nothing and overlaps the pinned row
 * labels below it.
 */
.dp-head-label {
  position: sticky;
  left: 0;
  z-index: 1;
  background-color: var(--color-primary);
}

/*
 * The one column that is ours, marked at the head with the brand rule and
 * carried down the table as a wash.
 *
 * A VIOLET WASH RATHER THAN `--color-slate`: slate is what every card on this
 * page is filled with and it sits four points off the page background — right
 * for a card, and invisible as the one thing distinguishing a column from five
 * others standing beside it.
 */
.dp-head--own {
  border-top: 2px solid var(--color-dp-violet);
  background-color: color-mix(in srgb, var(--color-dp-violet) 16%, transparent);
  padding-top: 0.75rem;
}

.dp-group {
  padding: 1.5rem 0 0.5rem;
  text-align: left;
  font-weight: 400;
}

/*
 * The cell already spans the table, so pinning IT would pin nothing. The label
 * inside it is what has to stay on screen when the reader scrolls out to Orama
 * and stops being able to see which of the three groups they are reading.
 */
.dp-group span {
  position: sticky;
  left: 0;
  display: inline-block;
}

.dp-label,
.dp-cell {
  padding: 0.625rem 0.875rem 0.625rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--color-nickel) 55%, transparent);
  font-size: 0.8125rem;
  line-height: 1.35;
  vertical-align: top;
}

.dp-label {
  /*
   * The row name travels with the scroll. Without it, scrolling to Orama takes
   * the only thing identifying the row off screen — the same reasoning, and the
   * same fix, as the reference tables in `styles.css`.
   */
  position: sticky;
  left: 0;
  z-index: 1;
  background-color: var(--color-primary);
  color: color-mix(in srgb, #fff 82%, transparent);
  font-weight: 400;
  padding-right: 1.25rem;
  min-width: 14rem;
}

.dp-cell {
  padding-left: 0.875rem;
  min-width: 8.5rem;
}

/*
 * AFTER `.dp-cell`, not before it. Same specificity, so source order decides,
 * and a media query written above the rule it narrows is a media query that
 * does nothing.
 */
@media (max-width: 639px) {
  .dp-label {
    min-width: 10.5rem;
    padding-right: 0.875rem;
  }

  .dp-cell {
    min-width: 8rem;
  }
}

.dp-cell--own {
  background-color: color-mix(in srgb, var(--color-dp-violet) 9%, transparent);
  color: #fff;
}

.dp-cell--plain {
  color: color-mix(in srgb, #fff 68%, transparent);
}

.dp-cell--dim {
  color: var(--color-grey);
}
</style>
