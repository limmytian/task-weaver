"use client";

import { createContext, useContext } from "react";
import { useRealtime } from "@/hooks/use-realtime";

const RealtimeContext = createContext<ReturnType<typeof useRealtime> | null>(null);

/** The authenticated layout owns exactly one stream; pages consume status only. */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const state = useRealtime();
  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeStatus() {
  const state = useContext(RealtimeContext);
  if (!state) throw new Error("Realtime status requires the authenticated layout provider");
  return state;
}
