# Capability acceptance fixtures

Source tests, model connectivity and successful task execution are distinct evidence.
Use `pnpm exec tsx scripts/preflight-capability-agent.mts` to compare installed agy
model discovery in the operator profile with discovery in an empty worker HOME.
This uses the existing environment filter and managed process timeout. It does not
copy authentication, skills, plugins or conversation history, install dependencies,
or launch a model by default. A successful version check does not prove login.

Explicit `--run-real-model` permits one native-profile connectivity turn, bounded
to 60 seconds with a 65-second managed process deadline. The receipt contains
validated reported counters, when present, and no upstream content or credentials.
This does not establish isolated worker login, daemon execution, capability adoption,
quality, monetary cost or a particular resolved model. The operator must authorize
the profile and spending before using this option. Temporary probe state is removed
in `finally`; a provider may retain its own account-side records.

`scripts/capability-acceptance-fixture.mjs` creates a small synthetic quote task.
Persist one fixture privately and reuse it unchanged for baseline and candidate.
Keep its expected result outside agent-visible files and prompts. The useful task
needs the project calculation rule, reviewed customer source and live MCP pricing.
A deliberately unrelated shipping rule tests selection. The independent arithmetic
case needs no project capability and allows justified abstention. Fresh random
identifiers and prices reduce reliance on memorized examples.

The verifier rejects extra fields, stale source revisions, wrong currency and
double-counted fees. Correct output alone never sets adoption to verified. Require
current asset/version/hash audit references and the external server's invocation
receipt separately. A read of memory does not prove a read of its linked source;
review and compare both before using or saving a continuity record. Do not embed
expected totals or tool results in launch instructions.

Before calling an actual worker, prepare a loopback-only disposable API/database,
short-lived project-scoped identities and useful assets through the normal service
contracts. Supply only a task broker handle to the daemon child. An independently
launched client needs its own explicitly scoped key. Neither needs live-project
asset management access. Hosted execution remains optional and needs a ready,
approved pinned profile. Do not install a runtime to turn an unavailable probe green.

Record baseline/candidate commit IDs, serialized fixture hash, current source
revision, actual launch mode, provider/model when observable, process attempts,
elapsed times, artifact checks, authorized audit evidence and cleanup receipts.
Reported token counters are not money or evidence of useful adoption. Keep unknown
measurements null. Do not infer a reduction from a single connectivity turn.

Private remote Git needs a separately authorized disposable repository and real
authenticated fetch/push evidence. Confirm both HTTP status and response shape:
an API wrapper's zero exit code may still contain an authorization error body.
Never solve missing create permissions by silently widening credentials or choosing
an existing repository. Distinguish independent processes on one machine from
physically independent nodes. A missing remote or node prerequisite leaves those
acceptance cases uncovered, even when deterministic recovery tests pass.

Release-specific budgets, resource names and private evidence belong in project
planning documents, not this guide. Do not merge, publish or deploy as part of
capability acceptance unless the owner separately authorizes those operations.
