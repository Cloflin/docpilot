#!/usr/bin/env bash
#
# The deploy build, run by Vercel through `buildCommand` in vercel.json.
#
# Three steps, and the middle one is the only reason this is a script rather than
# a one-liner in vercel.json.
#
# ── WHY `doctor` IS IN THE MIDDLE ───────────────────────────────────────────────
# Every gate between a broken index and a rendered panel fails SOFT, by design,
# and they stack into one silent failure:
#
#   · docs/.vitepress/config.mjs mounts the panel on `existsSync(manifest.json)`
#   · `readiness()` in src/config.js never throws — a dependency that can fail
#     someone else's docs build the moment it lands is a dependency they remove
#   · src/index.js emits `{enabled: false}` when it is not ready
#   · the trigger, the CTA and the quote component all render NOTHING at that
#     point, and nothing anywhere logs why
#
# So a broken deploy is a GREEN deploy that ships a site with no panel and no
# error. `node bin/docpilot.js doctor` exits 1 (bin/docpilot.js, at the end of
# the doctor branch) and is the only thing in this pipeline that turns those
# facts into a red build. Removing this line does not make the build faster; it
# makes the failure invisible.
#
# ── WHY THERE IS NO `docpilot index` STEP ──────────────────────────────────────
# The index is committed to git in this project. That is a deliberate trade: the
# deploy makes zero API requests, so the whole of OpenRouter's 50-requests-a-day
# free allowance stays with readers instead of being spent on every push;
# preview deploys are fully working sites; and the build needs no key at all.
# The one cost — someone edits docs/ and forgets to rebuild — is covered by the
# index-freshness gate in the test suite, not here.
#
# ── THE LEXICAL TRAP: `--no-embed` IS NOT A FIX ────────────────────────────────
# When this build goes red, `doctor` will most often be saying:
#
#   the index at docs/public/rag was built without vectors, but embed names
#   "openrouter" — every question would be embedded and nothing would be scored
#   against it
#       npx docpilot index   (or set `embed: false` to declare lexical-only retrieval)
#
# Rebuilding the index with `--no-embed` DOES NOT SATISFY THAT. src/config.js
# raises "manifest has no vectors while `embed` names a provider" as a hard
# `missing`, not a note, and it is a `missing` precisely because it fails
# silently: the site pays to embed every question and gets BM25 back. Adding
# `--no-embed` to the indexer and changing nothing else leaves the disagreement
# exactly where it was, so `doctor` still exits 1 — and a "fix" that instead
# deletes the doctor line from this file produces a green build and a dead panel,
# which is the failure this whole script exists to prevent.
#
# Lexical-only is a real, supported mode. It takes BOTH halves: build the index
# with `--no-embed` AND set `embed: false` in the `docPilot` export of
# docs/.vitepress/config.mjs. It costs recall@8 0.97 -> 0.41 on this corpus.
#
# ── THE REST OF THE DEPLOY ─────────────────────────────────────────────────────
# vercel.json carries what cannot be commented there, because Vercel parses it as
# strict JSON and rejects unknown keys:
#
#   · installCommand is `npm ci --include=dev` — Vercel's default `npm install`
#     re-resolves the tree, and `sass` and `vite` are devDependencies this build
#     genuinely needs
#   · two EXACT rewrites, never `/ai/(.*)` — the first note of `proxyContract()`
#     is that a prefix match on /ai proxies anything underneath it
#   · `no-cache` on /rag/manifest.json alone: it is the only unhashed file and it
#     names all the others, so a cached one sends a returning reader after shards
#     the last deploy deleted
#
# OPENROUTER_API_KEY belongs to the runtime, not to this script: nothing here
# reads it. Set it on Production, Preview AND Development — a key scoped to
# Production alone answers every question on every preview URL with the proxy's
# 503.

set -euo pipefail

# The stylesheet first, and not for tidiness: src/theme/index.js imports
# `../../dist/docpilot.css`, which `npm run build` is what writes. Without this
# step VitePress cannot resolve the theme's own import and the build dies before
# it renders a page.
echo "[docpilot] vercel   building dist/"
npm run build

echo "[docpilot] vercel   checking readiness"
node bin/docpilot.js doctor

echo "[docpilot] vercel   building the site"
npx vitepress build docs
