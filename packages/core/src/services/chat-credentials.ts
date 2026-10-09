import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ChatConfigurationError } from "@task-weaver/contracts";

function currentKey() {
  const id = process.env.TW_CHAT_CREDENTIAL_KEY_ID ?? "primary";
  const value = process.env.TW_CHAT_CREDENTIAL_MASTER_KEY;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new ChatConfigurationError("chat_encryption_unavailable");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new ChatConfigurationError("chat_encryption_unavailable");
  return { id, key };
}
export function encryptChatKey(secret: string, binding: string) {
  const { id, key } = currentKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", id, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
export function decryptChatKey(envelope: string | null, binding: string) {
  if (!envelope) throw new ChatConfigurationError("chat_key_required");
  try {
    const [version, id, nonce, tag, ciphertext, extra] = envelope.split(".");
    const current = currentKey();
    const previous = JSON.parse(process.env.TW_CHAT_CREDENTIAL_PREVIOUS_KEYS ?? "{}") as Record<string, string>;
    const key = id === current.id ? current.key : Buffer.from(previous[id!] ?? "", "base64");
    if (version !== "v1" || extra || key.length !== 32 || !nonce || !tag || !ciphertext) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new ChatConfigurationError("chat_key_unreadable");
  }
}
export function chatKeyBinding(config: { ownerId: string; provider: string; model: string }) {
  return JSON.stringify(["chat-key-v1", config.ownerId, "human", config.provider, config.model]);
}
