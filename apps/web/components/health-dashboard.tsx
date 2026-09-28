"use client";

import { trpc } from "@/trpc/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Clock,
  FileText,
  Layers,
  Minus,
  TrendingUp,
  UserX,
  Zap,
} from "lucide-react";

function scoreColor(score: number) {
  if (score < 40) return { stroke: "#ef4444", text: "text-red-500", bg: "bg-red-500" };
  if (score < 70) return { stroke: "#f59e0b", text: "text-amber-500", bg: "bg-amber-500" };
  return { stroke: "#22c55e", text: "text-green-500", bg: "bg-green-500" };
}

function scoreLabel(score: number) {
  if (score < 40) return "Critical";
  if (score < 70) return "Needs Attention";
  return "Healthy";
}

function CircularScore({ score }: { score: number }) {
  const radius = 70;
  const strokeWidth = 10;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const colors = scoreColor(score);

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="176" height="176" viewBox="0 0 176 176" className="-rotate-90">
        <circle
          cx="88"
          cy="88"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/30"
        />
        <circle
          cx="88"
          cy="88"
          r={radius}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-4xl font-bold tabular-nums ${colors.text}`}>
          {score}
        </span>
        <span className="text-xs text-muted-foreground font-medium mt-0.5">
          {scoreLabel(score)}
        </span>
      </div>
    </div>
  );
}

function BreakdownBar({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  const colors = scoreColor(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5 text-muted-foreground font-medium">
          {icon}
          {label}
        </span>
        <span className={`font-semibold tabular-nums ${colors.text}`}>
          {value}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted/40 overflow-hidden">
        <div
          className={`h-full rounded-full ${colors.bg} transition-all duration-700 ease-out`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  );
}

function TrendIcon({ trend }: { trend: "up" | "down" | "stable" }) {
  if (trend === "up") return <ArrowUp className="size-4 text-green-500" />;
  if (trend === "down") return <ArrowDown className="size-4 text-red-500" />;
  return <Minus className="size-4 text-muted-foreground" />;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardContent className="flex flex-col items-center gap-4 pt-6">
            <Skeleton className="size-44 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-10" />
                </div>
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function HealthDashboard({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = trpc.project.health.useQuery({
    id: projectId,
  });

  if (isLoading) return <LoadingSkeleton />;

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <AlertTriangle className="size-10 text-destructive mb-3" />
          <p className="text-sm text-muted-foreground">
            Failed to load project health data.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const {
    healthScore,
    breakdown,
    overdueTasks,
    staleTasks,
    unassignedTasks,
    requirementsWithoutTasks,
    velocity,
    activitySummary,
    documentCount,
  } = data;

  const activityChange =
    activitySummary.previous7Days > 0
      ? Math.round(
          ((activitySummary.last7Days - activitySummary.previous7Days) /
            activitySummary.previous7Days) *
            100
        )
      : 0;

  const recentVelocity = velocity.slice(-4);

  return (
    <div className="space-y-6">
      {/* Top row: Score + Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Zap className="size-4" />
              Health Score
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-2">
            <CircularScore score={healthScore} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers className="size-4" />
              Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <BreakdownBar
              label="Completion Rate"
              value={breakdown.completionRate}
              icon={<CheckCircle2 className="size-3.5" />}
            />
            <BreakdownBar
              label="On-time Rate"
              value={100 - breakdown.overdueRate}
              icon={<Clock className="size-3.5" />}
            />
            <BreakdownBar
              label="Activity"
              value={breakdown.activityTrend}
              icon={<TrendingUp className="size-3.5" />}
            />
            <BreakdownBar
              label="Req Coverage"
              value={breakdown.requirementCoverage}
              icon={<FileText className="size-3.5" />}
            />
            <BreakdownBar
              label="Velocity"
              value={breakdown.velocityTrend}
              icon={<Zap className="size-3.5" />}
            />
          </CardContent>
        </Card>
      </div>

      {/* Middle row: Velocity chart + Activity + Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="size-4" />
              Velocity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={recentVelocity} barSize={28}>
                  <XAxis
                    dataKey="week"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "8px",
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                      fontSize: "12px",
                    }}
                    cursor={{ fill: "color-mix(in oklab, var(--muted) 30%, transparent)" }}
                  />
                  <Bar
                    dataKey="completed"
                    fill="var(--chart-2)"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Zap className="size-4" />
              Activity (7 days)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-bold tabular-nums">
                {activitySummary.last7Days}
              </span>
              <span className="text-sm text-muted-foreground">events</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <TrendIcon trend={activitySummary.trend} />
              <span className="text-muted-foreground">
                {activityChange >= 0 ? "+" : ""}
                {activityChange}% vs previous week
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ArrowRight className="size-3.5" />
              Previous: {activitySummary.previous7Days} events
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers className="size-4" />
              Quick Stats
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <UserX className="size-3.5" />
                Unassigned Tasks
              </span>
              <Badge variant={unassignedTasks > 0 ? "destructive" : "secondary"}>
                {unassignedTasks}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="size-3.5" />
                Documents
              </span>
              <Badge variant="secondary">{documentCount}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="size-3.5" />
                Overdue Tasks
              </span>
              <Badge variant={overdueTasks.length > 0 ? "destructive" : "secondary"}>
                {overdueTasks.length}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="size-3.5" />
                Stale Tasks
              </span>
              <Badge variant={staleTasks.length > 0 ? "outline" : "secondary"}>
                {staleTasks.length}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bottom row: Task lists */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {overdueTasks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm text-red-500">
                <AlertTriangle className="size-4" />
                Overdue Tasks
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {overdueTasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex flex-col gap-0.5 rounded-lg border p-2.5 text-sm"
                  >
                    <span className="font-medium truncate">{task.title}</span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Due {formatDate(task.expectedAt)}</span>
                      {task.assignee && (
                        <>
                          <span className="text-border">·</span>
                          <span>{task.assignee}</span>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {staleTasks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm text-amber-500">
                <Clock className="size-4" />
                Stale Tasks
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {staleTasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex flex-col gap-0.5 rounded-lg border p-2.5 text-sm"
                  >
                    <span className="font-medium truncate">{task.title}</span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Updated {formatDate(task.updatedAt)}</span>
                      <span className="text-border">·</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {task.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {requirementsWithoutTasks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm text-amber-500">
                <FileText className="size-4" />
                Requirements Without Tasks
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {requirementsWithoutTasks.map((req) => (
                  <li
                    key={req.id}
                    className="rounded-lg border p-2.5 text-sm font-medium truncate"
                  >
                    {req.title}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
