"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/trpc/client";
import {
  invalidateBrowserSession,
  SESSION_INVALIDATED_EVENT,
} from "@/lib/browser-session";
import type { Actor } from "@task-weaver/contracts";

const WebIdentityContext = createContext<Actor | null>(null);

export function WebIdentityProvider({
  actor,
  children,
}: {
  actor: Actor;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [ended, setEnded] = useState(false);
  const current = trpc.auth.current.useQuery(undefined, {
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  useEffect(() => {
    const end = () => {
      setEnded(true);
      void queryClient.cancelQueries();
      queryClient.clear();
    };
    const hide = () => {
      // Empty protected DOM before the browser can preserve a back/forward snapshot.
      flushSync(() => setEnded(true));
      window.dispatchEvent(new Event(SESSION_INVALIDATED_EVENT));
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", restore);
    window.addEventListener(SESSION_INVALIDATED_EVENT, end);
    const channel = new BroadcastChannel("tw-session");
    channel.onmessage = () => {
      end();
      invalidateBrowserSession();
    };
    return () => {
      channel.close();
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", restore);
      window.removeEventListener(SESSION_INVALIDATED_EVENT, end);
    };
  }, [queryClient]);
  useEffect(() => {
    if (current.data && current.data.actor.id !== actor.id)
      invalidateBrowserSession();
  }, [current.data, actor.id]);
  useEffect(() => {
    const expiry = current.data?.session?.expiresAt;
    if (!expiry) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = Date.parse(expiry) - Date.now();
      if (remaining <= 0) invalidateBrowserSession();
      else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [current.data?.session?.expiresAt]);
  if (ended || (current.data && current.data.actor.id !== actor.id))
    return null;
  return (
    <WebIdentityContext.Provider value={actor}>
      {children}
    </WebIdentityContext.Provider>
  );
}

export function useWebIdentity(): Actor {
  const actor = useContext(WebIdentityContext);
  if (!actor)
    throw new Error("useWebIdentity must be used inside WebIdentityProvider");
  return actor;
}
