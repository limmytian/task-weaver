# Start or resume a Task Weaver task

Read the current task, requirement and execution slice before source work. Check
blocking dependencies, declared inputs, the frozen repository manifest and any
preserved-work provenance. An earlier summary or memory is not current authority.

In an interactive session, claim the task and renew its lease while working. In a
daemon child, keep the supervisor's requirement ownership and process only the
selected task; do not claim/release the requirement or finalize its delivery.

```bash
tw context bootstrap --json
tw task get <task-id> --json
tw req get <requirement-id> --json
tw context search "<task-specific topic>" --project <project-id> --json
```

Read a selected skill or pinned package file only when its summary is useful.
Memory reuse also needs expiry/source review. An available instruction API does
not mean assets exist. If inventory is empty, continue with the authorized work
instead of repeatedly searching. If a capability is required and unavailable,
record the missing permission/content/runtime/input and an actionable next step.
Let the supervisor release capacity while waiting.

Before completion, run the checks appropriate to the actual change and inspect
the artifact. Update task status with a concrete result and evidence. In an
interactive session release any remaining claim; terminal transitions may already
release it. In a daemon session leave requirement workflow/delivery to its owner.
