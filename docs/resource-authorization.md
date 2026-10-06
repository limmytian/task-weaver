# Resource authorization

Ordinary resource adapters call `createResourceServices(verifiedContext)`. The context comes only from the shared authentication resolver. Each operation revalidates persisted actor, session/key, issuer, parent and membership authority inside a transaction serialized with identity lifecycle changes. A previously verified snapshot does not retain revoked authority. Delegations remain rejected by the live resolver until the bounded execution implementation is available.

The package-level compatibility namespaces reject business calls. The underlying service modules are private implementation helpers, not package exports or transport interfaces. Internal callers must enter through the verified factory before ordinary resource work. There is no internal administrator or allow-all context. Existing workers remain paused pending their execution authorization slices.

Query predicates filter project membership, explicitly granted human personal ownership and ordinary global knowledge before SQL counts and pagination. Invalid mixed scopes and legacy agent/partial ownership are quarantined. Instance administration is independent of content access. Writes require the corresponding action, and relationships require write access to their owning endpoint and read access to the other endpoint. Nested relation metadata is filtered again before serialization. Project deletion archives the project so nullable document foreign keys cannot turn project content into global knowledge.

## Coverage inventory

| Service exports / entry points | Current boundary | Remaining work |
| --- | --- | --- |
| Authentication, principals, API keys, identity management | Live A3/A4 context, lifecycle locks and scoped grants | Existing UX and upgrade slices |
| Projects: list/detail/counts/create/update/archive/pin | Verified ordinary-resource factory | Stats, health and graph queries filter scoped nodes and both edge endpoints |
| Requirements: CRUD/batch/slices/dependencies/document links | Verified ordinary-resource factory; both relation endpoints checked | Search, burndown/heatmap use authorized SQL sets |
| Tasks: CRUD/status/batch/comments/notes/dependencies | Verified ordinary-resource factory; scope and eligible assignee checked | Search, boards/gantt/graphs use authorized SQL sets |
| Task and requirement claims | Factory; own holder checks plus resource write or execution authority; lease fencing retained | Daemon acquisition and delegated execution remain closed |
| Documents: CRUD/versions/revert/backlinks/links | Factory; current scope controls history; implicit wiki targets filtered | Title resolution/search/recommendations/context are authenticated and scoped |
| Memories: CRUD/list/entity shortcut | Factory; resource owner separate from creator/executor | Search applies scope and attached entity predicates without renewing expiry on reads |
| Context and recommendations | Verified ordinary-resource factory; ranking and vector candidate selection use current document authority | Package metadata enrichment filters authorized, active packages before context ranking |
| MCP registry/pool | Verified core factory; live scope and explicit invoke/manage permissions; HTTP/SSE connections partitioned by actor/credential/config | Local stdio executes on the credential-bound registered client; trusted cross-identity node sharing remains closed |
| Repository catalog and readiness | Verified core reads; catalog scopes, nested project/task relations and usage counts filtered before pagination; credential references redacted | Shared catalog management requires administrator plus global repository.manage; personal catalog uses explicitly granted personal repository.manage and human ownership. Project links require project repository.manage plus catalog reads. Nested links validate both endpoints and task workspace membership. Delivery/forge execution remain closed |
| Reviews, schedules, usage, activity, daemon control/progress/observability/metrics/SLO | Transport denied; existing pure state/fence helpers remain private implementation | Metadata and execution authorization |
| Assistant, Ti, plans, persisted Gateway work | Transport denied / execution paused | Runtime delegation and account-owned controls |
| Web/daemon SSE and outbound webhooks | Closed; no resource event delivery | Realtime and webhook authorization |
| Version | Exact public static endpoints; authenticated update check | No ordinary content authority |

REST, tRPC and GraphQL use the same factory. Skill packages/storage and embedding management use the asset authorization boundary below. Preset synchronization and background execution remain closed.

Entry-point allowlists must stay narrower than the factory: implementing one ordinary method does not open a neighboring discovery, execution or system route. GraphQL default field resolvers must recheck the source resource as well as explicit resolvers. Errors use the shared safe transport mapping; inaccessible IDs return 404 and insufficient action on a visible resource returns 403. Responses stay `no-store`.


### Skill distribution and embedding management

Skill package registration, metadata/version changes, files, downloads, storage verification and reindexing use the verified core facade. Package predicates run before pagination and context ranking; primary/indexed documents must share the package scope and each storage object must belong to the selected version. Invalid relationships quarantine the package. Internal storage keys are omitted from responses. Global skills are readable to authenticated subjects with global resource.read; global mutations require explicit global resource.write. Personal resources remain human-owned.

Embedding profiles, generations and jobs use the same live scope grants. Provider creation/configuration changes, tests, enablement and generation activation additionally require an active human instance administrator, instance.manage in the credential, and management rights for the resource (project.manage, personal resource.write, or global.manage). Instance administration alone never grants project/personal access. Other readers receive metadata with blank provider endpoint/secret references; raw provider errors and lease details are omitted. Existing resource maintainers may rebuild, disable and control jobs. Malformed cross-scope children quarantine the profile; document counts and rebuild inputs use authorized current documents. Provider test and enable construct their provider inside the authorized core operation. Worker execution, SSE and unconverted execution/integration surfaces remain closed.

PostgreSQL acceptance includes package/version/storage relationship attacks, private/global package access, administrator scope intersection, provider-config privileges, scoped keys, job/generation ownership, and cached-context membership revocation across REST and tRPC. GraphQL has no package or embedding management fields; its existing resource/retrieval fields continue through the same facade.
