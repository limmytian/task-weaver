# Verified inbound events

An inbound source belongs to one project and one requirement. Its signed events
can invoke only configured, bounded actions: create a task, add a comment, update
permitted task fields, record comment-based workflow evidence, or run an existing
schedule in that same project and requirement. Events cannot choose credentials,
change ownership, move tasks between requirements, upload code or grant permission.
Recording evidence does not approve or advance a workflow stage.

Create sources in Settings → Inbound Events, through `/api/v1/inbound/sources`,
or with `tw inbound create --file source.json --json`. Project resource read/write
and webhook management grants are required. Schedule actions additionally require
project management and execution grants. Store the one-time signing secret securely.
Editing a source replaces its credential/authority binding; queued events from an
older binding cannot run under a new configuration.

## Sender contract

POST a JSON envelope to the returned endpoint path, under the instance's API URL:

```json
{
  "eventId": "build-12345",
  "type": "build.completed",
  "occurredAt": "2026-01-01T12:00:00Z",
  "data": { "title": "Build 12345", "status": "passed" }
}
```

`eventId`, `type` and object-valued `data` are required. `occurredAt` is optional
and is informational. The HTTP body must be UTF-8 JSON and at most 65536 bytes.
Unknown envelope fields are rejected.

Set `X-TaskWeaver-Signature-V1` to `t=<Unix seconds>,v1=<hex HMAC-SHA256>`.
Sign the bytes `<Unix seconds>.<raw HTTP body>` using the source secret. The
request timestamp must be within five minutes of server time; event occurrence
time does not replace this check. The receiver verifies the signature before
interpreting JSON or storing an event. A browser session or an actor ID in the
body is not source authentication.

HTTP 202 acknowledges durable acceptance, not completed actions. Retries of the
same event must preserve the body bytes and event ID. A matching duplicate returns
the existing record and never repeats committed actions. Reusing an ID with a
different body returns 409. Sources are limited to 100 newly accepted events per
minute and 1000 queued/in-progress events; excess requests return 429. Invalid
signatures return 401 and oversized bodies return 413.

## Rules and authority

Rules match explicit event types and up to ten scalar conditions. Conditions use
`equals`, `not_equals` or `exists` against bounded dotted paths such as
`data.status`. Templates substitute scalar values with `{{data.title}}`; they do
not evaluate expressions or execute code. Task targets are fixed UUIDs or values
from an explicitly configured path such as `data.taskId`. Every target is resolved
from the database and must remain in the source's project and requirement.

The worker rechecks the persisted owner, original credential, stored permission
ceiling, live membership and configuration binding before action dispatch.
All actions for an event, their receipts, resulting outbound events and the inbox
completion state share one database transaction. Any rejected action rolls the
whole batch back. Worker leases and receipt identities prevent a restart from
repeating committed database writes. Temporary processing failures retry at most
five times; permanent validation/authorization failures stop.

A `run_schedule` action queues normal owned Ti work through the existing schedule
service. Model execution remains subject to that owner's Ti policy, model,
executor credential and execution lease. There is no separate MCP polling engine.

## History and recovery

Use Web history or these CLI commands:

```bash
tw inbound list --project <project-id> --json
tw inbound events <source-id> --json
tw inbound actions <source-id> <event-id> --json
tw inbound retry <source-id> <event-id> --json
```

REST history is `GET /api/v1/inbound/sources/:id/events`; action receipts append
`/:eventId/actions`, and retry appends `/:eventId/retry` with POST. Routine history
omits payload bodies and signing secrets. Successful events cannot be replayed
through retry. Failed events can be retried only under the same still-live source
binding. Rotation, deletion and revoked credentials cannot silently restore old
queue eligibility. Outbound events caused by an action retain the inbox ID as
causation/correlation, so operators can trace accepted input to committed output.
