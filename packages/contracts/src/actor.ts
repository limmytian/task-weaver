import type { Actor } from "./types";

/** Resolve the existing single-instance trusted-header actor convention. */
export function resolveActor(headers: Readonly<Record<string, string | undefined>>): Actor {
  return { id: headers["x-actor-id"] || "anonymous",
    type: headers["x-actor-type"] === "agent" ? "agent" : "human" };
}
