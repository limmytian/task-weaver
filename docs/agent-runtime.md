# Ti execution and Partners integration

[简体中文](agent-runtime.zh-CN.md).

Ti is Task Weaver's server-side agent for explicitly assigned tasks and scheduled
work. It is separate from the local `tw daemon` requirement-lane executor. The
server-side runtime uses a bounded model/tool loop in Task Weaver and a configured
Partners Streamable HTTP MCP backend for sandbox operations. Configuring a
registered general-purpose MCP server alone does not configure this backend.

The runtime loads the task and its policy, issues a bounded execution delegation,
and checks live authority and the worker lease around tool dispatch. Live mode
makes authorized platform and sandbox tools available; dry-run and disabled
policies do not grant the same execution capability. Model and infrastructure
credentials stay in trusted services, not model-visible tool arguments. The
sandbox adapter owns the mapping from a run attempt to its workspace and job IDs;
models use attempt-scoped operation keys rather than choosing arbitrary sessions.

Sandbox execution, job status and file operations use the Partners MCP adapter.
The current MCP contract does not provide a per-command network switch, so the
runtime rejects sandbox execution when the task policy disallows network instead
of pretending shell text enforces isolation. A failed or unconfirmed sandbox
operation routes the run to review; a successful command alone does not establish
that the task or its acceptance checks succeeded.

Dispatch checkpoints and sandbox operation receipts preserve the outcome of
accepted operations. An interrupted attempt with a checkpoint is routed to review
instead of replaying its model and tools as a new run. Owned workspace cleanup is
recorded for asynchronous reclamation; an unconfirmed cleanup or unknown remote
outcome is not proof that an operation stopped. Consult [execution recovery](live-planning-recovery.md)
and [requirement workflows](workflows.md) before retrying or accepting work.

The implementation is in `packages/core/src/services/ti-task-runtime.ts`,
`ti-sandboxes.ts` and their authorization and recovery services. The
`scripts/ti-runtime.live-e2e.test.ts` and related PostgreSQL tests describe the
scoped verification paths. Live execution depends on a configured model,
execution policy and compatible sandbox service; availability in source does not
prove a particular deployment or provider has passed those tests. See
[hosted capability operations](hosted-capability-operations.md) and
[agent token usage](agent-token-usage.md) for related operating guidance.
