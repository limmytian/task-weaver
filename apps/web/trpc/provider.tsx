"use client";

import { useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./client";
import { invalidateBrowserSession } from "@/lib/browser-session";

function handleAuthenticationError(error: unknown) {
  if (
    typeof window === "undefined" ||
    !window.location.pathname.startsWith("/projects")
  )
    return;
  if (
    error &&
    typeof error === "object" &&
    "data" in error &&
    (error.data as { code?: string } | undefined)?.code === "UNAUTHORIZED"
  )
    invalidateBrowserSession();
}

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleAuthenticationError }),
        mutationCache: new MutationCache({
          onError: handleAuthenticationError,
        }),
        defaultOptions: {
          queries: {
            staleTime: 5 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [trpcClient] = useState(() => {
    let challenge: Promise<string> | undefined;
    let challengeExpires = 0;
    return trpc.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          async fetch(url, options) {
            const headers = new Headers(options?.headers);
            if (options?.method === "POST") {
              if (!challenge || Date.now() >= challengeExpires) {
                challengeExpires = Date.now() + 30 * 60_000;
                challenge = fetch(`${getBaseUrl()}/api/auth/csrf`, {
                  credentials: "same-origin",
                  cache: "no-store",
                })
                  .then(async (response) => {
                    if (!response.ok)
                      throw new Error("Sign-in protection is unavailable");
                    const body = (await response.json()) as {
                      csrfToken: string;
                      expiresAt: string;
                    };
                    challengeExpires = Math.min(
                      challengeExpires,
                      Date.parse(body.expiresAt) - 60_000,
                    );
                    return body.csrfToken;
                  })
                  .catch((error) => {
                    challenge = undefined;
                    throw error;
                  });
              }
              headers.set("x-csrf-token", await challenge);
            }
            const response = await fetch(url, {
              ...options,
              headers,
              credentials: "same-origin",
              cache: "no-store",
            });
            if (
              response.status === 401 &&
              typeof window !== "undefined" &&
              window.location.pathname.startsWith("/projects")
            ) {
              queryClient.clear();
              invalidateBrowserSession();
            }
            return response;
          },
        }),
      ],
    });
  });

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
