# Daemon module ownership

The daemon command retains public command options, configuration, registration, polling/SSE scheduling and process shutdown. Role-specific execution continues to use the same REST contracts and live lease fences.

`apps/cli/src/daemon-delivery-worker.ts` owns a delivery attempt: provision its workspace, inspect registered evidence, optionally run the workflow agent, finalize repository delivery, advance the guarded workflow, then release the lane and reset worker fields. Command transports, tool/model selection and scheduling enter through typed dependencies. Worker/lane data lives in `daemon-worker-types.ts`; the runner does not import the command.

Ownership remains with the existing modules:

- `DaemonLifecycle`: tracked operations, abort and drain.
- `LeaseSupervisor`: process/lane heartbeat and health; the command cancels unhealthy workers.
- `repository-workspace`: repository locks, provisioning, inspection and finalization.
- `execution-control-monitor` and `local-execution-inventory`: durable control observation and preserved local execution.
- Evidence and worker-console coordinators: request/stream lifetime.

The runner preserves the delivery attempt's existing order: report busy, enter the attempt, perform work, release in `finally`, unregister the lease, clear worker fields, report aggregate status, then stop a successful `--once` run or schedule polling. Errors propagate after cleanup. Release failures remain best effort; they do not authorize a stale worker to advance. Cancellation and lease health are checked before guarded delivery updates and stage advancement. The outer lifecycle still owns tracking and cancellation; the extraction creates no second supervisor.

The larger execution/review/merge loops remain in the command. Future extractions should retain these owners and add a seam only when it reduces coupling without changing cancellation, recovery, cleanup or credential behavior.

## Operational Web view

The Daemons page owns list/queue/overview/SLO/metrics queries, 30-second refresh, live clock, operator mutations and pending state. It passes typed data and callbacks to `worker-card.tsx` and `queue-panel.tsx`. Shared display shapes live in `daemon-view-model.ts`; formatting and role presentation live in `daemon-presentation.ts`.

`timeline-dialog.tsx` retains its existing on-demand history query, cursor/filter/live state and 30-second refresh. `operator-action-dialog.tsx` renders the current action/reason and delegates confirmation to the page. The worker console stays inside the worker card, keyed by run ID with the same requirement/task/run/generation target. No second source of server state or additional console lifetime is introduced. Existing control-plane, console, recovery and evidence modules retain their responsibilities.
