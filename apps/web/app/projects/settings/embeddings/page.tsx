"use client";

import { useEffect, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  AlertTriangle,
  Database,
  Edit3,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "@/trpc/routers/_app";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { QueryStatePanel } from "@/components/query-state-panel";
import { EmbeddingProfileDialog } from "./embedding-profile-dialog";

type EmbeddingProfile = inferRouterOutputs<AppRouter>["embedding"]["list"][number];

export default function EmbeddingSettingsPage() {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const utils = trpc.useUtils();
  const cleanup = trpc.embedding.cleanup.useMutation();
  const { data: profiles, error, isError, isLoading, refetch } = trpc.embedding.list.useQuery();
  const selected = profiles?.find((profile) => profile.id === selectedId) ?? profiles?.[0];

  useEffect(() => {
    if (!selectedId && profiles?.[0]) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedId(profiles[0].id);
    }
  }, [profiles, selectedId]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Embedding Search
            </CardTitle>
            <CardDescription>
              Configure semantic retrieval providers, indexing behavior, and generation rollout.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New profile
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {isError ? (
          <QueryStatePanel
            icon={<Database className="h-5 w-5" />}
            title="Embedding profiles could not be loaded"
            description={error.message}
            onAction={() => refetch()}
          />
        ) : isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !profiles?.length ? (
          <QueryStatePanel
            icon={<Database className="h-5 w-5" />}
            title="No embedding profiles configured"
            description="Create a disabled profile, validate its provider, and build a generation before enabling semantic search."
            actionLabel="Create profile"
            onAction={() => setCreateOpen(true)}
          />
        ) : selected ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="embedding-profile-select" className="text-sm font-medium sm:sr-only">Embedding profile</label>
              <Select value={selected.id} onValueChange={setSelectedId}>
                <SelectTrigger id="embedding-profile-select" className="w-full sm:max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name} · {profile.scope} · {profile.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="sm:ml-auto" onClick={() => setEditOpen(true)}>
                <Edit3 className="h-4 w-4" />
                Edit configuration
              </Button>
            </div>
            <ProfileDetails profile={selected} onRequestCleanup={() => setCleanupOpen(true)} />
          </>
        ) : null}
      </CardContent>

      <EmbeddingProfileDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(profileId) => setSelectedId(profileId)}
      />
      <EmbeddingProfileDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        profile={selected}
        onSaved={(profileId) => setSelectedId(profileId)}
      />
      <ConfirmDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        title="Clean retired generations?"
        description="Retired generations beyond this profile's retention limit will be permanently deleted with their chunks and vectors."
        confirmLabel="Clean generations"
        destructive
        pending={cleanup.isPending}
        onConfirm={async () => {
          if (!selected) return;
          try {
            const result = await cleanup.mutateAsync({ id: selected.id });
            await Promise.all([
              utils.embedding.generations.invalidate({ id: selected.id }),
              utils.embedding.usage.invalidate({ id: selected.id }),
            ]);
            toast.success(`Deleted ${result.deletedGenerations} retired generation(s)`);
          } catch (cleanupError) {
            toast.error(cleanupError instanceof Error ? cleanupError.message : "Retired generations could not be cleaned");
          }
        }}
      />
    </Card>
  );
}

function ProfileDetails({ profile, onRequestCleanup }: { profile: EmbeddingProfile; onRequestCleanup: () => void }) {
  const utils = trpc.useUtils();
  const { data: preview, isLoading: previewLoading } = trpc.embedding.preview.useQuery({ id: profile.id });
  const { data: usage } = trpc.embedding.usage.useQuery({ id: profile.id });
  const { data: generations } = trpc.embedding.generations.useQuery({ id: profile.id });
  const test = trpc.embedding.test.useMutation();
  const enable = trpc.embedding.enable.useMutation();
  const disable = trpc.embedding.disable.useMutation();
  const rebuild = trpc.embedding.rebuild.useMutation();
  const activateGeneration = trpc.embedding.activateGeneration.useMutation();

  const refreshProfile = async () => {
    await Promise.all([
      utils.embedding.list.invalidate(),
      utils.embedding.preview.invalidate({ id: profile.id }),
      utils.embedding.usage.invalidate({ id: profile.id }),
      utils.embedding.generations.invalidate({ id: profile.id }),
    ]);
  };

  const testProvider = async () => {
    try {
      const result = await test.mutateAsync({ id: profile.id });
      toast.success(`Provider validated: ${result.capabilities.model} (${result.capabilities.dimensions} dimensions)`);
      await utils.embedding.list.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Provider validation failed");
    }
  };

  const toggleStatus = async () => {
    try {
      if (profile.status === "enabled") {
        await disable.mutateAsync({ id: profile.id });
        toast.success("Embedding profile disabled");
      } else {
        await enable.mutateAsync({ id: profile.id });
        toast.success("Embedding profile enabled");
      }
      await refreshProfile();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Embedding profile status could not be changed");
    }
  };

  const startRebuild = async (kind: "full" | "forced") => {
    try {
      const job = await rebuild.mutateAsync({ id: profile.id, kind });
      toast.success(`${kind === "forced" ? "Forced" : "Full"} rebuild queued (${job.id.slice(0, 8)})`);
      await refreshProfile();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Embedding rebuild could not be started");
    }
  };

  const activate = async (generationId: string) => {
    try {
      await activateGeneration.mutateAsync({ id: generationId });
      toast.success("Embedding generation activated");
      await refreshProfile();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Embedding generation could not be activated");
    }
  };

  const actionPending = test.isPending || enable.isPending || disable.isPending || rebuild.isPending;
  const scopeTarget = profile.scope === "project"
    ? profile.projectId ?? "Unknown project"
    : profile.scope === "personal"
      ? `${profile.personalOwnerType ?? "owner"}:${profile.personalOwnerId ?? "unknown"}`
      : "All shared documents";

  return (
    <div className="space-y-5 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{profile.name}</h2>
            <StatusBadge status={profile.status} />
            <Badge variant="outline">{profile.scope}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {profile.provider.replace("_", "-")} · version {profile.version}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={testProvider} disabled={actionPending}>
            <ShieldCheck className="h-4 w-4" />
            Test provider
          </Button>
          <Button size="sm" variant={profile.status === "enabled" ? "outline" : "default"} onClick={toggleStatus} disabled={actionPending}>
            {profile.status === "enabled" ? "Disable" : "Enable"}
          </Button>
        </div>
      </div>

      {profile.lastErrorSummary && (
        <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">{profile.lastErrorCode ?? "Provider error"}</p>
            <p className="mt-0.5 text-xs">{profile.lastErrorSummary}</p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Detail label="Model" value={profile.model} />
        <Detail label="Dimensions" value={String(profile.dimensions)} />
        <Detail label="Base URL" value={profile.baseUrl} code />
        <Detail label="Secret reference" value={profile.secretRef} code />
        <Detail label="Scope target" value={scopeTarget} code={profile.scope !== "global"} />
        <Detail label="Chunking" value={`${profile.chunkingVersion} · ${profile.chunkSize} / ${profile.chunkOverlap} overlap`} />
        <Detail label="Batch / concurrency" value={`${profile.batchSize} / ${profile.maxConcurrency}`} />
        <Detail label="Timeout" value={`${profile.timeoutMs} ms`} />
        <Detail label="Generation retention" value={String(profile.retentionGenerations)} />
      </div>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Coverage and usage</h3>
          <p className="text-xs text-muted-foreground">Semantic search falls back to full text while coverage is incomplete.</p>
        </div>
        {previewLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : preview ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Total" value={preview.totalDocuments} />
            <Metric label="Complete" value={preview.completeDocuments} />
            <Metric label="Stale" value={preview.staleDocuments} />
            <Metric label="Missing" value={preview.missingDocuments} />
          </div>
        ) : null}
        {usage && (
          <p className="text-xs text-muted-foreground">
            {usage.jobCount} job(s) · {usage.embeddedChunks} embedded chunks · {usage.promptTokens} prompt tokens
          </p>
        )}
      </section>

      <Separator />

      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Generations</h3>
            <p className="text-xs text-muted-foreground">Build vectors in isolation, then activate an eligible generation atomically.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => startRebuild("full")} disabled={rebuild.isPending}>
              <RefreshCw className="h-4 w-4" />
              Rebuild
            </Button>
            <Button size="sm" variant="outline" onClick={() => startRebuild("forced")} disabled={rebuild.isPending}>
              Force rebuild
            </Button>
          </div>
        </div>
        {!generations?.length ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No generations built yet.</p>
        ) : (
          <div className="space-y-2">
            {generations.map((generation) => (
              <div key={generation.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">v{generation.generationNumber}</span>
                    <Badge variant={generation.status === "active" ? "default" : "outline"}>{generation.status}</Badge>
                    <span className="text-xs text-muted-foreground">{generation.model} · {generation.dimensions}d</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {generation.coveredDocuments}/{generation.totalDocuments} documents · {generation.embeddedChunks} chunks
                  </p>
                </div>
                {generation.status === "building" && (
                  <Button size="sm" variant="outline" onClick={() => activate(generation.id)} disabled={activateGeneration.isPending}>
                    Activate
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onRequestCleanup}>
            <Trash2 className="h-4 w-4" />
            Clean retired generations
          </Button>
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: EmbeddingProfile["status"] }) {
  return (
    <Badge variant={status === "enabled" ? "default" : status === "failed" ? "destructive" : "secondary"}>
      {status}
    </Badge>
  );
}

function Detail({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {code ? (
        <code className="mt-1 block truncate text-xs" title={value}>{value}</code>
      ) : (
        <p className="mt-1 truncate text-sm font-medium" title={value}>{value}</p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
