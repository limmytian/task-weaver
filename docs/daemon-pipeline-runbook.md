# Daemon Pipeline Operator Runbook

This runbook covers the unified local supervisor for Task Weaver executor, reviewer, and merger daemons. The supervisor retains separate daemon instance IDs and worker pools while giving operators one configuration and one lifecycle surface.

## Prerequisites

- Install the `tw` CLI, verify a managed-Agent scoped Key with `tw auth login`,
  and confirm its stable actor with `tw auth whoami --json`.
- Grant current project permissions and the explicit executor/reviewer/merger
  entitlement for each role. Instance/node/client IDs cannot grant authority.
- Preserve the original worker lease/fence. Children receive task-bounded local
  broker access with a maximum 15-minute delegation; only the original supervisor
  credential can renew without widening tasks/repositories/actions.
- Verify revoke/expiry/member-removal cancellation in a disposable environment.
  Supervisor, provider and Git secrets must not be inherited by children.
- Configure non-secret repository catalog entries and local credential profile references.
- Install every AI CLI named in the pipeline configuration.
- Ensure the daemon node can read and push linked repositories and reach the configured API.
- Use Node.js 20 or newer.

Start from [the example configuration](../examples/daemon-pipeline/pipeline.yaml). Store secrets in the service environment or a protected environment file. The pipeline configuration should contain only environment references.

See [authenticated access](authenticated-access.md) for credential, cancellation
and offline-upgrade rules. These operator commands require explicit execution
authorization; source acceptance alone does not start a daemon. Unconverted SLO,
background acquisition and personal autonomous Ti remain closed.

## Validate and Start

```bash
tw daemon pipeline validate --config /etc/task-weaver/pipeline.yaml
tw daemon pipeline doctor --config /etc/task-weaver/pipeline.yaml
tw daemon pipeline start --config /etc/task-weaver/pipeline.yaml
```

`validate` checks schema version 1 and rejects unknown or incompatible fields. `doctor` checks:

- API connectivity and daemon role endpoint compatibility
- configured or auto-detected AI binaries
- model and reasoning settings
- review check shell syntax and prompt-file presence
- worktree-root permissions
- read, push, and forge credential readiness for active Requirement repositories
- configured base-branch reachability

`start` repeats the doctor checks before it creates the run directory or starts a daemon role. A failed check exits with code 1 and does not allow work acquisition.

For system service managers, use service mode. The process remains in the foreground so launchd, systemd, or a container runtime owns restart policy for the supervisor itself:

```bash
tw daemon pipeline start --config /etc/task-weaver/pipeline.yaml --service
```

## Configuration Reference

The supported version-1 sections are:

| Section | Purpose |
|---|---|
| `projectId`, `baseBranch`, `runMode` | Project scope and process mode |
| `roles.executor` | Workers, tools, capabilities, queue mode, models, reasoning, prompts |
| `roles.reviewer` | Workers, tools, models, reasoning, checks, prompts, review policy |
| `roles.merger` | Merger enablement and worker capacity |
| `retry` | Maximum child restarts and exponential backoff bounds |
| `limits` | Active roles, graceful shutdown timeout, control polling interval |
| `mergePolicy` | Direct, provider, or manual merge policy compatibility |
| `environment` | Target variables mapped from existing source variables |
| `logging` | Runtime root, bytes per JSONL file, retained file count |

Version 1 supports `direct` and provider-native GitHub/Gitea merge workers. `manual` mode requires the merger role to be disabled; the queue then exposes the Requirement as an operator action with its pull-request or compare URL. Reviewer configuration may set `postForgeSummary: true` to publish the local review summary on the provider pull request.

## Inspect and Control

Find the run ID and inspect all role slots:

```bash
tw daemon pipeline list
tw daemon pipeline status --run <run-id>
tw daemon pipeline status --run <run-id> --role reviewer --json
```

Role controls are asynchronous commands consumed by the supervisor. A queued command returns exit code 0; invalid run IDs, disabled roles, or terminal runs return a nonzero code.

```bash
# Drain current executor work and leave acquisition paused.
tw daemon pipeline pause --run <run-id> --role executor

# Start the same role and daemon instance again.
tw daemon pipeline resume --run <run-id> --role executor

# Drain and replace an unhealthy reviewer child without stopping siblings.
tw daemon pipeline restart --run <run-id> --role reviewer

# Drain a role and leave it stopped.
tw daemon pipeline drain --run <run-id> --role merger

# Gracefully drain every role and stop the supervisor with exit code 0.
tw daemon pipeline stop --run <run-id>
```

`pause`, `drain`, `restart`, and `stop` use each daemon role's graceful SIGTERM path. Active claims continue to heartbeat while the role drains. Work that cannot finish is routed through the role's existing retry/review recovery contract before the child exits.

## Logs and Retention

Each run stores:

```text
~/.task-weaver/pipelines/<run-id>/
├── state.json
├── events.jsonl
├── events.jsonl.1
└── control/
```

Runtime files are created with owner-only permissions. JSONL rotation is bounded by `logging.maxBytes` and `logging.maxFiles`. Events include the fields that are available at emission time: run, role, worker, Requirement, task, repository, command, duration, retry, failure code, level, and message.

```bash
tw daemon pipeline logs --run <run-id> --level error
tw daemon pipeline logs --run <run-id> --role executor --requirement <requirement-id>
tw daemon pipeline logs --run <run-id> --task <task-id> --since 2026-07-24T00:00:00Z
tw daemon pipeline logs --run <run-id> --repository git.example.com/team/service --json
```

## Signals and Exit Codes

| Outcome | Supervisor exit code |
|---|---:|
| Operator `stop`, SIGINT, or SIGTERM after graceful drain | `0` |
| Child exhausts `retry.maxRestarts` | child nonzero code, or `1` when unavailable |
| Invalid configuration or failed doctor checks | `1` before child spawn |
| Invalid local control target | `1` from the control command |

If SIGINT or SIGTERM arrives, the supervisor stops accepting control requests, signals every running role, waits up to `limits.shutdownGraceMs`, escalates remaining children to SIGKILL, persists final state, and exits deterministically.

## Service Examples

Ready-to-edit examples are included for:

- [systemd](../examples/daemon-pipeline/systemd/task-weaver-pipeline.service)
- [launchd](../examples/daemon-pipeline/launchd/com.task-weaver.pipeline.plist)

The service manager should restart the supervisor only on failure. Child-role restart limits remain owned by the pipeline configuration.

## Troubleshooting

| Symptom | Action |
|---|---|
| Doctor reports `api_unavailable` | Verify `TW_API_URL`, API key, TLS/network routing, and `tw auth status`. |
| Doctor reports `ai_tool_unavailable` | Install the configured binary or correct the service `PATH`. |
| Credential readiness fails | Run `tw repo credential readiness <repository-id> --operation read|push|forge` on the daemon node. |
| Base branch is unreachable | Confirm the Requirement repository link, base branch, transport, and read credential. |
| A role repeatedly restarts | Query error logs by role and inspect `lastFailureCode` in pipeline status. |
| A run appears stale after a host crash | Confirm the recorded supervisor PID is absent, inspect Task Weaver claim expiry, and start a new run. Do not reuse or edit the old run directory. |
| Logs are missing expected task IDs | Query by role/run first; child lines that do not contain an ID still remain as `role_output` events. |
