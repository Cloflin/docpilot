<script setup>
import Hero from './Hero.vue'
import PriceStrip from './PriceStrip.vue'
import HeadingSection from '@voidzero-dev/vitepress-theme/src/components/oss/HeadingSection.vue'
import FeatureGrid from './FeatureGrid.vue'
import ChatFeatures from './ChatFeatures.vue'
import Comparison from './Comparison.vue'
import Spacer from '@voidzero-dev/vitepress-theme/src/components/shared/Spacer.vue'
import Footer from '@voidzero-dev/vitepress-theme/src/components/oss/Footer.vue'
</script>

<!--
  Price, then three claims in the order a reader tests them: what it is made of,
  what it does, and why not one of the hosted services instead.

  PRICE SITS SECOND, above every feature. It is the question a reader arrives
  with, the answer is one character long, and burying a `$0` under two screens
  of mechanism is the one arrangement that wastes it. It is a strip rather than
  a section heading because the number needs the competitors beside it to mean
  anything — `$0` on its own is a claim, `$0` next to five published rates is a
  comparison.

  The full comparison is still LAST. It is the section with the most pull and
  the least substance about this project — a page that opens with a table of
  competitors has argued about them rather than about itself, and the honest
  half of that argument (the rows the others win) is a whole page of its own at
  `/guide/comparison` rather than a footnote here.
-->
<template>
  <Hero />
  <PriceStrip />
  <HeadingSection
    heading="Retrieval + a gate + checked citations"
    subheading="The panel goes on any page. The answers come from the index you built, not from the page — and three things have to hold before one reaches the reader."
  />
  <FeatureGrid />
  <HeadingSection
    heading="A chat, not a search box with better typography"
    subheading="Scope a question to one section, ask about a passage you selected, follow up, edit what you asked, keep the thread — and see the instruction the assistant is running under."
  />
  <ChatFeatures />
  <HeadingSection
    heading="Against a hosted answer service"
    subheading="Algolia Ask AI, kapa.ai, Inkeep, Mintlify and Orama are all real answers to this problem. One architectural decision separates them from this one."
  />
  <Comparison />
  <Spacer />
  <Footer
    heading="Put an AI assistant on your site"
    subheading="Install it, build the index, calibrate the gate against your own corpus."
    button-text="Get Started"
    button-link="/guide/"
  />
</template>
