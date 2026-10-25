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
