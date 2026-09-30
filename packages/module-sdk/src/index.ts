import type { RealtimeEvent } from "@task-weaver/contracts/events";
import { satisfies, valid, validRange } from "semver";
import type { ZodType } from "zod";
import {
  taskWeaverModuleManifestSchema,
  type TaskWeaverModuleManifest,
  type TaskWeaverModuleManifestInput,
} from "./manifest";

export * from "./manifest";
export * from "./ports";

export type MaybePromise<T> = T | Promise<T>;

export type ApiMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

export interface ModuleLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

export interface ModuleLifecycleContext<TConfig, TServices = unknown> {
  config: TConfig;
  coreVersion: string;
  logger: ModuleLogger;
  services: TServices;
  signal: AbortSignal;
}

export interface ModuleConfiguration<TConfig> {
  schema: ZodType<TConfig>;
  defaultValue?: unknown;
  sensitiveKeys?: readonly (keyof TConfig & string)[];
}

export interface ApiRouteContribution<TRoute = unknown> {
  id: string;
  method: ApiMethod;
  path: `/${string}`;
  mountPath?: `/${string}`;
  route: TRoute;
}

export interface TrpcRouterContribution<TRouter = unknown> {
  namespace: string;
  router: TRouter;
}

export interface BackgroundWorkerContribution<TContext = unknown> {
  id: string;
  start(context: TContext): MaybePromise<void>;
  stop?(context: TContext): MaybePromise<void>;
}

export interface EventSubscriberContribution<
  TEvent extends RealtimeEvent = RealtimeEvent,
  TContext = unknown,
> {
  id: string;
  eventTypes: readonly TEvent["type"][];
  handle(event: TEvent, context: TContext): MaybePromise<void>;
}

export type ModuleHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ModuleHealthResult {
  status: ModuleHealthStatus;
  message?: string;
  details?: Record<string, unknown>;
}

export interface HealthCheckContribution<TContext = unknown> {
  id: string;
  check(context: TContext): MaybePromise<ModuleHealthResult>;
}

export interface ModuleMigration<TContext = unknown> {
  id: string;
  version: number;
  description?: string;
  up(context: TContext): Promise<void>;
  down?(context: TContext): Promise<void>;
}

export interface MigrationContribution<TContext = unknown> {
  namespace: string;
  schema: string;
  migrations: readonly ModuleMigration<TContext>[];
}

export interface ComposedMigrationContribution extends MigrationContribution {
  moduleId: string;
  moduleVersion: string;
  supportedCoreVersion: string;
}

export interface WebNavigationContribution {
  id: string;
  label: string;
  href: `/${string}`;
  icon?: string;
  requiredCapability?: string;
}

export interface WebPageContribution<TPage = unknown> {
  id: string;
  route: `/${string}`;
  page: TPage;
  requiredCapability?: string;
}

export interface WebSettingsContribution<TSettings = unknown> {
  id: string;
  settings: TSettings;
  requiredCapability?: string;
}

export interface WebContributions<TPage = unknown, TSettings = unknown> {
  navigation?: readonly WebNavigationContribution[];
  pages?: readonly WebPageContribution<TPage>[];
  settings?: readonly WebSettingsContribution<TSettings>[];
}

export interface TaskWeaverModule<
  TConfig = unknown,
  TApiRoute = unknown,
  TTrpcRouter = unknown,
  TWorkerContext = unknown,
  TEvent extends RealtimeEvent = RealtimeEvent,
  TEventContext = unknown,
  THealthContext = unknown,
  TMigrationContext = unknown,
  TPage = unknown,
  TSettings = unknown,
> {
  manifest: TaskWeaverModuleManifestInput;
  configuration?: ModuleConfiguration<TConfig>;
  apiRoutes?: readonly ApiRouteContribution<TApiRoute>[];
  trpcRouters?: readonly TrpcRouterContribution<TTrpcRouter>[];
  workers?: readonly BackgroundWorkerContribution<TWorkerContext>[];
  eventSubscribers?: readonly EventSubscriberContribution<TEvent, TEventContext>[];
  healthChecks?: readonly HealthCheckContribution<THealthContext>[];
  migrations?: MigrationContribution<TMigrationContext>;
  web?: WebContributions<TPage, TSettings>;
}

export type AnyTaskWeaverModule = TaskWeaverModule<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

export interface ComposeTaskWeaverModulesOptions {
  coreVersion: string;
  configuration?: Readonly<Record<string, unknown>>;
}

export interface ComposedTaskWeaverModules {
  coreVersion: string;
  modules: readonly AnyTaskWeaverModule[];
  configuration: Readonly<Record<string, unknown>>;
  apiRoutes: readonly ApiRouteContribution[];
  trpcRouters: readonly TrpcRouterContribution[];
  workers: readonly BackgroundWorkerContribution[];
  eventSubscribers: readonly EventSubscriberContribution[];
  healthChecks: readonly HealthCheckContribution[];
  migrations: readonly ComposedMigrationContribution[];
  web: {
    navigation: readonly WebNavigationContribution[];
    pages: readonly WebPageContribution[];
    settings: readonly WebSettingsContribution[];
  };
}

export type ModuleCompositionErrorCode =
  | "configuration_invalid"
  | "core_version_invalid"
  | "core_version_unsupported"
  | "duplicate_api_route"
  | "duplicate_capability"
  | "duplicate_contribution"
  | "duplicate_migration_schema"
  | "duplicate_migration_namespace"
  | "duplicate_module"
  | "duplicate_permission"
  | "duplicate_trpc_namespace"
  | "duplicate_web_route"
  | "manifest_invalid"
  | "migration_manifest_mismatch"
  | "migration_order_invalid";

export class ModuleCompositionError extends Error {
  public readonly code: ModuleCompositionErrorCode;
  public readonly moduleIds: readonly string[];

  constructor(
    code: ModuleCompositionErrorCode,
    message: string,
    moduleIds: readonly string[] = [],
  ) {
    super(message);
    this.name = "ModuleCompositionError";
    this.code = code;
    this.moduleIds = moduleIds;
  }
}

export function defineTaskWeaverModule<const TModule extends AnyTaskWeaverModule>(
  module: TModule,
): TModule {
  return module;
}

function normalizedPath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

function claim(
  registry: Map<string, string>,
  key: string,
  moduleId: string,
  code: ModuleCompositionErrorCode,
  label: string,
): void {
  const owner = registry.get(key);
  if (owner) {
    throw new ModuleCompositionError(
      code,
      `${label} '${key}' from module '${moduleId}' conflicts with module '${owner}'`,
      [owner, moduleId],
    );
  }
  registry.set(key, moduleId);
}

function validateMigrationContribution(
  moduleId: string,
  manifest: TaskWeaverModuleManifest,
  migration: MigrationContribution | undefined,
): void {
  if (manifest.migrationNamespace !== migration?.namespace) {
    if (manifest.migrationNamespace || migration) {
      throw new ModuleCompositionError(
        "migration_manifest_mismatch",
        `Module '${moduleId}' must declare the same migration namespace in its manifest and runtime contribution`,
        [moduleId],
      );
    }
    return;
  }

  if (migration && migration.schema !== `task_weaver_${migration.namespace}`) {
    throw new ModuleCompositionError(
      "migration_manifest_mismatch",
      `Module '${moduleId}' migration schema must be 'task_weaver_${migration.namespace}' for namespace '${migration.namespace}'`,
      [moduleId],
    );
  }

  const migrationIds = new Set<string>();
  let previousVersion = 0;
  for (const item of migration?.migrations ?? []) {
    if (
      migrationIds.has(item.id)
      || !Number.isSafeInteger(item.version)
      || item.version <= previousVersion
    ) {
      throw new ModuleCompositionError(
        "migration_order_invalid",
        `Module '${moduleId}' migration '${item.id}' must have a unique id and a strictly increasing positive version`,
        [moduleId],
      );
    }
    migrationIds.add(item.id);
    previousVersion = item.version;
  }
}

function contributionId(
  registry: Map<string, string>,
  kind: string,
  id: string,
  moduleId: string,
): void {
  claim(
    registry,
    `${kind}:${id}`,
    moduleId,
    "duplicate_contribution",
    `${kind} contribution`,
  );
}

export function composeTaskWeaverModules(
  modules: readonly AnyTaskWeaverModule[],
  options: ComposeTaskWeaverModulesOptions,
): ComposedTaskWeaverModules {
  if (!valid(options.coreVersion)) {
    throw new ModuleCompositionError(
      "core_version_invalid",
      `Task Weaver Core version '${options.coreVersion}' is not a valid semantic version`,
    );
  }

  const moduleIds = new Map<string, string>();
  const capabilities = new Map<string, string>();
  const permissions = new Map<string, string>();
  const apiRoutes = new Map<string, string>();
  const trpcNamespaces = new Map<string, string>();
  const migrationNamespaces = new Map<string, string>();
  const migrationSchemas = new Map<string, string>();
  const webRoutes = new Map<string, string>();
  const contributionIds = new Map<string, string>();
  const parsedConfiguration: Record<string, unknown> = {};

  for (const module of modules) {
    const parsedManifest = taskWeaverModuleManifestSchema.safeParse(module.manifest);
    if (!parsedManifest.success) {
      throw new ModuleCompositionError(
        "manifest_invalid",
        `Module manifest is invalid: ${parsedManifest.error.issues.map((issue) => issue.message).join("; ")}`,
        [module.manifest.id],
      );
    }
    const manifest = parsedManifest.data;
    claim(moduleIds, manifest.id, manifest.id, "duplicate_module", "Module id");

    if (!valid(manifest.version)) {
      throw new ModuleCompositionError(
        "manifest_invalid",
        `Module '${manifest.id}' version '${manifest.version}' is not a valid semantic version`,
        [manifest.id],
      );
    }

    const range = validRange(manifest.supportedCoreVersion);
    if (!range) {
      throw new ModuleCompositionError(
        "manifest_invalid",
        `Module '${manifest.id}' declares invalid supported Core range '${manifest.supportedCoreVersion}'`,
        [manifest.id],
      );
    }
    if (!satisfies(options.coreVersion, range, { includePrerelease: true })) {
      throw new ModuleCompositionError(
        "core_version_unsupported",
        `Module '${manifest.id}' version ${manifest.version} supports Task Weaver Core '${manifest.supportedCoreVersion}', but Core '${options.coreVersion}' is running`,
        [manifest.id],
      );
    }

    for (const capability of manifest.capabilities) {
      claim(capabilities, capability, manifest.id, "duplicate_capability", "Capability");
    }
    for (const permission of manifest.permissions) {
      claim(permissions, permission.id, manifest.id, "duplicate_permission", "Permission");
    }

    if (module.configuration) {
      const rawConfig = options.configuration?.[manifest.id]
        ?? module.configuration.defaultValue
        ?? {};
      const result = module.configuration.schema.safeParse(rawConfig);
      if (!result.success) {
        throw new ModuleCompositionError(
          "configuration_invalid",
          `Configuration for module '${manifest.id}' is invalid: ${result.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ")}`,
          [manifest.id],
        );
      }
      parsedConfiguration[manifest.id] = result.data;
    }

    for (const route of module.apiRoutes ?? []) {
      const key = `${route.method} ${normalizedPath(route.path)}`;
      claim(apiRoutes, key, manifest.id, "duplicate_api_route", "API route");
      contributionId(contributionIds, "api-route", route.id, manifest.id);
    }
    for (const router of module.trpcRouters ?? []) {
      claim(trpcNamespaces, router.namespace, manifest.id, "duplicate_trpc_namespace", "tRPC namespace");
    }
    for (const worker of module.workers ?? []) {
      contributionId(contributionIds, "worker", worker.id, manifest.id);
    }
    for (const subscriber of module.eventSubscribers ?? []) {
      contributionId(contributionIds, "event-subscriber", subscriber.id, manifest.id);
    }
    for (const healthCheck of module.healthChecks ?? []) {
      contributionId(contributionIds, "health-check", healthCheck.id, manifest.id);
    }

    validateMigrationContribution(manifest.id, manifest, module.migrations);
    if (module.migrations) {
      claim(
        migrationNamespaces,
        module.migrations.namespace,
        manifest.id,
        "duplicate_migration_namespace",
        "Migration namespace",
      );
      claim(
        migrationSchemas,
        module.migrations.schema,
        manifest.id,
        "duplicate_migration_schema",
        "Migration schema",
      );
    }

    for (const navigation of module.web?.navigation ?? []) {
      contributionId(contributionIds, "web-navigation", navigation.id, manifest.id);
    }
    for (const page of module.web?.pages ?? []) {
      contributionId(contributionIds, "web-page", page.id, manifest.id);
      claim(webRoutes, normalizedPath(page.route), manifest.id, "duplicate_web_route", "Web route");
    }
    for (const settings of module.web?.settings ?? []) {
      contributionId(contributionIds, "web-settings", settings.id, manifest.id);
    }
  }

  return {
    coreVersion: options.coreVersion,
    modules: [...modules],
    configuration: parsedConfiguration,
    apiRoutes: modules.flatMap((module) => [...(module.apiRoutes ?? [])]),
    trpcRouters: modules.flatMap((module) => [...(module.trpcRouters ?? [])]),
    workers: modules.flatMap((module) => [...(module.workers ?? [])]),
    eventSubscribers: modules.flatMap((module) => [...(module.eventSubscribers ?? [])]),
    healthChecks: modules.flatMap((module) => [...(module.healthChecks ?? [])]),
    migrations: modules.flatMap((module) => {
      if (!module.migrations) return [];
      const manifest = taskWeaverModuleManifestSchema.parse(module.manifest);
      return [{
        ...module.migrations,
        moduleId: manifest.id,
        moduleVersion: manifest.version,
        supportedCoreVersion: manifest.supportedCoreVersion,
      }];
    }),
    web: {
      navigation: modules.flatMap((module) => [...(module.web?.navigation ?? [])]),
      pages: modules.flatMap((module) => [...(module.web?.pages ?? [])]),
      settings: modules.flatMap((module) => [...(module.web?.settings ?? [])]),
    },
  };
}
