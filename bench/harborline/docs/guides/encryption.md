---
title: Client-side encryption
---

# Client-side encryption

Harborline encrypts everything it stores with AES-256 and accepts connections over TLS 1.2 or later only. Client-side encryption adds a layer on top: the SDK encrypts each job payload in your process before it is sent, and decrypts it in your worker after it is received. Harborline only ever stores and sees ciphertext, and the key never leaves your servers.

## How it works

With encryption on, the SDK encrypts the payload with **AES-256-GCM** using a key that you provide, then sends the ciphertext in place of the payload. Harborline stores, leases and retries the job as usual — none of that needs the payload. When a worker reserves the job, its SDK decrypts the payload before your handler runs, so handlers see the original object and need no changes.

The key is a 32-byte value that exists only in the configuration of your producers and workers. Harborline never receives it, so Harborline cannot read encrypted payloads — not its staff, not its support tools, not anyone with access to its storage. GCM also authenticates the data: a payload altered in storage fails to decrypt instead of reaching your handler.

Generate a key once and keep it in your secret manager:

```bash
openssl rand -base64 32
```

## Turn it on in Node.js

```ts
import { Harbor } from '@harborline/sdk'

const harbor = new Harbor({
  apiKey: process.env.HARBOR_API_KEY,
  encrypt: { key: process.env.HARBOR_PAYLOAD_KEY }, // base64, 32 bytes
})

await harbor.queue('payouts').enqueue({ iban: 'DE89 3704 0044 0532 0130 00', amount: 1250 })
```

The `encrypt` option applies to every job the client enqueues and to every job its workers receive. Use the same key in producers and workers. A worker without the key, or with the wrong key, cannot decrypt the payload and fails the attempt with a decryption error. Those failures go through the normal retries, so fix the configuration before the jobs run out of attempts.

## Turn it on in Python

```python
import os
from harborline import Harbor

harbor = Harbor(
    api_key=os.environ["HARBOR_API_KEY"],
    encrypt={"key": os.environ["HARBOR_PAYLOAD_KEY"]},
)

harbor.queue("payouts").enqueue({"iban": "DE89 3704 0044 0532 0130 00", "amount": 1250})
```

Both SDKs use the same format, so a job encrypted by a Node.js producer can be decrypted by a Python worker and the other way round, as long as both have the key. Encryption is set per client: a process that talks to two projects can encrypt for one and not for the other by creating two clients.

## What Harborline can still see

Only the payload is encrypted. Everything Harborline needs to run the job stays readable:

| Readable by Harborline | Encrypted |
|---|---|
| Job id, queue, state, attempts and timestamps | The payload |
| Headers (metadata), such as `traceparent` | |
| `idempotencyKey` and `groupKey` | |
| Payload size, and error messages from failed attempts | |

Keep anything that must not be readable out of headers, keys and error messages. For example, throw `new Error('card declined')`, not an error that quotes the card number.

In the dashboard, encrypted payloads show as `encrypted`, and **payload search is unavailable** for them. Webhook events never contain payloads, encrypted or not.

## Size limits

The 256 KB payload limit applies to what Harborline stores: the encrypted payload, not your plaintext. Encryption adds a 12-byte nonce and a 16-byte authentication tag, and the ciphertext is base64-encoded inside a JSON envelope, which makes it about a third larger than the plaintext. In practice, keep plaintext payloads under about 190 KB when encryption is on.

A payload that is too large after encryption is rejected with `HL1002 payload_too_large`, as usual. The SDK checks the size before it sends the job, so the error arrives without a round trip to Harborline.

## Rotate the key

To replace the key without losing the jobs that are already enqueued, give your workers the old key as a previous key:

```ts
const harbor = new Harbor({
  apiKey: process.env.HARBOR_API_KEY,
  encrypt: { key: process.env.HARBOR_PAYLOAD_KEY, previousKeys: [process.env.HARBOR_PAYLOAD_KEY_OLD] },
})
```

New payloads are always encrypted with `key`; `previousKeys` are tried only for decryption. In Python the option is `previous_keys`. Roll the change out in order: first the workers, with the new key and the old one in `previousKeys`; then the producers, with the new key. Keep the old key in `previousKeys` until no job encrypted with it can still run — up to 30 days for delayed jobs, plus 14 days in a dead-letter queue if you may replay them.

If you lose a key, nobody can read the jobs encrypted with it, and Harborline cannot recover them.

## Limitations

Only the SDKs encrypt and decrypt. The `harbor` CLI, `harbor workers start` and raw REST calls see the ciphertext envelope: the command of a CLI worker receives it on standard input exactly as stored, and `harbor jobs get` shows the payload as `encrypted`. Process encrypted queues with SDK workers.

Schedules store their payload in Harborline, so the payload of a schedule is not encrypted, and the jobs it creates carry that same payload. Put references in schedule payloads, such as a report id, and keep the data itself in your own systems.
