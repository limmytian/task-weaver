import type { Actor } from "./types";

/**
 * Resolve legacy audit attribution only. This does not authenticate a caller.
 * @deprecated Replace in transport adapters with the shared verified resolver during auth activation.
 * Never use this result to construct a VerifiedRequestContext.
 */
export function resolveActor(headers: Readonly<Record<string, string | undefined>>): Actor {
  return { id: headers["x-actor-id"] || "anonymous",
    type: headers["x-actor-type"] === "agent" ? "agent" : "human" };
}
