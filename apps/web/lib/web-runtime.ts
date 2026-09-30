import type { Actor } from "@task-weaver/contracts";
import { createDefaultRuntimePorts } from "@task-weaver/core/default-ports";
import type { IdentityResult, TaskWeaverRuntimePorts } from "@task-weaver/module-sdk/ports";
import { coreWebModule } from "./core-web-module";
import {
  composeWebModuleRegistry,
  resolveVisibleWebContributions,
  type WebModuleRegistry,
} from "./web-module-registry";
import type { TaskWeaverWebModule, VisibleWebContributions } from "./web-extension-types";

export interface WebRuntime {
  ports: TaskWeaverRuntimePorts;
  registry: WebModuleRegistry;
}

export interface CreateWebRuntimeOptions {
  modules?: readonly TaskWeaverWebModule[];
  ports?: TaskWeaverRuntimePorts;
}

export interface WebRequestState {
  identity: IdentityResult;
  contributions: VisibleWebContributions;
}

export function requestHeadersRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(headers.entries());
}

export function createWebRuntime(options: CreateWebRuntimeOptions = {}): WebRuntime {
  return {
    ports: options.ports ?? createDefaultRuntimePorts(),
    registry: composeWebModuleRegistry([coreWebModule, ...(options.modules ?? [])]),
  };
}

let configuredRuntime: WebRuntime | undefined;

export function configureWebRuntime(options: CreateWebRuntimeOptions): WebRuntime {
  configuredRuntime = createWebRuntime(options);
  return configuredRuntime;
}

export function getWebRuntime(): WebRuntime {
  configuredRuntime ??= createWebRuntime();
  return configuredRuntime;
}

export async function resolveWebIdentity(
  runtime: WebRuntime,
  headers: Headers,
): Promise<IdentityResult> {
  return runtime.ports.identity.resolveIdentity({ headers: requestHeadersRecord(headers) });
}

export async function resolveWebRequestState(
  runtime: WebRuntime,
  headers: Headers,
): Promise<WebRequestState> {
  const identity = await resolveWebIdentity(runtime, headers);
  const contributions = await resolveVisibleWebContributions(
    runtime.registry,
    runtime.ports.entitlements,
    identity.actor,
  );
  return { identity, contributions };
}

export async function resolveWebContributionsForActor(
  runtime: WebRuntime,
  actor: Actor,
): Promise<VisibleWebContributions> {
  return resolveVisibleWebContributions(runtime.registry, runtime.ports.entitlements, actor);
}
