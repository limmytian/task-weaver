# Bounded collaboration context

`tw_tasks_context` and `tw_requirements_context` retrieve selected sections on
demand. Task sections include `comments`, `notes`, the current `claim`, linked
documents, parent requirement and dependencies. Comments and notes preserve author
IDs/types and timestamps; their previews stop at 2048 characters. Request full
text through the ordinary authorized resource interface when needed. `activity`
requires the separate `audit.read` grant. Section offsets and byte budgets remain
explicit; unavailable sections do not imply that no related data exists.

`tw_dependencies_graph` accepts a task or requirement `kind` and root `id`. It
returns visible upstream and downstream dependencies, compact nodes and current
unexpired claims. Both edge endpoints are filtered by live resource permissions
before traversal limits apply. Malformed historical cross-scope links do not
reveal hidden node IDs or claim holders.

Graphs permit at most four levels, 50 nodes, 100 edges and 32 KiB. Defaults use two
levels, 20 nodes, 40 edges and 16 KiB. Truncation is conservative: choose a returned
node as the next root to inspect another neighborhood. Each response records its
fetch time and read-committed consistency; it does not promise a historical or
atomic project snapshot. Graph reads do not claim tasks, grant execution rights,
change dependency guards or disclose requirement lease tokens.

## Historical documents and delivery references

`tw_document_history` lists revision metadata with bounded offset pagination and
without snapshot bodies. `tw_document_version` reads a selected revision in
Unicode-character chunks; use its `meta.nextOffset` verbatim to continue. Offsets
count Unicode characters, rather than UTF-8 bytes or JavaScript UTF-16 units.
The 32 KiB serialized response budget also accounts for escaped control characters.
Current authorization to the parent document is required for every history read.

Document sections retain `linkType` (`references`, `documents`, `output`),
`linkedAt`, and the current document version/update time. These distinguish
reference material from declared outputs. A link is not a historical snapshot or
an acceptance decision. Read an explicit document revision when exact historical
text matters, and inspect the requirement workflow for delivery acceptance.
