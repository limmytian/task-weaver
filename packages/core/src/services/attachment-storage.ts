import { resolve } from "node:path";
import { LocalStorageAdapter } from "./local-storage";

export function attachmentStorageConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const maxObjectBytes = Number(env.TW_ATTACHMENT_MAX_BYTES ?? 50 * 1024 * 1024);
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) throw new Error("TW_ATTACHMENT_MAX_BYTES must be a positive safe integer");
  return { directory: resolve(env.TW_ATTACHMENT_STORAGE_DIR ?? ".task-weaver/attachments"), maxObjectBytes };
}
export function attachmentStorage() {
  const config = attachmentStorageConfiguration();
  return new LocalStorageAdapter(config.directory, { maxObjectBytes: config.maxObjectBytes });
}
