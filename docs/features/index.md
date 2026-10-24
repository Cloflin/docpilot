---
description: Everything the panel does, one page each, with a live mock-up and the config that turns it on.
---

<script setup>
const reader = [
  { title: 'Triggers and layout', body: 'A floating button, a navbar icon, ⌘I, or a link under each article. Popup or drawer.', link: '/features/triggers' },
  { title: 'Search scope', body: 'All docs, this page, this section, or pages the reader picks.', link: '/features/scope' },
  { title: 'Sources and passages', body: 'Numbered citations, and an accordion with the exact passage behind each one.', link: '/features/sources' },
  { title: 'Ask about a selection', body: 'Select text on the page or in an answer, press Ask AI.', link: '/features/quote' },
  { title: 'Copy, retry, edit', body: 'Copy an answer with its sources, ask again, edit a question, copy the thread.', link: '/features/actions' },
  { title: 'Conversation history', body: 'Threads saved in localStorage, on the reader’s device only.', link: '/features/history' },
  { title: 'Suggestions', body: 'Starter questions, prepared answers, follow-ups.', link: '/features/suggestions' },
  { title: 'Status and reasoning', body: 'What it is doing right now, and how long the model thought.', link: '/features/status' },
  { title: 'Every language', body: 'Chrome in the page language, answers in the reader’s.', link: '/features/i18n' },
]
const engine = [
  { title: 'Conversation memory', body: 'The last answer goes to the model whole; older ones as summaries.', link: '/features/memory' },
  { title: 'Model fallback', body: 'A 429, a 5xx or a retired model moves the question to the next model.', link: '/features/fallback' },
  { title: 'Relevance gate', body: 'Refuse off-topic questions before any model call — opt-in.', link: '/features/gate' },
  { title: 'Pasted keys', body: 'A key typed into a question never leaves the browser.', link: '/features/credentials' },
  { title: 'Feedback', body: 'Thumbs, reasons, a comment — to your endpoint or the reader’s device.', link: '/features/feedback' },
  { title: 'How this works', body: 'Show readers the instruction the model runs under.', link: '/features/prompt' },
]
</script>

# Features

Every feature below is on by default unless its page says otherwise, and every one is a key in the same `docPilot` config object. Each page opens with a live mock-up — press **Config** on it to see the lines that produce it.

## What the reader sees

<Cards :items="reader" />

## What happens underneath

<Cards :items="engine" />

The complete list of keys, with types and defaults, is the [Configuration reference](/reference/config).
