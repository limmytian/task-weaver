import { createPublicKey, verify } from "node:crypto";
import { pluginManifestSchema, ValidationError, type PluginManifest } from "@task-weaver/contracts";
import { capabilityDigest } from "./capability-digest";

export type PluginTrustKey = { publisher: string; publicKey: string };

/** Sign the normalized manifest without its signature; artifact hashes bind original bytes. */
export function pluginSigningPayload(manifest: PluginManifest) {
  const { signature: _signature, ...payload } = pluginManifestSchema.parse(manifest);
  return capabilityDigest(payload);
}

export function verifyPluginManifest(raw: unknown, keys: Readonly<Record<string, PluginTrustKey>>, allowUnverified = false) {
  const manifest = pluginManifestSchema.parse(raw);
  const manifestHash = capabilityDigest(manifest);
  if (!manifest.signature) {
    if (!allowUnverified) throw new ValidationError("Plugin publisher verification is required");
    return { manifest, manifestHash, trust: "unverified" as const };
  }
  const trusted = Object.hasOwn(keys, manifest.signature.keyId) ? keys[manifest.signature.keyId] : undefined;
  if (!trusted || trusted.publisher !== manifest.pluginId.split("/")[0]) throw new ValidationError("Plugin signing key is untrusted or belongs to another publisher");
  try {
    const key = createPublicKey(trusted.publicKey);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(pluginSigningPayload(manifest), "utf8"), key, Buffer.from(manifest.signature.value, "base64"))) throw new Error("Invalid publisher signature");
  } catch { throw new ValidationError("Plugin publisher signature verification failed"); }
  return { manifest, manifestHash, trust: "verified" as const, publisherKeyId: manifest.signature.keyId };
}
