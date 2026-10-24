---
description: A key pasted into a question is caught in the browser and never sent — not to the embedder, not to the model, not to history.
---

# Pasted keys

Readers debugging an API paste their keys. DocPilot checks every question before anything leaves the browser. When it finds something that looks like a secret, the question stops there, the reader is told why in their own language, and one button asks the same question without the key.

<Demo>
  <CredentialsDemo />
</Demo>

## What it catches

`sk-…` keys, GitHub tokens (`ghp_…`, `gho_…`), Slack tokens (`xox…`), Stripe live keys, SendGrid keys, AWS access-key ids (`AKIA…`, `ASIA…`), JWTs (`eyJ…`), `Bearer …` headers, and long hex strings. Bare UUIDs are left alone.

## Where it runs

Before the turn exists: before the relevance gate, before the embedding call, before the model, before history. The stored thread holds `YOUR_SECRET_KEY` in place of the value. Quoted selections and feedback comments go through the same check.

There is nothing to configure; it is always on.

## What it is not

A habit guard, not a security boundary. It catches the common shapes of a careless paste; it cannot recognise every secret. The model is also told never to ask for a credential or repeat one back — but that instruction is a backstop, not the control. More: [Credentials in questions](/guide/credentials), and [Security](/guide/security) for the site's own key.
