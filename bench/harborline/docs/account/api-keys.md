---
title: API keys and scopes
description: Create, scope, rotate and revoke Harborline API keys — live and test keys, the six scopes, zero-downtime rotation, and how keys differ from webhook signing secrets.
---

# API keys and scopes

Every request to the Harborline API is authenticated with an API key. A key belongs to one project, can be limited to a set of scopes, and can be rotated without downtime.

## Live and test keys

| Prefix | Reaches | Use it for |
|---|---|---|
| `hl_live_` | The project's live data | Production and staging services |
| `hl_test_` | The project's sandbox only | Local development, test suites, CI |

The sandbox is a separate copy of the project with its own queues, jobs and schedules. A test key can never read or change live jobs, and a live key cannot reach the sandbox. Sandbox executions are free and do not count toward the plan's allowance; the sandbox has the Free plan's API rate limit of 20 requests per second.

Harborline shows a key only once, when it is created. It stores only a hash, so a lost key cannot be recovered; create a new one instead.

## Send a key

Send the key in the `Authorization` header as a bearer token:

```http
Authorization: Bearer hl_live_xxx
```

The SDKs and the CLI read it from `HARBOR_API_KEY` unless you pass it in code. A request without a valid key is refused with `HL4001 unauthorized` (HTTP 401). That includes revoked keys, rotated keys after their overlap window, and keys sent to the endpoint of another region.

Never put keys in front-end code or mobile apps: anyone who has a key can act on the project within the key's scopes. Keep keys in environment variables or a secret manager, and give every service its own key, so that you can revoke one without touching the others.

## Scopes

| Scope | Allows |
|---|---|
| `jobs:read` | Read jobs, queues, queue stats, dead jobs and schedules |
| `jobs:write` | Enqueue, cancel and retry jobs; reserve, ack, nack and touch them as a worker |
| `queues:admin` | Create, change and delete queues; pause, resume, drain and purge them; replay and delete dead jobs |
| `schedules:write` | Create, change, pause, resume and delete schedules |
| `webhooks:admin` | Manage webhook endpoints and roll their signing secrets |
| `metrics:read` | Read `GET /v3/metrics` |

A key created without scopes has **all** scopes. A key with scopes can call only the endpoints its scopes allow; anything else is refused with `HL4003 forbidden_scope` (HTTP 403), and the message names the missing scope. Typical keys: a producer with `jobs:write`; a worker with `jobs:read,jobs:write`; a deploy step with `queues:admin,schedules:write`; Prometheus with `metrics:read` only. The scopes of a key cannot be changed after it is created; create a new key instead.

## Create a key

In the dashboard, open **Project settings → API keys → Create key**, choose live or test, name the key and pick its scopes. With the CLI:

```bash
harbor keys create --name=checkout-producer --scopes=jobs:write
harbor keys create --name=ci-tests --scopes=jobs:read,jobs:write --test
```

The command prints the key once. `harbor keys list` shows the id (`key_…`), name and scopes of every key and when it was last used, but never the key itself. Key commands need a user login: an API key cannot create, rotate or revoke keys, and the API has no key endpoints.

## Rotate a key

Rotation replaces a key without downtime:

```bash
harbor keys rotate key_01JB5M7P9R1T3V5X7Z9B1D3F5H
```

`harbor keys rotate` creates a new key with the same name and scopes and prints it. The old key keeps working for **24 hours** — the overlap window — and is then revoked automatically. To rotate safely:

1. Run `harbor keys rotate <key-id>` and copy the new key.
2. Store it in your secret manager and deploy it to every service that uses the old key.
3. Check in `harbor keys list` that the last use of the old key stops changing.
4. Let the 24 hours run out, or revoke the old key early with `harbor keys revoke`.

If the old key leaked, do not wait for the overlap to end: revoke it at once, and accept a short outage for the services that still use it.

## Revoke a key

`harbor keys revoke <key-id>`, or **Revoke** in the dashboard, disables a key immediately. Requests that use it get `HL4001 unauthorized` from that moment on; there is no overlap window and no undo.

Revoke the keys of people who leave the team, the keys of services you shut down, and any key that may have been exposed — in a log, a repository or a support ticket. Revocations, like creations and rotations, are recorded in the [audit log](/account/security#audit-log) on the Team and Scale plans.

## API keys versus signing secrets

Harborline uses two kinds of secrets that are easy to mix up:

| | API key | Signing secret |
|---|---|---|
| Prefix | `hl_live_` or `hl_test_` | `whsec_` |
| Belongs to | a project | one webhook endpoint |
| Direction | your code calls Harborline | Harborline calls your code |
| Used for | authenticating API requests | verifying `Harbor-Signature` on webhooks |
| Replacing it | `harbor keys rotate`, 24-hour overlap | **Roll secret**, both secrets sign for 24 hours |

An API key never verifies a webhook, and a signing secret cannot call the API. See [Verify webhook signatures](/guides/webhook-signatures).

## OAuth and single sign-on

API access uses API keys only. Harborline has no OAuth flow and no SAML for the API: a service, a script or a CI job always authenticates with a key.

SAML single sign-on exists for the **dashboard**, on the Scale plan only. With SSO on, members sign in through your identity provider, and removing someone there removes their dashboard access. It does not affect API keys: keys that a person created keep working after they leave, until you revoke them, so revoke them as part of offboarding.
