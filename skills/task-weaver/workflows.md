---
name: task-weaver-workflows
description: Multi-step workflow guides for sprint planning, task triage, progress reporting, and knowledge base management.
keywords: ["sprint planning", "task triage", "progress reporting", "workflows", "knowledge base", "task assignment"]
tags: ["workflows", "guides"]
---

# Task Weaver Workflows

Multi-step workflow guides for common AI agent scenarios. Each workflow follows a **Read → Decide → Write → Verify** pattern.

Use `--json` on any `tw` command to get machine-readable output for parsing IDs and fields.

List commands return `{ "items": [...], "meta": {...} }` with compact summaries by default. Use `--full --json` for nested relationships or document content; full results remain paginated. Requirement and task lists include terminal items updated within the recent window by default; pass `--completed-within-days 0` for complete history.

---

## Verified access prerequisite

Use `tw auth login` with hidden scoped-Key input and check `tw auth whoami --json`
before any workflow. Actor headers or client/node IDs cannot supply identity.
Claim only currently authorized, unblocked work and preserve the original lease
fence. Resource visibility does not grant tool invocation, repository editing or
execution review/merge. An administrator does not inherit private/project content.
Children receive task-bounded delegation (at most 15 minutes), not supervisor
credentials. Renewal cannot widen bounds; revoked/expired capabilities require a
fresh authorized exchange. Keep credentials out of documents and CLI arguments.
Source development does not authorize starting a daemon or publishing/deploying.

## Project Onboarding

Bootstrap a new project from scratch.

### Steps

1. **Create project**
   ```bash
   tw project create --name "My Project" --description "..." --json
   # capture projectId from output
   ```

2. **Create foundation documents**
   ```bash
   tw doc create --project $PROJECT_ID --title "Architecture Overview" \
     --content "# Architecture\n..." --type design --json
   ```
   Use `[[wiki-links]]` in content to cross-reference other documents.

3. **Define requirements**
   ```bash
   tw req create --project $PROJECT_ID --title "User Authentication" \
     --priority high --status draft --json
   # move to approved when ready
   tw req update $REQ_ID --status approved
   ```

4. **Link documents to requirements**
   ```bash
   # via REST API (CLI link command coming soon)
   curl -X POST $API_URL/api/v1/documents/$DOC_ID/requirement-links \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"requirementId": "'$REQ_ID'", "linkType": "documents"}'
   ```

5. **Create initial tasks**
   ```bash
   tw task create --project $PROJECT_ID --req $REQ_ID \
     --title "Design login flow" --priority high --json
   ```
   Every task must have a `--req` (requirementId).

6. **Verify scaffold**
   ```bash
   tw req list --project $PROJECT_ID --json
   tw task list --project $PROJECT_ID --json
   tw activity --project $PROJECT_ID --limit 20
   ```

---

## Multi-Repository Requirement Workspace

Define a reusable catalog and attach the exact repository set before a Requirement slice starts.

### Read

1. Discover existing catalog entries before creating anything:
   ```bash
   tw repo search "service identity" --status active --json
   tw req repo list $REQ_ID --json
   tw task repo list $TASK_ID --json
   ```
2. Treat an empty Task scope as unspecified: the Task can use the entire Requirement workspace.
3. Check local readiness on the daemon node without requesting or printing a credential:
   ```bash
   tw repo credential readiness $REPOSITORY_ID --operation read --json
   tw repo credential readiness $REPOSITORY_ID --operation push --json
   ```

### Decide

- Reuse a canonical catalog entry across unrelated Projects when it is the same repository.
- Link every repository needed by the Requirement. Add Task links only when a smaller focus hint helps the agent.
- To use a catalog repository from a Task that is not yet in the Requirement workspace, make the expansion explicit with `--add-to-requirement`.
- Add repositories between slices, not during an active slice. Each lane receives a frozen manifest.
- Keep credentials out of endpoints, Task comments, Requirement descriptions, documents, and prompts.

### Write

```bash
# Create only if search found no canonical match.
tw repo create \
  --host github.com \
  --namespace example \
  --name service \
  --provider github \
  --https-url https://github.com/example/service.git \
  --default-branch main \
  --json

# Link the executable Requirement workspace.
tw req repo add $REQ_ID $REPOSITORY_ID --base-branch main

# Optional Task focus hint. This does not restrict the agent to one repository.
tw task repo add $TASK_ID $REPOSITORY_ID

# Explicitly expand the Requirement while adding a Task hint.
tw task repo add $TASK_ID $OTHER_REPOSITORY_ID --add-to-requirement
```

Credential profiles are node-local, non-secret references:

```bash
tw repo credential set github-work \
  --kind git-helper \
  --host github.com \
  --transport https \
  --operations read,push,forge
```

### Verify

```bash
tw req repo list $REQ_ID --json
tw task repo list $TASK_ID --json
tw repo get $REPOSITORY_ID --operation push --json
```

For partial delivery, inspect each Requirement repository link. Retry only failed links from the Web Repository detail page or:

```bash
curl -X POST "$API_URL/api/v1/requirement-repositories/$LINK_ID/retry" \
  -H "Authorization: Bearer $API_KEY"
```

Successful or unchanged sibling repositories are preserved and must not be repeated. See `docs/repository-rollout.md` for deployment, rollback, security, and incident procedures.

---

## Requirement Decomposition

Break a single requirement into a tree of dependent tasks.

### Steps

1. **Get the requirement**
   ```bash
   tw req get $REQ_ID --json
   ```
   Read description, linked documents, and acceptance criteria.

2. **Read specification documents**
   ```bash
   tw doc get $DOC_ID --json
   tw search "relevant topic" --project $PROJECT_ID
   ```

3. **Design task tree**
   Identify work units (each independently completable) and their dependencies.

4. **Create tasks**
   ```bash
   # create tasks one by one (or use REST batch endpoint for up to 50 at once)
   tw task create --project $PROJECT_ID --req $REQ_ID \
     --title "Implement JWT auth" --priority high --json
   ```

5. **Establish dependencies**
   ```bash
   # via REST API
   curl -X POST $API_URL/api/v1/tasks/$TASK_ID/dependencies \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"dependsOnTaskId": "'$BLOCKER_ID'", "type": "blocks"}'
   ```

6. **Create implementation document**
   ```bash
   tw doc create --project $PROJECT_ID \
     --title "Auth Implementation Plan" \
     --content "# Plan\n..." --type design --json
   ```

7. **Update requirement status**
   ```bash
   tw req update $REQ_ID --status in_progress
   ```

### Task Sizing Guide

| Size | Characteristics | Example |
|------|----------------|---------|
| Small | 1 file, clear scope | Fix validation bug |
| Medium | 2-5 files, some decisions | Add API endpoint |
| Large | 5+ files, design needed | New subsystem |

Prefer small/medium tasks. Split large tasks further.

---

## Sprint Planning

Plan tasks for a sprint by analyzing project state.

### Steps

1. **Assess current state**
   ```bash
   tw task list --project $PROJECT_ID --json        # see task distribution
   tw req list --project $PROJECT_ID --json         # check requirement coverage
   ```

2. **Identify gaps**
   ```bash
   tw req list --project $PROJECT_ID --status approved --json
   # find approved requirements with no tasks
   tw task list --project $PROJECT_ID --status todo --json
   # find todo tasks that may be blocked
   ```

3. **Analyze backlog**
   ```bash
   tw task list --project $PROJECT_ID --status in_progress --json
   ```

4. **Plan new tasks**
   ```bash
   tw task create --project $PROJECT_ID --req $REQ_ID \
     --title "..." --priority high --json
   ```

5. **Set dependencies**
   ```bash
   curl -X POST $API_URL/api/v1/tasks/$TASK_ID/dependencies \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"dependsOnTaskId": "'$BLOCKER_ID'", "type": "blocks"}'
   ```

6. **Verify coverage**
   ```bash
   tw req list --project $PROJECT_ID --json | jq '.items[] | select(.status == "approved")'
   ```

7. **Document the plan**
   ```bash
   tw doc create --project $PROJECT_ID \
     --title "Sprint 1 Plan" --type meeting \
     --content "# Sprint Goals\n..." --json
   ```

---

## Knowledge Graph Building

Systematically build an interconnected documentation network.

### Steps

1. **Inventory existing documents**
   ```bash
   tw doc list --project $PROJECT_ID --json
   ```

2. **Identify missing documents**
   ```bash
   tw search "topic that should have a doc" --project $PROJECT_ID
   ```

3. **Create missing documents**
   ```bash
   tw doc create --project $PROJECT_ID \
     --title "API Design" \
     --content "# API Design\n\nSee [[Architecture Overview]] for context..." \
     --type design --json
   ```
   Use `[[wiki-links]]` to cross-reference related documents.

4. **Establish explicit links**
   ```bash
   # link two documents
   curl -X POST $API_URL/api/v1/documents/$DOC_ID/links \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"targetDocId": "'$OTHER_DOC_ID'", "linkType": "related"}'
   ```

5. **Connect to tasks and requirements**
   ```bash
   # link document to requirement (spec)
   curl -X POST $API_URL/api/v1/documents/$DOC_ID/requirement-links \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"requirementId": "'$REQ_ID'", "linkType": "documents"}'

   # link document to task (output/deliverable)
   curl -X POST $API_URL/api/v1/documents/$DOC_ID/task-links \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"taskId": "'$TASK_ID'", "linkType": "output"}'
   ```

6. **Verify connectivity**
   ```bash
   tw doc get $DOC_ID --json  # check backlinks field
   # use REST API to get knowledge graph
   curl $API_URL/api/v1/projects/$PROJECT_ID/knowledge-graph \
     -H "Authorization: Bearer $API_KEY" | jq '.stats'
   ```

### Quality Checklist

- [ ] Every concept has a dedicated document
- [ ] Documents use `[[wiki-links]]` for cross-references
- [ ] No orphaned documents (everything has at least one link)
- [ ] Requirements are linked to their spec documents
- [ ] Tasks link to relevant documentation

---

## Progress Reporting

Collect data and generate a project status report.

### Steps

1. **Gather project health**
   ```bash
   curl $API_URL/api/v1/projects/$PROJECT_ID/health \
     -H "Authorization: Bearer $API_KEY" --json
   tw task list --project $PROJECT_ID --json | jq '.items | group_by(.status)'
   ```

2. **Review requirements**
   ```bash
   tw req list --project $PROJECT_ID --json
   curl "$API_URL/api/v1/projects/$PROJECT_ID/heatmap" \
     -H "Authorization: Bearer $API_KEY"
   ```

3. **Query recent activity**
   ```bash
   tw activity --project $PROJECT_ID --since 2026-05-01 --json
   ```

4. **Identify blockers**
   ```bash
   tw task list --project $PROJECT_ID --status in_progress --json
   # look for tasks with blocks dependencies not yet done
   ```

5. **Generate report document**
   ```bash
   tw doc create --project $PROJECT_ID \
     --title "Sprint 1 Progress Report" \
     --type meeting \
     --content "# Executive Summary\n..." --json
   ```

---

## Burndown Analysis

Track requirement progress over time and project completion velocity.

### Steps

1. **Get requirement burndown**
   ```bash
   curl "$API_URL/api/v1/requirements/$REQ_ID/burndown" \
     -H "Authorization: Bearer $API_KEY" --json
   ```
   Review `dataPoints`, compare actual vs `idealLine`.

2. **Assess velocity**
   Check `velocity` (7-day rolling average). If `projectedCompletionDate` exceeds deadline → flag risk.

3. **Identify scope creep**
   Look at `added` field in data points — spikes indicate new tasks mid-sprint.

4. **Review the heatmap**
   ```bash
   curl "$API_URL/api/v1/projects/$PROJECT_ID/heatmap" \
     -H "Authorization: Bearer $API_KEY"
   ```
   Identify `hotspots` (high activity) and `coldspots` (stale, may be blocked).

5. **Take action**
   ```bash
   tw task status $STALE_TASK_ID cancelled --reason "Deferred to next sprint"
   tw task comment $BLOCKED_TASK_ID "Blocked by: ..."
   ```

### Key Metrics

| Metric | Source | What it tells you |
|--------|--------|-------------------|
| Velocity | burndown `velocity` | Tasks completed per day (7-day avg) |
| Projected completion | burndown `projectedCompletionDate` | When current pace finishes all tasks |
| Heat score | heatmap `heatScore` | Overall activity level (0–100) |
| Overdue rate | heatmap `overdueTasks / totalTasks` | Percentage of tasks past deadline |

---

## Health Assessment

Assess overall project health and identify risks proactively.

### Steps

1. **Get health dashboard**
   ```bash
   curl "$API_URL/api/v1/projects/$PROJECT_ID/health" \
     -H "Authorization: Bearer $API_KEY"
   ```
   Review `healthScore` (0–100).

2. **Analyze score breakdown**
   - `completionRate` (30% weight): Are tasks getting done?
   - `overdueRate` (25% weight): Are deadlines being met?
   - `activityTrend` (15% weight): Is the project active?
   - `requirementCoverage` (15% weight): Do all requirements have tasks?
   - `velocityTrend` (15% weight): Is the team accelerating or decelerating?

3. **Review risks**
   ```bash
   tw task list --project $PROJECT_ID --json | jq '.items[] | select(.expectedAt != null)'
   tw activity --project $PROJECT_ID --since 2026-04-01 --json
   ```

4. **Generate report**
   ```bash
   tw doc create --project $PROJECT_ID \
     --title "Health Assessment $(date +%Y-%m-%d)" \
     --type other \
     --content "# Health Score: 78/100\n\n## Risks\n..." --json
   ```

### Health Score Guide

| Score | Status | Action |
|-------|--------|--------|
| 80–100 | Healthy | Monitor, no urgent action |
| 60–79 | At risk | Review risks, address overdue items |
| 40–59 | Unhealthy | Investigate blockers, reassign tasks, adjust scope |
| 0–39 | Critical | Immediate intervention needed |

---

## Multi-Agent Collaboration

Coordinate multiple AI agents (and humans) working on the same project without conflicts.

> **Daemon/executor mode:** this workflow is for **interactive/self-directed** agents that pick and claim their own work. If you were spawned by `tw daemon`, the daemon already claimed a requirement lane and selected an initial task — **skip the Claim and Release steps** below; process the provided requirement roadmap and set task/requirement statuses. See `SKILL.md` § Operating Modes.

### Core Protocol: Claim → Work → Release

Every agent must follow this cycle:

```
1. Scout    → tw task list + tw activity (see what's happening)
2. Claim    → tw task claim <id>  (or batch via REST API)
3. Start    → tw task status <id> in_progress
4. Work     → periodic tw task claim <id> heartbeat for long tasks
5. Complete → tw task status <id> done  (auto-releases claim)
```

### Step-by-Step

1. **Check what's happening**
   ```bash
   tw task list --project $PROJECT_ID --status todo --json
   tw activity --project $PROJECT_ID --limit 20 --json
   # check active claims via REST
   curl "$API_URL/api/v1/projects/$PROJECT_ID/claims" \
     -H "Authorization: Bearer $API_KEY"
   ```

2. **Pick tasks**
   - Choose tasks with status `todo` and no active claim
   - Respect `blocks` dependencies — don't pick tasks whose blockers are incomplete

3. **Claim tasks**
   ```bash
   tw task claim $TASK_ID --duration 30
   tw task comment $TASK_ID "Claiming this task, starting now."
   ```
   For batch claiming (atomic, up to 20 tasks), use the REST API:
   ```bash
   curl -X POST "$API_URL/api/v1/tasks/batch-claim" \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"taskIds": ["'$ID1'", "'$ID2'"]}'
   ```

4. **Work on the task**
   ```bash
   # extend lease for long tasks
   tw task claim $TASK_ID --duration 30   # heartbeat

   # use --expected-version on REST updates to prevent conflicts
   curl -X PATCH "$API_URL/api/v1/tasks/$TASK_ID" \
     -d '{"title": "...", "expectedVersion": 3}'
   ```

5. **Finish or hand off**
   ```bash
   # completing
   tw task status $TASK_ID done --reason "Implementation complete"

   # can't finish
   tw task release $TASK_ID --reason "Blocked, needs design decision"
   tw task comment $TASK_ID "Released: blocked by X. Next agent should..."
   ```

6. **Document your work**
   ```bash
   tw doc create --project $PROJECT_ID \
     --title "Auth implementation notes" \
     --content "# What was done\n..." --type other --json
   # link to task via REST
   curl -X POST "$API_URL/api/v1/documents/$DOC_ID/task-links" \
     -H "Authorization: Bearer $API_KEY" \
     -d '{"taskId": "'$TASK_ID'", "linkType": "output"}'
   ```

### Avoiding Common Conflicts

| Scenario | Prevention | Recovery |
|----------|-----------|----------|
| Two agents edit same task | Use `expectedVersion` on REST updates | Re-read, merge changes, retry |
| Two agents edit same document | Use `expectedVersion` on REST updates | Compare versions, merge manually |
| Agent disappears mid-task | Claims auto-expire after lease | Another agent can claim after expiry |
| Duplicate work | Check task list + activity before starting | One completes, other redirects |
| Dependency deadlock | System blocks status if blockers incomplete | Use `--force` only if justified |

### Daemon Requirement-Lane Protocol

Daemon workers use a different coordination unit from interactive agents:

```
1. Daemon worker applies for a requirement lane
2. Server creates/renews a requirement_claims lease
3. Server selects the first executable task and marks it in_progress
4. Daemon prepares the requirement branch worktree
5. Spawned agent processes the requirement task roadmap sequentially
6. When all requirement tasks are terminal, daemon commits/pushes the requirement branch, discovers or creates a PR when possible, records the result in Task Weaver comments, and moves the requirement to `in_review`
7. A review daemon can move approved branches to `ready_to_merge`; a merge daemon then consumes `ready_to_merge` and marks successful merges `done`
8. Daemon heartbeats and releases the requirement claim
```

If you are the spawned agent:

- Do not run `tw task claim`, `tw task release`, or requirement claim/release calls.
- Work only in the daemon-provided worktree.
- Start with the initial active task, then continue with remaining unblocked tasks in the same requirement.
- Mark tasks `done` as you complete them.
- Use task `in_review` when human judgment is needed.
- Do not commit, push, create a PR, or mark the requirement `done`.
- Leave file changes in the daemon-provided worktree. The daemon handles final branch publication and moves the requirement to `in_review` when all tasks are terminal.

Humans can inspect active daemon lanes on the Web Daemons page. It shows daemon workers, current requirement, active task, branch/worktree, task roadmap, and stale lease indicators.

For debugging lane ownership from the CLI:

```bash
tw req claims --project $PROJECT_ID --json
tw req claim-status $REQ_ID --json
tw req release $REQ_ID --reason "manual cleanup"
```

### Communication via Comments

```bash
tw task comment $TASK_ID "Starting: will implement the REST endpoint for user search"
tw task comment $TASK_ID "Progress: API done, starting tests. ~15 min remaining"
tw task comment $TASK_ID "Blocked: needs database migration from task $OTHER_ID first"
tw task comment $TASK_ID "Done: endpoint live, tests passing, doc linked"
```

### Requirement-Level Partitioning

For larger teams, partition work at the requirement level:
- Each agent "owns" one or more requirements
- Only create/modify tasks under your assigned requirements
- Cross-requirement work requires coordination via comments

This reduces contention and makes parallel work natural.
