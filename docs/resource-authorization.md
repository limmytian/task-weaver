# Resource authorization

Ordinary resource adapters call `createResourceServices(verifiedContext)`. The context comes only from the shared authentication resolver. Each operation revalidates persisted actor, session/key, issuer, parent and membership authority inside a transaction serialized with identity lifecycle changes. A previously verified snapshot does not retain revoked authority. Delegations remain rejected by the live resolver until the bounded execution implementation is available.

The package-level compatibility namespaces reject business calls. The underlying service modules are private implementation helpers, not package exports or transport interfaces. Internal callers must enter through the verified factory before ordinary resource work. There is no internal administrator or allow-all context. Existing workers remain paused pending their execution authorization slices.

Query predicates filter project membership, explicitly granted human personal ownership and ordinary global knowledge before SQL counts and pagination. Invalid mixed scopes and legacy agent/partial ownership are quarantined. Instance administration is independent of content access. Writes require the corresponding action, and relationships require write access to their owning endpoint and read access to the other endpoint. Nested relation metadata is filtered again before serialization. Project deletion archives the project so nullable document foreign keys cannot turn project content into global knowledge.

## Coverage inventory

| Service exports / entry points | Current boundary | Remaining work |
| --- | --- | --- |
| Authentication, principals, API keys, identity management | Live A3/A4 context, lifecycle locks and scoped grants | Existing UX and upgrade slices |
| Projects: list/detail/counts/create/update/archive/pin | Verified ordinary-resource factory | Stats, health, graphs: retrieval slice |
| Requirements: CRUD/batch/slices/dependencies/document links | Verified ordinary-resource factory; both relation endpoints checked | Search, burndown/heatmap: retrieval slice |
| Tasks: CRUD/status/batch/comments/notes/dependencies | Verified ordinary-resource factory; scope and eligible assignee checked | Search, boards/gantt/graphs: retrieval slice |
| Task and requirement claims | Factory; own holder checks plus resource write or execution authority; lease fencing retained | Daemon acquisition and delegated execution remain closed |
| Documents: CRUD/versions/revert/backlinks/links | Factory; current scope controls history; implicit wiki targets filtered | Public title resolution/search/recommendations/context remain closed |
| Memories: CRUD/list/entity shortcut | Factory; resource owner separate from creator/executor | Search/context assembly remain closed |
| Context, recommendations, skill packages/storage/presets, embeddings | Transport denied; internal document reconciliation is bounded to the changed document | Retrieval/distribution authorization |
| MCP registry/pool and repository/forge catalog | Transport denied; no tool invocation or repository metadata expansion | Tool and repository authorization |
| Reviews, schedules, usage, activity, daemon control/progress/observability/metrics/SLO | Transport denied; existing pure state/fence helpers remain private implementation | Metadata and execution authorization |
| Assistant, Ti, plans, persisted Gateway work | Transport denied / execution paused | Runtime delegation and account-owned controls |
| Web/daemon SSE and outbound webhooks | Closed; no resource event delivery | Realtime and webhook authorization |
| Version | Exact public static endpoints; authenticated update check | No ordinary content authority |

REST, tRPC and GraphQL use the same factory. Entry-point allowlists must stay narrower than the factory: implementing one ordinary method does not open a neighboring discovery, execution or system route. GraphQL default field resolvers must recheck the source resource as well as explicit resolvers. Errors use the shared safe transport mapping; inaccessible IDs return 404 and insufficient action on a visible resource returns 403. Responses stay `no-store`.
