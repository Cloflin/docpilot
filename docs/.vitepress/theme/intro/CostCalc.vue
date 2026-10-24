<script setup>
import { computed, ref } from 'vue'

/*
 * Cost of answering, from two measured numbers and a price list.
 *
 * TOKENS: a turn on this site averages 5.9k prompt and 0.7k output tokens at
 * `maxIterations: 2` (docs/guide/what-it-costs.md). The question embedding is
 * about 10 tokens — a rounding error, kept in so nothing is hidden.
 *
 * PRICES: OpenRouter list prices per million tokens, read from
 * https://openrouter.ai/api/v1/models in October 2026. They move; the formula
 * does not.
 */
const IN = 5900
const OUT = 700
const EMBED = 10
const EMBED_PRICE = 0.01 // qwen/qwen3-embedding-8b
const models = [
  { id: 'deepseek/deepseek-v4-flash', in: 0.091, out: 0.182, note: 'this site' },
  { id: 'openai/gpt-4o-mini', in: 0.15, out: 0.6 },
  { id: 'openai/gpt-5-mini', in: 0.25, out: 2.0 },
  { id: 'anthropic/claude-haiku-4.5', in: 1.0, out: 5.0 },
]
const pick = ref(0)
const steps = [1000, 10000, 50000, 100000, 500000, 1000000]
const vi = ref(0)
const m = computed(() => models[pick.value])
const per1k = (x) => ((IN * x.in + OUT * x.out + EMBED * EMBED_PRICE) / 1e6) * 1000
const total = computed(() => (per1k(m.value) * steps[vi.value]) / 1000)
const money = (v) => (v < 0.01 ? '< $0.01' : v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString('en-US')}`)
</script>

<template>
  <div class="cc">
    <div class="cc-models">
      <button v-for="(x, i) in models" :key="x.id" :class="{ on: i === pick }" @click="pick = i">
        <span class="cc-id">{{ x.id }}</span>
        <span class="cc-p">{{ money(per1k(x)) }} <small>/ 1,000 questions</small></span>
        <span v-if="x.note" class="cc-note">{{ x.note }}</span>
      </button>
    </div>
    <div class="cc-slider">
      <label for="cc-v">Questions a month</label>
      <input id="cc-v" v-model.number="vi" type="range" min="0" :max="steps.length - 1" step="1" />
      <div class="cc-ticks"><span v-for="s in steps" :key="s">{{ s >= 1e6 ? s / 1e6 + 'M' : s / 1000 + 'k' }}</span></div>
    </div>
    <div class="cc-out">
      <div>
        <div class="cc-big">{{ money(total) }}</div>
        <div class="cc-sub">a month for {{ steps[vi].toLocaleString('en-US') }} questions on {{ m.id }}</div>
      </div>
      <div class="cc-math">
        {{ (IN / 1000).toFixed(1) }}k in × ${{ m.in }}/M + {{ (OUT / 1000).toFixed(1) }}k out × ${{ m.out }}/M<br />
        + {{ EMBED }} tokens to embed the question
      </div>
    </div>
  </div>
</template>

<style scoped>
.cc {
  margin: 1.25rem 0 2rem;
  padding: 18px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-background);
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.cc-models {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}
.cc-models button {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--cf-border);
  text-align: left;
  transition: border-color 0.2s, background-color 0.2s;
}
.cc-models button.on {
  border-color: var(--cf-accent);
  background: color-mix(in oklab, var(--cf-accent) 7%, var(--cf-background));
}
.cc-id {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--cf-muted-foreground);
}
.cc-p {
  font-size: 18px;
  font-weight: 600;
}
.cc-p small {
  font-size: 12px;
  font-weight: 400;
  color: var(--cf-muted-foreground);
}
.cc-note {
  position: absolute;
  bottom: 12px;
  right: 12px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--cf-accent);
  color: #fff;
}
.cc-slider label {
  font-size: 13px;
  font-weight: 500;
}
.cc-slider input {
  width: 100%;
  accent-color: var(--cf-accent);
  margin-top: 8px;
}
.cc-ticks {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--cf-muted-foreground);
}
.cc-out {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--cf-border);
}
.cc-big {
  font-family: var(--font-serif, serif);
  font-size: 44px;
  line-height: 1;
}
.cc-sub,
.cc-math {
  font-size: 12.5px;
  color: var(--cf-muted-foreground);
}
.cc-math {
  font-family: var(--font-mono, monospace);
  text-align: right;
}
</style>
