# Partners Gateway reference module

`@task-weaver/partners-gateway` is a source-visible reference implementation of the Task Weaver module contract. Its package root exports the Gateway HTTP client, streaming parser, configuration validators, and run-to-job conversion functions. The `/module` export contributes the worker control routes, a background runner, a scheduled-run event subscriber, and a health check. The `/worker` export contains the durable run executor and recovery loop.

The API application installs this module through `createPartnersGatewayModule(db, env)`. The module owns `/api/v1/pi-agent/worker/status` and `/api/v1/pi-agent/worker/health`; existing `tw pi worker` commands continue to call those endpoints. Run acquisition, progress, retries, terminal completion, and lease recovery use Core's `piAgentService` persistence contract. Unit tests cover the client and worker in isolation. The PostgreSQL end-to-end harness uses a migrated disposable PostgreSQL instance, real API/Gateway HTTP and SSE transport, and a local Gateway protocol fixture.

Configuration is validated before the application starts. Set `PARTNERS_GATEWAY_URL` and `PARTNERS_GATEWAY_SERVICE_TOKEN` together to enable the runner. Worker timing and identity settings use the existing `PARTNERS_GATEWAY_WORKER_*` variables. The module configuration contribution marks `serviceToken` as sensitive. Disabled instances retain worker status and health responses for CLI compatibility.

## PostgreSQL end-to-end verification

Run `pnpm test:gateway-postgres` from the repository root with Docker available.
The runner uses a digest-pinned PostgreSQL 16/pgvector image, a temporary
loopback port and database, and always removes the disposable container. It
never loads the private `.env`. Results are stored under ignored
`release-artifacts/partners-gateway-postgres-e2e`.

The harness verifies API-key authentication, module controls, live progress and
heartbeat persistence, success/failure/cancellation/timeout, SSE-to-polling
fallback, retry/backoff/exhaustion, concurrent acquisition, expired lease
recovery, artifact reference filtering, and application worker startup/shutdown.
The test is skipped by the normal unit command unless
`TW_GATEWAY_E2E_DATABASE_URL` selects the disposable loopback database
`tw_gateway_e2e`. Use the runner for routine execution.

This establishes the real PostgreSQL integration path with a controlled Gateway
HTTP fixture. It does not certify an external Partners Gateway deployment,
remote command execution, paid model execution, or remote job idempotency.

## Live Gateway verification

Set `TW_GATEWAY_LIVE_URL` and `TW_GATEWAY_LIVE_TOKEN` through a protected local
process environment, then run `pnpm test:gateway-live`. The optional
`TW_GATEWAY_LIVE_TENANT` defaults to `task-weaver`. The Gateway must permit that
tenant and an isolated verification project. The command creates short-lived
remote sandbox jobs and artifacts, and a disposable local PostgreSQL database.
It requires Docker and a reachable deployed Gateway. It never loads `.env`.

The suite verifies readiness and authentication, input staging, actual shell
execution, stdout/stderr SSE and replay, artifact download and checksum,
idempotent submissions and conflicting payload rejection, failure, timeout,
cancellation, real API/Core persistence, and expired lease recovery without
remote reexecution. Unfinished verification jobs are cancelled during cleanup;
remote job records and artifacts remain subject to the Gateway retention policy.

Stable job IDs are sent as `Idempotency-Key`. Submission metadata uses the
original requested provider/model so progress updates do not change the retry
payload. An ID alone is insufficient to prevent reexecution in the reference
Gateway. Tasks changed after submission can still produce a conflict and should
be submitted as a new run.

The default worker command prints the staged task prompt. It does not invoke an
AI model or implement autonomous task resolution. Live shell verification does
not certify model execution, tenant isolation between independently scoped
credentials, or Gateway restart/disaster recovery.
