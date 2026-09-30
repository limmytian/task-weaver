# `@task-weaver/module-sdk`

Typed, runtime-neutral contracts for composing Task Weaver modules.

The SDK defines module manifests, validated configuration, REST and tRPC
contributions, background workers, event subscribers, health checks,
permissions, independently owned migrations, and Web extension points. Its
composition validator rejects incompatible Core versions and conflicting
registrations before application startup.

The package intentionally does not import Hono, tRPC, Next.js, Drizzle, or a
database client. Application adapters own those framework-specific types and
pass them through the SDK's generic contribution handles.

REST contributions declare a collision-checked `path`. Adapters that mount a
router at a broader prefix may also provide `mountPath`; `path` remains the
specific route ownership key used during composition.

```ts
import { defineTaskWeaverModule } from "@task-weaver/module-sdk";
import { z } from "zod";

export const exampleModule = defineTaskWeaverModule({
  manifest: {
    apiVersion: "task-weaver.dev/v1alpha1",
    id: "example.audit",
    name: "Example audit module",
    version: "1.0.0",
    supportedCoreVersion: ">=0.2.0 <0.3.0",
    capabilities: ["audit.read"],
  },
  configuration: {
    schema: z.object({ enabled: z.boolean().default(true) }),
  },
});
```

## Runtime ports

The `@task-weaver/module-sdk/ports` entry point defines narrow interfaces for
identity, authorization, entitlements, audit events, secret resolution,
notifications, and metering. Authorization and entitlement decisions are
server-side contracts; hiding a Web contribution is never an access-control
decision.

Core provides `createDefaultRuntimePorts()` from
`@task-weaver/core/default-ports`. These defaults preserve single-instance
behavior, resolve `env:VARIABLE_NAME` secret references, and retain bounded
local audit, notification, and usage records. Deployments may replace any port
without changing module contracts.

```ts
import { enforceAccess } from "@task-weaver/module-sdk/ports";

await enforceAccess(ports, {
  authorization: {
    actor,
    permission: "projects.read",
    resource: { type: "project", id: projectId },
  },
  entitlement: { capability: "projects" },
});
```

## Migration ownership

Every module migration namespace owns exactly one schema named
`task_weaver_<namespace>`. Core exclusively owns the `task_weaver` schema and
its Drizzle journal. Composition rejects schema or namespace collisions before
startup, and the database adapter records each extension in a journal inside
the extension-owned schema.

Module migrations are forward-only during normal startup. The runner never
invokes `down` callbacks automatically. See
[`docs/module-migrations.md`](../../docs/module-migrations.md) for upgrade,
backup, failure, and recovery guidance.
