import type { Actor } from "@task-weaver/contracts";
import {
  composeTaskWeaverModules,
  type WebNavigationContribution,
  type WebPageContribution,
  type WebSettingsContribution,
} from "@task-weaver/module-sdk";
import type { EntitlementPort } from "@task-weaver/module-sdk/ports";
import type {
  TaskWeaverWebModule,
  VisibleWebContributions,
  WebPageDescriptor,
  WebSettingsDescriptor,
} from "./web-extension-types";

export const TASK_WEAVER_WEB_CORE_VERSION = "0.2.1";
export const WEB_EXTENSION_ROUTE_PREFIX = "/projects/extensions/";

export interface WebModuleRegistry {
  navigation: readonly WebNavigationContribution[];
  pages: readonly WebPageContribution<WebPageDescriptor>[];
  settings: readonly WebSettingsContribution<WebSettingsDescriptor>[];
}

function isWebPageDescriptor(value: unknown): value is WebPageDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<WebPageDescriptor>;
  return typeof descriptor.title === "string"
    && descriptor.title.length > 0
    && typeof descriptor.component === "function"
    && (descriptor.description === undefined || typeof descriptor.description === "string");
}

function isWebSettingsDescriptor(value: unknown): value is WebSettingsDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<WebSettingsDescriptor>;
  return typeof descriptor.href === "string"
    && descriptor.href.startsWith("/")
    && typeof descriptor.title === "string"
    && descriptor.title.length > 0
    && typeof descriptor.description === "string";
}

export function defineTaskWeaverWebModule<const TModule extends TaskWeaverWebModule>(
  module: TModule,
): TModule {
  return module;
}

export function composeWebModuleRegistry(
  modules: readonly TaskWeaverWebModule[],
): WebModuleRegistry {
  const composed = composeTaskWeaverModules(modules, {
    coreVersion: TASK_WEAVER_WEB_CORE_VERSION,
  });

  const pages = composed.web.pages.map((contribution) => {
    if (!contribution.route.startsWith(WEB_EXTENSION_ROUTE_PREFIX)) {
      throw new Error(
        `Web page contribution '${contribution.id}' must use the '${WEB_EXTENSION_ROUTE_PREFIX}' route prefix`,
      );
    }
    if (!isWebPageDescriptor(contribution.page)) {
      throw new Error(`Web page contribution '${contribution.id}' has an invalid page descriptor`);
    }
    return contribution as WebPageContribution<WebPageDescriptor>;
  });

  const settings = composed.web.settings.map((contribution) => {
    if (!isWebSettingsDescriptor(contribution.settings)) {
      throw new Error(`Web settings contribution '${contribution.id}' has an invalid settings descriptor`);
    }
    return contribution as WebSettingsContribution<WebSettingsDescriptor>;
  });

  return {
    navigation: composed.web.navigation,
    pages,
    settings,
  };
}

async function capabilityIsVisible(
  entitlements: EntitlementPort,
  actor: Actor,
  capability: string | undefined,
): Promise<boolean> {
  if (!capability) return true;
  const decision = await entitlements.checkEntitlement({
    actor,
    capability,
    context: { purpose: "web-visibility" },
  });
  return decision.allowed;
}

export async function resolveVisibleWebContributions(
  registry: WebModuleRegistry,
  entitlements: EntitlementPort,
  actor: Actor,
): Promise<VisibleWebContributions> {
  const [navigation, pages, settings] = await Promise.all([
    Promise.all(registry.navigation.map(async (contribution) => (
      await capabilityIsVisible(entitlements, actor, contribution.requiredCapability)
        ? {
            id: contribution.id,
            label: contribution.label,
            href: contribution.href,
            icon: contribution.icon,
          }
        : null
    ))),
    Promise.all(registry.pages.map(async (contribution) => (
      await capabilityIsVisible(entitlements, actor, contribution.requiredCapability)
        ? { id: contribution.id, route: contribution.route, page: contribution.page }
        : null
    ))),
    Promise.all(registry.settings.map(async (contribution) => (
      await capabilityIsVisible(entitlements, actor, contribution.requiredCapability)
        ? { id: contribution.id, ...contribution.settings }
        : null
    ))),
  ]);

  return {
    navigation: navigation.filter((item) => item !== null),
    pages: pages.filter((item) => item !== null),
    settings: settings.filter((item) => item !== null),
  };
}
