# Reviewed memory reuse and handoff

Search only relevant project memories, then read selected records. Check scope,
source identity/version, expiry and freshness. Use a memory as source-backed
evidence; a stale source requires review against current facts. Reading does not
renew expiry or authorize executing old commands.

```bash
tw memory search "<specific verified topic>" --project <project-id> --json
tw memory get <memory-id> --json
```

Before finishing or resuming, decide whether a durable lesson is useful beyond
the current task. A good candidate states a verified conclusion, its source,
observed source timestamp, scope and remaining limits. Do not copy raw dialogue,
secrets, speculative conclusions or full tool output into long-term memory.
If no useful lesson exists, save nothing.

Without current write authorization, return a candidate for review. With explicit
review/write authorization, review or edit the conclusion, reread its source and
use the existing confirmation and receipt protocol:

```bash
tw memory record --project <project-id> --title '<verified lesson>' \
  --content '<reviewed conclusion>' --entity-type task --entity-id <source-task-id> \
  --source-updated-at <observed-timestamp> --confirm --key <new-uuid> --json
```

A worker additionally needs its supervisor's explicit capability execution mode.
Shared and personal writes remain closed. After an ambiguous response, read the
receipt/state or reuse the same key with the identical payload. Source changes
need a fresh review; changed payloads need a deliberate new key. Forgotten records
must not be recreated by blindly retrying an old save. Memories are not execution
authority, code checkpoints or proof of delivery.
