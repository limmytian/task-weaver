# Durable event PostgreSQL verification

On 2026-11-05, the durable event migration and service tests passed against a fresh local PostgreSQL 17.11 database (2 tests, 0 failures, 0 skips). The service test exercises concurrent sequence allocation, duplicate IDs, transaction rollback, project and resource isolation, principal-owned checkpoints, replay on a new connection, repeated and backward acknowledgments, retention locking and expired cursors, credential revocation and membership removal. Retention is simulated with a transaction that deletes rows and advances the floor; this does not establish that an automated retention job runs. Reconnection verifies database persistence across client connections, not a PostgreSQL server restart. These checks do not assert exactly-once delivery.

To reproduce with a disposable local PostgreSQL cluster and installed workspace dependencies:

```sh
initdb -D /tmp/tw-event-pg --auth=trust --no-locale
pg_ctl -D /tmp/tw-event-pg -o '-h 127.0.0.1 -p 55439' -l /tmp/tw-event-pg.log start
createdb -h 127.0.0.1 -p 55439 tw_event_e2e
TW_EVENT_E2E_DATABASE_URL=postgres://127.0.0.1:55439/tw_event_e2e pnpm exec tsx --test packages/db/src/durable-events.postgres-e2e.test.ts
TW_EVENT_E2E_DATABASE_URL=postgres://127.0.0.1:55439/tw_event_e2e pnpm exec tsx --test --test-concurrency=1 packages/core/src/services/durable-events.postgres-e2e.test.ts apps/api/src/durable-events.postgres-e2e.test.ts apps/api/src/daemon-event-consumer.postgres-e2e.test.ts
pg_ctl -D /tmp/tw-event-pg stop
```

Use a fresh cluster and an unused port; the tests write fixture data and run migrations. The database URL is deliberately restricted to `127.0.0.1` and `tw_event_e2e` by the service test.

On 2026-11-05, the migration test and the three service, API, and daemon tests passed against fresh local PostgreSQL databases. The service test covers concurrent lease acquisition, renewal, stale and expired fences, takeover, principal isolation, revocation, and reconnection; the daemon test exercises fenced REST consumption. The migration test must run against an empty schema: running it after the service tests in the same database fails because they have already created that schema. Reconnection tests a new database client, not a server restart.

Daemon checkpoints are scoped by project, authenticated principal, and the persistent node ID. A database lease fences competing daemon instances; takeover waits for lease expiry. The checkpoint endpoint (and `tw events cursor`) reports `status`, `cursor`, and `retentionFloor`. Expiration is derived from the persisted checkpoint and stream floor, so it remains visible after restart. An expired daemon consumer stops replay and requires review of the missing history and a deliberate resynchronization; it does not silently advance to the floor. Delivery can repeat after an interrupted handler or acknowledgment, and a lease does not stop a former handler's external effects. Changing node ID or principal creates a separate checkpoint.

Expired daemon checkpoints create a durable incident through the fenced consumer lease. A project-scoped caller can inspect its own principal's incidents at `GET /api/v1/events/incidents?projectId=...` and resolve one with `POST /api/v1/events/incidents/resolve` containing `projectId` and `incidentId`. The incident includes the consumer, checkpoint and retention floor. Review available history and independently investigate uncertain external effects before deliberately resynchronizing. Resolution records review only; it does not advance the checkpoint. If the checkpoint remains expired, a later daemon restart records another open incident. Access requires current project authorization.
