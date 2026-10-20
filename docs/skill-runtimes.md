# Isolated skill runtimes

An MCP client can execute an eligible skill without installing its script or
language dependencies locally. The operator configures a trusted server runtime
once. Instruction-only packages continue to work without a runtime. Skills that
need local files/devices must explicitly use a local bridge; they are not silently
run in an API or Web process.

## Operator setup

`TW_SKILL_RUNTIME_PROFILES` is a JSON array of trusted profiles. Each specifies:

- `id`: a stable profile name using letters, digits, underscores or hyphens.
- `image`: an immutable `REGISTRY/IMAGE@sha256:DIGEST` reference.
- `interpreter`: `node`, `python` or `shell`.
- `timeoutMs`: 100–10000 milliseconds; the default is 3000.

Use a dedicated runtime host with Docker available to the trusted launcher. Its
filesystem must share the materialization directory with the Docker daemon.
Pre-provision the exact approved image and its interpreter/dependencies; calls
never pull images or install software automatically. Keep profile configuration
in the operator's environment facility. Profile images, interpreter and limits
are hashed, so a changed profile invalidates an earlier execution confirmation.

The default deployment does not enable Docker access or provision a runtime.
API containers need an explicitly configured runtime host and shared workspace;
ordinary source availability does not imply runtime readiness. No Docker socket,
host credential files or unrelated filesystem paths enter a skill container.
Do not bake credentials into a runtime image.

## Package declaration and invocation

Add `executionMode: "isolated"` and a runtime entry to the version manifest's
`capabilities` declaration:

```json
{
  "capabilities": {
    "executionMode": "isolated",
    "runtime": { "profileId": "approved-node", "scriptPath": "scripts/run.js" }
  }
}
```

Resolve the package with `tw_skill_packages_resolve`, inspect profiles with
`tw_skill_runtimes_list`, then invoke `tw_skills_run`. Supply the exact package
version, graph `manifestHash`, `runtimeImage`, `runtimeProfileHash`, execution
scope and `confirmed: true`. Input is one JSON object delivered on stdin.
The container receives `/work/manifest.json` through `TW_SKILL_MANIFEST`, mapping
the root and dependency directories. No TW key or provider credential is passed.

Execution requires read access to every source dependency and both
`resource.write` and `mcp.invoke` in the selected project/personal/global execution
scope. Reading a shared global skill does not require permission to edit it;
the caller can execute it within an authorized project context. Sensitive calls
can require the existing one-time approval, bound to the exact manifest, profile,
input and target. Read-only clients cannot execute.

## Runtime boundaries

Containers run as an unprivileged user, with no network, a read-only root and
package mount, no extra capabilities, no privilege escalation, bounded processes,
256 MiB memory and one CPU. A private 32 MiB temporary filesystem is available.
Materialization is capped at 256 files and 8 MiB, input at 16 KiB, and captured
text output at 64 KiB, further reduced when necessary to fit the MCP envelope.
The profile deadline, cancellation and output overflow stop the container;
the launcher also escalates termination and removes its temporary files.

This first runtime path returns bounded text results. It does not retain generated
binary artifacts, grant outbound network access, install dependencies or invoke
external MCP tools on a script's behalf. Declare an appropriate local-required
workflow for unsupported capabilities, or compose separately authorized remote
tool calls with the agent. Execution output remains untrusted data.

Materialization and policy preparation finish before untrusted execution begins.
The global authorization transaction is not held for the script's duration.
Credentials and execution scope are checked during the run; all pinned
dependencies are rechecked before returning output. Revocation or changed pins
withhold results. This cannot erase data already read by a previously authorized
process, but isolation prevents it from contacting external services.

The dedicated runtime host must supervise Docker and reap abandoned containers
after a launcher/host failure. Containers carry the
`task-weaver.skill-runtime=true` label for operator reconciliation. If Docker is
unreachable, do not interpret a cleanup attempt as confirmed removal. Normal
completion, deadlines and live revocation are covered by real-container tests.
