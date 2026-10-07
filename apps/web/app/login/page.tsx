"use client";

import { useState, type FormEvent } from "react";
import {
  accountLoginSchema,
  activateAccountSchema,
  bootstrapAccountSchema,
} from "@task-weaver/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/trpc/client";
import { announceSessionChange } from "@/lib/browser-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Mode = "login" | "activate" | "bootstrap";
export default function LoginPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("login");
  const [error, setError] = useState("");
  const login = trpc.auth.login.useMutation();
  const activate = trpc.auth.activate.useMutation();
  const bootstrap = trpc.auth.bootstrap.useMutation();
  const busy = login.isPending || activate.isPending || bootstrap.isPending;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      if (mode === "login") {
        const { sessionDurationSeconds, ...credentials } = data;
        await login.mutateAsync(
          accountLoginSchema.parse({
            ...credentials,
            ...(sessionDurationSeconds
              ? { sessionDurationSeconds: Number(sessionDurationSeconds) }
              : {}),
          }),
        );
        form.reset();
        announceSessionChange();
        window.location.replace("/projects");
      } else {
        if (mode === "activate")
          await activate.mutateAsync(activateAccountSchema.parse(data));
        else await bootstrap.mutateAsync(bootstrapAccountSchema.parse(data));
        form.reset();
        setMode("login");
      }
    } catch {
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
        {mode === "login" && (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="session-duration">
              Session lifetime
            </label>
            <select
              id="session-duration"
              name="sessionDurationSeconds"
              defaultValue=""
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">Instance default</option>
              <option value={30 * 86400}>30 days</option>
              <option value={90 * 86400}>90 days</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Subject to the instance maximum and idle timeout. Sessions remain
              revocable.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {busy
            ? "Please wait…"
            : mode === "login"
              ? "Sign in"
              : "Save account"}
        </Button>
      </form>
      <nav aria-label="Account access" className="flex flex-wrap gap-2">
        {(["login", "activate", "bootstrap"] as const)
          .filter((item) => item !== mode)
          .map((item) => (
            <Button
              key={item}
              variant="link"
              onClick={() => {
                setMode(item);
                setError("");
              }}
            >
              {item === "login"
                ? "Sign in"
                : item === "activate"
                  ? "Use invitation / recovery token"
                  : "First instance setup"}
            </Button>
          ))}
      </nav>
    </main>
  );
}
