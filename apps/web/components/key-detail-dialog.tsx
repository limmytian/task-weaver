"use client";
import { useState } from "react";
import { trpc } from "@/trpc/client";
import { useIdentityConfirmation } from "@/components/identity-confirmation";
import { KeyGrantPicker, grantId, type NamedGrant } from "@/components/key-grant-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
export function KeyDetailDialog({ actorId, id, onClose }: { actorId: string; id: string; onClose: () => void }) {
  const detail = trpc.apiKey.detail.useQuery({ actorId, id }, { retry: false });
  const update = trpc.apiKey.updateGrants.useMutation();
  const confirmation = useIdentityConfirmation();
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<{ version: number; items: NamedGrant[] } | null>(null);
  const [error, setError] = useState("");
  const key = detail.data;
  const busy = update.isPending || confirmation.confirming;
  async function save() {
    if (!draft || !(await confirmation.confirm("update Key grants and invalidate existing derived authority"))) return;
    try {
      await update.mutateAsync({ actorId, id, expectedVersion: draft.version, grants: draft.items.map(item => item.grant) });
      setDraft(null); setError("");
      await utils.apiKey.invalidate();
    } catch {
      setError("Save denied, stale, or unavailable. Refresh to review the latest grants and current authority before retrying.");
    }
  }
  return <>{confirmation.dialog}<Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <DialogTitle>Key details and grants</DialogTitle><DialogDescription>Raw Key material is shown only at issuance. Each actual saved grant change permanently invalidates existing descendant Keys and execution delegations.</DialogDescription>
    {detail.isLoading && <p>Loading Key…</p>}{detail.error && <p role="alert">Key unavailable or access denied.</p>}
    {key && <><p className="font-medium">{key.name}</p><p className="break-all text-sm">Subject: {key.subjectName} · {key.actorId}</p><p className="text-sm">Status: {key.revokedAt ? "Revoked" : key.expiresAt && new Date(key.expiresAt) <= new Date() ? "Expired" : "Active"} · Version {key.grantVersion}<br />Expiry: {key.expiresAt ? new Date(key.expiresAt).toLocaleString() : "None"}</p>
      {!draft ? <><ul className="space-y-2 text-sm">{key.namedGrants.map(item => <li key={grantId(item.grant)} className="break-words">{item.label} <span className="break-all text-xs">({grantId(item.grant)})</span>: {item.grant.permissions.join(", ")}</li>)}</ul><Button disabled={busy || !!key.revokedAt || !!key.expiresAt && new Date(key.expiresAt) <= new Date()} onClick={() => setDraft({ version: key.grantVersion, items: key.namedGrants })}>Edit grants</Button></> : <>
        <KeyGrantPicker actorId={actorId} selected={draft.items} disabled={busy} onChange={items => setDraft({ ...draft, items })} />
        <div className="rounded-md border p-3 text-xs"><p>Before: {key.grants.length} scopes, {key.grants.reduce((sum, grant) => sum + grant.permissions.length, 0)} permissions</p><p>After: {draft.items.length} scopes, {draft.items.reduce((sum, item) => sum + item.grant.permissions.length, 0)} permissions</p><p>Changed scopes and permissions:</p><ul>{[...new Map([...key.namedGrants, ...draft.items].map(item => [grantId(item.grant), item])).values()].filter(item => JSON.stringify(key.grants.find(grant => grantId(grant) === grantId(item.grant))) !== JSON.stringify(draft.items.find(value => grantId(value.grant) === grantId(item.grant))?.grant)).map(item => <li className="break-words" key={grantId(item.grant)}>{item.label}: {key.grants.find(grant => grantId(grant) === grantId(item.grant))?.permissions.join(", ") ?? "none"} → {draft.items.find(value => grantId(value.grant) === grantId(item.grant))?.grant.permissions.join(", ") ?? "removed"}</li>)}</ul></div>
        <div className="flex gap-2"><Button disabled={busy || !draft.items.length || draft.items.length > 100} onClick={() => void save()}>Save grants</Button><Button variant="outline" disabled={busy} onClick={() => { setDraft(null); setError(""); }}>Cancel editing</Button></div>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}<Button variant="outline" disabled={busy} onClick={async () => { setDraft(null); setError(""); await detail.refetch(); }}>Refresh latest Key</Button>
  </DialogContent></Dialog></>;
}
