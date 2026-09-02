# CLI-контракт, потом провенанс — порядок работ по спекам 010 и 011

Статус на 2026-09-02. Обе спеки написаны и лежат в `engine-specs/` вместе со строками
в его `README.md`; кода по ним ещё нет, и кроме этих четырёх файлов дерево чистое.
Ветка `main`, версия `1.0.1`.

Порядок жёсткий и обоснован ценой, а не вкусом:

    010 (поверхность) → 011 (отчёты) → цифры и пере-калибровка

011 стоит до пере-калибровки потому, что её пятая фаза снижает цену прогона `eval`
с 58 запросов эмбеддера до двух. Пере-калибровка идёт последней потому, что она
единственная тратит метерённые запросы, и делать её дважды незачем.

## Гейт каждой фазы

    npm run verify        # check → build:js → typecheck → conformance → vitest
    git status --short    # пусто, кроме того, что фаза меняла

Плюс: новые тесты фазы зелёные, запись в `CHANGELOG.md` под `## Unreleased`
пополнена, и фаза не потратила ни одного сетевого запроса, если ниже не сказано
иначе. Спека коммитится в первом коммите своей фазы — по конвенции репозитория спека
пишется до кода и ложится вместе с ним.

## Что уже проверено, чтобы не проверять заново

    flagErrors('eval',   ['-level=low'])                  -> []
    flagErrors('eval',   ['--level=low','--level=high'])  -> []
    flagErrors('index',  ['--index-dir','foo'])           -> []
    flagErrors('doctor', ['--bogus'])                     -> сообщение есть

Последняя строка — ключевая: таблица знает `doctor`, его флаги и текст ошибки; команда
просто не спрашивает. `flagValue`/`flagGiven` (`src/cli-flags.ts:417`, `:425`)
экспортированы и покрыты тестами, а их единственный импортёр — `test/cli-flags.test.js`.

## Ловушки, на которых легко потерять день

**Peer-зависимости запрещены тестом.** `test/packaging.test.js:361` требует, чтобы
`peerDependencies` и `peerDependenciesMeta` отсутствовали, и docstring над ним
перечисляет три релиза, где optional-peer ломал чужой `npm install`. Поэтому vitepress
не переезжает в манифест — исправляются два комментария, называющие его peer'ом
(`bin/docpilot.js:548`, `src/build/vocabulary.ts:466`). `src/cli-context.ts:64-71`
трогать не надо: там vitepress уже назван удобством, а не жёсткой зависимостью.

**Гейт «флаг документирован» уже существует.** `test/cli-flags.test.js:299` сверяет
таблицу с `docs/reference/cli.md` флаг за флагом, а `:316` запрещает показывать в
доках командную строку с несуществующим флагом. Раздел про коды выхода надо добавлять
так, чтобы эти два не покраснели.

**`docpilot help` не добавляется в список команд.** `test/cli-flags.test.js:42`
сверяет массив `COMMANDS` из `bin/docpilot.js:22-36` с ключами таблицы на точное
равенство множеств, так что новая команда обязана попасть в оба места или ни в одно.
`help` — второе: он обрабатывается в быстрой ветке рядом с `--version`
(`bin/docpilot.js:105-109`), до диспатча и до загрузки конфига.

**Одиночный дефис нельзя запрещать целиком.** `-y` — документированный алиас, и держит
его тот же срез `^--?`: `flagGiven('index', ['-y'], 'yes')` возвращает `true`, а
`test/cli-flags.test.js:150-152` это пиннит. Запрещается одна черта только у имён
длиннее одного символа.

**`fileEnv` нельзя импортировать в launcher из `cli-context.ts`.** Модуль резолвит
`settings` на своём верхнем уровне (`:38-39`) из `globalThis.__DOCPILOT_SETTINGS__`,
который launcher кладёт туда позже; ранний импорт закэширует резолв на пустом конфиге.
Функция переезжает в отдельный модуль без состояния.

**`WINDOWS` уже экспортирован** (`calibrate.ts:2218`), и тесты уже импортируют этот
модуль (`test/docpilot.test.js:85`). А `scripts/refresh-figures.mjs` — обычный `node`
без импорта модулей проекта, и оба индексных клейма — `it.skipIf` на манифесте
(`test/docs-links.test.js:410`, `:417`). Поэтому eval-клеймы идут отдельным блоком
vitest, а не строкой в скрипте.

**`reportName` нельзя переносить как есть.** `src/eval/run.ts:747` — стрелка, которая
замыкает `LEXICAL` (`:749`) и `PROMPT_HASH` (`:751`); из другого модуля она вернёт
другое имя.

**`writeReport` делает три записи, а не две:** json (`report.ts:320`), markdown
(`:321-324`) и `latest.json` (`:344`). Копия в `history/` встаёт перед первой.

**Пустые свипы — свойство переноса, а не потери ключа.** В `docpilot/calibration.json`
и `sweep`, и `sweepLexical` несут по 101 строке; пусты они в
`docpilot/calibration.rag.json`, который писал `--transfer`. Чинится рендер (фаза 4),
а не запись.

**Фильтр `cosCeil <= 0.95` (`calibrate.ts:894`) сейчас инертен** — максимум потолка
0.86, 408 кандидатов на входе и на выходе. Гейт на «408» надо строить от
`WINDOWS.length`, а не от арифметики в голове.

## Фаза 1 — один читатель флагов

Шесть локальных `arg()`/`has()` (`run.ts:91`, `calibrate.ts:64`, `tune.ts:97`,
`answer-bench.ts:75`, `lint-golden.ts:35`), `argValue` (`build-rag-index.ts:89`) и
`value()` (`vocabulary.ts:310`) заменяются на `flagValue`/`flagGiven`. Срез `^--?`
сужается в четырёх местах (`:243`, `:260`, `:408`, `:429`) до имён длиннее одного
символа — `-y`, `-h`, `-v` остаются, — повторённый флаг и `--` получают правильные
ответы. `answer-bench.ts` получает entry-guard.

Тесты: `test/cli-flags.test.js`; там же меняется единственный ассерт, пиннящий ошибку
употребления к коду `1` (`:234`), и карта `READERS` (`:275-287`) — после переезда
`doctor` и `init` она указывает на старые файлы. Запросов: 0.

    feat(cli): one reader for every flag, and bench learns its own name

## Фаза 2 — коды выхода, потоки, ошибки

Коды `0/1/2/130`; `CALIBRATION FAILED` и блок `ready NO` уезжают в stderr;
перерисовка возвратом каретки в семи местах — под `stderr.isTTY`; единый префикс
`[docpilot]`; стек только под `DOCPILOT_DEBUG=1`; импорт конфига в `try/catch`.
`doctor` и `init` переезжают из `bin/docpilot.js` в `src/` под контракт `run*`.

Перед переездом снять эталон, после — сравнить:

    DOCPILOT_EMBED_LOCAL=1 node bin/docpilot.js doctor  > /tmp/doctor.before.txt
    node bin/docpilot.js --help                         > /tmp/help.before.txt

Тесты: spawn-секция `test/docpilot.test.js`, новый `test/cli-doctor.test.js`.
Запросов: до одного на каждый снятый эталон. Голый `doctor` **не бесплатен**:
`probeEmbedEndpoint` на `bin/docpilot.js:1072` стоит вне всяких флагов и шлёт
настоящий embedding-запрос, когда `embedNow.borrowed && target.baseURL` — то есть
когда ключ эмбеддера заимствован у чат-провайдера. Эталоны снимать под
`DOCPILOT_EMBED_LOCAL=1`, тогда цель локальная и запрос не метерённый.

    feat(cli): exit codes mean something, and doctor stops throwing

## Фаза 3 — json, help, окружение, npx

`doctor --json` и `lint --json`; `docpilot help [команда]`; алиасы видимы; `--version`
в глобальном help и в справочнике; рукописный `USAGE` в `feedback/cli.ts:31-48`
удаляется; футер берёт адрес из `package.json.homepage`. `.env.local` читается одним
законом: `fileEnv()` применяется в launcher'е один раз, дописывая только отсутствующие
ключи, копии в `bin/docpilot.js:551-557` и `vocabulary.ts:459-466` удаляются, а сам
`fileEnv` переезжает из `cli-context.ts` в модуль без состояния. Шесть ранних импортов
уезжают за диспатч (`init` всё равно зовёт две функции из `config.js` сам, так что
выигрывают команды, которым конфиг не нужен).

**Единственное место всего плана, где может возникнуть долг петли.** Смена закона
окружения способна сдвинуть цель эмбеддинга у того, у кого шелл и `.env.local`
расходятся. Поэтому:

    node bin/docpilot.js doctor --embed    # до правки, записать модель и адрес
    # …правка…
    node bin/docpilot.js doctor --embed    # после: совпало — петля не нужна

Разошлось — это была скрытая ошибка, и тогда фаза owes
`index --dry → index → calibrate → lint → eval`.

Тесты: `test/cli-flags.test.js`, `test/cli-doctor.test.js`, `test/packaging.test.js`
(peer-блок по-прежнему отсутствует). Запросов: до двух — по одному на каждый прогон
`doctor --embed`, и здесь их нельзя форсировать в локальные: смысл проверки именно в
том, какую цель выберет резолвер при настоящих настройках. Это единственная сетевая
трата фаз 1–5.

    feat(cli): doctor speaks json, and the environment obeys one law

## Фаза 4 — провенанс и сид

Новые поля `meta` (`ranAt`, `chatBase`, `embedBase`, `node`, `package`, `goldenSha`,
`temperature`, `seed`); `goldenSha` как маркер несравнимости рядом с `promptHash`;
`ranAt`/`embedBase`/`probeSha`/`embedRequests` в `calibration.json`; `sweptAt` в
`tuning.report.md`; сид через `tuning` в `config.llm` (`run.ts:548-558`);
«inherited from …» вместо пустых таблиц; `armed: false` при n = 0.

Ловушка фазы: положить `tuning` в `config.llm` недостаточно. На финальном ходе
`harness.ts:736` пропускает его через `thinkable()` (`:279`), а тот отдаёт `undefined`
целиком, когда `thinkSupported === false`. Фильтр надо разделить: поля размышления
гасятся, поля сэмплирования — нет. Иначе сид не доедет до вызова, который пишет ответ,
и это будет видно только по расхождению двух прогонов, а не по ошибке.

Тесты: `test/docpilot.test.js`. Запросов: 0.

    feat(eval): the report names its witnesses

## Фаза 5 — общая закупка и история

`prefetchEmbeddings` переезжает из `calibrate.ts:532-585` в `src/eval/prefetch.ts` без
изменения поведения; `run.ts`, `tune.ts` и `bench emit` закупают одним проходом;
`answer-bench.ts` получает `fileEnv()`; копия отчёта уходит в
`docpilot/reports/history/` перед перезаписью. Строка идёт в **корневой** `.gitignore`
рядом с `docpilot/embed-cache/` (`.gitignore:58`): `docpilot/.gitignore` в этом
репозитории отсутствует — его `docpilot init` пишет только в потребительский проект.

Тесты: прямые на `prefetch.ts` (раскладка, повтор, короткая пачка) — на моках, без
сети. Запросов: 0.

    feat(eval): one purchase per run, and history survives a rerun

## Фаза 6 — цифры и долг калибровки

Сначала цифры: `272` → `408` в `docs/guide/evaluation.md:63` и `:95`, список клеймов в
`test/docs-links.test.js` и `scripts/refresh-figures.mjs` пополняется числами, которые
выводятся из кода и артефактов (`WINDOWS.length`, 99 ячеек, `tau`, `probeCount`).

Затем обязательная петля. Локальная половина бесплатна:

    export DOCPILOT_EMBED_LOCAL=1        # весь блок читает docs/public/rag-local
    node bin/docpilot.js index
    node bin/docpilot.js calibrate
    node bin/docpilot.js lint
    node bin/docpilot.js eval --gate-only
    node bin/docpilot.js tune --dry      # отчёт; tuning.json narrowed-прогон не пишет

Переменная нужна на каждой команде блока, а не только на `index`: каталог индекса
выбирает конфиг сайта (`docs/.vitepress/config.mjs:89`), и `calibrate`, `lint` и `eval`
читают тот же ключ. Метерённая половина — считанная:

    export DOCPILOT_EMBED_LOCAL=0        # docs/public/rag
    node bin/docpilot.js index                                    # ~15 запросов
    node bin/docpilot.js calibrate --transfer=docpilot/calibration.json \
                                   --out=docpilot/calibration.rag.json   # ~10
    node bin/docpilot.js eval --gate-only                         # 2 после фазы 5

`--out` для переноса обязателен — так объявлено в таблице флагов
(`src/cli-flags.ts:140`), и без него прогон отказывается.

Итого около 27 метерённых запросов из 50 в сутки — один день с запасом, и это тот же
порядок, что записан в spec 008. Числа до и после дописываются в хвост `## Checks`
спеки 011.

Критерий фазы: оба манифеста под `docs/public/` несут `guard.source: "calibrated"`.
Сегодня оба `provisional`, потому что `docpilot/calibration.json` отмечен корпусом
`ab42d56c`, а манифесты — `e9985350`. Остался `provisional` после петли — фаза не
сдана.

    fix(docs): the window grid is 408, and the figures are gated

## Релиз

Версия — **1.1.0**, minor: коды выхода и форма ошибок не были обещанным контрактом ни
в `docs/reference/cli.md`, ни в help. Запись в `## Changed` обязана назвать три
изменения наблюдаемого поведения: `2` вместо `1` на ошибке употребления, `130` вместо
`0` на отмене, ошибка вместо тихого дефолта на `-level=low`.

Дальше — по `.claude/reindex-then-publish.md`: пуш аннотированного тега и есть
публикация, `publish.yml` стреляет на `v*` и сверяет тег с `package.json`.

## Критерий готовности всего плана

- `npm run verify` зелёный, оба манифеста `calibrated`;
- `node bin/docpilot.js eval -level=low` — код `2` и строка `[docpilot] …` (сегодня:
  тихий дефолт и код `0`);
- `node bin/docpilot.js doctor --json | jq .ready` работает в CI;
- два прогона `eval` подряд: второй не стирает первый, а `meta` различимы по `ranAt`;
- `DOCPILOT_API_KEY` только в `.env.local` виден командам `bench` и `lint`.
