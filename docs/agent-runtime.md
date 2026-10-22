# Ti execution and Partners integration

[简体中文](agent-runtime.zh-CN.md).

## Assessment and implementation status

Use Partners Streamable HTTP MCP as the sandbox interface for the planned Ti
execution loop. Task Weaver owns model requests, tool selection, platform
authorization, task state and schedule execution. Partners owns workspace
provisioning, isolated commands, files and command-job recovery.

The current chat assistant already implements a bounded model/tool loop and
authorized discovery/read tools for skills, memories and registered MCP tools.
Its operations follow account confirmation settings. Reading skill instructions
does not execute scripts. This is separate from the background task worker.

The existing background worker submits a REST Gateway job whose command prints
the task prompt. It tracks leases, progress and terminal jobs but does not call a
model. Adding an MCP server registration does not turn that adapter into an agent.
The MCP transport replacement and real background agent loop are not implemented
by this assessment.

The assessed Partners v0.1.4 source is commit
`de0290514d87604bdb66bbfa22d89323c59b4a35`. It exposes seven tools:

| Tool | Ti use |
| --- | --- |
| `session_create` | Allocate an authorized workspace for a run |
| `session_get` | Inspect the owned workspace and its readiness |
| `session_delete` | Clean up an idle owned workspace |
| `bash_exec` | Submit one bounded asynchronous command |
| `job_get` | Read job state and cursor-paginated stdout/stderr |
| `job_cancel` | Explicitly cancel accepted work |
| `file_ops` | List/read files and perform conditional text writes |

Read-only discovery from the deployed TW API using its configured service
credential successfully initialized the official SDK client and listed all seven
tools. This proves handshake/discovery compatibility only. It does not certify
execution, cancellation, tenant isolation or agent completion.

## Integration choice

Prefer a small typed MCP execution adapter over a second custom REST execution
client. Use the existing MCP SDK connection infrastructure where compatible,
with server-controlled tool contracts and scoped credentials. The adapter is
responsible for session/job ownership, durable request IDs, bounded output,
job polling and cancellation. These responsibilities are application orchestration,
not a new sandbox protocol.

Ordinary user-registered MCP servers remain general capabilities discovered by
the model. The configured execution backend is a trusted infrastructure binding;
the model cannot select its endpoint, credential, tenant/project ownership or
another run's resource IDs. Do not register a broad service credential as a
globally callable user tool. Both discovery and use must preserve TW authority.

Partners MCP provides sandbox tools, not an LLM or a ReAct loop. Ti calls the
model in TW, executes authorized tool requests and feeds results back to the
model until completion or a configured limit. Platform operations use the same
verified business services as REST/chat. Skills and memories use the common
scoped services; external MCP calls use the existing registry/policy broker.
The internal authorization mechanism must also support the task's bounded
delegation; the current human-chat adapter cannot simply be reused as an agent
identity without that work.

Schedules produce ordinary owned runs through this same execution path. Do not
add a separate MCP change-detection scheduler. A scheduled task can query an
authorized MCP tool and act on the result through the normal agent tools.

## Shared kernel and sandbox ownership

Chat and tasks should share the model/tool kernel, context loading, usage
accounting and sandbox adapter. Their supervisors preserve different policies:

| Mode | Authority and execution | Workspace lifetime |
| --- | --- | --- |
| Chat | Current human/session grants, explicit operation confirmation and streaming | One owned conversation workspace, reused only under an explicit retention policy |
| Task | Bounded task delegation, durable attempt state, lease fencing and execution limits | One owned attempt workspace, cleaned after completion/cancellation |
| Schedule | Starts the ordinary task runtime with its configured owner and policy | Same as a task; no separate sandbox lifecycle |

Partners `session_delete` resolves the stored resource and checks the caller's
`sessions:delete` permission and allowed tenant/project. These checks do not
distinguish different TW users, conversations or runs inside that scope. A broad
service credential can therefore affect another workspace in the same permitted
scope if supplied its ID. TW must own the resource mapping and derive all
session/job IDs server-side. Caller/model-supplied IDs, display names and shared
tenant/project membership are not ownership proof. Use dedicated, restricted
infrastructure credentials and verify both operation authority and ownership.

Partners' assessed defaults reclaim idle MCP workspaces after 30 minutes, limit
absolute lifetime to 8 hours, and sweep every 5 seconds. The reaper is a fallback:
provider/network failures can delay deletion. The existing TW REST adapter tries
deletion in `finally` but only logs failures; it does not establish durable cleanup
or restart reconciliation. The new adapter needs persisted cleanup intent,
bounded retries, confirmed deletion, quotas and recovery of its own resources.
Chat retention must be explicit and bounded; task completion should promptly
release its attempt workspace. Never sweep unrelated workspaces to meet a quota.

## Required execution semantics

- Persist the run, attempt, workspace, jobs and logical operation request IDs.
  Recover accepted work by querying its known IDs. A successful shell command
  does not independently prove the assigned task or its acceptance checks passed.
- Apply model-round, tool-call, wall-time, token and output limits. Keep the model
  credential in TW; keep the Partners credential in the trusted adapter. Neither
  credential enters model-visible arguments or workspace files.
- Recheck the run lease and TW grants before tool dispatch and before committing
  results. Stop dispatch on revocation or expiry. Background execution has an
  explicit execution policy; it cannot silently bypass chat confirmation settings.
- Treat RPC cancellation separately from sandbox cancellation. Use `job_cancel`,
  confirm its terminal outcome and clean up only resources owned by that run.
- Preserve the same Partners `requestId` and normalized arguments for a documented
  retry. The assessed deduplication window is 24 hours. Unknown execution and
  provisioning outcomes require reconciliation rather than a fresh submission.
- Consume `job_get` cursors until output is exhausted; retain truncation markers
  and nonzero exits. Artifact downloads currently use Partners' authenticated
  artifact REST interface; MCP alone does not transfer every binary artifact.
- Keep workspace mutations on MCP for MCP-created workspaces. Partners rejects
  conflicting legacy REST mutations on those workspaces. Do not switch protocols
  after an ambiguous request.
- In the assessed CubeSandbox provider, cancellation/timeout destroys the
  workspace to confirm execution stopped. A subsequent attempt needs a new
  workspace and must reconcile already committed platform/external side effects.

## Delivery proof

Verify a manual run and a schedule-created run through an actual model and the
configured Partners MCP backend. Include skill loading, memory recall, an
authorized external HTTP MCP read, sandbox file/write/execute/read, platform
result recording and explicit failed-command behavior. Repeat with cancellation,
revoked authority, worker restart and a lost submit response. Verify that no
second command is submitted and no other run's workspace is accessible.

Retain the existing REST adapter until this path passes those checks. It remains
a compatibility path and must not be presented as autonomous model execution.
