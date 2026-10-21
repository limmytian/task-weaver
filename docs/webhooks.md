# Outbound webhooks

Task Weaver persists task, requirement and document event hints in an outbox in
that business operation's database transaction. A rolled-back operation does not
leave an event to deliver. Realtime notifications only accelerate delivery; the
API's durable worker independently recovers pending events and attempts after a
restart. Other realtime event families are not outbound webhook sources.

Each version 1 envelope contains a stable `id`, event name, occurrence timestamp,
authorized resource hints, actor reference when known, and correlation/causation
identifiers. Resource hints are invalidations, not complete historical resource
snapshots. Authorization is checked during fanout and again before every network
attempt. Deleted documents use their persisted deletion scope. Personal and
foreign-project resources never become project/global webhook payloads.

## Delivery and verification

Delivery is at least once. Receivers must deduplicate `X-TaskWeaver-Delivery`;
`X-TaskWeaver-Event-Id` identifies the underlying event across manual replays.
A retry preserves the delivery ID and serialized body. A manual replay creates a
new delivery ID, retains the event ID and records `replayOf` in history.

For the timestamped signature, retain the raw HTTP body bytes, reject timestamps
outside the receiver's chosen short tolerance, and compare HMACs in constant time:

- `X-TaskWeaver-Timestamp`: Unix seconds.
- `X-TaskWeaver-Signature-V1`: `t=<timestamp>,v1=<hex HMAC-SHA256>`.
- The signed bytes are `<timestamp>.<raw body>` using the webhook signing secret.
- The compatibility `X-TaskWeaver-Signature` is `sha256=<HMAC-SHA256(raw body)>`.

The secret is returned only at creation or explicit rotation. Routine history
omits secrets, payloads and receiver response bodies. Updating a configuration
creates a new authority binding; old deliveries cannot be replayed under that
new generation. Disabling a hook, revoking its credential or reducing its owner's
permissions stops pending deliveries and retries. Redirects are not followed.

Network failures, HTTP 408/425/429 and HTTP 5xx receive at most five automatic
retries, using exponential delay. Other HTTP failures stop automatically. A
worker interrupted after sending may retry the same delivery: receiver-side
deduplication is required because HTTP cannot guarantee exactly-once effects.
Leases prevent concurrent workers from normally sending the same attempt.

## Operations

Open Settings → Webhooks to create or edit configuration, pause/resume, rotate a
secret, send a test, inspect paginated history/attempts and replay a delivery.
Project management permission is required; global hooks require an instance
administrator with the corresponding global grants.

REST management is under `/api/v1/webhooks`. Delivery history is
`GET /:id/deliveries`; attempt inspection is
`GET /:id/deliveries/:deliveryId/attempts`; replay is
`POST /:id/deliveries/:deliveryId/replay`. The existing `/retry` route is retained.
The same validated services back Web, REST and CLI:

```bash
tw webhook create --file webhook.json --json
tw webhook list --project <project-id> --json
tw webhook test <webhook-id> --json
tw webhook deliveries <webhook-id> --status failed --json
tw webhook attempts <webhook-id> <delivery-id> --json
tw webhook replay <webhook-id> <delivery-id> --json
```

A queued event or a successful test request does not prove successful delivery of
all business events. Inspect each delivery's status, next retry and attempt
history. A failed delivery without `nextRetryAt` has exhausted retries or reached
a permanent failure, including authorization revocation.
