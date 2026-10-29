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
