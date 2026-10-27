# Discover, inspect and invoke a relevant external tool

Use the live registry instead of a fixed catalog count. Search only when an
external capability is relevant to the task. Discovery is not invocation authority.

```bash
tw mcp search "<specific intent>" --project <project-id> --json
tw mcp tool <tool-id> --json
tw mcp call <tool-id> --schema-hash <observed-schema-hash> --params '<json-object>' --json
```

Inspect the target, argument schema, read-only declaration and authorization
metadata. Use the exact observed schema hash and only the inputs needed for the
authorized operation. A changed schema requires a new inspection and decision.
Existing tool policies and exact-operation approvals still apply; a worker may
not approve itself or broaden its grants. Local stdio tools also retain their
registered credential/client/node boundaries.

For MCP clients, use the corresponding live `tw_mcp_search`, `tw_mcp_tool` and
confirmed `tw_mcp_call` tools. A CLI lacking a required option needs a matching
CLI or the existing remote tool adapter, not a bypass of schema checks.

Inspect the actual result and task artifact. A successful invocation is not proof
that the task was solved. After timeout, disconnect or an ambiguous write result,
record the uncertainty and inspect external state where authorized. Do not
silently replay a call or try a parent credential. Missing optional access can
justify abstention; required access needs an actionable review reason.
