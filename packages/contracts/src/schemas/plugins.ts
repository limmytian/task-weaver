import { z } from "zod";
import { capabilityScopeSchema } from "./capabilities";
import { skillPackagePathSchema } from "./skill-packages";

export const PLUGIN_HOST_PROTOCOL = 1 as const;
export const PLUGIN_LIMITS = Object.freeze({ methods: 16, keys: 32, storageBytes: 65536, valueBytes: 16384, inputBytes: 16384, resultBytes: 65536, frontendBytes: 131072 });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().trim().min(1).max(100).refine(value => !/^(latest|next|stable|head|main|master)$/i.test(value) && !/[\s*^~<>=|]/.test(value), "Plugin artifacts require an exact immutable version");
export const pluginPermissionSchema = z.enum(["ui.render", "backend.execute", "storage.read", "storage.write", "skills.read", "mcp.read"]);
export const pluginStorageKeySchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).refine(value => !value.includes(".."), "Storage keys cannot address another namespace");
const pluginVersion = z.string().max(100).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const method = z.object({ name: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), access: z.enum(["read", "write"]) }).strict();
const runtime = z.object({ profileId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/), profileHash: hash, entryPath: skillPackagePathSchema }).strict();

export const pluginSkillBindingSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  documentId: z.string().uuid(), version: z.number().int().min(1).max(2147483647),
  contentHash: hash,
}).strict();

export const pluginJsonValueSchema = z.unknown().superRefine((value, context) => {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 512 || depth > 16) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || !item || seen.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    const keys = Object.keys(item);
    if (keys.length > 512 || Object.getOwnPropertySymbols(item).length || Array.isArray(item) && (item.length > 512 || keys.length !== item.length)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(descriptor => descriptor.get || descriptor.set)) return false;
    seen.add(item);
    const valid = keys.every(key => visit(descriptors[key]!.value, depth + 1));
    seen.delete(item);
    return valid;
  };
  let valid = visit(value, 0);
  try { valid = valid && new TextEncoder().encode(JSON.stringify(value)).byteLength <= PLUGIN_LIMITS.valueBytes; } catch { valid = false; }
  if (!valid) context.addIssue({ code: "custom", message: "Plugin values must be bounded finite JSON without cycles or executable objects" });
});
export const pluginToolBindingSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  method: method.shape.name, toolId: z.string().uuid(), schemaHash: hash,
  arguments: z.record(z.unknown()).superRefine((value, context) => {
    if (!pluginJsonValueSchema.safeParse(value).success) context.addIssue({ code: "custom", message: "Plugin tool arguments must be bounded finite JSON" });
  }),
  inputArguments: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(16).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.inputArguments).size !== (value.inputArguments?.length ?? 0) || value.inputArguments?.some(key => Object.hasOwn(value.arguments, key))) context.addIssue({ code: "custom", message: "Tool input argument names must be unique and cannot override fixed arguments" });
});

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(PLUGIN_HOST_PROTOCOL),
  pluginId: z.string().min(3).max(100).regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
  version: pluginVersion,
  displayName: z.string().min(1).max(128), description: z.string().max(1000).default(""),
  artifact: z.object({ packageId: z.string().uuid(), version: exactVersion, manifestHash: hash }).strict(),
  permissions: z.array(pluginPermissionSchema).max(6),
  toolBindings: z.array(pluginToolBindingSchema).min(1).max(4).optional(),
  skillBindings: z.array(pluginSkillBindingSchema).min(1).max(8).optional(),
  frontend: z.object({ entryPath: skillPackagePathSchema.refine(path => path.endsWith(".html"), "Frontend entry must be an HTML artifact") }).strict().optional(),
  backend: runtime.optional(), methods: z.array(method).max(PLUGIN_LIMITS.methods).default([]),
  signature: z.object({ algorithm: z.literal("ed25519"), keyId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/), value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().optional(),
  storageSchemaVersion: z.number().int().min(1).max(2147483647).default(1),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (value.toolBindings && (!value.backend || !value.permissions.includes("mcp.read"))) issue("Tool bindings require a backend and mcp.read");
  if (value.permissions.includes("mcp.read") && !value.toolBindings) issue("mcp.read requires explicit pinned tool bindings");
  if (new Set(value.toolBindings?.map(binding => binding.name)).size !== (value.toolBindings?.length ?? 0)) issue("Tool binding names must be unique");
  if (value.toolBindings?.some(binding => !value.methods.some(method => method.name === binding.method))) issue("Tool bindings require a declared plugin method");
  if (value.skillBindings && (!value.backend || !value.permissions.includes("skills.read"))) issue("Skill bindings require a backend and skills.read");
  if (value.permissions.includes("skills.read") && !value.skillBindings) issue("skills.read requires explicit pinned skill bindings");
  if (new Set(value.skillBindings?.map(binding => binding.name)).size !== (value.skillBindings?.length ?? 0)) issue("Skill binding names must be unique");
  if (new Set(value.skillBindings?.map(binding => binding.documentId.toLowerCase())).size !== (value.skillBindings?.length ?? 0)) issue("Skill binding documents must be unique");
  if (!value.frontend && !value.backend) issue("A plugin must provide an isolated frontend or backend");
  if (new Set(value.permissions).size !== value.permissions.length) issue("Plugin permissions must be unique");
  if (new Set(value.methods.map(item => item.name)).size !== value.methods.length) issue("Plugin method names must be unique");
  if (value.frontend && !value.permissions.includes("ui.render")) issue("Frontend rendering requires its declared permission");
  if (value.backend && !value.permissions.includes("backend.execute")) issue("Backend execution requires its declared permission");
  if (value.methods.length && !value.backend) issue("API methods require an isolated backend");
  if (value.methods.some(item => item.access === "write") && !value.permissions.includes("storage.write")) issue("Write methods require storage.write");
});

export const installPluginSchema = z.object({
  scope: capabilityScopeSchema, manifest: pluginManifestSchema,
  confirmedManifestHash: hash, confirmed: z.literal(true), idempotencyKey: z.string().uuid(),
}).strict();
export const upgradePluginSchema = installPluginSchema.omit({ scope: true }).extend({
  expectedRevision: z.number().int().min(1).max(2147483647), confirmedPermissionDiffHash: hash,
}).strict();

export const invokePluginSchema = z.object({
  method: method.shape.name, input: pluginJsonValueSchema,
  expectedRevision: z.number().int().min(1).max(2147483647),
  idempotencyKey: z.string().uuid(), confirmed: z.literal(true),
  toolApprovals: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.string().uuid()).refine(value => Object.keys(value).length <= 4, "At most four tool approvals are allowed").optional(),
}).strict();
export const pluginStorageChangeSchema = z.object({
  key: pluginStorageKeySchema, expectedVersion: z.number().int().min(0).max(2147483647),
  operation: z.enum(["put", "delete"]), value: pluginJsonValueSchema.optional(),
}).strict().refine(value => value.operation === "put" ? value.value !== undefined : value.value === undefined, "Storage operation must agree with its payload");
export const pluginBackendResultSchema = z.object({
  result: pluginJsonValueSchema,
  storageChanges: z.array(pluginStorageChangeSchema).max(8).default([]),
}).strict().refine(value => new Set(value.storageChanges.map(change => change.key)).size === value.storageChanges.length, "A storage key can change only once per atomic invocation")
  .refine(value => {
    if (!pluginJsonValueSchema.safeParse(value.result).success || value.storageChanges.some(change => change.value !== undefined && !pluginJsonValueSchema.safeParse(change.value).success)) return false;
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= PLUGIN_LIMITS.resultBytes; } catch { return false; }
  }, "Plugin responses exceed the host byte limit");
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const changePluginStatusSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2147483646),
  action: z.enum(["disable", "uninstall", "purge"]),
  confirmed: z.literal(true), idempotencyKey: z.string().uuid(),
}).strict();
export const recoverPluginSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2147483646),
  version: pluginVersion,
  confirmedManifestHash: hash, confirmedPermissionDiffHash: hash,
  confirmed: z.literal(true), idempotencyKey: z.string().uuid(),
}).strict();

const frameNonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const exactOrigin = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && url.origin === value && !url.username && !url.password; } catch { return false; }
}, "A canonical HTTP or HTTPS origin is required");
export const pluginFrontendOriginsSchema = z.object({ webOrigin: exactOrigin, apiOrigin: exactOrigin, artifactOrigin: exactOrigin }).strict().superRefine((value, context) => {
  let origins: URL[];
  try { origins = [value.webOrigin, value.apiOrigin, value.artifactOrigin].map(value => new URL(value)); } catch { return; }
  if (origins[2]!.hostname === origins[0]!.hostname || origins[2]!.hostname === origins[1]!.hostname) context.addIssue({ code: "custom", message: "Plugin artifact host must differ from both Web and API hosts; ports do not isolate cookies" });
  if (origins.some(origin => origin.protocol !== "https:" && !["localhost", "127.0.0.1", "127.0.0.2", "[::1]"].includes(origin.hostname) && !origin.hostname.endsWith(".localhost"))) context.addIssue({ code: "custom", message: "Plugin frontend origins require HTTPS outside explicit loopback development hosts" });
});
export const pluginFrameBindingSchema = z.object({
  installationId: z.string().uuid(), revision: z.number().int().positive().max(2147483647), manifestHash: hash,
  bridgeNonce: frameNonce, webOrigin: exactOrigin, allowedMethods: z.array(method.shape.name).max(PLUGIN_LIMITS.methods),
}).strict();
export const pluginInvokeMessageSchema = z.object({
  protocol: z.literal(PLUGIN_HOST_PROTOCOL), kind: z.literal("invoke"), installationId: z.string().uuid(),
  revision: z.number().int().positive().max(2147483647), manifestHash: hash, nonce: frameNonce,
  requestId: z.string().uuid(), method: method.shape.name, input: pluginJsonValueSchema,
}).strict().refine(value => {
  if (!pluginJsonValueSchema.safeParse(value.input).success) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32768; } catch { return false; }
}, "Plugin bridge request exceeds its byte limit");

export const pluginViewerTicketSchema = pluginFrameBindingSchema.extend({
  displayName: z.string().min(1).max(128), pluginId: z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/).max(100),
  artifactUrl: z.string().max(4096).url(), expiresAt: z.string().datetime(), frontendFormat: z.literal("restricted_html_v1"),
}).strict().refine(value => {
  try { const url = new URL(value.artifactUrl); return url.href === value.artifactUrl && !url.username && !url.password && !url.search && !url.hash && /^\/artifacts\/[A-Za-z0-9_-]{43}$/.test(url.pathname); } catch { return false; }
}, "Plugin artifact tickets require an exact bounded artifact URL");

const pluginMessageBinding = pluginFrameBindingSchema.omit({ bridgeNonce: true, webOrigin: true, allowedMethods: true }).extend({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), nonce: frameNonce });
export const pluginInitializeMessageSchema = pluginMessageBinding.extend({ kind: z.literal("initialize") }).strict();
export const pluginReadyMessageSchema = pluginMessageBinding.extend({
  kind: z.literal("ready"),
  isolation: z.object({ opaqueOrigin: z.boolean(), coreDomDenied: z.boolean(), cookiesDenied: z.boolean(), localStorageDenied: z.boolean() }).strict(),
}).strict();
export const pluginResultMessageSchema = pluginMessageBinding.extend({ kind: z.literal("result"), requestId: z.string().uuid(), ok: z.boolean(), result: pluginJsonValueSchema.optional() }).strict().refine(value => {
  if (value.ok ? value.result === undefined : value.result !== undefined) return false;
  if (value.result !== undefined && !pluginJsonValueSchema.safeParse(value.result).success) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32768; } catch { return false; }
}, "Plugin reply must agree with its success state and byte limit");


export const pluginListQuerySchema = z.object({
  scope: z.enum(["project", "personal", "global"]).default("personal"), projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict().refine(value => value.scope === "project" ? !!value.projectId : !value.projectId, "Project scope requires projectId; other scopes forbid it");
export const pluginManifestReviewSchema = z.object({ manifest: pluginManifestSchema, installationId: z.string().uuid().optional() }).strict();
