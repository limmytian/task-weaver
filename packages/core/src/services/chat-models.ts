import { and, desc, eq } from "drizzle-orm";
import { tiAgentModelConfigs, activityLog, type Database } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, ChatConfigurationError, saveChatModelSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resourceAuthority, requireScope } from "./resource-authorization";
import { lockIdentityLifecycle } from "./auth-security";
import { chatKeyBinding, encryptChatKey, decryptChatKey } from "./chat-credentials";
import { chatEndpoint, requestChatConnection } from "./chat-endpoint";

function modelKey(config: Config) {
  return config.encryptedApiKey ? decryptChatKey(config.encryptedApiKey, chatKeyBinding(config)) : "";
}

type Config = typeof tiAgentModelConfigs.$inferSelect;
function publicModel(row: Config) {
  return { id: row.id, provider: row.provider, model: row.model, baseUrl: row.baseUrl, label: row.label,
    credentialStatus: row.credentialStatus, enabled: row.enabled, isDefaultChat: row.isDefaultChat,
    isDefaultAgent: row.isDefaultAgent, hasApiKey: !!row.encryptedApiKey, apiKeyMask: row.encryptedApiKey ? row.apiKeyMask : null,
    requiresKeyEntry: false };
}
export function createChatModelService(identity: VerifiedRequestContext) {
  async function authorize(db: Database, permission: "resource.read" | "resource.write" | "credential.manage" = "resource.read") {
    const live = await resourceAuthority(db, identity);
    if (live.bounds || live.actor.type !== "human") throw new AuthorizationError();
    requireScope(live, { personalOwnerId: live.actor.id, personalOwnerType: "human" }, permission);
    return live.actor.id;
  }
  async function get(db: Database, id: string) {
    const ownerId = await authorize(db);
    const row = await db.query.tiAgentModelConfigs.findFirst({ where: and(eq(tiAgentModelConfigs.id, id), eq(tiAgentModelConfigs.ownerId, ownerId), eq(tiAgentModelConfigs.ownerType, "human")) });
    if (!row) throw new NotFoundError("Chat model not found");
    return row;
  }
  return {
    async list(db: Database) {
      const ownerId = await authorize(db);
      return (await db.query.tiAgentModelConfigs.findMany({ where: and(eq(tiAgentModelConfigs.ownerId, ownerId), eq(tiAgentModelConfigs.ownerType, "human")), orderBy: desc(tiAgentModelConfigs.updatedAt) })).map(publicModel);
    },
    async save(db: Database, value: unknown) {
      const input = saveChatModelSchema.parse(value);
      if (input.baseUrl) chatEndpoint(input.baseUrl);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const txDb = tx as unknown as Database;
        const ownerId = await authorize(txDb, "resource.write");
        if (input.apiKey) await authorize(txDb, "credential.manage");
        const encryptedApiKey = input.apiKey ? encryptChatKey(input.apiKey, chatKeyBinding({ ownerId, ...input })) : undefined;
        const patch = { ...input, credentialStatus: input.credentialStatus ?? (input.apiKey ? "unknown" as const : undefined), apiKey: undefined, apiKeyRef: null, encryptedApiKey,
          apiKeyMask: input.apiKey ? "••••••••" : undefined, updatedAt: new Date() };
        // Plaintext is never passed to the database, audit log or return value.
        const { apiKey: _apiKey, ...stored } = patch;
        if (input.isDefaultChat) await tx.update(tiAgentModelConfigs).set({ isDefaultChat: false }).where(and(eq(tiAgentModelConfigs.ownerId, ownerId), eq(tiAgentModelConfigs.ownerType, "human")));
        if (input.isDefaultAgent) await tx.update(tiAgentModelConfigs).set({ isDefaultAgent: false }).where(and(eq(tiAgentModelConfigs.ownerId, ownerId), eq(tiAgentModelConfigs.ownerType, "human")));
        const [row] = await tx.insert(tiAgentModelConfigs).values({ ownerId, ownerType: "human", ...stored })
          .onConflictDoUpdate({ target: [tiAgentModelConfigs.ownerId, tiAgentModelConfigs.ownerType, tiAgentModelConfigs.provider, tiAgentModelConfigs.model], set: stored }).returning();
        await tx.insert(activityLog).values({ entityType: "ti_agent_model_config", entityId: row!.id, action: "personal_chat_model_saved", actorId: ownerId, actorType: "human", metadata: { credentialReplaced: !!input.apiKey } });
        return publicModel(row!);
      });
    },
    async deleteKey(db: Database, id: string) {
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const txDb = tx as unknown as Database;
        const ownerId = await authorize(txDb, "credential.manage");
        await get(txDb, id);
        await tx.update(tiAgentModelConfigs).set({ encryptedApiKey: null, apiKeyMask: null, apiKeyRef: null, credentialStatus: "missing", updatedAt: new Date() }).where(eq(tiAgentModelConfigs.id, id));
        await tx.insert(activityLog).values({ entityType: "ti_agent_model_config", entityId: id, action: "personal_chat_key_deleted", actorId: ownerId, actorType: "human" });
        return { deleted: true };
      });
    },
    async test(db: Database, id: string) {
      const config = await get(db, id);
      const key = modelKey(config);
      if (!config.baseUrl) throw new ChatConfigurationError("chat_url_required");
      await requestChatConnection(config.baseUrl, key, config.model);
      return { connected: true };
    },
    async resolve(db: Database, provider?: string | null, model?: string | null) {
      const ownerId = await authorize(db);
      const rows = await db.query.tiAgentModelConfigs.findMany({ where: and(eq(tiAgentModelConfigs.ownerId, ownerId), eq(tiAgentModelConfigs.ownerType, "human")) });
      const config = provider || model ? rows.find(row => row.provider === provider && row.model === model) : rows.find(row => row.isDefaultChat);
      if (!config || !config.enabled) throw new ChatConfigurationError("chat_model_required");
      if (!config.baseUrl) throw new ChatConfigurationError("chat_url_required");
      return { config, apiKey: modelKey(config) };
    },
  };
}
