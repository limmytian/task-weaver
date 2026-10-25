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

For an explicitly authorized disposable private HTTPS repository, run:

```bash
TW_ACCEPTANCE_GIT_URL=https://forge.example.test/owner/disposable.git \
TW_ACCEPTANCE_GIT_MAIN=<observed-main-commit> \
pnpm exec tsx scripts/verify-private-git-acceptance.mts --confirm-disposable-private-remote
```

The caller must verify privacy and ownership first. This opt-in probe uses existing
trusted Git authentication without placing credentials in its URL or receipt.
It operates on unique temporary branches, creates DCO-signed synthetic commits,
fetches an advanced target, detects a real merge conflict and verifies clean abort.
It withholds a successful real push result from a simulated controller, then checks
the remote ref without replaying that write. This injection is not evidence of an
actual network outage. The receipt explicitly leaves real-agent and independent
physical-node coverage false. Temporary branches and local clones are removed in
`finally`, and the pinned main ref is checked again. The remote repository itself
is retained; its owner-authorized lifecycle remains the caller's responsibility.

Release-specific budgets, resource names and private evidence belong in project
planning documents, not this guide. Do not merge, publish or deploy as part of
capability acceptance unless the owner separately authorizes those operations.

## Actual independent CLI agent

`scripts/verify-real-capability-agent.mts --verify-fixture-only` verifies a disposable
loopback API/database and a pinned scoped CLI launcher without starting a model.
Use `pnpm exec tsx` to run it. It requires the existing PostgreSQL test image locally;
it does not pull an image or install a runtime. The independent agent key grants only
project reads and MCP invocation, expires after ten minutes, and is revoked before
teardown. A subsequent authentication request must fail. The launcher embeds its
configuration directory and removes ambient TW credential/endpoint overrides;
login-shell PATH changes cannot select another Task Weaver profile.

With explicit owner authorization for the configured agy profile and its spend,
replace that flag with `--confirm-one-real-external-agent`. An optional
`TW_ACCEPTANCE_AGY_MODEL` names an already available model. The script starts one
fresh provider project and bounds its model process to 150 seconds, with a
155-second managed deadline. `TW_ACCEPTANCE_FIXTURE_FILE` reuses a privately saved
synthetic fixture. Its canonical JSON digest is distinct from a file-byte digest.

The source-backed memory is saved by the fixture owner with explicit reviewed-source
confirmation. The pricing server is read-only, and its tool receives a separate
trusted read-only declaration through the existing authorization endpoint. Remote
schema synchronization deliberately does not grant that declaration. The exact
client must discover the tool before any model spend; an empty registration or a
hidden tool is not readiness.

A successful useful-task receipt requires exact artifact validation, current-source
and relevant instruction/memory HTTP response observations, an actual external tool
call, and a successful invocation audit attributed to that client's credential.
Returning selected memory content through search counts as content delivery; an
extra get call is not required merely to increase tool counts. These bounded
response hashes are labeled `harness_http_response`, separate from durable platform
audits. Ordinary independent REST reads do not acquire a fabricated daemon run or
an inbound-MCP read audit. No model reasoning, raw HTTP bodies, credentials or tool
arguments are exported in the receipt.

This mode deliberately uses the operator's native provider configuration. An empty
test workspace and disabled slash expansion do not imply an empty personal skill
directory or filesystem sandbox. Provider-managed project/conversation records may
remain in that profile after temporary fixture files and the database are removed.
This is independent-client evidence, not daemon login or physical-node failover
certification. Preserve failed attempts and their reported usage alongside success;
a single successful artifact does not establish an efficiency improvement.

`TW_ACCEPTANCE_CASE=irrelevant` selects the arithmetic task instead of the useful
quote. Its artifact must be correct and the harness must observe no fixture
capability requests during model execution. Preflight discovery is kept outside
that measurement. The option's presence is not evidence that the case was run.

## Actual daemon worker

`TW_ACCEPTANCE_LAUNCH_MODE=daemon-codex` selects the existing Codex profile and the
real `tw daemon start --once` path. It uses the same explicit model-confirmation
flag as above. The supervisor key additionally grants project writes and execution;
the child receives the existing bounded per-run broker and an isolated HOME.
Its pass-through CLI launcher preserves that broker environment. It never embeds
the supervisor's configuration or key. The provider's existing `CODEX_HOME` remains
available for its authenticated runtime; this is not an empty personal skill profile.

The source document is linked to the fixture requirement before acquisition.
Project-level parent access alone does not authorize an ordinary document inside
the child, and an inaccessible linked entity also hides its memory. Do not loosen
those rules to make a test pass. In daemon mode, `--verify-fixture-only` registers
a disposable daemon, acquires a lane, issues an actual execution delegation and
verifies exact source, memory and tool visibility before revoking and releasing it.
No model is used by that prerequisite check.

The real worker has a 150-second deadline and its supervisor a 180-second deadline.
Success requires the exact artifact, observed source/skill/memory adoption, a
successful external invocation, actual per-run delegation records and task status
`done`. A clean supervisor exit or `in_review` alone is not success. Durable
delegation audit references remain separate from HTTP response observations.
The existing Usage summary supplies whole-process counters where reported; missing
reports, including termination before a final provider usage event, remain unknown.
Do not substitute another run's counters or estimate money from them.

This verifies one worker on one host. It does not prove agy isolated login,
replanning/resume, independent-node recovery, worker-managed remote Git delivery,
all package/runtime paths or untested vendor clients. Keep those coverage gates
open and preserve blocked/failed attempts as part of the evidence.

## Replanning and clean-client probes

`TW_ACCEPTANCE_CASE=replan` requires daemon mode. After a successful old-run source
read, the harness updates the synthetic customer and pricing and explicitly edits
the task's acceptance text. A document reference link grants visibility; it is not
itself a frozen workflow-input declaration. Editing an ordinary referenced document
alone is not used as evidence of execution invalidation.

The probe verifies rejection of the old credential and its stale completion request,
two distinct execution run IDs, a resumed recovery control, a fresh source hash,
the unchanged memory's `changed` freshness observation and the revised exact artifact.
It does not save memory automatically or claim physical-node failover. Its supervisor
deadline is 330 seconds, allowing one interrupted worker and one replacement with
the existing 150-second per-worker ceiling. Missing usage remains unknown.

Instruction evidence accepts either the standalone Skill or the registered package's
actual primary indexed document. A package index is an existing Skill resource;
reading it must not be mistaken for abstention merely because its UUID differs from
the independently seeded Skill. The harness retains that actual asset reference.

`TW_ACCEPTANCE_LAUNCH_MODE=external-codex-empty` is a separate opt-in clean-profile
probe. It supports an existing ChatGPT-authenticated default OpenAI profile only.
It copies that provider's authentication into a mode-0600 temporary profile and
copies only the selected model setting, with low reasoning effort. It does not
copy personal skills, plugins, conversation history or arbitrary provider settings.
The temporary HOME/profile is removed during teardown. The Task Weaver credential
remains the separate short-lived project key. This is not a filesystem sandbox or
proof that this client can authenticate successfully; require actual artifact and
invocation evidence before marking the probe passed. Failed probes stay uncovered.
