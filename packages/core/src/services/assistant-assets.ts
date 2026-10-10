import { resolve } from "node:path";
import { LocalSkillPackageStorageAdapter } from "./skill-package-storage";
/** Match the existing API/Web skill storage without exposing storage paths to the model. */
export function assistantSkillStorage() {
  return new LocalSkillPackageStorageAdapter(process.env.SKILL_PACKAGE_STORAGE_DIR ?? resolve(process.cwd(), "data", "skill-packages"), {
    maxObjectBytes: Number(process.env.SKILL_PACKAGE_MAX_OBJECT_BYTES) || 1_048_576,
  });
}
/** Tool snapshots omit provider credentials, internal connection configuration and large binary data. */
export function cleanAssistantToolData(value: unknown, preserveStructuredData = false): any {
  let remaining = 24_000;
  let nodes = 0;
  const clean = (item: unknown, schema = false): any => {
    if (++nodes > 2000 || remaining <= 0) return "[Truncated]";
    if (item instanceof Date) return item.toISOString();
    if (typeof item === "string") { const result = item.slice(0, Math.min(12_000, remaining)); remaining -= result.length; return result; }
    if (Array.isArray(item)) return item.slice(0, 50).map(field => clean(field, schema));
    if (!item || typeof item !== "object") return item;
    const binary = ["image", "audio"].includes((item as { type?: string }).type ?? "");
    return Object.fromEntries(Object.entries(item).filter(([key]) => schema || (!/^(?:config|headers|env|apiKey|apiKeyRef|encryptedApiKey|serviceToken|token|tokenHash|leaseHash|callerContext|storageObject|storageKeyPrefix|objectKey|contentBase64|repositories)$/i.test(key) && (key !== "data" || preserveStructuredData && !binary)))
      .map(([key, field]) => [key, clean(field, schema || key === "inputSchema")]));
  };
  return clean(value);
}

/** Only a completed deletion by this conversation's owner permits viewing an absent historical reference. */
export async function assistantDeletedReference(db: import("@task-weaver/db").Database, actions: Array<{ status: string; executionResult: unknown }>, kind: string, id: string) {
  if (!["document", "memory", "mcp"].includes(kind)) return false;
  const removed = actions.some(action => {
    const result = action.executionResult as { entityType?: string; entityId?: string; result?: { deleted?: boolean } } | null;
    return action.status === "succeeded" && result?.entityType === kind && result.entityId === id && result.result?.deleted === true;
  });
  if (!removed) return false;
  const { documents, memories, mcpServers } = await import("@task-weaver/db");
  const { eq } = await import("drizzle-orm");
  const table = kind === "document" ? documents : kind === "memory" ? memories : mcpServers;
  const rows = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return rows.length === 0;
}

export function redactAssistantValues(value: any, secrets: string[]): any {
  if (typeof value === "string") return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map(item => redactAssistantValues(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAssistantValues(item, secrets)]));
}
