# Human repository delivery reconciliation

A human with both `project.manage` and `repository.manage` in the requirement project, plus access to its catalog repository, can register or synchronize an externally delivered PR. This is a separate operation from daemon delivery: Agent credentials, execution delegations, and the existing daemon endpoints retain their role and lease restrictions.

## Use

In the requirement's repository card, choose **Verify delivery**, select **Pull request**, enter the PR URL and an audit reason, then choose **Verify and synchronize**. The server reads the provider's current state. It validates the catalog repository, PR number, target branch, source branch when configured, and recorded head. It records the actual merge commit and provider merge time only for merged PRs. Open and closed PRs are recorded as `in_review` and `failed`; they cannot satisfy a required Git integration.

CLI:

```bash
# Inspect the link ID, externalSyncRevision and updatedAt.
tw req repo list "$REQUIREMENT_ID" --json
# Use the observed revision/timestamp and a fresh UUID; retain the UUID for retries.
tw req repo sync-pr "$LINK_ID" --url "https://github.com/owner/repository/pull/123" \
  --reason "Register externally delivered pull request" --revision 0 \
  --updated-at "2026-10-15T10:00:00.000Z" \
  --request-id "11111111-1111-4111-8111-111111111111" --json
```

REST: `POST /api/v1/requirement-repositories/:id/human-sync` with `pullRequestUrl`, `reason`, `expectedRevision`, `expectedUpdatedAt`, and UUID `idempotencyKey`. Extra fields, including client snapshots and status overrides, are rejected. The response includes `link`, `idempotent`, and `revision`.

An exact replay of the latest successful request is idempotent, including after normal requirement completion. Reusing its key with another URL, actor, or reason is rejected. For a network retry, keep the same request. For a revision conflict, reload the delivery and open a new operation. Active daemon leases and claims held by another actor block synchronization. Terminal requirements permit only exact successful replays. Replacing a registered PR or a changed head requires the existing explicit reopen/rework process.

A verified external merge preserves Task Weaver review evidence; it does not invent approvals or advance workflow stages. Git workflow delivery evidence is registered for the current definition. Complete delivery, configured acceptance, and integration through their normal controls. Legacy requirements can complete through the normal update endpoint after their completion guards pass. Completion validation errors identify incomplete repository deliveries or stages separately from authorization failures.

## Direct integration without a pull request

Direct integration accepts an explicit delivered commit instead of a PR URL. In
**Verify delivery**, select **Direct integration without a PR**, supply the full
commit SHA and an audit reason. The configured repository link supplies the target
branch; clients cannot override it. The server reads that branch from the trusted
forge and verifies that it contains the delivered commit. GitHub uses its commit
comparison API; Gitea verifies parent objects with a 128-object / 20-second traversal
budget. Missing, unrelated or unverifiable commits fail without changing delivery.
The target tip, delivered commit, source and observation time are recorded; the
observation time is not presented as a historical provider merge timestamp.

```bash
tw req repo sync-direct "$LINK_ID" --commit "$DELIVERED_COMMIT" \
  --reason "Owner authorized direct integration into the target branch" \
  --revision 0 --updated-at "2026-10-16T03:00:00.000Z" \
  --request-id "22222222-2222-4222-8222-222222222222" --json
```

REST uses the same `human-sync` endpoint with `commit` instead of `pullRequestUrl`;
exactly one evidence type is permitted. Human management permissions, lease guards,
revision/timestamp checks, exact retry semantics and auditing remain the same.
An existing PR record must use PR synchronization. A workflow explicitly requiring
`git_pr` cannot substitute direct evidence. Configured acceptance and integration
still require their normal decisions; no review approval is fabricated.

Legacy requirements with no workflow definition can complete normally after all
repository links have verified merged/unchanged delivery. For the original released
defect, verify the directly integrated commit, then update requirement status to
`done` using the normal requirement endpoint. No PR, link removal or database repair
is required. The operation verifies an existing integration; it does not push code.

## Trusted server connections

Public `github.com` repositories use anonymous `https://api.github.com` reads by default. Private GitHub, GitHub Enterprise, and Gitea require an operator-configured server connection. API and Web both need the same configuration because Web uses core services directly.

Set `TW_FORGE_CONNECTIONS_FILE` to a mounted JSON configuration file. Each entry binds an HTTPS API origin, provider, host, exact catalog IDs, and exact `namespace/name` identities. Credentials are read from `tokenFile`, preferably mounted from deployment Secrets. Repository edits and client requests cannot select another API origin or credential. Redirects are rejected and requests have a ten-second timeout.

```json
[
  {
    "host": "forge.example.com",
    "provider": "gitea",
    "apiBaseUrl": "https://forge.example.com/api/v1",
    "repositoryIds": ["22222222-2222-4222-8222-222222222222"],
    "repositories": ["team/project"],
    "tokenFile": "/run/secrets/forge-read-token"
  }
]
```

Use a read-only provider credential with access limited to the configured repositories. Missing connections, provider failures, identity mismatches and incomplete evidence leave delivery unchanged. Audit records include the human operator, reason, trusted source, observation time, before/after delivery state, revision, and merge commit. This feature performs read-only forge requests; it does not create or merge PRs.

Provider references: [GitHub pull request REST API](https://docs.github.com/en/rest/pulls/pulls), [Gitea get pull request API](https://docs.gitea.com/api/operations/repo-get-pull-request/).
