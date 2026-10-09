"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/trpc/routers/_app";
type RouterOutputs = inferRouterOutputs<AppRouter>;

type Model = RouterOutputs["assistant"]["listModels"][number];
const empty = { provider: "", model: "", baseUrl: "", label: "", credentialStatus: "unknown" as Model["credentialStatus"], enabled: true, isDefaultChat: false, isDefaultAgent: false };

export function ChatModelSettings({ compact = false }: { compact?: boolean }) {
  const utils = trpc.useUtils();
  const query = trpc.assistant.listModels.useQuery();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [draft, setDraft] = useState(empty);
  const [apiKey, setApiKey] = useState("");
  const refresh = () => utils.assistant.listModels.invalidate();
  const save = trpc.assistant.saveModel.useMutation({ onSuccess: () => { refresh(); setApiKey(""); setEditing(null); setDraft(empty); toast.success("Model settings saved"); }, onError: error => toast.error(error.message) });
  const remove = trpc.assistant.deleteModelKey.useMutation({ onSuccess: () => { refresh(); toast.success("API key deleted"); }, onError: error => toast.error(error.message) });
  const test = trpc.assistant.testModel.useMutation({ onSuccess: () => toast.success("Model connection succeeded"), onError: error => toast.error("Connection test failed", { description: error.message }) });
  const content = <div className="space-y-5">
    <p className="text-sm text-muted-foreground">Your models and keys belong to your account. Keys are encrypted and never displayed. Old environment references require key re-entry.</p>
    {query.isError && <p role="alert" className="text-destructive">{query.error.message}</p>}
    <div className="space-y-3">{query.data?.map(model => <div key={model.id} className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><strong>{model.label || model.model}</strong><Badge variant="secondary">{model.credentialStatus}</Badge>{model.isDefaultChat && <Badge>Default Chat</Badge>}{!model.enabled && <Badge variant="outline">Disabled</Badge>}</div>
      <p className="break-all text-xs text-muted-foreground">{model.provider} · {model.model} · {model.baseUrl || "Base URL required"}</p>
      <p className="mt-1 text-xs">{model.requiresKeyEntry ? "API key required — enter or replace it below." : `Saved API key: ${model.apiKeyMask}`}</p>
      <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { setEditing(model); setDraft({ provider: model.provider, model: model.model, baseUrl: model.baseUrl ?? "", label: model.label ?? "", credentialStatus: model.credentialStatus, enabled: model.enabled, isDefaultChat: model.isDefaultChat, isDefaultAgent: model.isDefaultAgent }); setApiKey(""); }}>Edit</Button>
        <Button size="sm" variant="outline" disabled={!model.hasApiKey || test.isPending} onClick={() => test.mutate({ id: model.id })}>Test connection</Button>
        <Button size="sm" variant="outline" disabled={!model.hasApiKey || remove.isPending} onClick={() => remove.mutate({ id: model.id })}>Delete key</Button>
      </div>
    </div>)}</div>
    <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); save.mutate({ ...draft, label: draft.label || null, apiKey: apiKey.trim() || undefined }); }}>
      <h3 className="font-medium">{editing ? "Edit saved model" : "Add model"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">{(["provider", "model", "baseUrl", "label"] as const).map(field => <label key={field} className="space-y-1 text-sm">{{ provider: "Provider", model: "Model", baseUrl: "Base URL", label: "Display name" }[field]}<Input required={field !== "label"} disabled={!!editing && (field === "provider" || field === "model")} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /></label>)}</div>
      <label className="block space-y-1 text-sm">API key<Input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={editing?.hasApiKey ? "Leave blank to preserve the saved key" : "Enter your provider API key"} /></label>
      <label className="flex items-center gap-2 text-sm">Credentials<select value={draft.credentialStatus} onChange={event => setDraft({ ...draft, credentialStatus: event.target.value as Model["credentialStatus"] })} className="rounded border bg-background p-2">{["unknown", "valid", "invalid", "missing"].map(status => <option key={status}>{status}</option>)}</select></label>
      <p className="text-xs text-muted-foreground">Unknown allows Chat with a saved key. Invalid or missing requires you to review the key.</p>
      <div className="flex flex-wrap gap-3">{(["enabled", "isDefaultChat"] as const).map(field => <label key={field} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.checked })} />{{ enabled: "Enabled", isDefaultChat: "Default Chat", isDefaultAgent: "Default task model" }[field]}</label>)}</div>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={save.isPending} onClick={() => { setDraft(empty); setEditing(null); setApiKey(""); }}>Cancel edits</Button><Button type="submit" disabled={save.isPending}>{editing ? "Save changes" : "Save model"}</Button></div>
    </form>
  </div>;
  if (!compact) return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />Personal models and keys</CardTitle></CardHeader><CardContent>{content}</CardContent></Card>;
  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setApiKey(""); }}><DialogTrigger asChild><Button size="icon" variant="ghost" aria-label="Personal model settings"><KeyRound className="h-4 w-4" /></Button></DialogTrigger><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Personal models and keys</DialogTitle><DialogDescription>Configure your Chat provider and encrypted API key.</DialogDescription></DialogHeader>{content}</DialogContent></Dialog>;
}
