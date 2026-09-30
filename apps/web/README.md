# Task Weaver Web

The Task Weaver Web application is a Next.js App Router client for the public Task Weaver services. It resolves every request actor through the shared runtime ports and composes its navigation, settings, and extension pages from typed Task Weaver modules.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @task-weaver/web dev
```

The default development URL is `http://localhost:3000`. A PostgreSQL connection string must be supplied through the normal deployment environment.

## Identity and access

The tRPC context delegates identity resolution to `IdentityPort`. The default implementation accepts the trusted `X-Actor-Id` and `X-Actor-Type` headers and otherwise resolves an anonymous human actor. Deployments can replace all runtime ports through `createWebRuntime()` or `configureWebRuntime()`.

Every tRPC procedure enforces the `core.web.access` permission and `core.web` entitlement on the server. Capability-based navigation filtering is presentation logic only; it does not replace server-side authorization.

## Web modules

Use `defineTaskWeaverWebModule()` to provide typed Web contributions. A module can contribute:

- navigation entries, including an optional icon token and capability requirement;
- settings entries with a route, title, description, and optional icon token;
- extension pages with a title, optional description, and React component.

Extension page routes must start with `/projects/extensions/`. The application owns one static App Router catch-all route at `/projects/extensions/[...slug]`, so modules do not write files into the public application or create routes dynamically at runtime. Modules and their page components must be supplied to `createWebRuntime()` as static build inputs. The default runtime imports only `coreWebModule`; host builds supply additional modules explicitly.

```tsx
import { TASK_WEAVER_MODULE_API_VERSION } from "@task-weaver/module-sdk";
import { defineTaskWeaverWebModule } from "./lib/web-module-registry";
import { configureWebRuntime } from "./lib/web-runtime";

const exampleModule = defineTaskWeaverWebModule({
  manifest: {
    apiVersion: TASK_WEAVER_MODULE_API_VERSION,
    id: "example.web",
    name: "Example Web",
    version: "1.0.0",
    supportedCoreVersion: "^0.2.0",
    capabilities: ["example.ui"],
  },
  web: {
    navigation: [{
      id: "example-navigation",
      label: "Example",
      href: "/projects/extensions/example",
      requiredCapability: "example.ui",
    }],
    pages: [{
      id: "example-page",
      route: "/projects/extensions/example",
      page: { title: "Example", component: ExamplePage },
      requiredCapability: "example.ui",
    }],
  },
});

configureWebRuntime({ modules: [exampleModule], ports });
```

The host build is responsible for installing the runtime before it begins serving requests. Duplicate contribution IDs and page routes, unsupported Core versions, invalid descriptors, and routes outside the catch-all prefix fail during composition.
