<script setup>
/*
 * What the assistant DOES, as opposed to what it is made of — `FeatureGrid.vue`
 * above already argues the architecture, and repeating it here in smaller type
 * would be the second half of the page saying nothing new.
 *
 * Every card names a real control and links to the page documenting it, and the
 * `setting` chip is the key a reader searches the reference for. A card whose
 * chip is not a real key is a card promising a feature that does not exist, so
 * the chips are copied from `DEFAULTS` in `src/config.js` rather than invented
 * to look tidy: five of the twelve are not settings at all and carry a CLI
 * command or a plain noun instead of a fake one.
 */
const doors = [
  { label: 'Navbar button', detail: "beside your site's search" },
  { label: 'Floating button', detail: 'every page, every width' },
  { label: '⌘I', detail: 'bound even with no button' },
  { label: 'A selection', detail: 'Ask AI, above the text' },
  { label: 'Under an article', detail: "Didn't find it?" },
  { label: 'open()', detail: 'from your own code' },
]

const features = [
  {
    title: 'Scope it before asking',
    body: 'A picker in the composer narrows the search to this page, this section, or a list the reader picks. Past a dozen pages a filter appears above the list.',
    chip: 'scope.default',
    href: '/guide/panel#scoping-the-question',
  },
  {
    title: 'Select a passage, ask about it',
    body: 'One button above the selection attaches the text to the composer as a removable chip — so the question can be “what does this mean?” with a this on screen.',
    chip: 'quote.fromDocs',
    href: '/guide/panel#quoting-a-passage',
  },
  {
    title: 'Status, not a spinner',
    body: 'Loading the index · searching · looking at the page list · reading guide/indexing · thinking · writing. Six named states, and reasoning collapses behind “Thought for 4s”.',
    chip: 'six states',
    href: '/guide/panel#while-it-answers',
  },
  {
    title: 'Citations that open',
    body: 'Show the passage opens the exact text a marker was drawn from. Every marker is checked against what the host retrieved that turn; an invented route is de-linked before render.',
    chip: 'citations.passage',
    href: '/concepts/guarantees',
  },
  {
    title: 'A refusal that does something',
    body: 'Nothing found offers the closest pages, says what was searched and how many pages were read, and puts one button under it: clear the scope and search all docs.',
    chip: 'docpilot calibrate',
    href: '/concepts/the-gate',
  },
  {
    title: 'Work the thread',
    body: 'Edit a question and everything below it is discarded and answered again. Ask again throws away an answer that arrived. Copy one turn, or the whole conversation as Markdown.',
    chip: 'history.exportThread',
    href: '/guide/panel#working-the-thread',
  },
  {
    title: 'Conversations survive a reload',
    body: "Kept in the reader's own localStorage, listed behind the clock, sent nowhere. Reasoning and retrieved excerpts are never written. One switch stops recording and clears the store.",
    chip: 'history.enabled',
    href: '/guide/history',
  },
  {
    title: 'A thumb, and a reason',
    body: 'Four reasons and a 500-character comment, redacted before it leaves the browser, posted to an endpoint you own — or to nowhere, in which case the panel says so.',
    chip: 'feedbackEndpoint',
    href: '/guide/panel#telling-you-it-was-wrong',
  },
  {
    title: 'It shows its own instruction',
    body: 'How this works opens the system prompt, its tool definitions and the scope in force. The reader may add an instruction of their own — sent with the question, never merged into the prompt.',
    chip: 'prompt.show',
    href: '/guide/panel#showing-the-reader-how-it-works',
  },
  {
    title: 'A pasted key never leaves',
    body: 'A question containing an API key, a JWT or a bearer token is caught before the embedding call, warned about in the language the reader typed, and re-asked without it on one button.',
    chip: 'credentials',
    href: '/guide/credentials',
  },
  {
    title: '“Hello” is not a refusal',
    body: 'Greetings, thank-yous, farewells and who-are-you are answered from a template in eighteen languages, before the gate and with no model call. A greeting attached to a real question is not claimed.',
    chip: 'social openers',
    href: '/guide/social-openers',
  },
  {
    title: '173 strings, one at a time',
    body: "Every reader-facing string is replaceable, in 25 groups. Chrome follows the page's locale; the credential warning and the greeting follow the language the reader typed in.",
    chip: 'i18n.locales',
    href: '/guide/i18n',
  },
]
</script>

<template>
  <section class="wrapper wrapper--ticks border-t flex flex-col">
    <!--
      The doors come first and are deliberately not cards: they are one decision
      (`ui.trigger`) with six placements, and six cards would read as six
      features to configure separately.
    -->
    <div class="p-5 sm:p-15 flex flex-col gap-5 border-b border-nickel">
      <div class="flex flex-col gap-2">
        <h5 class="text-white">Six ways a reader opens it</h5>
        <p class="max-w-[34rem] text-pretty">
          One setting picks which of them exist, and a site is allowed all of
          them at once — <span class="font-mono text-white">ui.trigger</span>
        </p>
      </div>
      <ul class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 list-none">
        <li
          v-for="door in doors"
          :key="door.label"
          class="bg-slate rounded px-3 py-2.5 flex flex-col gap-0.5"
        >
          <span class="font-mono text-sm text-white">{{ door.label }}</span>
          <span class="font-mono text-[11px] text-grey leading-tight">{{ door.detail }}</span>
        </li>
      </ul>
    </div>

    <div class="grid sm:grid-cols-2 lg:grid-cols-3 divide-x divide-y divide-nickel">
      <a
        v-for="feature in features"
        :key="feature.title"
        :href="feature.href"
        class="dp-card p-5 sm:p-8 flex flex-col gap-2.5"
      >
        <span class="font-mono text-[11px] text-dp-violet">{{ feature.chip }}</span>
        <h6 class="text-white">{{ feature.title }}</h6>
        <p class="text-sm text-pretty">{{ feature.body }}</p>
      </a>
    </div>
  </section>
</template>

<style scoped>
/*
 * The whole card is the link, so the hover has to be a card-level change rather
 * than an underline on a title nobody is pointing at. The fill is the same
 * `--color-slate` every other panel on this page uses, at the one moment the
 * card is the thing being read.
 */
.dp-card {
  transition: background-color 0.15s ease;
}

.dp-card:hover {
  background-color: var(--color-slate);
}

.dp-card:focus-visible {
  outline: 2px solid var(--color-dp-violet);
  outline-offset: -2px;
}
</style>
