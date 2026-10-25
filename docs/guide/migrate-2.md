---
title: Migrate to 2.0
description: What changes for a site owner moving from DocPilot 1.x to 2.0 — nothing for readers, new defaults on the server install, content-named index files, and docpilot serve reading server settings.
---

# Migrate to 2.0

**Nothing changes for your readers.** The panel, its features and its client config are the same. Every change in 2.0 is under the hood or in your own tooling. What you must check depends on your install:

| you run | what to do |
|---|---|
| the static install (`runtime: 'browser'`, the default) | Upgrade, rebuild the index, deploy it. Check that no host rewrites `/rag/*` — see [Index files are named by their bytes](#index-files) |
| the server install (`runtime: 'server'`) | The same, then read [New defaults on the server install](#server-defaults). Limits are on |

[The full list of changes](/changelog) has the engine specs behind each one.

## Upgrade

```bash
npm i @cloflin/docpilot@2
npx docpilot update
npx docpilot index --yes
```

- `update` refreshes the skills and slash commands you installed, and installs the `docpilot-tuner` and `docpilot-writer` agents into `.claude/agents/` if you chose the Claude Code target. A file you edited is kept beside the new one as `.bak`.
- `index` rebuilds the index with the new file names. An index built by 1.x still loads, without the integrity check, so you can upgrade first and rebuild when you deploy.

Run `npx docpilot status` afterwards. It shows whether the index is fresh and what to run next.

## Index files are named by their bytes {#index-files}

In 1.x the shards, the document-frequency file, the vectors and the openers carried the corpus hash in their names. The corpus hash covers chunk ids and text only, so a change of tokenizer, config or embedder could rewrite a file under a name that a returning reader's immutable cache already held.

In 2.0 every one of those files is named by a hash of its own bytes. `manifest.json` stays the one file served without a long cache, and it carries `integrity`: the `sha256-…` digest of each file. The panel fetches each file with that digest, so a file that is not the one you built fails the load.

What this means for you:

- **Deploy the whole index directory**: the new files and the manifest together.
- **A host that rewrites `/rag/*` in flight now breaks the load.** Minifiers, HTML or JSON rewriters, and proxies that re-compress or inject into responses change the bytes. Turn that off for the index path, or the load fails.
- **`docpilot index` prints the size on the wire** (brotli) beside the size on disk, so you see what a reader downloads.

## New defaults on the server install {#server-defaults}

Skip this section if you run the static install.

| change | what you do |
|---|---|
| **The turn is one-shot.** A server turn goes straight to the answer call with the gate's evidence and no reasoning before it. On a local model the first token comes about three times sooner, with answer quality inside the noise of 1.x | To keep the 1.x tool loop, set `server: { turn: { loop: 'agentic' } }` |
| **Limits are on.** Each client gets 10 turns a minute (burst 10) and 500 a day, 3 at once, and the server runs 16 at once. A refused turn is `429` with `Retry-After`, or `503` when the server is full | If a proxy already limits, set `server: { limits: false }`. Otherwise check the numbers against your traffic and raise them in `server.limits` |
| **The client is the socket's address.** Behind a proxy, every reader looks like the proxy | Set `server.trustProxy` to the number of hops in front of the server |
| **A turn has a deadline**, 300 seconds | Change `server.turnTimeoutMs` if your model is slower or you want it shorter |
| **Signed history.** An answer the server did not sign reaches the model quoted in the reader's message, not as its own turn | Set `DOCPILOT_SERVER_SECRET` on every replica. Without it each process makes its own secret and demotes the others' answers |
| **A metrics route exists**, at `{endpoint}/metrics`, for loopback or a bearer token | If your proxy forwards the whole endpoint prefix, set `DOCPILOT_METRICS_TOKEN` or route only the exact paths |
| **The leak guard** stops `prompt.override` and `prompt.extend` leaving in an answer | Nothing, unless a legitimate answer quotes six words of your instruction. Then that turn settles as not-answerable |
| **`serve --dir` refuses dotfiles**, except `.well-known/`, and sends `nosniff` | Move anything you served from a dot path |
| **Bodies are read to 256 KB** | Nothing, for a panel. A script that posts more gets `413` |

Every setting and its default is on [Server operations](/guide/server-operations#settings).

### `docpilot serve` now reads `server.*` {#serve}

`docpilot serve` handed the server the resolved settings, and the resolved object carried `server.endpoint` alone. It dropped every other `server.*` key. In 2.0 the server gets the settings you wrote.

If you had `server.*` keys in your config that never seemed to do anything, they do now. Read them again before you deploy. The usual surprise is a `server.limits` or a `server.allowedOrigins` you wrote months ago and forgot.

## What you gain, and need not use

None of the following is required.

- **`npx docpilot init` asks which install** you want and prints the block to paste. See [Choose your install](/install/choose).
- **Measuring:** [`eval --runtime=server`](/reference/cli#eval-runtime), `--split=dev|test`, `--set=adversarial` and `--quiet`, plus new metrics: see [Measure](/guide/measure).
- **Improving:** [`docpilot improve`](/guide/improving), and the [Claude Code agents](/guide/tuning-agent) that run it.
- **The terminal:** the home screen, `status` and `monitor` — see [The terminal](/features/terminal).
- **Security probes:** [Attack probes](/guide/security-probes).

## What did not change

- The client config, `themeConfig`, and every panel feature.
- The golden-set format. A record without `split` is assigned one by a hash of its id, so an existing set works with no edit.
- The turn log. It keeps `docpilot.turn/1` and gains fields: `timing`, `rankedIds`, `historySigned`, `leakBlocked` and `cached`.
- The `/ai/v1/*` proxy contract of the static install.
- The default `runtime: 'browser'`.

## If something breaks

1. Run `npx docpilot status` and `npx docpilot doctor`.
2. On the server install, a surprise `429` is the new limits. Read `docpilot_refused_requests_total` in the metrics, then change `server.limits`.
3. A panel that cannot load the index after the upgrade points at a host that rewrites the files. Compare the bytes you deploy with the bytes the host serves.
4. To go back, pin the 1.x version you came from and redeploy the index you built with it.
