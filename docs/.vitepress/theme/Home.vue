<script setup>
import Hero from './Hero.vue'
import HeadingSection from '@voidzero-dev/vitepress-theme/src/components/oss/HeadingSection.vue'
import FeatureGrid from './FeatureGrid.vue'
import Spacer from '@voidzero-dev/vitepress-theme/src/components/shared/Spacer.vue'
import Footer from '@voidzero-dev/vitepress-theme/src/components/oss/Footer.vue'
</script>

<template>
  <Hero />
  <HeadingSection
    heading="Retrieval + a gate + checked citations"
    subheading="The panel goes on any page. The answers come from the index you built, not from the page — and three things have to hold before one reaches the reader."
  />
  <FeatureGrid />
  <Spacer />
  <Footer
    heading="Put a grounded answer panel on your site"
    subheading="Install it, build the index, calibrate the gate against your own corpus."
    button-text="Get Started"
    button-link="/guide/"
  />
</template>
