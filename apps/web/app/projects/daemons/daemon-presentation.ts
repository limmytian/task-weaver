import { Bot, Clock3, GitMerge, SearchCheck, ShieldAlert, UserRoundCog } from "lucide-react";

export function statusColor(status: string) {
  if (status === "idle") return "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]";
  if (status === "busy") return "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]";
  return "bg-slate-400";
}

export function formatRelativeTime(date: Date | string | null | undefined, now: number) {
  if (!date) return "—";
  const diffSeconds = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  return `${Math.round(diffMinutes / 60)}h ago`;
}

export function formatDateTime(date: Date | string | null | undefined) {
  return date ? new Date(date).toLocaleString() : "—";
}

export function taskBadgeVariant(status: string) {
  if (status === "done") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "in_progress") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "in_review") return "bg-indigo-50 text-indigo-700 border-indigo-200";
  if (status === "ready_to_merge") return "bg-cyan-50 text-cyan-700 border-cyan-200";
  if (status === "cancelled") return "bg-slate-100 text-slate-500 border-slate-200";
  return "bg-background text-muted-foreground border-border";
}

export function sloStatusClass(status: string) {
  if (status === "pass") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "breach") return "border-red-200 bg-red-50 text-red-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

export function sloTarget(metric: { unit: string; comparator: string; target: number }) {
  const value = metric.unit === "ratio"
    ? `${(metric.target * 100).toFixed(0)}%`
    : metric.unit === "seconds"
      ? `${metric.target}s`
      : String(metric.target);
  return `${metric.comparator === "lte" ? "≤" : "≥"} ${value}`;
}

export const requirementStatusLabels: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  in_progress: "In Progress",
  in_review: "In Review",
  ready_to_merge: "Ready to Merge",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived",
};

export const rolePresentation = {
  executor: {
    label: "Executors",
    description: "Implementation and task execution",
    icon: Bot,
    accent: "text-indigo-600",
    border: "border-l-indigo-500",
    surface: "bg-indigo-50/60 dark:bg-indigo-950/20",
  },
  reviewer: {
    label: "Reviewers",
    description: "Verification and review decisions",
    icon: SearchCheck,
    accent: "text-fuchsia-600",
    border: "border-l-fuchsia-500",
    surface: "bg-fuchsia-50/60 dark:bg-fuchsia-950/20",
  },
  merger: {
    label: "Mergers",
    description: "Delivery and merge completion",
    icon: GitMerge,
    accent: "text-cyan-600",
    border: "border-l-cyan-500",
    surface: "bg-cyan-50/60 dark:bg-cyan-950/20",
  },
} as const;

export const queueViews = [
  { id: "executor", label: "Executor", icon: Bot },
  { id: "reviewer", label: "Review", icon: SearchCheck },
  { id: "merger", label: "Merge", icon: GitMerge },
  { id: "retrying", label: "Retry", icon: Clock3 },
  { id: "blocked", label: "Blocked", icon: ShieldAlert },
  { id: "manual", label: "Manual", icon: UserRoundCog },
] as const;
