<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

/*
 * The heading and placeholder are what a site supplies through
 * `i18n.locales[lang].translations` — the chrome ships in English. The reply
 * line is different: greetings are answered from built-in copy in 18 languages,
 * chosen by the language the reader TYPED, with no model call.
 */
const locales = [
  { lang: 'en', heading: 'How can I help you today?', ph: 'Ask about Acme', hi: 'Hello!', reply: 'Hi! I answer questions about Acme. What are you building?' },
  { lang: 'ru', heading: 'Чем помочь?', ph: 'Спросите об Acme', hi: 'Привет!', reply: 'Привет! Я отвечаю на вопросы об Acme. Что вы делаете?' },
  { lang: 'de', heading: 'Wie kann ich helfen?', ph: 'Fragen zu Acme', hi: 'Hallo!', reply: 'Hallo! Ich beantworte Fragen zu Acme. Woran arbeitest du?' },
  { lang: 'ja', heading: 'ご用件は何ですか？', ph: 'Acme について質問', hi: 'こんにちは', reply: 'こんにちは！Acme についての質問にお答えします。' },
  { lang: 'ar', heading: 'كيف يمكنني المساعدة؟', ph: 'اسأل عن Acme', hi: 'مرحبا', reply: 'مرحبًا! أجيب عن الأسئلة حول Acme.' },
  { lang: 'es', heading: '¿En qué puedo ayudarte?', ph: 'Pregunta sobre Acme', hi: '¡Hola!', reply: '¡Hola! Respondo preguntas sobre Acme. ¿Qué estás creando?' },
]
const { step, root } = useTimeline(locales.flatMap(() => [1300, 1900]))
const l = computed(() => locales[Math.floor(step.value / 2)])
const replied = computed(() => step.value % 2 === 1)
</script>

<template>
  <div ref="root" class="id">
    <div class="id-langs">
      <span v-for="x in locales" :key="x.lang" class="mp-chip" :class="{ on: x === l }">{{ x.lang }}</span>
    </div>
    <div :dir="l.lang === 'ar' ? 'rtl' : 'ltr'" class="id-panel">
      <MockPanel :placeholder="l.ph" :height="340" footnote="">
        <Transition name="mp-fade" mode="out-in">
          <div v-if="!replied" :key="l.lang + 'e'" class="id-empty">
            <div class="id-h">{{ l.heading }}</div>
          </div>
          <div v-else :key="l.lang + 'r'" class="id-thread">
            <div class="mp-q">{{ l.hi }}</div>
            <div class="mp-a">{{ l.reply }}</div>
            <div class="mp-muted">No model call · built-in reply</div>
          </div>
        </Transition>
      </MockPanel>
    </div>
  </div>
</template>

<style scoped>
.id {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}
.id-langs {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
.mp-chip {
  font-family: var(--font-mono, monospace);
  transition: all 0.2s;
}
.mp-chip.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.id-panel {
  width: min(380px, 100%);
  display: grid;
  place-items: center;
}
.id-empty {
  margin-top: auto;
}
.id-h {
  font-size: 22px;
  font-weight: 600;
}
.id-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
