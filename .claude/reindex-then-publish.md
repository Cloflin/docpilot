# Релиз 0.4.0 — что сделано и что осталось

Статус на 2026-08-29. Версия в `package.json` и `package-lock.json` — `0.4.0`,
первый заголовок CHANGELOG — `## 0.4.0 — 2026-08-28`, `check-publish.js` их
сверяет и даёт `ok`. `npm run build` зелёный, `npm pack` — 1.2 MB / 134 файла.

    DOCPILOT_EMBED_LOCAL=0 npm run verify   → 1392 passed, 1 failed
    npm run build                           → ok
    node scripts/check-publish.js           → ok  (@cloflin/docpilot@0.4.0)

**Единственный красный тест — устаревший индекс,** и на этой машине его не
починить: `OPENROUTER_API_KEY` не задан ни в окружении, ни в `.env.local`.
`docs/public/rag/` содержит индекс `87a483e5` на 405 чанков, а `docs/` уже
чанкуется в 430. `test/docs-links.test.js` это ловит, и именно эта сюита
запускается из `prepublishOnly` — то есть без пересборки `npm publish` упадёт.

## Порядок выпуска, когда ключ появится

```bash
export OPENROUTER_API_KEY=…              # ~13 запросов из 50/день, см. память
node bin/docpilot.js index               # пересобирает docs/public/rag/
node scripts/refresh-figures.mjs         # переписывает 12 печатных цифр
DOCPILOT_EMBED_LOCAL=0 npm run verify    # ожидается 1393 passed
node bin/docpilot.js doctor              # ready — 0 to fix
git add -A && git commit                 # релизный коммит
git tag -a v0.4.0 -m 0.4.0               # аннотированный, как v0.2.0 и v0.3.0
DOCPILOT_EMBED_LOCAL=0 npm publish       # passkey 2FA, нужен живой терминал
git push && git push --tags
```

**`DOCPILOT_EMBED_LOCAL=0` в шелле достаточно — файл править не нужно.**
`loadEnv` в `docs/.vitepress/config.mjs` отдаёт приоритет `process.env` над
`.env.local`, проверено: с флагом из файла `test/vercel-proxy.test.js` падает на
двух тестах, с `DOCPILOT_EMBED_LOCAL=0` в шелле — проходит все 29. Более ранняя
заметка утверждала обратное; она была неверна.

**`scripts/refresh-figures.mjs` — новый, добавлен 2026-08-29.** Он читает
`manifest.json` и размер блоба и переписывает все двенадцать печатных цифр в
`README.md`, `docs/guide/indexing.md`, `docs/guide/comparison.md`,
`FeatureGrid.vue` и `Comparison.vue` — тот же вывод, что делает третий гейт
`docs-links.test.js`. Старые значения знать не нужно: шаблоны сопоставляются
регулярками с цифрами-джокерами. `--check` показывает изменения, ничего не
записывая. Гейт и скрипт держат один и тот же список, так что новая печатная
цифра добавляется в оба.

## Долг, который этот релиз не закрывает

**Калибровка.** `node bin/docpilot.js calibrate` даёт `FAIL no probe set at
docpilot/calibration.jsonl` — набора проб в репозитории нет. `guard.source` в
манифесте так и остаётся `provisional`, а `calibratedAt` — `null`. Пересборка
индекса это не меняет; нужен `docpilot init`, который разложит eval-наборы, и
человек, который напишет золотые ответы.

**Десять экспортов `./config` без деклараций.** `src/config.js` экспортирует
28 имён. Два недостающих были новыми в 0.4.0 — `ladderOrder` и
`resolveChatChain` — и добавлены 2026-08-29. Остальные десять (`capsOf`,
`chatModels`, `embedModels`, `indexDirOf`, `manifestPathOf`, `noChat`,
`noEmbed`, `poolProviderOf`, `proxyContract`, `resolveTuning`) — дрейф старше
этого релиза.

**Два негейченных гейта дописаны 2026-08-29.** `docpilot.test.js` получил
`every other page quoting the totals quotes the current ones` — README,
`comparison.md`, `panel.md` и `ChatFeatures.vue` печатали «158 строк в 22
группах» против настоящих 170 в 25, и держал их только `i18n.md`. Rule 10 в
`check-docpilot.sh` теперь читает обе опубликованные копии таблицы токенов, а
не одну: `docs/reference/theme.md` сам про себя писал, что его проверяют, и это
было неправдой.

**`npm run typecheck` не проверяет `types/**`.** `tsconfig.json` их включает и
объясняет зачем — «чтобы синтаксическая ошибка или сломанный импорт падали
здесь, а не в редакторе потребителя», — но `skipLibCheck: true` ровно это и
отключает. Проверено: висячая ссылка на несуществующий тип в
`types/config.d.ts` прошла `npm run typecheck` без единого слова. Снять флаг
нельзя — `linkedom` в `node_modules` даёт 133 ошибки. Узкий вариант, если
кто-то возьмётся: отдельный прогон `tsc --skipLibCheck false` с фильтром на
`^types/`; сегодня он даёт одну ошибку — `types/react.d.ts` не находит `react`,
которого нет в зависимостях с тех пор, как убрали `peerDependencies`.

## Что осталось из той заметки актуальным


**Дыру в тестах закрыли.** Заметка отмечала: «readiness против реального конфига
не проверяет никто, кроме `vercel-build.sh`». Теперь проверяет
`test/vercel-proxy.test.js` — `it('commits an index the site’s own embed
configuration can ask for')`, сужен фильтром на несоответствие индекса и
эмбеддера, чтобы отсутствие ключа в CI не роняло тест.

Там же появился гейт на провайдера: локальный `chat.provider` в
`docs/.vitepress/config.mjs` теперь падает с внятным сообщением про то, что
Vercel-деплой **и есть** `/ai` прокси, а не с `assertChat` про модель.

**Ограничение free tier никуда не делось.** 50 запросов в день на аккаунт.
Пересборка индекса стоит ~13 запросов (365 чанков батчами по 32 плюс пробы
кандидатов). Постоянные варианты, если мало: $10 кредитов на OpenRouter
(1000/день) либо перевод embed-половины на платного провайдера — второе требует
правки `lib/ai-proxy.js` (`UPSTREAM`), `vercel.json` и теста.

**Локальную Ollama выбирают через `OLLAMA_BASE_URL` в `.env.local`, не коммитом.**
Переключение `chat.provider` на `ollama` прямо в конфиге сайта роняет
`vercel-proxy.test.js` — локальный провайдер вызывается напрямую, маршрута
`/ai/v1/embeddings` в контракте не появляется, и Vercel не достучится до
localhost:11434.

## Локальный Ollama для итераций — `DOCPILOT_EMBED_LOCAL=1`

Добавлено 2026-08-28, после того как четвёртая пересборка за день упала на 429.

```bash
ollama pull bge-m3                                    # один раз
DOCPILOT_EMBED_LOCAL=1 node bin/docpilot.js index     # 0 запросов к API
DOCPILOT_EMBED_LOCAL=1 npm run docs:dev               # панель читает /rag-local
```

Флаг в `docs/.vitepress/config.mjs` переключает **три ключа разом**:
`embed → {provider:'ollama', model:'bge-m3'}`, `indexDir → docs/public/rag-local`,
`host.ragBase → /rag-local`. Порознь их менять нельзя: эмбеддер без своего
`indexDir` затрёт закоммиченный индекс, а `indexDir` без `host.ragBase` даст
браузеру 404.

**Почему отдельный каталог, а не `docs/public/rag/`.** Ollama-индекс рядом с
`chat: {provider:'openrouter'}` — это ровно тот красный деплой, про который
написан `test/vercel-proxy.test.js:406`: браузер спросит у OpenRouter модель
`bge-m3`, которой там нет. `src/config.js` это ловит и `doctor` даёт exit 1 — но
уже **после** того, как хороший индекс уничтожен, а на исчерпанной квоте его не
пересобрать.

**Обновлено 2026-08-29.** До этой даты три ключа выше были описаны здесь и не
были реализованы ни одним: `indexDir` отсутствовал, поэтому локальная сборка
писала в `docs/public/rag/` и затирала закоммиченный индекс — ровно тот исход,
против которого написан абзац выше; `host.ragBase` отсутствовал, поэтому панель
в dev читала `/rag/`, то есть флаг показывал работу на том самом артефакте,
который он должен был подменять. Оба ключа теперь в файле.

**`rag-local/` больше не в `.gitignore` и коммитится.** Прятать файл — это не
защита; защита — это `readiness()`, который поднимает
«the index was built with bge-m3, which is not in openrouter's free embedding
pool» как жёсткий `missing`, и `scripts/vercel-build.sh`, который на нём даёт
красную сборку. `test/docs-links.test.js` держит **каждый** `manifest.json` под
`docs/public/` к хешу корпуса, так что второй индекс не может тихо разъехаться с
доками.

**Зачем он в репозитории.** 1024 измерения против 2048 — это более слабый
эмбеддер, и в этом смысл: конфигурация, которая хорошо отвечает здесь, отвечает
не хуже там, поэтому прогон против этого индекса — нижняя граница, а не другое
измерение. Сравнивать имеет смысл только потому, что корпус у обоих один и это
обеспечено гейтом. Абсолютные числа между индексами всё так же несопоставимы —
сопоставим порядок конфигураций. Инструмент — `npx docpilot bench`.

Перед коммитом `rag/` — по-прежнему обычный `node bin/docpilot.js index` на
OpenRouter.

## Цифры индекса на главной защищены тестом

`docs-links.test.js` получил третий gate: `docs — the printed index figures match
the committed index`. Главная и три страницы доков печатают конкретные измерения
(`405 chunks`, `810 KB`, `829,440 bytes`, `3.2 MB as float32`) — тест выводит их
из манифеста и размера блоба и требует дословного совпадения, называя в
сообщении, что именно поправить.

Нужен он потому, что gate свежести сравнивает **хеш корпуса** и про эти цифры
молчит: пересборка, сдвинувшая счётчик чанков, оставляет его зелёным и в том же
коммите превращает каждую цифру в ложь. Это уже случилось — две сессии правили
`docs/` параллельно, и 405 стало 409.
