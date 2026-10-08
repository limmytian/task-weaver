"use client";

import Link from "next/link";
import { useState } from "react";
import { UserRound } from "lucide-react";
import { trpc } from "@/trpc/client";
import { announceSessionChange, invalidateBrowserSession } from "@/lib/browser-session";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccountMenu() {
  const current = trpc.auth.current.useQuery();
  const name = current.data?.account?.displayName ?? "Account";
  const logout = trpc.auth.logout.useMutation();
  const [error, setError] = useState("");
  async function signOut() {
    if (logout.isPending) return;
    setError("");
    try {
      await logout.mutateAsync();
      announceSessionChange();
      invalidateBrowserSession();
    } catch {
      setError("Sign out failed. Try again.");
    } finally {
      logout.reset();
    }
  }
  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="w-full justify-start" aria-label="Account menu" disabled={logout.isPending}>
            <UserRound className="h-4 w-4 shrink-0" />
            <span className="truncate group-data-[collapsible=icon]:hidden">{logout.isPending ? "Signing out…" : name}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel className="max-w-64 truncate">{name}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><Link href="/projects/settings/account">Account settings</Link></DropdownMenuItem>
          <DropdownMenuItem disabled={logout.isPending} onSelect={() => void signOut()}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
