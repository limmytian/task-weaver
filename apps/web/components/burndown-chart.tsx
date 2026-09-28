"use client";

import { trpc } from "@/trpc/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ChartSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-48" />
      </CardHeader>
      <CardContent className="space-y-6">
        <Skeleton className="h-[300px] w-full rounded-lg" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      </CardContent>
    </Card>
  );
}

interface MergedDataPoint {
  date: string;
  label: string;
  remaining: number | undefined;
  completed: number | undefined;
  ideal: number | undefined;
}

function mergeData(
  dataPoints: { date: string; remainingTasks: number; completedTasks: number }[],
  idealLine: { date: string; remaining: number }[]
): MergedDataPoint[] {
  const map = new Map<string, MergedDataPoint>();

  for (const pt of idealLine) {
    map.set(pt.date, {
      date: pt.date,
      label: formatDate(pt.date),
      remaining: undefined,
      completed: undefined,
      ideal: pt.remaining,
    });
  }

  for (const pt of dataPoints) {
    const existing = map.get(pt.date);
    if (existing) {
      existing.remaining = pt.remainingTasks;
      existing.completed = pt.completedTasks;
    } else {
      map.set(pt.date, {
        date: pt.date,
        label: formatDate(pt.date),
        remaining: pt.remainingTasks,
        completed: pt.completedTasks,
        ideal: undefined,
      });
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center gap-2 text-sm">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">
            {entry.dataKey === "remaining"
              ? "Remaining"
              : entry.dataKey === "ideal"
                ? "Ideal"
                : "Completed"}
            :
          </span>
          <span className="font-medium">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export function BurndownChart({
  requirementId,
}: {
  requirementId: string;
}) {
  const { data, isLoading } = trpc.requirement.burndown.useQuery({
    id: requirementId,
  });

  if (isLoading || !data) return <ChartSkeleton />;

  const chartData = mergeData(data.dataPoints, data.idealLine);
  const maxRemaining = Math.max(
    data.totalTasks,
    ...data.dataPoints.map((p) => p.remainingTasks),
    ...data.idealLine.map((p) => p.remaining)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Burndown — {data.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
            >
              <defs>
                <linearGradient id="blueGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                className="text-border"
                opacity={0.5}
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                stroke="currentColor"
                className="text-muted-foreground"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={[0, maxRemaining]}
                tick={{ fontSize: 12 }}
                stroke="currentColor"
                className="text-muted-foreground"
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="currentColor" className="text-border" />
              <Line
                dataKey="ideal"
                stroke="#9ca3af"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                connectNulls
                name="Ideal"
              />
              <Area
                dataKey="remaining"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#blueGradient)"
                dot={{ r: 3, fill: "#3b82f6", strokeWidth: 0 }}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }}
                connectNulls
                name="Remaining"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Total Tasks" value={String(data.totalTasks)} />
          <StatCard
            label="Velocity"
            value={`${data.velocity.toFixed(1)} tasks/day`}
          />
          <StatCard
            label="Projected Completion"
            value={
              data.projectedCompletionDate
                ? formatDate(data.projectedCompletionDate)
                : "No prediction available"
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/40 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tracking-tight">{value}</p>
    </div>
  );
}
