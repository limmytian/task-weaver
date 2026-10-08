"use client";

import { useState, type FormEvent } from "react";
import {
  changeAccountPasswordSchema,
  provisionAccountSchema,
  reauthenticateAccountSchema,
} from "@task-weaver/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/trpc/client";
import {
  announceSessionChange,
  invalidateBrowserSession,
} from "@/lib/browser-session";
import { OneTimeSecret } from "@/components/one-time-secret";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { Input } from "@/components/ui/input";

export default function AccountPage() {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const current = trpc.auth.current.useQuery();
  const sessions = trpc.auth.sessions.useQuery();
  const admin = current.data?.account?.instanceRole === "admin";
  const accounts = trpc.auth.accounts.useQuery(undefined, { enabled: admin });
  const logout = trpc.auth.logout.useMutation();
  const password = trpc.auth.password.useMutation();
  const recent = trpc.auth.reauthenticate.useMutation();
  const revoke = trpc.auth.revokeSession.useMutation();
  const provision = trpc.auth.provision.useMutation();
  const recover = trpc.auth.recover.useMutation();
  const state = trpc.auth.accountState.useMutation();
  const [message, setMessage] = useState("");
  const [token, setToken] = useState<{
    activationToken: string;
    expiresAt: string;
  } | null>(null);
  const busy = [
    logout,
    password,
    recent,
    revoke,
    provision,
    recover,
    state,
  ].some((item) => item.isPending);
  async function perform(action: () => Promise<unknown>) {
    setMessage("");
    setToken(null);
    try {
      await action();
      await utils.auth.invalidate();
    } catch {
      setMessage(
        "Request denied or unavailable. Sensitive actions require a recent sign-in and current permission.",
      );
    } finally {
      logout.reset();
      password.reset();
      recent.reset();
      revoke.reset();
      provision.reset();
      recover.reset();
      state.reset();
      queryClient.getMutationCache().clear();
    }
  }
  async function submit(
    event: FormEvent<HTMLFormElement>,
    kind: "password" | "recent" | "provision",
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    await perform(async () => {
      if (kind === "password") {
        await password.mutateAsync(changeAccountPasswordSchema.parse(data));
        announceSessionChange();
        invalidateBrowserSession();
      } else if (kind === "recent") {
        await recent.mutateAsync(reauthenticateAccountSchema.parse(data));
        setMessage("Identity confirmed. Retry your sensitive action.");
      } else {
        const result = await provision.mutateAsync(
          provisionAccountSchema.parse(data),
        );
        setToken(result);
      }
    });
    form.reset();
  }
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold"><BrandMark className="h-6 w-6" />Account</h1>
          <p className="break-all text-sm text-muted-foreground">
            {current.data?.account?.displayName} ·{" "}
            {current.data?.account?.email}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await logout.mutateAsync();
              announceSessionChange();
              invalidateBrowserSession();
            })
          }
        >
          Sign out
        </Button>
      </header>
      <p className="break-all text-xs text-muted-foreground">
        Your stable actor ID: {current.data?.actor.id}
      </p>
      {message && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {message}
        </p>
      )}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Confirm your identity</h2>
        <p className="text-sm text-muted-foreground">
          Sensitive account and credential actions require a recent password
          confirmation.
        </p>
        <form
          onSubmit={(event) => void submit(event, "recent")}
          className="space-y-3"
        >
          <label className="text-sm font-medium" htmlFor="confirm-password">
            Current password
          </label>
          <Input
            id="confirm-password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            required
          />
          <Button disabled={busy}>Confirm identity</Button>
        </form>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Change password</h2>
        <p className="text-sm text-muted-foreground">
          Changing your password ends your sessions. Sign in again afterward.
        </p>
        <form
          onSubmit={(event) => void submit(event, "password")}
          className="space-y-3"
        >
          <label className="text-sm font-medium" htmlFor="current-password">
            Current password
          </label>
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            required
          />
          <label className="text-sm font-medium" htmlFor="new-password">
            New password (at least 12 characters)
          </label>
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
          <Button disabled={busy}>Change password</Button>
        </form>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your sessions</h2>
        {sessions.error && <p role="alert">Sessions are unavailable.</p>}
        {sessions.data
          ?.filter((item) => !item.revokedAt)
          .map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <p className="text-sm">
                {item.id === current.data?.session?.id
                  ? "This session"
                  : "Browser session"}{" "}
                · Expires {new Date(item.expiresAt).toLocaleString()}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await revoke.mutateAsync({ id: item.id });
                    if (item.id === current.data?.session?.id) {
                      announceSessionChange();
                      invalidateBrowserSession();
                    }
                  })
                }
              >
                End session
              </Button>
            </div>
          ))}
      </section>
      {admin && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Account administration</h2>
          <p className="text-sm text-muted-foreground">
            Instance administration does not grant access to project or personal
            content. Invitation and recovery tokens are private: deliver them to
            the intended person through a trusted channel.
          </p>
          <form
            onSubmit={(event) => void submit(event, "provision")}
            className="space-y-3"
          >
            <label className="text-sm font-medium" htmlFor="invite-email">
              Email
            </label>
            <Input
              id="invite-email"
              name="email"
              type="email"
              maxLength={320}
              required
            />
            <label className="text-sm font-medium" htmlFor="invite-name">
              Display name
            </label>
            <Input
              id="invite-name"
              name="displayName"
              maxLength={255}
              required
            />
            <Button disabled={busy}>Create invitation</Button>
          </form>
          {token && (
            <div className="space-y-2">
              <OneTimeSecret
                key={token.activationToken}
                value={token.activationToken}
                label="Private activation token (shown once)"
                onDismiss={() => setToken(null)}
              />
              <p className="text-sm">
                Expires {new Date(token.expiresAt).toLocaleString()}.
              </p>
            </div>
          )}
          {accounts.error && (
            <p role="alert">
              Account list requires current administrator permission and recent
              identity confirmation.
            </p>
          )}
          {accounts.data?.map((account) => (
            <div key={account.id} className="space-y-3 rounded-md border p-3">
              <p className="break-all font-medium">
                {account.displayName} · {account.email}
              </p>
              <p className="text-sm text-muted-foreground">
                {account.instanceRole} · {account.status}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy || account.status !== "active"}
                  onClick={() =>
                    void perform(async () => {
                      setToken(await recover.mutateAsync({ id: account.id }));
                    })
                  }
                >
                  Create recovery token
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || account.status !== "active"}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Change this account's instance administration role?",
                      )
                    )
                      void perform(() =>
                        state.mutateAsync({
                          id: account.id,
                          state: {
                            instanceRole:
                              account.instanceRole === "admin"
                                ? "user"
                                : "admin",
                          },
                        }),
                      );
                  }}
                >
                  Make{" "}
                  {account.instanceRole === "admin" ? "user" : "administrator"}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy || account.status !== "active"}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Disable this account and revoke its access?",
                      )
                    )
                      void perform(() =>
                        state.mutateAsync({
                          id: account.id,
                          state: { status: "disabled" },
                        }),
                      );
                  }}
                >
                  Disable account
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
