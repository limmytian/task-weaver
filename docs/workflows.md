# Requirement workflows (0.3.8)

A requirement owns delivery, acceptance, and integration. Tasks and execution slices describe execution units; finishing one does not independently accept or integrate the requirement.

## Configuration and defaults

Web creation, REST, CLI, batch creation, and plan application resolve the same configuration: explicit requirement workflow or preset, project default, then `basic`. The effective definition is stored on the requirement. Later project changes do not rewrite existing requirements. Requirements created before this feature keep their legacy workflow until explicitly migrated while draft or approved, with all tasks unstarted.

| Stage | Automatic role | Purpose |
| --- | --- | --- |
| Delivery | Executor | Finish execution and register the selected primary evidence |
| Acceptance | Reviewer | Evaluate instructions and named required checks |
| Integration | Merger | Apply accepted results to the selected destination |

Each stage supports `automatic`, `manual`, and `skip`. Manual decisions require a human credential. Skipped stages add no work. Empty instructions add no agent invocation; selected delivery evidence and built-in Git actions still apply. The basic default is automatic delivery with no required output and skipped acceptance/integration. All tasks must finish or be cancelled before delivery completes. A requirement with no tasks can also complete delivery.

Presets: `basic`, `comment`, `attachment`, `url`, `local`, `git_branch`, and `git_pr`. The PR preset requests automatic review and manual provider integration. PR creation is optional. Git targets are the linked repository base branches; an explicit integration target must match them. The daemon does not assume that every result belongs in `main`.

Use the structured Web editor or `tw req create --workflow <preset>` / `--workflow-file <json>`. Project defaults use `tw project update --default-workflow <preset>` or `--default-workflow-file <json>`. Configuration changes are allowed only before execution. Workflow updates increment a definition revision; outputs from an earlier definition cannot satisfy current delivery.

## Evidence and decisions

Outputs may reference a task comment, platform attachment, HTTP(S) URL, durable local file, Git branch, or PR. Several output types may coexist. No output is required for the basic workflow. A comment output references an existing task comment. Register evidence using `tw req output register`.

Stage decisions use `tw req advance` with the current `workflowStateRevision`, stage, decision, and reason. Decisions are `complete`, `changes_requested`, `failed`, or human `retry` for a failed stage. Required check results must be explicitly reported as passed. Acceptance may require a human decision. Feedback creates a follow-up task and routes execution back to the executor. Accepted evidence is frozen until rework resets the relevant stages.

The server enforces permissions, lease ownership, stage order, evidence, and revision checks. Agent instructions describe the work; they cannot bypass those controls. Delegated agents register evidence and return structured results; the supervising daemon advances stages. Custom integration (`publish`, `attach`, `archive`, `custom`) needs nonempty instructions for automatic execution and an available agent tool. Such actions depend on that agent's available tools and credentials.

## Local artifacts and scheduling

`tw req output register <requirement> --type local --file <path>` copies the file into `TW_ARTIFACT_ROOT` (default `~/.task-weaver/artifacts`) and registers its relative path, stable node ID, size, and SHA-256. File bytes remain on that machine.

Declare a downstream input with `tw req input add <consumer-requirement> <output-id>` and optionally `--task` or `--slice`. This is separate from a requirement blocking dependency. Use both when the consumer must wait for the producer to finish. Scheduling requires the producing node, and the daemon probes the file before work. Missing, changed, or retired inputs block execution. Matching node IDs require access to the same durable artifact root; they are not a file transfer mechanism. Conflicting node requirements cannot run until the dependencies are made accessible together.

Retirement requires completed producers/consumers and elapsed local retention (default 30 days). `tw req output retire` records retirement; `--delete-local` additionally removes the local file. Nothing is automatically uploaded or deleted.

## Workspaces

`worktreeMode: auto` provisions Git worktrees only when Git delivery or integration needs them. `none` uses an ordinary runtime workspace and rejects Git actions. `isolated` explicitly requests worktrees for linked repositories. Artifacts belong in the durable artifact root, outside worktrees.

`tw req workspace cleanup` checks terminal requirement state, completed consumers, and retention (default 7 days). It removes only registered clean worktrees under the managed root; dirty worktrees are preserved. Base checkouts and branches are retained. Cleanup is explicit.
