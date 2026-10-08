"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/** Passwords travel directly to the transport, never through the mutation cache. */
export function useIdentityConfirmation() {
  const utils = trpc.useUtils();
  const formRef = useRef<HTMLFormElement | null>(null);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const attempt = useRef(0);
  const submitting = useRef(false);
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => {
    attempt.current++;
    pending.current?.(false);
    pending.current = null;
  }, []);
  function finish(confirmed: boolean) {
    formRef.current?.reset();
    attempt.current++;
    const resolve = pending.current;
    pending.current = null;
    setLabel(null);
    setError("");
    setBusy(false);
    submitting.current = false;
    resolve?.(confirmed);
  }
  function confirm(action: string): Promise<boolean> {
    if (pending.current) return Promise.resolve(false);
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLabel(action);
    setError("");
    return new Promise((resolve) => { pending.current = resolve; });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !pending.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const generation = attempt.current;
    const form = event.currentTarget;
    const request = { password: String(new FormData(form).get("password") ?? "") };
    form.reset();
    try {
      await utils.client.auth.reauthenticate.mutate(request);
      if (attempt.current === generation) finish(true);
    } catch {
      if (attempt.current === generation)
        setError("Identity confirmation failed. Check your password and try again.");
    } finally {
      request.password = "";
      if (attempt.current === generation) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  const dialog = (
    <Dialog open={label !== null} onOpenChange={(open) => { if (!open) finish(false); }}>
      <DialogContent onCloseAutoFocus={(event) => {
        event.preventDefault();
        trigger.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>Confirm your identity</DialogTitle>
          <DialogDescription>Enter your current password to continue: {label}.</DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={submit} className="space-y-4">
          <label htmlFor="action-confirm-password" className="text-sm font-medium">Current password</label>
          <Input id="action-confirm-password" name="password" type="password" autoComplete="current-password" maxLength={1024} required disabled={busy} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Confirming…" : "Confirm and continue"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
  return { confirm, dialog, confirming: label !== null };
}
