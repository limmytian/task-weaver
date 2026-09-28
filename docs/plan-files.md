# Plan Files

Plan files let agents stage a complete project planning batch in one YAML or JSON document, validate it, then apply it atomically.

## CLI

```bash
tw plan validate --file plan.yaml
tw plan apply --file plan.yaml
tw plan apply --file plan.yaml --dry-run --json
```

`validate` and `apply --dry-run` both call the API in dry-run mode. They parse the file, expand local `contentFile` references, validate project/existing IDs, check plan-local dependency cycles, and return the same summary without writing changes.

## Shape

```yaml
projectId: 00000000-0000-4000-8000-000000000001

documents:
  - key: auth-design
    title: Auth Design
    contentFile: ./auth-design.md
    docType: design
    tags: [auth]

requirements:
  - key: auth-api
    title: Auth API
    status: approved
    priority: high
    modelTier: strong
    documents:
      - document: auth-design
        type: documents
    slices:
      - key: auth-api-schema
        title: Schema
        orderIndex: 0
        tasks: [auth-db]
      - key: auth-api-routes
        title: Routes
        orderIndex: 1
        tasks: [auth-login]
    tasks:
      - key: auth-db
        title: Add auth tables
        priority: high
        comments:
          - "Planning: create user credential tables before routes."
      - key: auth-login
        title: Implement login endpoint
        priority: high
        dependsOn:
          - task: auth-db
            type: blocks
        documents:
          - document: auth-design
            type: references

  - key: auth-web
    title: Auth Web UI
    status: approved
    dependsOn:
      - requirement: auth-api
        type: blocks
```

## References

Use `key` values for objects created or reused in the same plan. Use `existingId` to reuse an existing requirement, task, or document under a stable key:

```yaml
documents:
  - key: existing-architecture
    existingId: 00000000-0000-4000-8000-000000000010
```

References may also be direct UUIDs when linking to an existing object outside the file.

## Supported Operations

- Create or reuse documents, requirements, and tasks.
- Create ordered execution slices and assign tasks.
- Add requirement and task dependencies.
- Link documents to documents, requirements, and tasks.
- Add task comments and notes.

The API applies the whole plan in one transaction. If any operation fails, no plan changes are committed.
