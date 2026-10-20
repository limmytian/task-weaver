import { PLUGIN_LIMITS, pluginBackendResultSchema, pluginJsonValueSchema, pluginStorageKeySchema, ValidationError, ConflictError } from "@task-weaver/contracts";

export type PluginStateEntry = { key: string; version: number; value: unknown; deleted: number };

/** Plan the complete namespace before writing anything; caller authorization belongs to the broker. */
export function planPluginState(current: PluginStateEntry[], raw: unknown, writable: boolean) {
  const response = pluginBackendResultSchema.parse(raw);
  if (response.storageChanges.length && !writable) throw new ValidationError("This plugin method cannot write storage");
  const entries = new Map(current.map(entry => [entry.key, { ...entry }]));
  for (const change of response.storageChanges) {
    const previous = entries.get(change.key);
    if ((previous?.version ?? 0) !== change.expectedVersion) throw new ConflictError("Plugin storage version changed", previous?.version ?? 0);
    if (previous?.version === 2147483647) throw new ValidationError("Plugin storage version limit reached");
    entries.set(change.key, { key: change.key, version: change.expectedVersion + 1, value: change.operation === "delete" ? null : change.value, deleted: change.operation === "delete" ? 1 : 0 });
  }
  // Tombstones also consume the key budget; arbitrary deleted keys cannot grow without bound.
  if (entries.size > PLUGIN_LIMITS.keys) throw new ValidationError("Plugin storage key quota exceeded");
  let bytes = 0;
  for (const entry of entries.values()) {
    pluginStorageKeySchema.parse(entry.key);
    if (!entry.deleted) pluginJsonValueSchema.parse(entry.value);
    bytes += Buffer.byteLength(JSON.stringify(entry));
  }
  if (bytes > PLUGIN_LIMITS.storageBytes) throw new ValidationError("Plugin storage byte quota exceeded");
  return { result: response.result, changes: response.storageChanges.map(change => entries.get(change.key)!) };
}
