# Релиз 1.0.0 — что сделано и что осталось

Статус на 2026-08-31. Версия в `package.json` и обоих полях `package-lock.json` —
`1.0.0`, первый заголовок CHANGELOG — `## 1.0.0 — 2026-08-31`, `check-publish.js`
их сверяет и даёт `ok`. Тег `v1.0.0` — аннотированный, на `main`, локальный.

    npm run verify                          → 1630 passed, 0 failed
    npm run build                           → ok
    node scripts/check-publish.js           → ok  (@cloflin/docpilot@1.0.0)
    node bin/docpilot.js doctor             → ready — the panel will render

**Индекс пересобран.** Оба каталога — `docs/public/rag` (метеренный провайдер)
и `docs/public/rag-local` (ollama) — на корпусе `aab4ce6a`, 471 чанк. Двенадцать
печатных цифр переписаны под него и сходятся с
`node scripts/refresh-figures.mjs --check`.

## Порядок выпуска

```bash
node scripts/refresh-figures.mjs --check    # сначала: не разъехались ли цифры
DOCPILOT_EMBED_LOCAL=1 node bin/docpilot.js index   # ollama, бесплатно
DOCPILOT_EMBED_LOCAL=0 node bin/docpilot.js index   # ~15 запросов из 50/день
node scripts/refresh-figures.mjs            # переписывает 12 печатных цифр
# если скрипт что-то переписал — корпус сдвинулся, индексировать заново
npm run verify                              # ожидается 1630 passed
npm run build && node scripts/check-publish.js
node bin/docpilot.js doctor                 # ready
git add -A && git commit                    # релизный коммит
git tag -a vX.Y.Z -m "…"                    # аннотированный, как v0.2.0 и v0.3.0
git push origin main && git push origin vX.Y.Z
```

**Пуш тега — это и есть публикация.** `.github/workflows/publish.yml` стреляет
на `v*` и делает `npm publish --provenance` через trusted publishing; локальный
`npm publish` руками не нужен и требует passkey 2FA в живом терминале. Тот же
workflow отказывает, если тег не совпал с `package.json`.

**Порядок «индекс → цифры → индекс» не лишний.** `refresh-figures.mjs` правит
`docs/guide/indexing.md` и `docs/guide/comparison.md`, а они сами в корпусе —
любая правка сдвигает хеш, и третий гейт `docs-links.test.js` снова краснеет.
Если правка вышла посимвольно равной длины (`465`→`471`, `930 KB`→`942 KB`),
число чанков не меняется и хватает одного повторного прогона.

**`DOCPILOT_EMBED_LOCAL` в шелле достаточно — файл править не нужно.** `loadEnv`
в `docs/.vitepress/config.mjs` отдаёт приоритет `process.env` над `.env.local`,
где флаг выставлен в `1`; значит метеренный индекс требует явного
`DOCPILOT_EMBED_LOCAL=0` в команде.

**`scripts/refresh-figures.mjs`** читает `manifest.json` и размер блоба и
переписывает все двенадцать печатных цифр в `README.md`,
`docs/guide/indexing.md`, `docs/guide/comparison.md`, `FeatureGrid.vue` и
`Comparison.vue` — тот же список, что проверяет третий гейт
`docs-links.test.js`. Старые значения знать не нужно: шаблоны сопоставляются
регулярками с цифрами-джокерами. `--check` показывает изменения, ничего не
записывая. Гейт и скрипт держат один список, так что новая печатная цифра
добавляется в оба.

## Долг, который этот релиз не закрывает

**Калибровка гейта.** `docpilot/calibration.json` измерен на корпусе `6d0e6a78`
(460 чанков, bge-m3), а собранный индекс — `aab4ce6a`. Сборка это замечает и
подставляет провизорный порог: в манифесте `guard.source` — `provisional`,
`guard.tau` — `0.3`, `calibratedAt` — `null`, вместо измеренных 0.69. Это было
так и до 1.0.0: закоммиченный ранее индекс `04383fc1` тоже не совпадал с
калибровкой. Наборы проб теперь в репозитории есть — `docpilot/calibration.jsonl`
и `docpilot/golden.jsonl`, — так что `calibrate` выполним, но `calibrate`
эмбеддит по одной пробе на запрос, а не батчами по 32, и на метеренном
провайдере в 50 запросов/день не укладывается. Дешёвый путь: откалибровать на
ollama и перенести окно — хеш корпуса не зависит от эмбеддера.

**Печатная `|Δcos|`.** `docs/guide/indexing.md` показывает
`quantisation err 0.00262 mean |Δcos|` в блоке вывода сборки; реальное значение
на `aab4ce6a` — `0.00259`. Ничем не гейтится и не чинится в лоб: строка живёт
внутри корпуса, который измеряет, так что любое новое значение сдвигает то, что
меряется. `0.0026` — окрестность неподвижной точки.

**IME-фикс нигде не описан.** Слова `IME` под `docs/` нет ни разу, прозы про то,
что Enter больше не отправляет вопрос во время композиции, — тоже. Остальные два
новых поведения задокументированы: `composer.draft` — в `docs/guide/history.md`
(строки 20 и 48) и в справочнике конфига, `ui.waitingEscalation` — в
`docs/reference/config.md` (таблица и свой раздел). Ни то ни другое не попало в
`docs/guide/panel.md`, который в этом релизе сдвинул только счётчик строк.

**`--html-base` без строки в `--help`.** Флаг документирован в
`docs/reference/cli.md` и `engine-specs/001` и читается как
`argValue('html-base')`, но `docpilot --help` перечисляет только `--html-dir`,
`--html-select` и `--sitemap`.
