import { z } from "zod";
import { capabilityScopeSchema } from "./capabilities";
import { skillPackagePathSchema } from "./skill-packages";

export const PLUGIN_HOST_PROTOCOL = 1 as const;
export const PLUGIN_LIMITS = Object.freeze({ methods: 16, keys: 32, storageBytes: 65536, valueBytes: 16384, inputBytes: 16384, resultBytes: 65536, frontendBytes: 131072 });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().trim().min(1).max(100).refine(value => !/^(latest|next|stable|head|main|master)$/i.test(value) && !/[\s*^~<>=|]/.test(value), "Plugin artifacts require an exact immutable version");
export const pluginPermissionSchema = z.enum(["ui.render", "backend.execute", "storage.read", "storage.write"]);
export const pluginStorageKeySchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).refine(value => !value.includes(".."), "Storage keys cannot address another namespace");
const pluginVersion = z.string().max(100).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const method = z.object({ name: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), access: z.enum(["read", "write"]) }).strict();
const runtime = z.object({ profileId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/), profileHash: hash, entryPath: skillPackagePathSchema }).strict();

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(PLUGIN_HOST_PROTOCOL),
  pluginId: z.string().min(3).max(100).regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
  version: pluginVersion,
  displayName: z.string().min(1).max(128), description: z.string().max(1000).default(""),
  artifact: z.object({ packageId: z.string().uuid(), version: exactVersion, manifestHash: hash }).strict(),
  permissions: z.array(pluginPermissionSchema).max(4),
  frontend: z.object({ entryPath: skillPackagePathSchema.refine(path => path.endsWith(".html"), "Frontend entry must be an HTML artifact") }).strict().optional(),
  backend: runtime.optional(), methods: z.array(method).max(PLUGIN_LIMITS.methods).default([]),
  signature: z.object({ algorithm: z.literal("ed25519"), keyId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/), value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().optional(),
  storageSchemaVersion: z.number().int().min(1).max(2147483647).default(1),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
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
export const invokePluginSchema = z.object({
  method: method.shape.name, input: pluginJsonValueSchema,
  expectedRevision: z.number().int().min(1).max(2147483647),
  idempotencyKey: z.string().uuid(), confirmed: z.literal(true),
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
