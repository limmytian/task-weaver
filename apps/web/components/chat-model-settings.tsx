"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/trpc/routers/_app";
type RouterOutputs = inferRouterOutputs<AppRouter>;

type Model = RouterOutputs["assistant"]["listModels"][number];
const empty = { provider: "", model: "", baseUrl: "", label: "", proxyMode: "inherit" as Model["proxyMode"], proxyUrl: "", credentialStatus: "unknown" as Model["credentialStatus"], enabled: true, isDefaultChat: false, isDefaultAgent: false };

export function ChatModelSettings({ compact = false }: { compact?: boolean }) {
  const utils = trpc.useUtils();
  const query = trpc.assistant.listModels.useQuery();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [draft, setDraft] = useState(empty);
  const [apiKey, setApiKey] = useState("");
  const [confirmEndpoint, setConfirmEndpoint] = useState(false);
  const [skipEndpointWarning, setSkipEndpointWarning] = useState(false);
  const warningPreference = "task-weaver:chat-model-endpoint-warning-disabled";
  const persistModel = () => save.mutate({ ...draft, label: draft.label || null, proxyUrl: draft.proxyMode === "custom" ? draft.proxyUrl.trim() : null, apiKey: apiKey.trim() || undefined });
  const submitModel = () => {
    try { if (localStorage.getItem(warningPreference) === "true") { persistModel(); return; } } catch { /* Confirmation remains available without local storage. */ }
    setSkipEndpointWarning(false);
    setConfirmEndpoint(true);
  };
  const refresh = () => utils.assistant.listModels.invalidate();
  const save = trpc.assistant.saveModel.useMutation({ onSuccess: () => { refresh(); setApiKey(""); setEditing(null); setDraft(empty); toast.success("Model settings saved"); }, onError: error => toast.error(error.message) });
  const remove = trpc.assistant.deleteModelKey.useMutation({ onSuccess: () => { refresh(); toast.success("API key deleted"); }, onError: error => toast.error(error.message) });
  const test = trpc.assistant.testModel.useMutation({ onSuccess: () => toast.success("Model connection succeeded"), onError: error => toast.error("Connection test failed", { description: error.message }) });
  const content = <div className="space-y-5">
    <AlertDialog open={confirmEndpoint} onOpenChange={setConfirmEndpoint}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Use this model endpoint?</AlertDialogTitle>
        <AlertDialogDescription>The server will connect to the address you configured, including local network addresses. A custom proxy will also carry these requests. HTTP does not encrypt messages or API keys in transit. Only use a server you trust.</AlertDialogDescription>
      </AlertDialogHeader><p className="break-all text-sm">{draft.baseUrl}{draft.proxyMode === "custom" && <> · Proxy: {draft.proxyUrl}</>}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={skipEndpointWarning} onChange={event => setSkipEndpointWarning(event.target.checked)} />Don’t show again on this device</label>
        <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => {
          if (skipEndpointWarning) { try { localStorage.setItem(warningPreference, "true"); } catch { /* Save is independent of browser storage availability. */ } }
          persistModel();
        }}>Confirm and save</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <p className="text-sm text-muted-foreground">Your models and keys belong to your account. Keys are encrypted and never displayed. API keys are optional. Leave the key blank if your server does not require one, then test the connection. Deployment keys are not imported.</p>
    {query.isError && <p role="alert" className="text-destructive">{query.error.message}</p>}
    <div className="space-y-3">{query.data?.map(model => <div key={model.id} className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><strong>{model.label || model.model}</strong><Badge variant="secondary">{model.credentialStatus}</Badge>{model.isDefaultChat && <Badge>Default Chat</Badge>}{!model.enabled && <Badge variant="outline">Disabled</Badge>}</div>
      <p className="break-all text-xs text-muted-foreground">{model.provider} · {model.model} · {model.baseUrl || "Base URL required"}</p>
      <p className="mt-1 text-xs text-muted-foreground">Proxy: {model.proxyMode === "custom" ? model.proxyUrl : model.proxyMode === "direct" ? "Direct connection" : "Deployment default"}</p>
      <p className="mt-1 text-xs">{model.hasApiKey ? `Saved API key: ${model.apiKeyMask}` : "No API key saved — test the connection to check whether your server requires one."}</p>
      <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { setEditing(model); setDraft({ provider: model.provider, model: model.model, baseUrl: model.baseUrl ?? "", label: model.label ?? "", proxyMode: model.proxyMode, proxyUrl: model.proxyUrl ?? "", credentialStatus: model.credentialStatus, enabled: model.enabled, isDefaultChat: model.isDefaultChat, isDefaultAgent: model.isDefaultAgent }); setApiKey(""); }}>Edit</Button>
        <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate({ id: model.id })}>Test connection</Button>
        <Button size="sm" variant="outline" disabled={!model.hasApiKey || remove.isPending} onClick={() => remove.mutate({ id: model.id })}>Delete key</Button>
      </div>
    </div>)}</div>
    <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); submitModel(); }}>
      <h3 className="font-medium">{editing ? "Edit saved model" : "Add model"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">{(["provider", "model", "baseUrl", "label"] as const).map(field => <label key={field} className="space-y-1 text-sm">{{ provider: "Provider", model: "Model", baseUrl: "Base URL", label: "Display name" }[field]}<Input required={field !== "label"} disabled={!!editing && (field === "provider" || field === "model")} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /></label>)}</div>
      <label className="block space-y-1 text-sm">Proxy<select className="ml-2 rounded border bg-background p-2" value={draft.proxyMode} onChange={event => setDraft({ ...draft, proxyMode: event.target.value as Model["proxyMode"] })}>
        <option value="inherit">Use deployment default</option><option value="direct">Direct connection</option><option value="custom">Custom proxy</option>
      </select></label>
      {draft.proxyMode === "custom" && <label className="block space-y-1 text-sm">Proxy URL<Input required type="url" placeholder="http://proxy.example.com:7890" value={draft.proxyUrl} onChange={event => setDraft({ ...draft, proxyUrl: event.target.value })} /></label>}
      <p className="text-xs text-muted-foreground">The server uses this setting for connection tests and all replies. A custom proxy overrides deployment bypass rules. Direct connection bypasses deployment proxies.</p>
      <label className="block space-y-1 text-sm">API key (optional)<Input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={editing?.hasApiKey ? "Leave blank to preserve the saved key" : "Leave blank if your server does not require a key"} /></label>
      <label className="flex items-center gap-2 text-sm">Credentials<select value={draft.credentialStatus} onChange={event => setDraft({ ...draft, credentialStatus: event.target.value as Model["credentialStatus"] })} className="rounded border bg-background p-2">{["unknown", "valid", "invalid", "missing"].map(status => <option key={status}>{status}</option>)}</select></label>
      <p className="text-xs text-muted-foreground">Credential status is informational. Test the connection to verify whether your server accepts the saved settings.</p>
      <div className="flex flex-wrap gap-3">{(["enabled", "isDefaultChat"] as const).map(field => <label key={field} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.checked })} />{{ enabled: "Enabled", isDefaultChat: "Default Chat", isDefaultAgent: "Default task model" }[field]}</label>)}</div>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={save.isPending} onClick={() => { setDraft(empty); setEditing(null); setApiKey(""); }}>Cancel edits</Button><Button type="submit" disabled={save.isPending}>{editing ? "Save changes" : "Save model"}</Button></div>
    </form>
  </div>;
  if (!compact) return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />Personal models and keys</CardTitle></CardHeader><CardContent>{content}</CardContent></Card>;
  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setApiKey(""); }}><DialogTrigger asChild><Button size="icon" variant="ghost" aria-label="Personal model settings"><KeyRound className="h-4 w-4" /></Button></DialogTrigger><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Personal models and keys</DialogTitle><DialogDescription>Configure your Chat provider and encrypted API key.</DialogDescription></DialogHeader>{content}</DialogContent></Dialog>;
}
