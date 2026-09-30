import assert from "node:assert/strict";
import test from "node:test";
import { TASK_WEAVER_MODULE_API_VERSION } from "@task-weaver/module-sdk";
import type { EntitlementPort } from "@task-weaver/module-sdk/ports";
import {
  composeWebModuleRegistry,
  defineTaskWeaverWebModule,
  resolveVisibleWebContributions,
} from "./web-module-registry";
import { createWebRuntime } from "./web-runtime";

function ExamplePage() {
  return null;
}

const extensionModule = defineTaskWeaverWebModule({
  manifest: {
    apiVersion: TASK_WEAVER_MODULE_API_VERSION,
    id: "example.web",
    name: "Example Web",
    version: "1.0.0",
    supportedCoreVersion: "^0.2.0",
    capabilities: ["example.ui"],
    permissions: [],
  },
  web: {
    navigation: [{
      id: "example-nav",
      label: "Example",
      href: "/projects/extensions/example",
      icon: "puzzle",
      requiredCapability: "example.ui",
    }],
    pages: [{
      id: "example-page",
      route: "/projects/extensions/example",
      page: { title: "Example", component: ExamplePage },
      requiredCapability: "example.ui",
    }],
    settings: [{
      id: "example-settings",
      settings: {
        href: "/projects/extensions/example/settings",
        title: "Example",
        description: "Example module settings",
      },
      requiredCapability: "example.ui",
    }],
  },
});

test("composes typed navigation, page, and settings contributions", () => {
  const registry = composeWebModuleRegistry([extensionModule]);

  assert.equal(registry.navigation[0]?.icon, "puzzle");
  assert.equal(registry.pages[0]?.page.component, ExamplePage);
  assert.equal(registry.settings[0]?.settings.title, "Example");
});

test("keeps the default Web module when additional modules are installed", () => {
  const runtime = createWebRuntime({ modules: [extensionModule] });

  assert.equal(runtime.registry.navigation[0]?.id, "projects");
  assert.equal(runtime.registry.navigation.at(-1)?.id, "example-nav");
  assert.equal(runtime.registry.pages[0]?.id, "example-page");
});

test("filters every UI contribution through capability visibility", async () => {
  const checkedCapabilities: string[] = [];
  const entitlements: EntitlementPort = {
    checkEntitlement(request) {
      checkedCapabilities.push(request.capability);
      return { allowed: false, reason: "not licensed" };
    },
  };

  const visible = await resolveVisibleWebContributions(
    composeWebModuleRegistry([extensionModule]),
    entitlements,
    { id: "viewer", type: "human" },
  );

  assert.deepEqual(visible, { navigation: [], pages: [], settings: [] });
  assert.deepEqual(checkedCapabilities, ["example.ui", "example.ui", "example.ui"]);
});

test("rejects extension pages outside the build-time catch-all route", () => {
  const unsafeModule = defineTaskWeaverWebModule({
    ...extensionModule,
    manifest: { ...extensionModule.manifest, id: "example.unsafe" },
    web: {
      pages: [{
        id: "unsafe-page",
        route: "/admin",
        page: { title: "Unsafe", component: ExamplePage },
      }],
    },
  });

  assert.throws(
    () => composeWebModuleRegistry([unsafeModule]),
    /must use the '\/projects\/extensions\/' route prefix/,
  );
});
