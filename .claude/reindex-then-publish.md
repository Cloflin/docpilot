# ВНИМАНИЕ: не коммитить docs/public/rag/ в текущем виде

Индекс на диске собран **локальной Ollama** (`bge-m3`, 1024d, hash `fff98def`),
чтобы `npm run verify` стал зелёным для публикации 0.3.2 в обход исчерпанной
дневной квоты OpenRouter.

Конфиг сайта (`docs/.vitepress/config.mjs`) при этом остался прежним —
`chat: {provider: 'openrouter'}, embed: 'auto'` — и с ним этот индекс
несовместим:

    node bin/docpilot.js doctor   → exit 1
    · the index was built with "bge-m3", which is not in openrouter's free
      embedding pool — the browser would ask openrouter for a model it does
      not serve

`scripts/vercel-build.sh` гоняет `doctor`, так что коммит этого индекса
= красный деплой.

Тестовый набор этого НЕ ловит: `docs-links.test.js` сверяет только хеш и число
чанков, а readiness против реального конфига не проверяет никто, кроме
`vercel-build.sh`.

## Порядок

1. **Опубликовать** — можно сейчас, пакет от этого не зависит
   (`files` не включает `docs/`):

       npm publish              # интерактивный терминал: passkey 2FA

2. **После сброса квоты OpenRouter** — 2026-08-28T00:00Z:

       npx docpilot index       # пересоберёт на openrouter free pool
       node bin/docpilot.js doctor    # должен стать exit 0
       npm run verify

3. **Только теперь коммитить**, включая docs/public/rag/.

## Почему Ollama не годится как постоянное решение

`vercel-proxy.test.js` сверяет `vercel.json` с `proxyContract()` для конфига
этого сайта. Локальный провайдер вызывается напрямую, маршрута
`/ai/v1/embeddings` в контракте не появляется, и тест падает. Плюс Vercel не
достучится до localhost:11434.

Постоянные варианты, если 50 запросов/день мало: $10 кредитов на OpenRouter
(1000/день) либо перевод embed-половины сайта на платного провайдера — второе
требует правки `lib/ai-proxy.js` (`UPSTREAM`), `vercel.json` и теста.
