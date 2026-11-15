# Task worker

`tw worker start` pulls eligible tasks for a project and runs Codex in a task
workspace. A managed agent needs a scoped API key, project membership and
`execution.run` and `resource.write` permission. Configure the CLI with
`tw auth login` and verify the agent identity before starting a worker.

```bash
tw worker start --project <project-id> --model <codex-model>
```

Use `--once` for at most one task, or `--requirement <requirement-id>` to limit
the queue. Git delivery also needs `--git-name` and `--git-email` for signed-off
commits. A resident process can run on a host or in a container with persistent
worker configuration, the Codex login and task workspaces mounted. Configure any
network proxy in the environment, not in an image or committed configuration.
Protect the login and avoid exposing unrelated credentials to the executor.

The API atomically acquires a task and renews its fenced lease. Workers wake on
events and fall back to polling. They submit verified artifacts and guarded Git
deliveries. A stopped or expired attempt is not automatically retried: inspect
its workspace and external effects, then use `tw worker attempts` and
`tw worker resolve` to record a review or explicitly safe retry. Unknown remote
process state or a lost Git response is not proof that an operation stopped.

`tw worker presence --project <project-id>` reports worker activity, including
quota cooldown. A successful model request can be used to verify the configured
account; credentials and quota can differ across independent Codex homes.
Historical daemon and execution-slice records are retained for audit, but their
old scheduling commands and creation interfaces are retired.

## Inspect and resolve in the Web UI

Needs attention includes interrupted or expired task attempts. Open the affected
requirement and expand **Worker evidence and recovery**, or open the project's
Workers tab. Inspect the task, attempt timestamps, reported reason, delivered
work and known Git delivery observations. A heartbeat or long phase does not
prove that a process is stuck. Missing shared evidence does not establish that
the local workspace is empty.

A current project manager can send an attempt to review or record a safe retry.
Both require an inspection reason; retry also requires an explicit safety
assessment. Unresolved Git deliveries block retry. Remote verification checks
the observed branch and commit through the existing trusted forge path; a
failed check remains unresolved. Other external effects still require human
inspection. If the request fails, inspect current state before submitting again.
The server rechecks permission, attempt identity and concurrent changes on every
request. A stale page cannot resolve a replacement attempt. Successful recovery
refreshes the attempt and attention views and records an audit event.

## Delivery and token evidence

Project Analytics and requirement details show a compact evidence summary.
Requirement acceptance decisions and worker review opinions are separate;
task completion does not establish owner acceptance. Additional attempts do not
prove defects, and recorded human recovery decisions do not measure all human
effort. Closed-attempt durations include waiting and recovery.

Workers register each executor process with the current attempt fence and report
supported Codex counters through the existing Usage model. Cumulative revisions
replace earlier snapshots. Retries and conflict-resolution processes use fresh
process identities. Cache reads may be included in input and must not be added.
Unknown and partial counters retain those labels; reporting failures cannot
establish zero usage. Coverage includes registered processes and the existing
known Ti attempt inventory. Unregistered worker or historical daemon processes
remain outside that denominator. Inspect process reports and coverage before
drawing conclusions; no money or inferred productivity gain is reported.

See [the maintained Chinese guide](task-worker.zh-CN.md).
