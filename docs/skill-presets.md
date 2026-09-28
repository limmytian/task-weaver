# Git-managed global skill presets

The API imports the repository's global onboarding skills during startup. A preset is an immediate child of `skills/` containing a `SKILL.md` entry file; any other files in that directory are included in the package and indexed when they are readable text.

## Lifecycle

1. Add, edit, or remove a directory under `skills/` in Git.
2. Build and deploy the API image. `apps/api/Dockerfile` copies the source tree into `/app/skills` because Turbo prune does not treat skills as a package dependency.
3. After database migrations, API startup acquires a PostgreSQL advisory lock and synchronizes the presets.
4. The package version is content-addressed (`git-<sha256-prefix>`). Unchanged content is a no-op; changed content creates a new immutable version and deprecates older active versions.
5. A preset removed from Git is archived in the global package catalog and its files disappear from normal skill retrieval. Historical package versions remain available for audit.

Only packages whose manifest contains `managedBy: task-weaver-git-presets` are managed by this process. A name collision with a user-created global package fails startup instead of overwriting user data.

## Configuration

The defaults are suitable for the repository layout and API image:

```text
TW_PRESET_SKILLS_DIR=skills
SKILL_PACKAGE_STORAGE_DIR=data/skill-packages
```

Set `TW_PRESET_SKILLS_DIR` to an absolute mounted path when the service receives presets from a separate Git checkout. Set `TW_PRESET_SKILLS_SYNC=disabled` only for a deliberate maintenance or migration window.

## Authoring a preset

Use a directory name that is stable and a unique `name` in the frontmatter:

```markdown
---
name: task-weaver-example-integration
description: One-sentence retrieval description.
keywords: ["example", "integration"]
tags: ["integration"]
---

# Example integration

Give a new agent the prerequisites, exact `tw`/REST commands, scope rules, and safe handling of credentials. Keep secrets and environment-specific tokens out of the file.
```

After deployment, verify the result:

```bash
tw context search "example integration" --json
tw context package list --json
```
