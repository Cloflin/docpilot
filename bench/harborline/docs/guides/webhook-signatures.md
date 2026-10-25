---
title: Verify webhook signatures
description: Check that a webhook request really comes from Harborline by verifying the Harbor-Signature header with your endpoint's signing secret, in Node.js or Python.
---

# Verify webhook signatures

Your webhook endpoint is a public URL, so anyone can send it a request. Every request from Harborline carries a `Harbor-Signature` header computed with a secret that only you and Harborline know. Verify it on every request and reject the ones that fail.

## How the signature works

```http
Harbor-Signature: t=1792919523,v1=b4813a29cb99b5497ff0330013c94a74d0fa7acb8e03f145c1b7b5c1ac43d2b2
```

The header has two parts:

- `t` — the time of this delivery attempt, in Unix seconds.
- `v1` — a hex-encoded HMAC-SHA256 signature.

Harborline computes `v1` with the endpoint's **signing secret** (`whsec_…`) as the key, over the string `"<t>.<raw body>"`: the timestamp, a literal dot, and the request body exactly as it was sent, byte for byte. To verify, compute the same HMAC yourself. Accept the request only when:

1. your HMAC equals `v1`, compared in constant time; and
2. `t` is no more than **5 minutes** away from your server's clock.

The timestamp check stops an attacker from replaying a request they captured. Because `t` is set for each delivery attempt, a retried event still verifies.

## Verify with the SDK

```ts
import express from 'express'
import { verifyWebhook, SignatureVerificationError } from '@harborline/sdk'

const app = express()

app.post('/hooks/harbor', express.raw({ type: 'application/json' }), (req, res) => {
  let event
  try {
    event = verifyWebhook(req.body, req.get('Harbor-Signature'), process.env.HARBOR_WEBHOOK_SECRET)
  } catch (err) {
    if (err instanceof SignatureVerificationError) return res.status(400).end()
    throw err
  }
  // event.type, event.data …
  res.status(200).end()
})
```

```python
import os
from flask import Flask, request, abort
from harborline.webhooks import verify, SignatureVerificationError

app = Flask(__name__)

@app.post("/hooks/harbor")
def harbor_hook():
    try:
        event = verify(request.get_data(), request.headers.get("Harbor-Signature"),
                       os.environ["HARBOR_WEBHOOK_SECRET"])
    except SignatureVerificationError:
        abort(400)
    # event["type"], event["data"] ...
    return "", 200
```

Both helpers compare the HMAC in constant time, enforce the 5-minute tolerance, and return the parsed event.

## Verify by hand in Node.js

```ts
import crypto from 'node:crypto'

const TOLERANCE_SECONDS = 5 * 60

export function verifyHarborSignature(rawBody: Buffer, header: string, secret: string): boolean {
  const items = header.split(',').map((part) => part.trim().split('='))
  const t = items.find(([k]) => k === 't')?.[1]
  const signatures = items.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || signatures.length === 0) return false
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false

  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest()
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex')
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  })
}
```

Pass the raw request body as a `Buffer`, not a parsed object. In Express that means `express.raw({ type: 'application/json' })` on the webhook route, before any JSON body parser sees the request.

## Verify by hand in Python

```python
import hashlib
import hmac
import time

TOLERANCE_SECONDS = 5 * 60

def verify_harbor_signature(raw_body: bytes, header: str, secret: str) -> bool:
    items = [part.strip().split("=", 1) for part in header.split(",") if "=" in part]
    t = next((v for k, v in items if k == "t"), None)
    signatures = [v for k, v in items if k == "v1"]
    if t is None or not signatures:
        return False
    if abs(time.time() - int(t)) > TOLERANCE_SECONDS:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, sig) for sig in signatures)
```

In Flask the raw body is `request.get_data()`; in Django it is `request.body`. Do not use `request.json` or `request.get_json()`: serialising the parsed object again changes the bytes.

## Common mistakes

Most failed verifications come from one of these:

- **Verifying a parsed body.** `JSON.stringify(req.body)` does not reproduce the bytes Harborline signed: key order, spacing and Unicode escapes differ. Always use the raw body.
- **Using the API key.** The signing secret starts with `whsec_` and belongs to one webhook endpoint. Your API key (`hl_live_…`) is for calling Harborline and is never used to sign anything. See [API keys versus signing secrets](/account/api-keys#api-keys-versus-signing-secrets).
- **Comparing with `===` or `==`.** An ordinary string comparison leaks timing information. Use `crypto.timingSafeEqual` or `hmac.compare_digest`.
- **A wrong clock.** If your server's clock is more than 5 minutes off, every signature fails the timestamp check. Run NTP.
- **The secret of another endpoint.** Each endpoint has its own secret; the secret of a staging endpoint does not verify production deliveries.

## Roll a signing secret

To replace a secret — because it leaked, or as routine — select **Roll secret** on the endpoint in the dashboard, or call `POST /v3/webhooks/{id}/roll-secret`. The response shows the new secret once.

For the next 24 hours Harborline signs every delivery with both secrets, so the header carries two `v1` values: `t=…,v1=<new>,v1=<old>`. A request is valid when any `v1` matches. Deploy the new secret within those 24 hours; after that, only the new secret signs. The code samples on this page already accept several `v1` values.

## Signatures in v2

Harborline v2 sent an `X-Harbor-Sig` header with an HMAC-SHA1 signature of the body alone, without a timestamp. That header was removed in v3: v3 deliveries carry only `Harbor-Signature`, signed with HMAC-SHA256 over the timestamp and the body.

Code that still checks `X-Harbor-Sig` rejects every v3 delivery — or, worse, accepts every request because it treats a missing header as nothing to check. Replace it with one of the verifications above; [Migrate from v2](/releases/migrate-v2) lists the other changes.
