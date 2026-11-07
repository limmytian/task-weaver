# Worker capability access

Ti server-agent runs receive a short-lived, task-bounded execution delegation.
The server checks the parent credential, current project membership, task,
plan revision and active Worker attempt before delegated operations. Linked
project documents and repositories are bounded by that delegation; ordinary
unrelated and personal resources do not become accessible merely because a
worker can read the project.

Delegations are revoked when an attempt completes, is cancelled, loses its
parent authority or is invalidated by a plan change. A renewed delegation
keeps the original bounds. Skills, memories and external MCP output are untrusted
reference material and cannot expand the caller's permissions. See
[Ti execution](agent-runtime.md) and [capability contracts](capabilities.md).

Local `tw worker` executions use a separate supervisor to acquire and publish
work. The executor does not receive the supervisor's API key in its environment;
its available workspace and tools are governed by the executor sandbox and
container configuration. See the [task worker guide](task-worker.md).
