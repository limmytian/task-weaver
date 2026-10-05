"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, Key, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryStatePanel } from "@/components/query-state-panel";
import { useWebIdentity } from "@/components/web-identity-provider";

export default function ApiKeysSettingsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const utils = trpc.useUtils();
  const {
    data: keys,
    error,
    isError,
    isLoading,
    refetch,
  } = trpc.apiKey.list.useQuery();
  const revokeKey = trpc.apiKey.revoke.useMutation();

  const handleRevoke = async (id: string) => {
    try {
      await revokeKey.mutateAsync({ id });
      await utils.apiKey.list.invalidate();
      toast.success("API key revoked");
    } catch (mutationError) {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : "API key could not be revoked",
      );
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(createdKey);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = createdKey;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const copiedWithFallback = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copiedWithFallback) throw new Error("Copy command failed");
      }
      setCopied(true);
      toast.success("API key copied");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy API key");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              API Keys
            </CardTitle>
            <CardDescription>
              Create and revoke credentials bound to your identity and selected
              permissions.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Create key
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {createdKey && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              Copy your API key now — it won&apos;t be shown again
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs">
                {createdKey}
              </code>
              <Button
                size="sm"
                variant="outline"
                aria-label="Copy API key"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        )}

        {isError ? (
          <QueryStatePanel
            icon={<Key className="h-5 w-5" />}
            title="API keys could not be loaded"
            description={error.message}
            onAction={() => refetch()}
          />
        ) : isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : !keys?.length ? (
          <QueryStatePanel
            icon={<Key className="h-5 w-5" />}
            title="No API keys yet"
            description="Create a key to let an AI agent authenticate with Task Weaver."
            actionLabel="Create key"
            onAction={() => setCreateOpen(true)}
          />
        ) : (
          <div className="space-y-3">
            {keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{key.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <code>{key.prefix}...</code>
                    <span>
                      Created {new Date(key.createdAt).toLocaleDateString()}
                    </span>
                    {key.lastUsedAt && (
                      <span>
                        Last used{" "}
                        {new Date(key.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                    {key.expiresAt && (
                      <span>
                        Expires {new Date(key.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                    {!key.expiresAt && <span>No time-based expiry</span>}
                    {key.revokedAt && <span>Revoked</span>}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-destructive hover:text-destructive"
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => handleRevoke(key.id)}
                  disabled={revokeKey.isPending || Boolean(key.revokedAt)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(rawKey) => {
          setCreatedKey(rawKey);
          utils.apiKey.list.invalidate();
        }}
      />
    </Card>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (rawKey: string) => void;
}) {
  const [name, setName] = useState("");
  const actor = useWebIdentity();
  const [expiry, setExpiry] = useState("90");
  const [customExpiry, setCustomExpiry] = useState("");
  const createKey = trpc.apiKey.create.useMutation();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const expiresAt =
        expiry === "never"
          ? null
          : expiry === "custom"
            ? new Date(customExpiry).toISOString()
            : new Date(Date.now() + Number(expiry) * 86400_000).toISOString();
      const data = await createKey.mutateAsync({
        name: name.trim(),
        expiresAt,
        grants: [
          {
            scope: "personal",
            actorId: actor.id,
            permissions: ["resource.read"],
          },
        ],
      });
      onCreated(data.rawKey);
      onOpenChange(false);
      setName("");
      toast.success("API key created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "API key could not be created",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              This key grants read access to your personal space and acts as
              you. Choose its expiry explicitly; you can revoke it at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-1.5">
            <label htmlFor="api-key-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="api-key-name"
              placeholder="e.g. Documentation agent"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="mt-4 space-y-1.5">
            <label htmlFor="api-key-expiry" className="text-sm font-medium">
              Expires
            </label>
            <select
              id="api-key-expiry"
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In one year</option>
              <option value="custom">Custom date</option>
              <option value="never">Never</option>
            </select>
            {expiry === "custom" && (
              <Input
                type="datetime-local"
                aria-label="Custom expiry"
                value={customExpiry}
                onChange={(event) => setCustomExpiry(event.target.value)}
                required
              />
            )}
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createKey.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !name.trim() ||
                createKey.isPending ||
                (expiry === "custom" && !customExpiry)
              }
            >
              {createKey.isPending ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
