# Repository Domain Model

Status: accepted implementation contract

## Decisions

- A Repository is an instance-global reusable resource. A Project never owns or stores a direct repository association.
- RequirementRepository is the execution and delivery source of truth. The Requirement remains the only claimed scheduling lane.
- TaskRepository is optional planning metadata. An empty set means **unspecified scope**, so the agent may still use the complete Requirement workspace.
- Provider external identity is authoritative when available. Generic repositories use a normalized `host/namespace/name` identity.
- Repository metadata visibility and Git authorization are separate concerns. Repository APIs expose only readiness computed for the requesting actor and node.
- Delivery is independently resumable per RequirementRepository. A successful repository is never rolled back because another repository failed.

## Repository identity

Canonicalization runs before validation and persistence:

1. Parse the Web, HTTPS clone, or SSH clone endpoint without accepting embedded user information, passwords, query credentials, or fragments.
2. Lowercase and IDNA-normalize the host, remove its default port, trim slash boundaries, remove a terminal `.git`, and preserve case-sensitive namespace/name display fields separately.
3. Normalize a namespace to slash-separated segments and reject `.` or `..` segments.
4. Produce `canonicalKey = <host>/<lowercase namespace>/<lowercase name>`.
5. When `providerExternalId` is present, use `(provider, providerExternalId)` as the primary deduplication key and retain `canonicalKey` as a unique alias when safe.

Equivalent SSH and HTTPS endpoints resolve to one record. Redirects, mirrors, and forks are separate repositories unless a provider external ID proves identity. Canonical-key conflicts return `409` and include the existing non-secret repository summary.

## Persistence contract

### `repositories`

| Column | Type | Contract |
| --- | --- | --- |
| `id` | uuid PK | Generated v4 UUID. |
| `display_name` | varchar(255) | Human-readable name. |
| `description` | text nullable | Searchable description. |
| `provider` | text | `generic`, `github`, `gitea`, `gitlab`, or adapter identifier. |
| `provider_external_id` | text nullable | Stable opaque provider identifier. |
| `host` | varchar(255) | Normalized host, without credentials. |
| `namespace` | text | Normalized slash-separated owner/path. |
| `name` | varchar(255) | Repository name without `.git`. |
| `canonical_key` | text | Normalized `host/namespace/name`. |
| `web_url` | text nullable | Non-secret browser URL. |
| `https_clone_url` | text nullable | Non-secret HTTPS clone endpoint. |
| `ssh_clone_url` | text nullable | Non-secret SSH clone endpoint. |
| `default_branch` | text nullable | Provider-discovered or user-supplied default. |
| `status` | text | `active` or terminal `archived`. |
| `tags` | text[] nullable | Normalized, unique tags. |
| `visibility` | text | `instance` initially; reserves `restricted` and `private`. |
| `owner_id`, `owner_type` | text nullable | Reserved ownership boundary; not a credential binding. |
| `auth_policy` | jsonb | Non-secret allowed transport and credential reference policy only. |
| `last_used_at` | timestamptz nullable | Derived usage sort signal. |
| `created_by` | text | Audit actor. |
| `created_at`, `updated_at` | timestamptz | UTC timestamps. |

Indexes and constraints:

- unique partial `(provider, provider_external_id)` where the external ID is not null;
- unique `canonical_key` for active and archived records;
- B-tree indexes on `(status, updated_at, id)`, `(provider, status)`, and `(host, status)`;
- GIN indexes on normalized `tags` and a stored search vector over identity, display name, description, and safe URLs;
- trigram indexes on `canonical_key`, `display_name`, `namespace`, and `name`;
- URLs must contain no password, token-like query parameter, or fragment;
- `visibility = instance` requires null owner fields; restricted/private modes require an owner.

### `requirement_repositories`

| Column group | Columns |
| --- | --- |
| Identity | `id`, `requirement_id`, `repository_id`, unique pair |
| Desired state | `base_branch`, `working_branch` |
| Frozen workspace | `workspace_key`, `manifest_version`, `provisioned_at` |
| Git result | `head_commit`, `pushed_commit`, `push_status`, `pushed_at` |
| Forge result | `pull_request_provider`, `pull_request_external_id`, `pull_request_url`, `review_status`, `merge_status`, `merged_at` |
| Retry state | `delivery_status`, `failure_code`, `failure_summary`, `retry_count`, `last_attempt_at` |
| Audit | `created_at`, `updated_at` |

`delivery_status` is `pending`, `provisioning`, `ready`, `changed`, `pushing`, `pushed`, `in_review`, `ready_to_merge`, `merged`, `unchanged`, or `failed`. `push_status`, `review_status`, and `merge_status` retain their independent outcome so a retry starts at the first incomplete operation.

Failure summaries are redacted and bounded. Provider response bodies, remote URLs containing credentials, environment values, and helper output are never persisted.

### `task_repositories`

The table contains `id`, `task_id`, `repository_id`, `created_by`, and timestamps, with a unique `(task_id, repository_id)` pair. A deferred constraint implemented in the service transaction requires the same `(task.requirement_id, repository_id)` to exist in RequirementRepository. Moving a Task to a different Requirement revalidates or removes no links automatically; the move is rejected with the offending repository IDs.

### `repository_checkout_bindings`

Trusted daemon state maps `(repository_id, node_id)` to a local base checkout reference and last verified remote identity. It stores no credential values or helper environment. Requirement worktrees are keyed by `(requirement_id, repository_id)` and never fall back to a shared mutable checkout.

## Service invariants

All interfaces use the same core service transaction:

- Adding a TaskRepository requires an existing RequirementRepository. Callers may explicitly request the two-step add-to-Requirement flow; silent expansion is rejected.
- Removing a RequirementRepository is rejected while referenced by Tasks, present in an active frozen slice manifest, or carrying delivery state beyond `pending`. The response returns structured blocking reasons.
- Archiving a Repository prevents new links but preserves history and existing delivery rows.
- A Requirement may have no repositories for research or documentation work.
- Requirement completion is allowed only when every linked repository is `merged` or `unchanged`; repository-free Requirements follow normal task completion rules.
- A slice freezes a sorted manifest of linked repository IDs, canonical keys, safe endpoints, branches, aliases, and local relative paths. Changes become visible only to the next slice.
- Delivery aggregation is `failed` when any repository is failed, `partial` when terminal successes coexist with incomplete or failed rows, and `complete` only when all rows are terminal successes.
- Activity records reference repository IDs and redacted outcome codes, never credential references or helper output.

## Search contract

The query is normalized using the canonical identity rules. Stable ranking is:

1. exact canonical key, host, namespace, or name;
2. normalized prefix;
3. full-text rank;
4. trigram similarity;
5. Requirement usage count;
6. `last_used_at DESC`, then `id ASC`.

Filters are provider, host, lifecycle status, tags, and authorized visibility. Cursor material includes all active sort keys plus ID so pagination cannot reorder equal-rank rows. Results expose only non-secret metadata plus actor/node-scoped readiness.

## Idempotent migration

Migration is split into expand, backfill, verify, and contract phases:

1. Create repository tables, indexes, service contracts, and compatibility reads.
2. In a repeatable backfill, select non-null `projects.git_url`, parse and canonicalize each URL, upsert Repository by provider identity/canonical key, and link all non-terminal and historical Requirements in that Project. Record ambiguous or credential-bearing URLs in a redacted migration report and do not guess.
3. Copy `requirements.branch_name` into each new RequirementRepository working branch. Convert resolvable project/node checkout mappings to repository/node bindings; leave unresolved mappings for explicit repair.
4. Verify that every valid legacy URL maps to exactly one Repository, every affected Requirement is linked, and rerunning produces zero changes.
5. Switch daemon, Web, CLI, REST, tRPC, assistant context, and search reads to Repository links. Drop the legacy project-level clone endpoint.
6. Drop `projects.git_url`, project schema fields, and compatibility code only after verification succeeds.

The migration command supports `--dry-run`, emits counts and redacted ambiguity codes, and is safe to resume after any committed batch. No migration step deletes a checkout or credential configuration.

## Delivery state examples

- Repository A merged and Repository B push failed: Requirement delivery is partial; retry B from push while A remains merged.
- A linked repository has no diff: mark it unchanged with its observed head commit.
- A repository is added while a slice runs: persist the link as pending, but do not mutate the current manifest; provision it before the next slice starts.
- Two Requirements use the same Repository: each has a distinct branch and worktree, while their trusted base checkout may be shared read-only through serialized Git maintenance.
