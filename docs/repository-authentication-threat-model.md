# Repository Authentication Threat Model

Status: accepted ADR; required before credential resolver implementation

## Security objective

Task Weaver may use local Git credentials to clone, fetch, push, and call forge APIs without storing a raw secret in Repository data or disclosing a secret, secret helper, or credential-bearing environment to an AI process.

Metadata visibility does not imply Git access. Readiness is evaluated for one actor on one daemon node and is never reused as evidence about another principal.

## Trust boundaries

| Component | Trust | May receive credentials? | Responsibilities |
| --- | --- | --- | --- |
| API/Web/CLI clients | Untrusted input | No | Manage non-secret policy references and display scoped readiness. |
| API database | Trusted metadata store | No raw secrets | Store repository identity, policy, binding references, and redacted audit. |
| Daemon supervisor | Trusted credential broker | Transiently | Resolve policy, invoke approved helpers, verify hosts, perform Git/forge operations, redact results. |
| Git/forge adapter child | Trusted, tightly scoped | Transiently | Perform exactly one authenticated operation with a minimized environment and bounded output. |
| AI CLI process | Untrusted for secrets | Never | Edit provisioned worktrees using a frozen non-secret manifest. |
| SSH agent / OS keychain / Git helper | External trusted store | Owns secrets | Authenticate within its native process boundary. |

The daemon and AI CLI never share a shell process. The daemon provisions worktrees before spawning AI, finalizes after AI exits, and removes helper variables and inherited descriptors from the AI environment.

## Threats and controls

| Threat | Required control |
| --- | --- |
| Credential in a remote URL | Reject user info, secret-like query parameters, and fragments at every API boundary; redact URLs before logs. |
| Secret inherited by AI | Build an allowlisted environment; remove `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `SSH_ASKPASS`, credential-helper overrides, provider tokens, keychain variables, and unknown secret-like keys. Close non-standard file descriptors. |
| AI invokes Git and reaches a helper | Worktrees receive a neutral local Git config (`credential.helper=` and no askpass); authenticated network operations are daemon-owned. Network isolation is recommended where the execution runtime supports it. |
| Malicious repository config executes a program | Ignore repository-controlled credential, proxy, hook, pager, diff, filter, and SSH command config for trusted operations. Use explicit trusted config and `--no-optional-locks` where appropriate. Disable hooks. |
| SSH host impersonation | Require strict host key checking against a node-managed known-hosts store. First-use enrollment is an explicit human/administrator action and records the fingerprint. Never auto-accept a changed key. |
| Helper leaks output | Capture bounded stdout/stderr, parse only the expected protocol, redact known and entropy-like secrets, and persist only an outcome code. |
| Readiness oracle leaks another user's access | Key readiness by actor, actor type, node, repository, transport, and policy revision; return only the caller's state. Do not expose binding IDs or last-success actor. |
| Confused deputy uses a credential for the wrong host | Bind references to normalized host, provider, allowed operations, actor/node scope, and repository policy. Revalidate immediately before use. |
| Revoked credential remains cached | Store no secret cache. Readiness caches are short-lived capability results invalidated by policy/binding revisions and revocation events. |
| Prompt or audit exfiltration | Manifests and comments contain canonical identity, safe URLs, and redacted failure codes only. Audit schemas reject secret-shaped keys. |
| Path or argument injection | Pass structured argv without a shell, validate repository/worktree paths, use `--` before positional paths, and never interpolate helper output. |

## Credential policy and binding references

Repository `authPolicy` contains only:

- allowed transports (`ssh`, `https`);
- preferred transport;
- allowed operations (`read`, `push`, `forge`);
- host-key policy reference;
- optional named credential profile reference;
- policy revision.

A credential profile is also non-secret metadata: kind (`ssh-agent`, `git-helper`, `system-keychain`, future `external-broker`), normalized host/provider, actor and node applicability, operation scope, status, revision, and a store-native opaque reference where needed. API responses never return opaque store locators that would help another process invoke the secret.

Resolution precedence is deterministic:

1. explicit repository profile bound to the requesting actor and current node;
2. repository profile bound to the current node and allowed for that actor;
3. actor/node host profile;
4. node host default explicitly consented for shared use;
5. native local default only when repository policy opts in.

At every level, the candidate must match host/provider, transport, operation, policy revision, consent, and non-revoked status. Ambiguity fails closed instead of selecting the first credential.

## Permission and consent model

- Creating or changing a repository policy requires repository-management permission.
- Binding a personal credential reference requires the actor's explicit consent.
- Sharing a node-scoped profile requires node-administrator consent and a declared actor audience.
- A daemon may use a credential only for a currently claimed RequirementRepository and the exact delivery operation being processed.
- Readiness checks do not perform a write. Push/forge write permission is only proved during a requested trusted operation.
- Removing consent or revoking a profile immediately prevents new operations and invalidates readiness caches; running operations are cancelled where safe and otherwise audited as completing under the prior revision.

## Readiness API

Safe states are:

- `available`: a matching local mechanism and verified host policy exist;
- `needs_configuration`: policy is valid but no matching mechanism is configured;
- `denied`: policy or consent explicitly forbids the operation;
- `unavailable`: a configured mechanism is revoked, invalid, or inaccessible;
- `unknown`: the requested node cannot be evaluated from this process.

Responses include `state`, `transport`, a stable non-sensitive reason code, `checkedAt`, and `policyRevision`. They do not include usernames, profile IDs, helper names, key fingerprints other than an explicitly public host key, token scope, last successful actor, or another node's readiness.

## Trusted operation lifecycle

1. Authorize the caller, verify the Requirement claim, and load the frozen repository manifest.
2. Resolve one credential mechanism using the current policy revision and actor/node identity.
3. Verify host identity and construct an allowlisted process environment.
4. Invoke the capability adapter with structured arguments and a timeout. Provide secrets through the native agent/helper protocol, never argv, prompt text, or a persisted file.
5. Bound and redact output before parsing. Convert it to a normalized delivery result.
6. Destroy transient buffers and temporary sockets/files, if any, before returning.
7. Record a redacted audit event with repository, requirement, actor, node, adapter capability, transport, policy revision, outcome code, duration, and correlation ID.

## Rotation, revocation, and failure behavior

- Rotation creates a new binding revision, tests readiness, atomically activates it, then revokes the old revision. In-flight operations retain their audit revision.
- Revocation is monotonic and is checked immediately before subprocess execution. A revoked profile cannot be re-enabled; create a new revision.
- Authentication rejection, host-key mismatch, helper protocol errors, timeout, and permission denial have distinct non-secret codes.
- The daemon never falls back to a broader credential, a different transport, a shared workspace, or an interactive prompt after an authentication failure unless policy explicitly allows that ordered fallback.
- Failed delivery preserves successful repository outcomes and schedules only the incomplete repository operation for retry.

## Verification requirements

Automated security tests must prove:

- credential-bearing URLs and secret-shaped policy keys are rejected;
- AI environment and Git config contain no agent socket, askpass, token, helper, provider secret, or store locator;
- readiness is isolated across actors and nodes;
- a changed SSH host key blocks all operations;
- malicious repository config and hooks cannot influence trusted Git commands;
- logs, errors, activity, comments, manifests, and snapshots redact seeded canary secrets;
- revocation wins over cached readiness;
- adapter timeouts and partial failures preserve resumable delivery state.

Future Vault/KMS, OAuth, or provider-app support must implement the same broker interface and pass this suite. It requires a separate security review and may not relax AI-process isolation.
