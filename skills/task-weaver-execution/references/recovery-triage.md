# Recovery triage

Read the current requirement revision, recovery phase, lease/run owner, deadline,
retry budget, dependency state and preserved-work evidence. Distinguish an online
daemon from an authorized execution, notification from confirmed stopping, and
available worker capacity from retained files.

```bash
tw req get <requirement-id> --json
tw req claim-status <requirement-id> --json
```

A daemon child cannot revalidate or recover its own fenced authority. Report the
concrete reason and leave operator decisions to the authorized human/supervisor.
After a fresh run starts, reload current instructions and inputs, reconcile code
and review memory sources again. Do not continue old instructions from memory.

For an authorized operator, existing revalidation/recovery commands require the
current revision and evidence. Inspect a conflict or stale response, refresh the
state and make a new decision; never blindly replay a recovery action. Branch
conflicts, irreplaceable local inputs and uncertain external effects can require
manual resolution rather than another attempt.

Retry-safe policy is explicit. Unknown safety is not permission to retry. A
returning old node must stop old work and preserve it for inspection, without
overwriting a replacement. Local work and memories are not shared checkpoints;
recovery cannot undo an external request already sent.
