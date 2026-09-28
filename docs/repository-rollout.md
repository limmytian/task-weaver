# Repository Catalog Rollout and Operations

This runbook covers the instance repository catalog, Requirement workspaces, optional Task scope hints, node-local credential profiles, and multi-repository daemon delivery. The catalog stores repository identity and non-secret endpoints. Git and forge credentials remain on trusted daemon nodes and are never included in AI process environments or workspace manifests.

## Deployment sequence

1. Pause daemon start, review, and merge workers. Interactive project management can remain online.
2. Back up the database and record the current migration journal entry.
3. Deploy migration `0029_repository_catalog`. It creates the catalog and link tables, normalizes legacy Project Git URLs, deduplicates by canonical identity, and links every migrated Project Requirement to the resulting repository.
4. Run the preflight checks below. Do not continue if a legacy Project with a Git URL has no Requirement repository link.
5. Deploy API, Web, and CLI code that reads repository links as the source of truth.
6. Deploy migration `0030_remove_project_git_url` only after all running application versions no longer read or write `projects.git_url`.
7. Configure non-secret credential profile references on each daemon node and verify readiness for `read`, `push`, and, where supported, `forge`.
8. Resume one daemon worker as a canary. Run one repository-free Requirement, one single-repository Requirement, and one multi-repository Requirement before restoring normal concurrency.

Preflight and release checks:

```bash
pnpm check:repository-rollout
pnpm typecheck
pnpm lint
pnpm test
pnpm build
scripts/docker-isolated-smoke.sh smoke
```

The isolated Docker smoke is required for a release candidate because it verifies migrations from an empty database, API health, and the production Web build without depending on a developer database.

## Migration verification

Verify these invariants using a read-only database session after `0029` and before `0030`:

```sql
-- No duplicate normalized identities.
SELECT canonical_key, count(*)
FROM repositories
GROUP BY canonical_key
HAVING count(*) > 1;

-- Every legacy Project URL produced links for every non-terminal Requirement in that Project.
SELECT p.id AS project_id, r.id AS requirement_id
FROM projects p
JOIN requirements r ON r.project_id = p.id
LEFT JOIN requirement_repositories rr ON rr.requirement_id = r.id
WHERE p.git_url IS NOT NULL
  AND btrim(p.git_url) <> ''
  AND r.status NOT IN ('cancelled', 'archived')
  AND rr.id IS NULL;

-- No endpoint contains user-info, secret query parameters, or a fragment.
SELECT id, canonical_key
FROM repositories
WHERE coalesce(web_url, '') ~ '://[^/@[:space:]]+:[^/@[:space:]]+@|[?&](access_?token|api_?key|password|secret|token)=|#'
   OR coalesce(https_clone_url, '') ~ '://[^/@[:space:]]+:[^/@[:space:]]+@|[?&](access_?token|api_?key|password|secret|token)=|#';
```

All three queries must return zero rows. The second query is only valid before `0030`, while `projects.git_url` still exists.

## Rollback

Migration `0029` is additive and can remain in place if the new application version is rolled back before `0030`. Pause daemons first so no new delivery state is written by a mixed-version fleet.

After `0030`, an old application cannot be restored directly because it expects `projects.git_url`. Prefer fixing forward. If an emergency rollback is unavoidable:

1. Pause every daemon lane and all repository catalog writes.
2. Restore the pre-deployment database backup, or reintroduce `projects.git_url` in a reviewed emergency migration.
3. If reintroducing the column, backfill only Projects whose Requirements resolve to exactly one distinct active repository. A Project whose Requirements use zero or multiple repositories has no lossless legacy representation and must be reviewed manually.
4. Deploy the old application only after its schema expectation has been restored.
5. Keep the repository tables intact unless restoring the complete backup; they contain delivery and audit history.

Never reconstruct credential material from catalog data. The server does not have it.

## Observability

Monitor by repository link, not only by Requirement. Useful dimensions are `repositoryId`, `requirementId`, `executionSliceId`, `provider`, `nodeId`, `deliveryStatus`, `pushStatus`, `reviewStatus`, `mergeStatus`, `failureCode`, and retry count. Logs and activity payloads must not include clone credentials, trusted environment values, Git configuration values, or full command output.

Track at least these signals:

- readiness counts by state and reason code;
- provisioning and finalization duration per repository;
- delivery outcomes and retries by provider and failure code;
- partial Requirements where successful repositories coexist with failed repositories;
- stale `provisioning`, `pushing`, `in_review`, or `merging` links;
- duplicate-canonical-key conflicts and archive/remove guard conflicts;
- worktree move failures and remote identity mismatches;
- daemon lane release and heartbeat failures.

Initial alert thresholds:

- any credential-bearing endpoint rejection or AI credential-isolation canary failure: page immediately;
- more than 5% failed repository deliveries over 15 minutes: investigate and pause new lanes for the affected provider;
- any link in an active delivery state without `lastAttemptAt` progress for 30 minutes: warn;
- any migration verification query returning rows: block rollout.

The Repository detail page exposes per-link delivery, failure summaries, retry actions, and recent activity. The Daemons page exposes active Requirement lanes and worker state. Use `tw repo get <id> --json`, `tw req repo list <requirement-id> --json`, and `tw repo credential readiness <id> --operation <operation> --json` for node-side diagnosis.

## Incident handling

For a partial delivery, retry only failed links. Successful or unchanged repositories must not be re-committed or re-pushed. Correct the node readiness or provider issue, then call `POST /api/v1/requirement-repositories/:linkId/retry` or use the Repository detail retry action.

For `remote_identity_mismatch`, do not overwrite the cached checkout. Confirm the catalog identity and endpoint, quarantine the unexpected checkout, and reprovision from the trusted endpoint.

For a revoked or changed credential profile, leave the profile revision revoked, create a new revision with explicit consent, and rerun readiness. Do not place a token in a repository URL, Task comment, Requirement description, daemon prompt, or environment forwarded to an AI tool.

For concurrent Requirements on one repository, each Requirement branch must have a separate worktree while sharing the node's base checkout. A collision or branch/worktree mismatch is a provisioning failure, not permission to reuse another Requirement's worktree.

## Validation matrix

| Scenario | Automated evidence | Expected result |
|---|---|---|
| Visibility and canonical deduplication | Core schema/service tests and rollout migration check | Only visible rows are returned; equivalent identities cannot duplicate |
| Shared repository across Projects | Requirement links use instance repository IDs | One catalog entry can be linked independently without Project ownership |
| Task scope: zero, one, or many | Task link API/CLI and interaction regression checks | Zero means the full Requirement workspace; links are hints, not restrictions |
| Add repository between slices | `repository-workspace.test.ts` | Existing dirty worktree moves forward and the new repository is added |
| Multi-repository success | `daemon-e2e.test.ts` | Both repositories commit and push independently |
| Partial push failure and retry | `daemon-e2e.test.ts` | One failed link does not roll back or repeat the successful link |
| Concurrent Requirements | `repository-workspace.test.ts` | Distinct branch worktrees coexist over one base checkout |
| Generic/GitHub/Gitea adapters | Git provider unit and daemon tests | Generic Git works without forge; provider capabilities are additive |
| Credential privacy | `repository-credentials.test.ts` and endpoint schemas | AI environment and manifests contain no Git/provider credentials |
| Web loading/error/empty/mobile/keyboard states | `check:interactions` plus in-app browser QA | States are announced, errors retry, actions are named, tables degrade to cards |
| Legacy migration and removal | `check:repository-rollout` | `0029` precedes `0030`, dedupe is retained, Project Git URL is not restored |

Release evidence should record the exact commit, migration journal state, validation command results, canary Requirement IDs, and any accepted provider limitations.
