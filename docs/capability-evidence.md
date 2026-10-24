# Capability evidence and its limits

Capability use extends existing security and MCP invocation audit records. It does
not add a registry, a transcript store, model reasoning capture or a new execution
identity. Recording evidence does not grant permission to read it.

## Attribution

Delegated worker operations retain their immutable delegation/run/requirement
association. Existing delegation rows connect a run to its frozen tasks, slices
and repositories. Renewal changes the credential handle while preserving run
attribution; an invalidated run cannot regain authority through a recorded asset.

External MCP clients use the existing credential and invocation-audit IDs. They
are labelled `attribution=credential`; no daemon run is invented for an unbound
API key. A reviewer may correlate explicitly scoped task reports and test outputs,
but must not infer task ownership or individual model cost from a shared key.
Direct unbound CLI reads do not automatically acquire daemon-run attribution.

## Bounded references

New capability metadata is labelled `capabilityEvidenceVersion=1`. Depending on
the actual operation it can contain:

- Capability kind/action and selected asset ID.
- Exact version and SHA-256, labelled as content, file, tool schema or manifest graph.
- Bounded discovery result count, including an explicit empty result.
- Source freshness, an isolated execution status or an existing MCP invocation audit ID.
- A task comment/note reference for an agent report.

The reference extractor uses an explicit field allowlist. It does not copy bodies,
titles, raw arguments, stdout/stderr, private configuration or reasoning. External
tool output cannot replace the authoritative requested tool ID or inspected schema
hash. A manifest inspection is distinct from reading instruction text; neither
proves that an agent applied the instructions correctly.

The source labels have different meanings:

| Label | Meaning |
| --- | --- |
| `api` | The authorized API operation returned; task correctness is still unproven |
| `api_attempt` | An attempt failed; an already dispatched effect can remain uncertain |
| `agent_report` | A comment/note was stored; its capability-use claims are unverified |

Existing MCP failure records retain safe error categories and measured call
duration. An isolated script returning a failed status is an error outcome even
when the MCP transport returned normally. Absence of an event is unknown, not
proof of abstention, zero cost or an empty inventory. Failed non-MCP facade
transactions are not a complete denial telemetry stream. Missing legacy fields
remain unknown.

## Review and retention

Use actual artifacts, current source versions, audit references and explicit
reports together. A successful call, current source timestamp or saved memory is
not proof of task quality. Relevant recall, instruction adherence and external
operation correctness need task-specific acceptance evidence. Token counts and
money are unknown unless independently measured; invocation duration is not model
latency or total task cost. There is no usage quota or incentive to manufacture
calls or memories.

References inherit the retention and visibility of their existing host records.
Existing MCP cleanup rights do not grant permission to delete security audit
records. Any project-facing reader or aggregate must recheck current resource and
scope authorization, including personal-owner and shared-asset boundaries; raw
instance administration does not confer content access. No new audit-reading or
management permission is issued by this feature.
