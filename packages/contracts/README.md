# `@task-weaver/contracts`

`@task-weaver/contracts` is the database-free public contract surface for Task Weaver.

It contains:

- Zod request, response, configuration, and validation schemas
- DTO and stable public TypeScript types
- realtime event envelopes
- shared domain errors

The package may depend on validation libraries such as Zod, but it must not import database adapters, Drizzle ORM, PostgreSQL clients, application services, or server lifecycle code. Browser, CLI, module, and integration consumers should import contracts from this package instead of the `@task-weaver/core` service barrel.

`@task-weaver/core` re-exports the contract surface for backwards compatibility. New client code should use `@task-weaver/contracts` directly.
