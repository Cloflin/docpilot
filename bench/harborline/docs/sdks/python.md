---
title: Python SDK
description: Install and use the harborline package for Python 3.9+ — client options, enqueueing, decorator workers, async handlers, errors and webhook verification.
---

# Python SDK

`harborline` is the official Harborline client for Python 3.9 and later. It covers the whole v3 API and runs workers in threads or on asyncio.

## Install

```bash
pip install harborline
```

The package version follows the platform: `harborline` 3.4 supports every 3.4 feature. Version 2.x of the package talks only to the v2 API, which answers `410 Gone` since 2026-07-01; upgrade with `pip install --upgrade "harborline>=3"` and follow [Migrate from v2](/releases/migrate-v2). The package name did not change between v2 and v3. It ships type hints and works with mypy and Pyright, and its only dependency is an HTTP client.

## Create a client

```python
import os
from harborline import Harbor

harbor = Harbor(api_key=os.environ["HARBOR_API_KEY"], region="eu-central-1")
```

| Argument | Default | Description |
|---|---|---|
| `api_key` | `HARBOR_API_KEY` | The API key, `hl_live_…` or `hl_test_…` |
| `region` | `HARBOR_REGION`, else `us-east-1` | The project's region |
| `endpoint` | `HARBOR_ENDPOINT` | A full base URL; wins over `region` |
| `encrypt` | `None` | `{"key": ..., "previous_keys": [...]}` for [client-side encryption](/guides/encryption) |
| `timeout` | `30` | Seconds per HTTP request |
| `max_network_retries` | `2` | Retries after a network error, `HL2001` or `HL5000` |

`Harbor()` with no arguments reads everything from the environment. One client per process is enough, and it is thread-safe.

## Enqueue jobs

```python
emails = harbor.queue("emails")

job = emails.enqueue({"to": "ada@example.com"}, delay="10m", idempotency_key="welcome-42")
print(job.id, job.state, job.replayed)

results = emails.enqueue_batch([
    {"payload": {"to": "a@example.com"}},
    {"payload": {"to": "b@example.com"}, "delay": "1h"},
])

harbor.jobs.get(job.id)
harbor.jobs.cancel(job.id)
harbor.jobs.retry(job.id)
```

Keyword arguments mirror the REST fields: `delay`, `run_at`, `idempotency_key`, `max_attempts`, `visibility_timeout`, `group_key` and `headers`. `delay` takes a duration string or a `timedelta`, and `run_at` an aware `datetime` or an RFC 3339 string. Queue management is on `harbor.queues` (`create`, `update`, `list`, `delete`) and on the queue itself: `pause()`, `resume()`, `drain()`, `purge()`, `stats()` and `dead`.

## Workers

```python
from harborline import Harbor, PermanentError

harbor = Harbor()

@harbor.worker("emails", concurrency=8, shutdown_grace="45s")
def send(job):
    job.log(f"sending {job.payload['template']}")
    mailer.send(job.payload)

@harbor.worker("thumbnails")
async def thumbnail(job):
    await render(job.payload["image_id"])

if __name__ == "__main__":
    harbor.run()  # blocks; handles SIGTERM and SIGINT
```

`@harbor.worker(queue, ...)` registers a handler. Its options are `concurrency` (default **4**), `heartbeat_interval` (default one third of the visibility timeout) and `shutdown_grace` (default `"30s"`). Plain functions run in a thread pool of `concurrency` threads; `async def` functions run on one asyncio event loop with up to `concurrency` jobs in flight.

`harbor.run()` starts every registered worker, and `harbor.run(queues=["emails"])` starts only some of them. A handler that returns acknowledges the job, one that raises fails the attempt, and `PermanentError` sends the job straight to `dead`.

## Errors

```python
from harborline import HarborError

try:
    harbor.queue("emails").enqueue(huge_payload)
except HarborError as err:
    print(err.code, err.type, err.status, err.request_id)  # HL1002 payload_too_large 413 req_…
```

`HarborError` carries the error code, its name as `type`, the HTTP status and the request id; quote the request id when you contact support. `PermanentError` is raised by your own handlers, never by the SDK. The webhook helpers raise `harborline.webhooks.SignatureVerificationError`.

## Verify webhooks

```python
import os
from harborline.webhooks import verify, SignatureVerificationError

def handle(raw_body: bytes, signature: str) -> int:
    try:
        event = verify(raw_body, signature, os.environ["HARBOR_WEBHOOK_SECRET"])
    except SignatureVerificationError:
        return 400
    if event["type"] == "job.dead":
        page_on_call(event["data"]["job"]["id"])
    return 200
```

`verify` checks the HMAC in constant time and the 5-minute timestamp tolerance, and returns the event as a `dict`. Pass the raw bytes of the body: `request.get_data()` in Flask, `request.body` in Django. See [Verify webhook signatures](/guides/webhook-signatures).

## Use it from Django

Enqueue after the database transaction commits, or a worker can receive a job for a row that does not exist yet:

```python
from django.db import transaction

def signup(request):
    user = User.objects.create(email=request.POST["email"])
    transaction.on_commit(lambda: harbor.queue("emails").enqueue(
        {"user_id": user.id, "template": "welcome"},
        idempotency_key=f"welcome-{user.id}",
    ))
    return redirect("/welcome")
```

Run workers as a separate process — a management command that calls `harbor.run()` is a common pattern — and not inside the processes of the web server.
