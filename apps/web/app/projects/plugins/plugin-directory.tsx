"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PluginManifest } from "@task-weaver/contracts";
import { pluginManagementRequest as request } from "@/lib/plugin-management-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface Entry {
  id: string; displayName: string; pluginId: string; description: string; version: string;
  maintainer: string; sourceUrl: string; sourceRevision: string; reviewedAt: string;
  reviewHash: string; artifactHash: string; publisherTrust: string; hostProtocol: number;
  requestedPermissions: string[]; availability: { state: string; message: string };
}
interface Inspected extends Entry { manifest: PluginManifest; requiredGrants: string[]; checkedAt: string }
export function PluginDirectory({ scope, canInstall, busy, onReview }: {
  scope: string; canInstall: boolean; busy: boolean;
  onReview(manifest: PluginManifest, directory: { entryId: string; reviewHash: string }): Promise<void>;
}) {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ scope: scope.startsWith("project:") ? "project" : scope, ...(scope.startsWith("project:") ? { projectId: scope.slice(8) } : {}), limit: "5", offset: String(offset) });
  const list = useQuery({ queryKey: ["plugin-directory", scope, offset], queryFn: ({ signal }) => request<{ items: Entry[]; hasMore: boolean; configured: boolean }>(`/directory?${params}`, undefined, signal), retry: false });
  const detail = useQuery({ queryKey: ["plugin-directory-entry", scope, selected], queryFn: ({ signal }) => request<Inspected>(`/directory/${selected}?${params}`, undefined, signal), enabled: Boolean(selected), retry: false, staleTime: 0 });
  return <section className="space-y-3 rounded-lg border bg-card p-5" aria-label="Reviewed plugin directory">
    <div><h3 className="font-semibold">Reviewed directory</h3><p className="mt-1 text-sm text-muted-foreground">Operator-reviewed extensions. Inspect current readiness before reviewing an installation; nothing installs automatically.</p></div>
    {list.isPending && <p className="text-sm">Loading directory…</p>}
    {list.error && <p role="alert" className="text-sm text-destructive">Directory unavailable. Ask the operator to check its configuration.</p>}
    {list.data?.items.length === 0 && <p className="text-sm text-muted-foreground">{list.data.configured ? "No reviewed entries are visible with your current package access." : "No reviewed directory is configured. You can still install an operator-provided manifest above."}</p>}
    <div className="grid gap-3 md:grid-cols-2">{list.data?.items.map(entry => <Card key={entry.id}><CardContent className="space-y-3 pt-4">
      <div className="flex items-start justify-between gap-2"><div><h4 className="font-medium">{entry.displayName}</h4><p className="mt-1 text-xs text-muted-foreground">{entry.pluginId} · {entry.version}</p></div><Badge variant="outline">Publisher {entry.publisherTrust}</Badge></div>
      <p className="text-sm text-muted-foreground">{entry.description || "No description supplied."}</p>
      <p className="text-xs">Maintainer: {entry.maintainer}</p>
      <p className="text-xs text-muted-foreground">Host protocol {entry.hostProtocol} · Reviewed {new Date(entry.reviewedAt).toLocaleDateString()}</p>
      <div className="flex flex-wrap gap-1">{entry.requestedPermissions.map(permission => <Badge key={permission} variant="secondary">{permission}</Badge>)}</div>
      <Button size="sm" variant="outline" disabled={busy || detail.isFetching} onClick={() => { if (selected === entry.id) void detail.refetch(); else setSelected(entry.id); }}>Inspect readiness</Button>
    </CardContent></Card>)}</div>
    {list.data && (offset > 0 || list.data.hasMore) && <div className="flex justify-between"><Button variant="ghost" disabled={busy || offset === 0} onClick={() => setOffset(offset - 5)}>Previous entries</Button><Button variant="ghost" disabled={busy || !list.data.hasMore} onClick={() => setOffset(offset + 5)}>More entries</Button></div>}
    {detail.isFetching && <p role="status" className="text-sm">Checking publisher, artifact, runtime and dependencies…</p>}
    {detail.error && <p role="alert" className="text-sm text-destructive">This entry is unavailable. Refresh the directory or ask the operator to review it.</p>}
    {detail.data && !detail.error && !detail.isFetching && <div className="space-y-3 rounded-md border p-4">
      <h4 className="font-medium">{detail.data.displayName} · {detail.data.version}</h4>
      <p role="status" className="text-sm">{detail.data.availability.message}</p>
      <dl className="space-y-2 break-all text-xs text-muted-foreground"><div><dt className="font-medium text-foreground">Reviewed source</dt><dd>{detail.data.sourceUrl}</dd><dd>Commit {detail.data.sourceRevision}</dd></div><div><dt className="font-medium text-foreground">Immutable artifact hash</dt><dd>{detail.data.artifactHash}</dd></div><div><dt className="font-medium text-foreground">Required caller grants</dt><dd>{detail.data.requiredGrants.join(", ")}</dd></div></dl>
      <p className="text-xs text-muted-foreground">Checked {new Date(detail.data.checkedAt).toLocaleString()}. Preflight runs only after confirmation.</p>
      <Button disabled={busy || !canInstall || detail.data.availability.state !== "review_required"} onClick={() => void onReview(detail.data!.manifest, { entryId: detail.data!.id, reviewHash: detail.data!.reviewHash })}>Review installation</Button>
    </div>}
  </section>;
}
