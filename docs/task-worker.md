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
