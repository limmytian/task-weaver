# Executor availability and quota recovery

Task Weaver reports a task Worker's presence and activity separately from its
agent identity. An online worker may be in quota cooldown. Token totals from
previous runs do not establish remaining provider allowance, and unavailable or
unsupported quota information remains unknown.

```bash
tw worker presence --project <project-id>
tw worker attempts --project <project-id>
```

The Codex executor performs a bounded availability check before acquiring a
task and observes provider limit errors during execution. It retains cooldown
on the worker node until the reported reset or a conservative fallback time.
Investigate the configured Codex home and account when another login appears to
have different allowance. A different account can have a different quota; do
not clear a cooldown or retry uncertain work without checking its cause.

If an attempt stopped or its result is uncertain, inspect the workspace and any
external effects before recording a decision with `tw worker resolve`. A retry
requires an explicit safety assessment. Automatic fallback to another provider
or model is not implied by a quota error.
