# 005 — An identifier is searchable by its parts

> **Кратко.** `surfaceTokens` держит `_ $ . # / -` внутри токена и не разбивает
> его, поэтому `docPilot.sources.allow` — один терм, и запрос «sources allow» его
> не находит; `getUserName` не находится по «user name». Токен, похожий на
> идентификатор, теперь отдаёт и себя целиком, и свои части. **Выключено по
> умолчанию** и включается `DOCPILOT_SPLIT_IDENTIFIERS=1` на сборке: правка
> двигает каждый лексический скор, а число, которое говорит, в ту ли сторону,
> снимается только `eval` на своём корпусе. Флаг едет в манифесте и вложен в
> `vocabHash`, поэтому устаревшую калибровку ловит уже существующий guard.

## Problem

`surfaceTokens` (`text.ts:205-211`) keeps `.`, `#`, `/`, `-`, `_` and `$` inside a
token, and its comment says why: `Plugin.init` and `/getting-started#roles` have to
survive. That is right, and it is only half of what an identifier needs. Nothing
splits it, so:

- `docPilot.sources.allow` is **one term**. A reader who types *sources allow*
  matches nothing — not partially, nothing.
- `getUserName` is **one term**, and `norm()` has already lowercased it to
  `getusername`. *user name* matches nothing.
- `rate_limit`, `built-in`, `guide/indexing` — same shape, same result.

This is the single most common query in technical documentation. The reader saw
the identifier once, remembers two of its three words, and types those. The dense
channel sometimes rescues it; on a lexical-only build there is nothing to rescue
it with, and the gate's lexical coverage L is measured on exactly these terms, so
the failure can end the turn before a model is called.

## Research

- **`norm()` lowercases** (`text.ts:56-58`), which is why the camel boundary
  cannot be recovered downstream: by the time `surfaceTokens` has produced a
  token, `getUserName` is `getusername`. The split has to see the case, so the
  scanner had to be separated into a case-preserving `rawTokens` and a
  `surfaceTokens` that lowercases its output. The two are one scanner called
  twice, not two scanners — the distinction this file's header exists for.
- **The precision risk is the whole design question.** Splitting everything would
  add `get`, `set`, `in`, `to` and every other fragment to every chunk that
  mentions a hyphen. The narrow rule — a token qualifies only if it carries a
  separator **inside** it or an internal capital — means a sentence of ordinary
  prose contributes exactly zero extra terms, which is asserted rather than
  assumed.
- **The whole token has to stay.** An exact query must not lose weight to its own
  fragments, so parts are *appended*; nothing is replaced. Order does not matter
  because every consumer of `terms()` treats the result as a bag.
- **Measured on this corpus:** vocabulary **4,710 → 4,998 types (+6.1%)**, chunk
  count unchanged at 470 — tokenisation does not touch chunking. That is the size
  of the change to `df.json`, and it is why this is not simply switched on.
- **There is already a mechanism for exactly this class of change.** The
  vocabulary is a build-time decision, written into `manifest.vocabulary`,
  installed by `store.js` at load, and hashed into `vocabHash` so `guardFor`
  reports a calibration measured under a different one. A tokenizer flag is the
  same shape of thing and needed no new machinery.

## Decision

**`identifierParts(s)`** is a new export of `text.ts`. For every token that
carries a separator inside it or an internal capital, it emits the lowercased
parts — split on `. _ / -` and then on camel and Pascal boundaries, with an
acronym kept whole (`HTTPServer` → `http`, `server`). A part equal to the whole
token is dropped.

**`terms()` appends those parts** after the phrase pass, so a declared
multi-word phrase is still matched on the surface stream before anything inside
it is taken apart.

**It is off by default**, and switched on for a build by
`DOCPILOT_SPLIT_IDENTIFIERS=1`. An environment variable rather than a setting,
because it is a lever to sweep before it is a decision to ship, and a default
nobody measured is the thing this package refuses to publish.

**It travels with the index**, through machinery that already existed:

| carried in | installed by | guarded by |
|---|---|---|
| `manifest.tokenizer = { splitIdentifiers }` | `store.js` → `setTokenizer` | — |
| folded into `vocabularyHash()` → `manifest.vocabHash` | — | `guardFor`'s existing stale-calibration warning |

An index built before the key existed has no `tokenizer` and reads as off, which
is the behaviour it was built with.

## Why it fits

`terms()` is the single tokenizer for the build and the runtime — that is what
`text.ts`'s header is about, and it is what makes this change safe in one place:
the same function produces `df.json` and scores the gate, so they cannot
disagree.

The staleness question is answered by folding the flag into `vocabularyHash`
rather than adding a second guard. The name stays `vocabularyHash` and the
manifest key stays `vocabHash` because consumers have committed
`calibration.json` files carrying it; what the value means is now "the identity
of the tokenizer", and it says so.

## Cost and risk

- **THE MEASUREMENT IS OWED AND HAS NOT BEEN TAKEN.** `calibrate` and `eval` on
  this corpus with the flag on are metered calls against the project's own
  provider quota and were not run here. Until they are, the honest status of this
  spec is: *implemented, unit-tested, off, and unmeasured.* The default must not
  change on anything weaker than a number.
- **What to measure, and the condition that reverts it:** run `eval` before,
  build with the flag, `calibrate`, run `eval` after. If `gatePrecision` falls
  below its baseline, the flag stays off and this spec keeps the number.
- **Precision is the risk, recall is the gain.** More terms per chunk means more
  documents matching a given query. The narrow qualification rule is the whole
  mitigation, and prose is asserted to be unaffected.
- **`vocabularyHash` now returns a string where it used to return `null`** for a
  project with no vocabulary and the flag on (`'none+split'`). Only reachable
  with the flag on.
- **A second pass over the string.** `terms()` scans through `rawTokens` twice
  when the flag is on. Same cost class as the existing pass, and only when on.

## Checks

- `test/identifier-tokens.test.js` — 16 cases: the six splitting behaviours
  including the acronym and the prose guard, the default-off contract, prose
  being byte-identical either way, the two retrieval cases this exists for
  (*sources allow* → `docPilot.sources.allow`, *user name* → `getUserName`), the
  exact form surviving, and the manifest round-trip including both hash
  transitions. Every test restores the module state, because a leaked `true`
  would re-tokenise every other suite in the process.
- `npm run check` — unchanged and passing.

## What this does not do

- **It does not change the default.** See the cost section: that is what the
  measurement is for.
- **It does not split on case inside a stem.** `stemLite` runs after, on parts as
  on anything else.
- **It does not touch the dense channel.** Vectors are built from chunk text,
  which this does not modify — the chunk hash is unchanged, and the build proves
  it: 470 chunks before and after.
- **It is not a code tokenizer.** Indexing source files is a separate question
  with its own chunker, and this is the part of it that pays without one.
