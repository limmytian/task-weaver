# Durable event PostgreSQL verification

On 2026-11-05, the durable event migration and service tests passed against a fresh local PostgreSQL 17.11 database (2 tests, 0 failures, 0 skips). The service test exercises concurrent sequence allocation, duplicate IDs, transaction rollback, project and resource isolation, principal-owned checkpoints, replay on a new connection, repeated and backward acknowledgments, retention locking and expired cursors, credential revocation and membership removal. Retention is simulated with a transaction that deletes rows and advances the floor; this does not establish that an automated retention job runs. Reconnection verifies database persistence across client connections, not a PostgreSQL server restart. These checks do not assert exactly-once delivery.

To reproduce with a disposable local PostgreSQL cluster and installed workspace dependencies:

```sh
initdb -D /tmp/tw-event-pg --auth=trust --no-locale
pg_ctl -D /tmp/tw-event-pg -o '-h 127.0.0.1 -p 55439' -l /tmp/tw-event-pg.log start
createdb -h 127.0.0.1 -p 55439 tw_event_e2e
TW_EVENT_E2E_DATABASE_URL=postgres://127.0.0.1:55439/tw_event_e2e pnpm exec tsx --test packages/core/src/services/durable-events.postgres-e2e.test.ts packages/db/src/durable-events.postgres-e2e.test.ts
pg_ctl -D /tmp/tw-event-pg stop
```

Use a fresh cluster and an unused port; the tests write fixture data and run migrations. The database URL is deliberately restricted to `127.0.0.1` and `tw_event_e2e` by the service test.
