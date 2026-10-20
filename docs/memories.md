# Memory lifecycle and continuity

Use `tw_memories_search` to discover small summaries, then `tw_memories_get` to
read the selected entry. Search uses keyword matching with scope/actor boosts,
not an embedding service. Results explain their retrieval method, exclude expired
entries and do not renew expiry. At most 20 summaries and 16 KiB are returned;
`hasMore` requests a narrower query rather than promising unsupported pagination.

Memory writes are explicit operations. `tw_memories_record` requires
`confirmed: true`, the intended scope and a UUID `idempotencyKey`. Personal
ownership is derived from the credential. A saved entry records its author,
source entity, provenance, expiry and revision. Provenance is descriptive data,
not execution authority or a claim that retrieved instructions are trusted.

Retry the same save with the identical normalized payload and key after an
ambiguous response. It returns the current saved memory; it does not overwrite a
subsequent edit. A different payload with the same key fails. Receipts are scoped
to the actor and memory scope, and every retry rechecks current resource access.
After forgetting an entry the receipt remains, so an old request cannot resurrect
it. A deliberate new save requires a new key. Receipts contain a payload hash,
not the forgotten content. Retain them while old saves can still be retried.

`tw_memories_update` and `tw_memories_forget` require `expectedVersion` from a
fresh read. Forget also requires explicit confirmation. Concurrent edits cannot
silently overwrite one another. A normal read hides expired entries; explicit
`includeExpired: true` permits authorized inspection and marks them expired.
Search cannot promote expired content into active execution context.

REST and CLI retain compatible optional concurrency controls:

```sh
tw memory record --project "$PROJECT_ID" --title "Verified handoff" \
  --content "Continue from the recorded checks." --key "$SAVE_KEY" --json
tw memory get "$MEMORY_ID" --json
tw memory update "$MEMORY_ID" --content "Reviewed handoff" --expected-version 1 --json
tw memory forget "$MEMORY_ID" --expected-version 2
```

REST save accepts `idempotencyKey`; PATCH accepts `expectedVersion`; DELETE
accepts `?expectedVersion=N`. Older callers may omit these fields, while inbound
MCP requires them. Content and arbitrary storage metadata are not injected into
search summaries or bootstrap. Memory read tools are advertised only when the
credential's current catalog includes them.

Apply additive migration `0074_memory_lifecycle` before starting code that reads
memory revisions and receipts. Back up the database together with other project
state. Physical forgetting removes the row and its database search entry; there
is no separate memory vector index to leave stale. This does not promise deletion
from separately retained operator backups or external client transcripts.
