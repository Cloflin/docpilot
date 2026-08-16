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
    subheading="Three things have to hold before an answer reaches the reader. Each one is measurable, and each one is documented."
  />
  <FeatureGrid />
  <Spacer />
  <Footer
    heading="Put a grounded answer panel in your docs"
    subheading="Install the plugin, build an index, calibrate the gate against your own corpus."
    button-text="Get Started"
    button-link="/guide/getting-started"
  />
</template>
