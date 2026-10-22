import { createHash } from "node:crypto";

/** Deterministic across object-key order and host locale; arrays retain their order. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)])) : item;
  return JSON.stringify(canonical(value));
}

export function capabilityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
