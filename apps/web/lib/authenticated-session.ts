import { AuthenticationError, type AuthenticationRuntime } from "@task-weaver/core";

/** SSR renders a human browser session only; identity headers and bearer Agent keys confer no UI identity. */
export async function resolveWebSession(headers: Headers, auth: AuthenticationRuntime) {
  auth.assertOrigin(headers);
  const identity = await auth.verify(headers);
  if (identity.credential.kind !== "session" || identity.actor.type !== "human")
    throw new AuthenticationError();
  return { id: identity.actor.id, type: identity.actor.type };
}
