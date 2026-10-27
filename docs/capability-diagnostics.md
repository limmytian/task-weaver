# Capability readiness and evidence

`tw context readiness --project <id> --json` and
`GET /api/v1/context/readiness?projectId=<id>` expose selected-project metadata.
The Web Skills page shows it after selecting a project. Reads use current project
permission; invocation permission is reported separately. Personal/global assets
are not implicitly merged into project inventory. Workers retain their existing
bounded bootstrap rather than gaining this aggregate surface.

Inventory separates registered assets from metadata candidates. Skill/memory
text candidates are nonempty bounded text; memories must also be unexpired.
Package candidates have an active version and bounded readable entry-file
metadata. MCP candidates have a visible registered tool and connected, active,
unexpired server metadata. These counts do not probe package storage, establish
source freshness, inspect dependency graphs or prove invocation readiness.
Load selected content and exact schemas/graphs on demand before use.

Runtime profiles come from the authoritative API bootstrap/configuration. Web
forwards the current authenticated request to the configured API without following
redirects or caching; it does not substitute its own runtime environment. When runtime catalog access is missing, profile state is explicitly unknown;
missing grants do not imply missing runtime configuration. An
available profile does not authorize a selected asset, local bridge, dependency
set or external call. If the API is unavailable, inventory/runtime are unknown,
not empty or ready. Optional unavailable execution can degrade to instructions;
required capabilities need a concrete blocked reason. No dependencies or assets
are installed automatically.

First-use guidance favors relevance and useful abstention over call counts.
Verify task artifacts, exact asset references, memory source freshness and external
outcomes. Record actual costs only where measured; missing telemetry is unknown.
Never save raw conversation, secrets or speculative conclusions as memories.

MCP tool metadata keeps its existing invocation/discovery permission, live server
and tool-policy predicates. A project read grant does not grant tool discovery.
Without that access, tool counts are null/unknown rather than a fabricated zero.
Runtime catalog restrictions likewise produce null profile state instead of
misdiagnosing absent configuration. Memory entity visibility is filtered before
counts, including memories linked to an inaccessible document/task/requirement.

## Currently visible use references

`tw context evidence --project <id> --json` and the selected-project Web panel
require current project `resource.read` and `audit.read`. Execution-bound
credentials do not gain a project-wide audit surface. The core projection filters
each asset using current document/memory/package-version/MCP discovery rules in
SQL before grouping, counts and pagination. Related private memory entities,
archived package versions, disconnected/denied tools and another credential's
local bridge cannot consume result slots or inflate visible totals.

The bounded last-seven-days view groups references by run (or independent
credential), asset, action, version, hash/kind and normalized outcome. Nested
read/returned success layers collapse; these are reference groups, not exact call
counts. Only delegation audit origins can attribute a daemon run. Independent
credential observations do not acquire a run from an incidental metadata field.
Parent credential identifiers and arbitrary audit metadata are never returned.

Progress-report references are counted separately only while the related task
remains readable. Their bodies are not loaded or projected, and they do not prove
capability adoption. Unattributed discovery events, missing/retained-away audit
coverage, inaccessible references and unmeasured model/context costs stay unknown.
Zero currently visible references does not establish zero actual use.

When a retained invocation audit supplies a duration, the view identifies it as
one API observation, not model latency or total task time. Whole-process token
reports, where available, remain in the existing Usage view/CLI and cannot be
apportioned to individual capabilities from these reference records. No call or
memory-save quota contributes to a usefulness score. Queries have a bounded
window/page and a three-second per-statement database budget; unavailable evidence
is not substituted with an empty success result. Large-instance performance and
retention coverage still need their own measurements.

## Usefulness rubric

Evaluate the actual artifact, not the quantity of calls or reports. For each
item record **met**, **not met** or **unknown**, with a concise artifact/source
reference in the existing task/review evidence:

| Dimension | Evidence needed |
| --- | --- |
| Task correctness | Produced artifact and a check establishing the requested behavior |
| Instruction adherence | Task-specific behavior against the selected exact instruction/package version |
| Relevant recall | A factual dependency that affected the result, including distracting recall |
| Source freshness | A current source check at memory reuse; historical freshness is insufficient |
| External correctness | Inspected schema/graph/runtime pins, scope/approval and verified external outcome |
| Cost and latency | Supported process/provider counters and measured latency, with explicit coverage |
| Useful abstention | Correct no-call/no-save behavior for irrelevant, empty or optional-unavailable cases |

Unknown is neither zero nor a passing result. Do not add overlapping cache/token
counters or assign whole-process token use to individual retrievals. The view
does not calculate monetary cost or automatically grade task usefulness. There is
no second scoring registry or call/memory quota. Actual-model baseline comparison
and private remote Git/node recovery remain separately scoped acceptance work.

Run `pnpm test:capability-diagnostics-postgres` for isolated API/Web protocol,
actual captured facade-read, current permission/lifecycle, deduplication and
privacy checks. No real model provider, external MCP server or production instance is
contacted by those fixtures. Native-browser interactions, large-instance query
performance and usefulness/cost improvements are not certified by these tests.

Live Skill instruction revisions advance on edits, conversion to/from Skill and
reverts. A supplied stale `expectedVersion` is rejected; restoring old content
creates a new live revision rather than reviving its old pin. This live revision
is distinct from the document-history snapshot sequence. Refresh cached manifests
when upgrading from an implementation that reused a live revision, and compare
exact content/graph hashes; the change cannot reconstruct missing historical
revision information. Package/version/status and execution graph/hash checks
remain in force.
