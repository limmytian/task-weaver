"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Actor } from "@task-weaver/contracts";

const WebIdentityContext = createContext<Actor | null>(null);

export function WebIdentityProvider({
  actor,
  children,
}: {
  actor: Actor;
  children: ReactNode;
}) {
  return <WebIdentityContext.Provider value={actor}>{children}</WebIdentityContext.Provider>;
}

export function useWebIdentity(): Actor {
  const actor = useContext(WebIdentityContext);
  if (!actor) throw new Error("useWebIdentity must be used inside WebIdentityProvider");
  return actor;
}
