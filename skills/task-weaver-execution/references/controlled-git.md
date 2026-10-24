# Controlled Git and preserved work

Inspect the frozen repository manifest and the provenance of existing dirty files.
Preserve unrelated edits and user work. A branch name or local file is not proof
that a prior execution remains authorized.

For a daemon-provided repository, use the controlled access path:

```bash
tw execution git fetch <repository-id> --json
# Inspect and reconcile the fetched target with ordinary local Git.
tw execution git verify <repository-id> --json
```

Verification freshly fetches the target and records that its observed tip is in
the working history. Repeat if the remote advances before completion. Resolve
conflicts deliberately and validate the resulting code; do not force push,
automatically discard dirty files or treat a cached remote-tracking ref as fresh.

Use the owner-selected canonical repository and development branch. An interactive
agent may commit/push only within the current authorization; a daemon child leaves
trusted credential use and finalization to its supervisor. Do not put credentials
in URLs, task comments, source files or prompts. Source work never implies main
integration, tag mutation, publication or deployment permission.

After an ambiguous push result, inspect the remote tip before retrying. Record
an uncertain effect when it cannot be established. Do not invent exactly-once
execution or restore old run authority by pointing at local code.
