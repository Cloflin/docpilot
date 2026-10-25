---
title: Security
description: How Harborline protects your jobs — encryption at rest and in transit, client-side payload encryption, IP allowlists, SAML SSO, audit logs and data retention.
---

# Security

This page describes how Harborline protects the jobs you send it, and which controls you can add on top: client-side encryption, an IP allowlist, single sign-on and the audit log.

## Encryption at rest and in transit

Harborline encrypts all stored data — jobs, payloads, logs, history and backups — with AES-256. The API, the dashboard and webhook deliveries use TLS 1.2 or later only; connections that offer an older TLS version are refused. Webhook endpoints must be HTTPS URLs.

For payloads that Harborline should not be able to read at all, use [client-side encryption](/guides/encryption): the SDK encrypts each payload with AES-256-GCM before it leaves your process, with a key that never leaves your servers. Harborline then stores only ciphertext, at the cost of payload search in the dashboard.

## IP allowlist

On the Scale plan you can restrict API access to a list of IP addresses and CIDR ranges, under **Project settings → Security → IP allowlist**. Requests from any other address are refused with `HL4001 unauthorized`, even with a valid key. The allowlist applies to the API only; access to the dashboard is governed by sign-in and SSO.

Add the egress addresses of every service that calls Harborline — producers, workers, CI and monitoring — before you turn the allowlist on, or those services lose access at once. Changes take effect within a minute and are recorded in the audit log.

## Dashboard sign-in and SSO

Members sign in to the dashboard with their email address. A workspace on the Scale plan can require SAML single sign-on: members then sign in through your identity provider, and their access ends when you remove them there. SSO applies to the dashboard only. API access always uses API keys; there is no OAuth and no SAML for the API.

Members have one of two roles. An **owner** manages billing, members and SSO; a **developer** manages projects, queues, keys and webhooks. Keep the number of owners small, and remove members who no longer need access.

## Audit log

The audit log records who did what in a workspace: key creation, rotation and revocation; queue creation and deletion, pause, drain and purge; replays and deletions of dead jobs; changes to schedules and webhook endpoints; and changes to members, roles and SSO. Each entry has the time, the actor — a member or an API key — the project and the IP address.

| Plan | Audit log retention |
|---|---|
| Free | not available |
| Team | 90 days |
| Scale | 1 year |

Open it under **Workspace settings → Audit log**, filter by project, actor or action, and export entries as CSV.

## Data retention

| Data | Kept for |
|---|---|
| Succeeded and canceled jobs | 1 day on Free, 7 days on Team, 30 days on Scale |
| Job logs | 3 days on Free, 14 days on Team, 30 days on Scale |
| Dead jobs in dead-letter queues | 14 days |
| Failed webhook events | 7 days |
| Idempotency keys | 24 hours |
| Pending jobs (`scheduled`, `queued`, `failed`) | until they run, are canceled or are purged |

When a retention period ends, the data is deleted from the live system, and from backups within 30 days. Deleting a project deletes all of its data on the same terms.

## Report a vulnerability

If you believe you have found a security issue in Harborline, email `security@harborline.dev` with the details and the steps to reproduce it. We answer within two business days, keep you informed while we fix it, and credit you if you want. Do not test against the data of other customers, run denial-of-service tests, or publish the issue before it is fixed.

Never send API keys, signing secrets or payload encryption keys to support or to the security address. If one was exposed, revoke or roll it first; [API keys and scopes](/account/api-keys#revoke-a-key) shows how.
