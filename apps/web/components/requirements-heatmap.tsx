"use client";

import { useRouter } from "next/navigation";
import { trpc } from "@/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Flame,
  Snowflake,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  MessageSquare,
  Activity,
} from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  in_progress: "In Progress",
  in_review: "In Review",
  ready_to_merge: "Ready to Merge",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  approved: "secondary",
  in_progress: "default",
  in_review: "secondary",
  ready_to_merge: "default",
  done: "secondary",
  cancelled: "destructive",
  archived: "outline",
};

function getHeatColor(score: number): string {
  if (score >= 80) return "bg-red-500/20 border-red-500/40 hover:bg-red-500/30";
  if (score >= 60) return "bg-orange-500/20 border-orange-500/40 hover:bg-orange-500/30";
  if (score >= 40) return "bg-amber-500/20 border-amber-500/40 hover:bg-amber-500/30";
  if (score >= 20) return "bg-sky-500/20 border-sky-500/40 hover:bg-sky-500/30";
  return "bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20";
}

function getHeatTextColor(score: number): string {
  if (score >= 80) return "text-red-600 dark:text-red-400";
  if (score >= 60) return "text-orange-600 dark:text-orange-400";
  if (score >= 40) return "text-amber-600 dark:text-amber-400";
  if (score >= 20) return "text-sky-600 dark:text-sky-400";
  return "text-blue-600 dark:text-blue-400";
}

function HeatmapSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-36 rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function RequirementsHeatmap({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { data, isLoading, error } = trpc.project.heatmap.useQuery({ id: projectId });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Requirements Heatmap</CardTitle>
        </CardHeader>
        <CardContent>
          <HeatmapSkeleton />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Requirements Heatmap</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            Failed to load heatmap data.
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.requirements.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Requirements Heatmap</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No requirements found for this project.</p>
        </CardContent>
      </Card>
    );
  }

  const hotspotIds = new Set(data.hotspots.map((h) => h.id));
  const coldspotIds = new Set(data.coldspots.map((c) => c.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-5" />
          Requirements Heatmap
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary bar */}
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
            <FileText className="size-4 text-muted-foreground" />
            <span className="font-medium">{data.requirements.length}</span>
            <span className="text-muted-foreground">Total</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
            <Flame className="size-4 text-red-500" />
            <span className="font-medium text-red-600 dark:text-red-400">
              {data.hotspots.length}
            </span>
            <span className="text-red-600/80 dark:text-red-400/80">Hotspots</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm">
            <Snowflake className="size-4 text-blue-500" />
            <span className="font-medium text-blue-600 dark:text-blue-400">
              {data.coldspots.length}
            </span>
            <span className="text-blue-600/80 dark:text-blue-400/80">Coldspots</span>
          </div>
        </div>

        {/* Heatmap grid */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {data.requirements.map((req) => {
            const isHotspot = hotspotIds.has(req.id);
            const isColdspot = coldspotIds.has(req.id);
            const progress =
              req.totalTasks > 0
                ? Math.round((req.completedTasks / req.totalTasks) * 100)
                : 0;

            return (
              <button
                key={req.id}
                onClick={() => router.push(`/projects/${projectId}/requirements/${req.id}`)}
                className={`relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-all ${getHeatColor(req.heatScore)} cursor-pointer`}
              >
                {/* Spot indicators */}
                {isHotspot && (
                  <Flame className="absolute right-2 top-2 size-4 text-red-500 animate-pulse" />
                )}
                {isColdspot && (
                  <Snowflake className="absolute right-2 top-2 size-4 text-blue-500" />
                )}

                {/* Title */}
                <p className="line-clamp-2 pr-6 text-sm font-medium leading-tight">
                  {req.title}
                </p>

                {/* Status badge */}
                <Badge variant={STATUS_VARIANTS[req.status] ?? "outline"} className="w-fit text-xs">
                  {STATUS_LABELS[req.status] ?? req.status}
                </Badge>

                {/* Task progress */}
                <div className="mt-auto space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="size-3" />
                      {req.completedTasks}/{req.totalTasks}
                    </span>
                    {req.overdueTasks > 0 && (
                      <span className="flex items-center gap-1 text-destructive">
                        <Clock className="size-3" />
                        {req.overdueTasks}
                      </span>
                    )}
                  </div>
                  {req.totalTasks > 0 && (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                      <div
                        className="h-full rounded-full bg-current transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Heat score + meta */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className={`font-semibold ${getHeatTextColor(req.heatScore)}`}>
                    {req.heatScore}
                  </span>
                  <span className="flex items-center gap-2">
                    {req.commentCount > 0 && (
                      <span className="flex items-center gap-0.5">
                        <MessageSquare className="size-3" />
                        {req.commentCount}
                      </span>
                    )}
                    {req.documentLinkCount > 0 && (
                      <span className="flex items-center gap-0.5">
                        <FileText className="size-3" />
                        {req.documentLinkCount}
                      </span>
                    )}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
