"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  accountLoginSchema,
  activateAccountSchema,
  bootstrapAccountSchema,
} from "@task-weaver/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/trpc/client";
import { announceSessionChange } from "@/lib/browser-session";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Input } from "@/components/ui/input";

type Mode = "login" | "activate" | "bootstrap";
export default function LoginPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("login");
  const [error, setError] = useState("");
  const login = trpc.auth.login.useMutation();
  const activate = trpc.auth.activate.useMutation();
  const bootstrap = trpc.auth.bootstrap.useMutation();
  const setup = trpc.auth.setupStatus.useQuery(undefined, {
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: 15_000,
  });
  const canSetup = !setup.isFetching && !setup.isError && setup.data?.initialized === false;
  useEffect(() => {
    if (mode === "bootstrap" && (setup.isError || setup.data?.initialized)) setMode("login");
  }, [mode, setup.isError, setup.data?.initialized]);
  const busy = login.isPending || activate.isPending || bootstrap.isPending;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      if (mode === "login") {
        await login.mutateAsync(accountLoginSchema.parse(data));
        form.reset();
        announceSessionChange();
        window.location.replace("/projects");
      } else {
        if (mode === "activate")
          await activate.mutateAsync(activateAccountSchema.parse(data));
        else {
          const status = await setup.refetch();
          if (status.error || status.data?.initialized !== false)
            throw new Error("First setup is unavailable");
          await bootstrap.mutateAsync(bootstrapAccountSchema.parse(data));
          await setup.refetch();
        }
        form.reset();
        setMode("login");
      }
    } catch {
      if (mode === "bootstrap") void setup.refetch();
      // Provider and validation errors may contain credentials; display fixed text only.
      setError(
        "Unable to complete this request. Check your details or contact your administrator.",
      );
      form.reset();
    } finally {
      login.reset();
      activate.reset();
      bootstrap.reset();
      queryClient.getMutationCache().clear();
    }
  }
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold"><BrandMark className="h-10 w-10" />Task Weaver</div>
        <ThemeToggle />
      </div>
      <div>
        <h1 className="text-2xl font-semibold">
          {mode === "login"
            ? "Sign in to Task Weaver"
            : mode === "activate"
              ? "Activate your account"
              : "Set up the first administrator"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "login"
            ? "Accounts are provided by your instance administrator. Public registration is closed."
            : mode === "activate"
              ? "Use the private invitation or recovery token provided by your administrator."
              : "For a new instance only. Obtain the bootstrap secret from your deployment administrator."}
        </p>
      </div>
      {mode === "login" && setup.isError && (
        <p role="status" className="text-sm text-muted-foreground">
          Instance setup status is unavailable. You can still sign in.
        </p>
      )}
      <form key={mode} onSubmit={submit} className="space-y-4">
        {mode !== "activate" && (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              maxLength={320}
              required
            />
          </div>
        )}
        {mode === "bootstrap" && (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="displayName">
              Display name
            </label>
            <Input
              id="displayName"
              name="displayName"
              autoComplete="name"
              maxLength={255}
              required
            />
          </div>
        )}
        {mode !== "login" && (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="secret">
              {mode === "activate"
                ? "Invitation or recovery token"
                : "Bootstrap secret"}
            </label>
            <Input
              id="secret"
              name={mode === "activate" ? "token" : "bootstrapSecret"}
              type="password"
              autoComplete="off"
              required
            />
          </div>
        )}
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="password">
            Password{mode !== "login" && " (at least 12 characters)"}
          </label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            minLength={mode === "login" ? 1 : 12}
            maxLength={mode === "login" ? 1024 : 128}
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || (mode === "bootstrap" && !canSetup)} className="w-full">
          {busy
            ? "Please wait…"
            : mode === "login"
              ? "Sign in"
              : "Save account"}
        </Button>
      </form>
      <nav aria-label="Account access" className="flex flex-wrap gap-2">
        {(["login", "activate", "bootstrap"] as const)
          .filter((item) => item !== mode && (item !== "bootstrap" || canSetup))
          .map((item) => (
            <Button
              key={item}
              variant={item === "activate" ? "outline" : "link"}
              disabled={busy}
              onClick={() => {
                setMode(item);
                setError("");
              }}
            >
              {item === "login"
                ? "Back to sign in"
                : item === "activate"
                  ? "Use invitation / recovery token"
                  : "First instance setup"}
            </Button>
          ))}
      </nav>
    </main>
  );
}
