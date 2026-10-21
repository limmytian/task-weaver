"use client";

import { PluginDirectory } from "./plugin-directory";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/trpc/client";
import { pluginManagementRequest as request } from "@/lib/plugin-management-client";
import type { PluginManifest } from "@task-weaver/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Puzzle, Plus, RefreshCw, ExternalLink, ShieldCheck } from "lucide-react";

interface Summary { id: string; pluginId: string; displayName: string; version: string; revision: number; status: "active" | "disabled" | "uninstalled"; manifestHash: string }
interface Detail extends Summary { manifest: PluginManifest; viewerAvailable: boolean }
interface Generation { version: string; manifestHash: string; verifiedAtInstall: boolean }
interface Review { manifest: PluginManifest; manifestHash: string; currentRevision: number | null; permissionDiff: { added: string[]; removed: string[]; hash: string } }
interface Pending { title: string; description: string; path: string; body: Record<string, unknown>; review?: Review; scopeLabel: string; target?: string }
const message = (error: unknown) => error instanceof Error ? error.message : "Plugin service is unavailable.";
const selectClass = "h-9 rounded-md border bg-background px-3 text-sm min-w-0 max-w-full";

export default function PluginsPage() {
  const cache = useQueryClient();
  const [scope, setScope] = useState("personal");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [editor, setEditor] = useState<"install" | "upgrade" | null>(null);
  const [manifestText, setManifestText] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const projects = trpc.project.list.useQuery();
  const projectId = scope.startsWith("project:") ? scope.slice(8) : undefined;
  const scopeValue = projectId ? { kind: "project", projectId } : { kind: scope };
  const scopeLabel = projectId ? projects.data?.find(project => project.id === projectId)?.name ?? "Selected project" : scope === "personal" ? "Personal space" : "Global space";
  const query = new URLSearchParams({ scope: projectId ? "project" : scope, limit: "20", offset: String(offset), ...(projectId ? { projectId } : {}) });
  const installations = useQuery({ queryKey: ["plugins", scope, offset], queryFn: ({ signal }) => request<{ items: Summary[]; permissions: { manage: boolean; activate: boolean } }>(`?${query}`, undefined, signal), retry: false });
  const detail = useQuery({ queryKey: ["plugin-detail", selected], queryFn: ({ signal }) => request<Detail>(`/${selected}`, undefined, signal), enabled: Boolean(selected), retry: false });
  const history = useQuery({ queryKey: ["plugin-history", selected, historyOffset], queryFn: ({ signal }) => request<{ items: Generation[] }>(`/${selected}/generations?offset=${historyOffset}&limit=20`, undefined, signal), enabled: Boolean(selected), retry: false });
  const row = detail.data;
  const permissions = installations.data?.permissions;
  const openEditor = (operation: "install" | "upgrade") => { setError(""); setManifestText(""); setEditor(operation); };
  const reviewManifest = async (manifest: unknown, operation: "install" | "upgrade" | "recover", directory?: { entryId: string; reviewHash: string }) => {
    setBusy(true); setError("");
    try {
      const review = await request<Review>("/review", { manifest, ...(operation !== "install" ? { installationId: selected } : {}) });
      const body: Record<string, unknown> = { confirmed: true, confirmedManifestHash: review.manifestHash, idempotencyKey: crypto.randomUUID() };
      if (operation === "install") { body.scope = scopeValue; body.manifest = review.manifest; if (directory) body.directory = directory; }
      else { body.expectedRevision = review.currentRevision; body.confirmedPermissionDiffHash = review.permissionDiff.hash; if (operation === "recover") body.version = review.manifest.version; else body.manifest = review.manifest; }
      setEditor(null);
      setPending({ title: operation === "install" ? "Install plugin" : operation === "upgrade" ? "Upgrade plugin" : "Recover generation", description: operation === "recover" ? "Reactivate this immutable generation with retained data. Current trust and dependency checks still apply." : "Review the publisher, artifact and requested access before confirming. Runtime preflight may reject an unavailable or untrusted package.", path: operation === "install" ? "" : `/${selected}/${operation}`, body, review, scopeLabel });
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const recover = async (version: string) => {
    setBusy(true); setError("");
    try { const generation = await request<{ manifest: PluginManifest }>(`/${selected}/generations/${encodeURIComponent(version)}`); await reviewManifest(generation.manifest, "recover"); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const status = (action: "disable" | "uninstall" | "purge") => {
    if (!row) return;
    setError("");
    setPending({ title: action === "disable" ? "Disable plugin" : action === "uninstall" ? "Uninstall plugin" : "Purge retained data", description: action === "disable" ? "Stop calls and retain installation data. Use recovery to reactivate a reviewed generation." : action === "uninstall" ? "Retire this installation and retain its data. A later new installation gets a fresh empty namespace." : "Permanently delete this installation's retained storage and cached result payloads. Audit and anti-replay tombstones remain. This cannot be undone.", path: `/${row.id}/status`, scopeLabel, target: `${row.manifest.displayName} · ${row.pluginId}`, body: { action, expectedRevision: row.revision, confirmed: true, idempotencyKey: crypto.randomUUID() } });
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setError("");
    try {
      await request(pending.path, pending.body);
      setPending(null); setNotice("Plugin operation completed. The current installation state is shown below.");
      await Promise.all([cache.invalidateQueries({ queryKey: ["plugins"] }), cache.invalidateQueries({ queryKey: ["plugin-detail"] }), cache.invalidateQueries({ queryKey: ["plugin-history"] }), cache.invalidateQueries({ queryKey: ["plugin-directory"] }), cache.invalidateQueries({ queryKey: ["plugin-directory-entry"] })]);
    } catch (failure) { setError(message(failure) + " Refresh to inspect current state, or retry this same request if the result was ambiguous."); } finally { setBusy(false); }
  };
  return <div className="flex flex-1 flex-col min-w-0">
    <header className="flex items-center gap-3 border-b px-6 py-4"><SidebarTrigger /><Puzzle className="h-5 w-5" /><h1 className="text-xl font-semibold">Plugins</h1></header>
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-2xl font-semibold tracking-tight">Installed plugins</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Manage isolated extensions and their retained data. Review every installation and permission change.</p></div><Button onClick={() => openEditor("install")} disabled={busy || !permissions?.activate}><Plus className="h-4 w-4" />Install plugin</Button></div>
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm font-medium" htmlFor="plugin-scope">Space</label><select id="plugin-scope" className={selectClass} value={scope} disabled={busy || Boolean(pending)} onChange={event => { setScope(event.target.value); setOffset(0); setSelected(null); setHistoryOffset(0); setNotice(""); setError(""); }}><option value="personal">Personal space</option><option value="global">Global space</option>{projects.data?.map(project => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}</select><Button variant="outline" size="sm" disabled={busy} onClick={() => { void installations.refetch(); if (selected) { void detail.refetch(); void history.refetch(); } }}><RefreshCw className="h-4 w-4" />Refresh</Button>{permissions && !permissions.manage && <span className="text-sm text-muted-foreground">Read-only access</span>}{permissions?.manage && !permissions.activate && <span className="text-sm text-muted-foreground">Installation and recovery require execution access in this space.</span>}</div>
      <PluginDirectory key={scope} scope={scope} busy={busy || Boolean(pending) || Boolean(editor)} canInstall={Boolean(permissions?.activate)} onReview={(manifest, directory) => reviewManifest(manifest, "install", directory)} />
      {notice && <p role="status" className="rounded-md border p-3 text-sm">{notice}</p>}
      {error && !editor && !pending && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {installations.error && <p role="alert" className="rounded-md border p-4">{message(installations.error)}</p>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="space-y-3" aria-label="Installed plugins">
          {installations.isPending && <p className="p-4 text-muted-foreground">Loading installations…</p>}
          {installations.data?.items.length === 0 && <Card><CardContent className="py-12 text-center"><Puzzle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /><h3 className="font-medium">No plugins in this space</h3><p className="mt-2 text-sm text-muted-foreground">Install a reviewed manifest to add an extension.</p></CardContent></Card>}
          {installations.data?.items.map(item => <button type="button" key={item.id} disabled={busy || Boolean(pending)} onClick={() => { setSelected(item.id); setHistoryOffset(0); setError(""); }} className={`w-full rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring ${selected === item.id ? "border-primary bg-muted/40" : "bg-card"}`}><div className="flex items-center justify-between gap-2"><span className="font-medium">{item.displayName}</span><Badge variant={item.status === "active" ? "default" : "secondary"}>{item.status}</Badge></div><p className="mt-1 break-all text-sm text-muted-foreground">{item.pluginId}</p><p className="mt-3 text-xs text-muted-foreground">Version {item.version} · Revision {item.revision}</p></button>)}
          {installations.data && <div className="flex items-center justify-between"><Button variant="ghost" size="sm" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button><span className="text-xs text-muted-foreground">Page {offset / 20 + 1}</span><Button variant="ghost" size="sm" disabled={busy || installations.data.items.length < 20 || offset >= 10000} onClick={() => setOffset(offset + 20)}>Next</Button></div>}
        </section>
        <section aria-label="Plugin details" className="min-w-0">
          {!selected && <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Select an installation to inspect its access and generations.</div>}
          {selected && detail.isPending && <p className="p-4">Loading plugin…</p>}
          {detail.error && <p role="alert">{message(detail.error)}</p>}
          {row && selected && <Card><CardHeader><CardTitle>{row.manifest.displayName}</CardTitle><p className="break-all text-sm text-muted-foreground">{row.pluginId}</p></CardHeader><CardContent className="space-y-5">
            <div className="flex flex-wrap gap-2"><Badge>{row.status}</Badge><Badge variant="outline">{row.manifest.version}</Badge><Badge variant="outline">Revision {row.revision}</Badge></div>
            <p className="text-sm text-muted-foreground">{row.manifest.description || "No description supplied."}</p>
            <div><h3 className="mb-2 text-sm font-medium">Declared access</h3><div className="flex flex-wrap gap-2">{row.manifest.permissions.map(permission => <Badge key={permission} variant="secondary">{permission}</Badge>)}</div></div>
            <p className="text-xs text-muted-foreground">Publisher: {row.pluginId.split("/")[0]} · {row.manifest.signature ? "Signed manifest; trust is rechecked on use." : "Unverified manifest; operator policy applies."}</p>
            <div className="flex flex-wrap gap-2">{row.viewerAvailable && row.status === "active" && <Button asChild variant="outline"><a href={`/plugins/${row.id}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" />Open plugin</a></Button>}{permissions?.activate && row.status !== "uninstalled" && <Button variant="outline" onClick={() => openEditor("upgrade")} disabled={busy}>Review upgrade</Button>}{permissions?.manage && row.status === "active" && <Button variant="outline" onClick={() => status("disable")} disabled={busy}>Disable</Button>}{permissions?.manage && row.status !== "uninstalled" && <Button variant="outline" onClick={() => status("uninstall")} disabled={busy}>Uninstall</Button>}{permissions?.manage && row.status !== "active" && <Button variant="destructive" onClick={() => status("purge")} disabled={busy}>Purge retained data</Button>}</div>
            <details><summary className="cursor-pointer text-sm font-medium">Current manifest</summary><pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(row.manifest, null, 2)}</pre></details>
            <div className="border-t pt-4"><h3 className="font-medium">Generations & recovery</h3><p className="mb-3 mt-1 text-xs text-muted-foreground">Historical verification describes installation time. Recovery rechecks current trust and keeps retained data.</p>{history.error && <p role="alert" className="text-sm">{message(history.error)}</p>}{history.data?.items.map(generation => <div key={generation.version} className="flex items-center justify-between gap-3 border-b py-3"><div><p className="text-sm font-medium">{generation.version}</p><p className="mt-1 text-xs text-muted-foreground">{generation.verifiedAtInstall ? "Verified at install" : "Unverified at install"}</p></div>{permissions?.activate && row.status !== "uninstalled" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void recover(generation.version)}>Review recovery</Button>}</div>)}<div className="mt-3 flex justify-between"><Button size="sm" variant="ghost" disabled={historyOffset === 0 || busy} onClick={() => setHistoryOffset(historyOffset - 20)}>Newer</Button><Button size="sm" variant="ghost" disabled={busy || (history.data?.items.length ?? 0) < 20 || historyOffset >= 10000} onClick={() => setHistoryOffset(historyOffset + 20)}>Older</Button></div></div>
          </CardContent></Card>}
        </section>
      </div>
    </main>
    <Dialog open={Boolean(editor)} onOpenChange={open => { if (!open && !busy) { setEditor(null); setError(""); } }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{editor === "upgrade" ? "Review upgrade manifest" : "Install a plugin"}</DialogTitle><DialogDescription>Space: {scopeLabel}. Paste or choose a publisher manifest. Uploading does not install or approve it.</DialogDescription></DialogHeader><label className="text-sm font-medium" htmlFor="plugin-manifest-file">Manifest JSON file</label><input id="plugin-manifest-file" type="file" accept=".json,application/json" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 131072) { setError("Manifest file exceeds 128 KiB."); return; } setManifestText(await file.text()); }} /><label htmlFor="plugin-manifest-text" className="text-sm font-medium">Manifest</label><Textarea id="plugin-manifest-text" rows={12} className="font-mono text-xs" disabled={busy} value={manifestText} onChange={event => setManifestText(event.target.value)} />{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditor(null)}>Cancel</Button><Button disabled={busy || !manifestText.trim()} onClick={() => { try { void reviewManifest(JSON.parse(manifestText), editor!); } catch { setError("The manifest must be valid JSON."); } }}>{busy ? "Preparing review…" : "Review access"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(pending)} onOpenChange={open => { if (!open && !busy) { setPending(null); setError(""); } }}><DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{pending?.title}</DialogTitle><DialogDescription>{pending?.description}</DialogDescription></DialogHeader>{pending?.target && <p className="break-all font-medium">{pending.target}</p>}<p className="text-sm">Space: <strong>{pending?.scopeLabel}</strong> · Expected revision: {String(pending?.body.expectedRevision ?? "new installation")}</p>{pending?.review && <><div className="rounded-md border p-3"><p className="font-medium">{pending.review.manifest.displayName} · {pending.review.manifest.version}</p><p className="mt-1 break-all text-sm text-muted-foreground">{pending.review.manifest.pluginId}</p><p className="mt-2 flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4" />{pending.review.manifest.signature ? "Signature supplied; host verification is required." : "Unsigned manifest; no verified publisher claim."}</p></div><div><h3 className="text-sm font-medium">Access added</h3>{pending.review.permissionDiff.added.length ? <ul className="mt-2 space-y-1 break-all text-xs">{pending.review.permissionDiff.added.map(value => <li key={value}>{value}</li>)}</ul> : <p className="text-sm text-muted-foreground">None</p>}<h3 className="mt-3 text-sm font-medium">Access removed</h3>{pending.review.permissionDiff.removed.length ? <ul className="mt-2 space-y-1 break-all text-xs">{pending.review.permissionDiff.removed.map(value => <li key={value}>{value}</li>)}</ul> : <p className="text-sm text-muted-foreground">None</p>}</div><details><summary className="cursor-pointer text-sm">Reviewed manifest & artifact pins</summary><pre className="mt-2 max-h-60 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(pending.review.manifest, null, 2)}</pre><p className="mt-2 break-all text-xs text-muted-foreground">Manifest hash: {pending.review.manifestHash}</p></details></>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setPending(null); setError(""); }}>Cancel</Button><Button disabled={busy} variant={pending?.body.action === "purge" ? "destructive" : "default"} onClick={() => void confirm()}>{busy ? "Applying…" : error ? "Retry same request" : "Confirm"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
