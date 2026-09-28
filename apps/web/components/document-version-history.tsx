"use client";

import { useState } from "react";
import { trpc } from "@/trpc/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  History,
  RotateCcw,
  GitCompare,
  Bot,
  User,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

function computeDiff(
  oldText: string,
  newText: string,
): { type: "same" | "added" | "removed"; line: string }[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // LCS via DP
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: { type: "same" | "added" | "removed"; line: string }[] = [];
  let i = m;
  let j = n;
  const stack: { type: "same" | "added" | "removed"; line: string }[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "same", line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "added", line: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: "removed", line: oldLines[i - 1] });
      i--;
    }
  }

  while (stack.length > 0) {
    result.push(stack.pop()!);
  }

  return result;
}

const changeTypeBadgeVariant: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  created: "default",
  updated: "secondary",
  reverted: "outline",
};

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function VersionHistorySkeleton() {
  return (
    <div className="space-y-3 pt-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3">
          <Skeleton className="h-8 w-8 rounded-full shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}

export function DocumentVersionHistory({
  documentId,
}: {
  documentId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const [compareTo, setCompareTo] = useState<number | null>(null);
  const [revertTarget, setRevertTarget] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const versionsQuery = trpc.document.versions.useQuery(
    { id: documentId },
    { enabled: expanded },
  );

  const versionPreviewQuery = trpc.document.version.useQuery(
    { id: documentId, version: previewVersion! },
    { enabled: previewVersion !== null },
  );

  const compareQuery = trpc.document.compareVersions.useQuery(
    { id: documentId, from: compareFrom!, to: compareTo! },
    { enabled: compareFrom !== null && compareTo !== null },
  );

  const revertMutation = trpc.document.revertVersion.useMutation({
    onSuccess: () => {
      toast.success("Document reverted successfully");
      utils.document.versions.invalidate({ id: documentId });
      utils.document.get.invalidate({ id: documentId });
      setRevertTarget(null);
      setPreviewVersion(null);
    },
    onError: (err) => {
      toast.error(`Failed to revert: ${err.message}`);
    },
  });

  function handleVersionClick(version: number) {
    if (compareMode) {
      if (compareFrom === null) {
        setCompareFrom(version);
      } else if (compareTo === null) {
        if (version === compareFrom) return;
        const [lo, hi] = [compareFrom, version].sort((a, b) => a - b);
        setCompareFrom(lo);
        setCompareTo(hi);
      } else {
        setCompareFrom(version);
        setCompareTo(null);
      }
    } else {
      setPreviewVersion(previewVersion === version ? null : version);
    }
  }

  function exitCompareMode() {
    setCompareMode(false);
    setCompareFrom(null);
    setCompareTo(null);
  }

  const versions = versionsQuery.data ?? [];

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <CardTitle className="flex items-center gap-2 text-base">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <History className="h-4 w-4" />
          Version History
          {versions.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-xs">
              {versions.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-4">
          {/* Toolbar */}
          <div className="flex items-center gap-2">
            <Button
              variant={compareMode ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (compareMode) {
                  exitCompareMode();
                } else {
                  setCompareMode(true);
                  setPreviewVersion(null);
                }
              }}
            >
              <GitCompare className="h-3.5 w-3.5 mr-1.5" />
              {compareMode ? "Exit Compare" : "Compare"}
            </Button>
            {compareMode && (
              <span className="text-xs text-muted-foreground">
                {compareFrom === null
                  ? "Select the first version"
                  : compareTo === null
                    ? "Select the second version"
                    : `Comparing v${compareFrom} → v${compareTo}`}
              </span>
            )}
          </div>

          {/* Loading state */}
          {versionsQuery.isLoading && <VersionHistorySkeleton />}

          {/* Timeline */}
          {!versionsQuery.isLoading && versions.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">
              No version history available.
            </p>
          )}

          {versions.length > 0 && (
            <div className="relative space-y-0">
              {/* Vertical line */}
              <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />

              {versions.map((v) => {
                const isSelected =
                  compareMode &&
                  (v.version === compareFrom || v.version === compareTo);
                const isPreviewActive =
                  !compareMode && previewVersion === v.version;

                return (
                  <div key={v.id} className="relative">
                    <div
                      className={`flex items-start gap-3 py-2 px-2 rounded-md cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-primary/10"
                          : isPreviewActive
                            ? "bg-muted"
                            : "hover:bg-muted/50"
                      }`}
                      onClick={() => handleVersionClick(v.version)}
                    >
                      {/* Timeline dot */}
                      <div
                        className={`relative z-10 mt-1 h-[10px] w-[10px] shrink-0 rounded-full border-2 ${
                          isSelected
                            ? "border-primary bg-primary"
                            : "border-border bg-background"
                        }`}
                        style={{ marginLeft: "5px" }}
                      />

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">
                            v{v.version}
                          </span>
                          <Badge
                            variant={
                              changeTypeBadgeVariant[v.changeType] ?? "outline"
                            }
                            className="text-xs"
                          >
                            {v.changeType}
                          </Badge>
                          {v.changedByType === "agent" ? (
                            <Badge
                              variant="outline"
                              className="text-xs gap-1"
                            >
                              <Bot className="h-3 w-3" />
                              AI
                            </Badge>
                          ) : (
                            <User className="h-3 w-3 text-muted-foreground" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {v.title}
                          {v.changeDescription && ` — ${v.changeDescription}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(v.createdAt)}
                        </p>
                      </div>

                      {/* Revert button */}
                      {!compareMode && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0 h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRevertTarget(v.version);
                          }}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Revert
                        </Button>
                      )}
                    </div>

                    {/* Inline preview */}
                    {isPreviewActive && (
                      <div className="ml-8 mr-2 mb-2 mt-1 rounded-md border bg-muted/30 p-3 text-sm">
                        {versionPreviewQuery.isLoading ? (
                          <div className="space-y-2">
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-2/3" />
                          </div>
                        ) : versionPreviewQuery.data ? (
                          <div>
                            <p className="font-medium mb-2">
                              {versionPreviewQuery.data.title}
                            </p>
                            <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono max-h-64 overflow-y-auto">
                              {versionPreviewQuery.data.content}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Diff view */}
          {compareMode && compareFrom !== null && compareTo !== null && (
            <div className="rounded-md border overflow-hidden">
              <div className="bg-muted px-3 py-2 text-xs font-medium flex items-center gap-2 border-b">
                <GitCompare className="h-3.5 w-3.5" />
                Diff: v{compareFrom} → v{compareTo}
              </div>
              {compareQuery.isLoading ? (
                <div className="p-3 space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-4/6" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ) : compareQuery.data ? (
                <div>
                  {compareQuery.data.changes.titleChanged && (
                    <div className="px-3 py-2 text-xs border-b bg-muted/50">
                      <span className="text-muted-foreground">Title: </span>
                      <span className="line-through text-red-600">
                        {compareQuery.data.from.title}
                      </span>
                      {" → "}
                      <span className="text-green-600">
                        {compareQuery.data.to.title}
                      </span>
                    </div>
                  )}
                  <DiffView
                    oldText={compareQuery.data.from.content}
                    newText={compareQuery.data.to.content}
                  />
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      )}

      {/* Revert confirmation dialog */}
      <ConfirmDialog
        open={revertTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevertTarget(null);
        }}
        title="Revert Document"
        description={`This will revert the document to version ${revertTarget}. The current version will be saved as a new version before reverting.`}
        confirmLabel="Revert"
        destructive
        onConfirm={() => {
          if (revertTarget !== null) {
            revertMutation.mutate({ id: documentId, version: revertTarget });
          }
        }}
      />
    </Card>
  );
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = computeDiff(oldText, newText);

  if (lines.every((l) => l.type === "same")) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground text-center">
        No content differences.
      </p>
    );
  }

  return (
    <div className="max-h-80 overflow-y-auto text-xs font-mono">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`px-3 py-0.5 ${
            line.type === "added"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : line.type === "removed"
                ? "bg-red-500/10 text-red-700 dark:text-red-400"
                : "text-muted-foreground"
          }`}
        >
          <span className="select-none inline-block w-4 mr-2 text-right opacity-50">
            {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
          </span>
          {line.line || " "}
        </div>
      ))}
    </div>
  );
}
