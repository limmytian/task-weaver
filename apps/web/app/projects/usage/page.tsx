"use client";
import { useState } from "react";
import Link from "next/link";
import { agentUsageQuerySchema } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
const emptyId = "00000000-0000-0000-0000-000000000000";
const selectClass = "h-9 w-full rounded-md border bg-background px-3 text-sm";
const tokens = (value: string | number | null | undefined) =>
  value == null ? "Unknown" : String(value);
export default function UsagePage() {
  const [projectId, setProjectId] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [requirementId, setRequirementId] = useState("");
  const [requirementSearch, setRequirementSearch] = useState("");
  const [taskId, setTaskId] = useState("");
  const [taskSearch, setTaskSearch] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [offset, setOffset] = useState(0);
  const projects = trpc.agentUsage.scopes.useQuery({
    kind: "project",
    query: projectSearch || undefined,
  });
  const requirements = trpc.agentUsage.scopes.useQuery(
    {
      kind: "requirement",
      projectId: projectId || emptyId,
      query: requirementSearch || undefined,
    },
    { enabled: !!projectId },
  );
  const tasks = trpc.agentUsage.scopes.useQuery(
    {
      kind: "task",
      projectId: projectId || emptyId,
      requirementId: requirementId || undefined,
      query: taskSearch || undefined,
    },
    { enabled: !!projectId },
  );
  const parsed = agentUsageQuerySchema.safeParse({
    projectId: projectId || emptyId,
    requirementId: requirementId || undefined,
    taskId: taskId || undefined,
    since: since ? new Date(since).toISOString() : undefined,
    until: until ? new Date(until).toISOString() : undefined,
    limit: 25,
    offset,
  });
  const query = parsed.success ? parsed.data : { projectId: emptyId };
  const enabled = !!projectId && parsed.success;
  const runs = trpc.agentUsage.runs.useQuery(query, { enabled });
  const summary = trpc.agentUsage.summary.useQuery(query, { enabled });
  const projectItems = projects.data ?? [];
  const requirementItems = requirements.data ?? [];
  const taskItems = tasks.data ?? [];
  const resetPage = () => setOffset(0);
  return (
    <>
      <header className="flex h-14 items-center gap-3 border-b px-4">
        <SidebarTrigger />
        <h1 className="text-lg font-semibold">Agent Usage</h1>
      </header>
      <main className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <p className="text-sm text-muted-foreground">
          Reported tokens for each agent process from launch to exit. Totals
          include execution, review, rework and restarted attempts. Missing
          counters remain unknown.
        </p>
        <Card>
          <CardHeader>
            <CardTitle>Scope and time range</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label htmlFor="usage-project" className="text-sm">
                Project
              </label>
              <Input
                aria-label="Search projects"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder="Search projects"
              />
              <select
                id="usage-project"
                className={selectClass}
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setRequirementId("");
                  setTaskId("");
                  resetPage();
                }}
              >
                <option value="">Select a project</option>
                {projectItems.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="usage-requirement" className="text-sm">
                Requirement
              </label>
              <Input
                aria-label="Search requirements"
                disabled={!projectId}
                value={requirementSearch}
                onChange={(e) => setRequirementSearch(e.target.value)}
                placeholder="Search requirements"
              />
              <select
                id="usage-requirement"
                className={selectClass}
                disabled={!projectId}
                value={requirementId}
                onChange={(e) => {
                  setRequirementId(e.target.value);
                  setTaskId("");
                  resetPage();
                }}
              >
                <option value="">All requirements</option>
                {requirementItems.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="usage-task" className="text-sm">
                Task
              </label>
              <Input
                aria-label="Search tasks"
                disabled={!projectId}
                value={taskSearch}
                onChange={(e) => setTaskSearch(e.target.value)}
                placeholder="Search tasks"
              />
              <select
                id="usage-task"
                className={selectClass}
                disabled={!projectId}
                value={taskId}
                onChange={(e) => {
                  setTaskId(e.target.value);
                  resetPage();
                }}
              >
                <option value="">All tasks and shared runs</option>
                {taskItems.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="space-y-2 text-sm">
              Started from (inclusive, local time)
              <Input
                type="datetime-local"
                value={since}
                onChange={(e) => {
                  setSince(e.target.value);
                  resetPage();
                }}
              />
            </label>
            <label className="space-y-2 text-sm">
              Started before (exclusive, local time)
              <Input
                type="datetime-local"
                value={until}
                onChange={(e) => {
                  setUntil(e.target.value);
                  resetPage();
                }}
              />
            </label>
            <div className="flex items-end">
              <Button
                variant="outline"
                disabled={!enabled || runs.isFetching || summary.isFetching}
                onClick={() => {
                  void runs.refetch();
                  void summary.refetch();
                }}
              >
                Refresh
              </Button>
            </div>
            <p className="text-xs text-muted-foreground md:col-span-3">
              Lists show up to 50 matching options; search to narrow the
              selection. Shared requirement runs are included once in
              requirement/project totals and excluded from individual task
              totals.
            </p>
          </CardContent>
        </Card>
        {!parsed.success && (
          <p role="alert">
            The start timestamp must precede the end timestamp.
          </p>
        )}
        {(projects.error ||
          requirements.error ||
          tasks.error ||
          runs.error ||
          summary.error) && (
          <p role="alert">
            Usage or scope data could not be loaded. Try refreshing.
          </p>
        )}
        {enabled && (runs.isLoading || summary.isLoading) && (
          <p role="status">Loading usage…</p>
        )}
        {enabled && summary.data && (
          <Card>
            <CardHeader>
              <CardTitle>Reported totals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-4 sm:grid-cols-4">
                {(
                  [
                    [
                      "Input tokens",
                      summary.data.inputTokens,
                      summary.data.inputReportedRuns,
                    ],
                    [
                      "Output tokens",
                      summary.data.outputTokens,
                      summary.data.outputReportedRuns,
                    ],
                    [
                      "Cache reads",
                      summary.data.cacheReadTokens,
                      summary.data.cacheReadReportedRuns,
                    ],
                    [
                      "Cache writes",
                      summary.data.cacheWriteTokens,
                      summary.data.cacheWriteReportedRuns,
                    ],
                  ] as const
                ).map(([label, value, count]) => (
                  <div key={label}>
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="text-xl font-semibold">{tokens(value)}</dd>
                    <dd className="text-xs text-muted-foreground">
                      Reported by {count}/{summary.data!.runs} processes
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm">
                {summary.data.runs} registered processes ·{" "}
                {summary.data.complete} complete · {summary.data.partial}{" "}
                partial · {summary.data.unknown} unknown ·{" "}
                {summary.data.running} still running
              </p>
              <p className="text-sm">
                Complete coverage:{" "}
                {summary.data.coverage == null
                  ? "Unknown"
                  : `${(summary.data.coverage * 100).toFixed(1)}%`}{" "}
                of registered processes and known unregistered Ti attempts.
              </p>
              <p className="text-sm">
                {summary.data.knownUnregisteredTiAttempts} known Ti attempts
                without process reports (including shell jobs).
              </p>
              <p className="text-xs text-muted-foreground">
                {summary.data.accountingSince} Cache counters are displayed
                separately and may overlap input tokens; they are never added to
                input totals. A total with missing reports is incomplete.
                Unsupported agents and shell jobs have unknown usage.
              </p>
            </CardContent>
          </Card>
        )}
        {enabled && runs.data && (
          <Card>
            <CardHeader>
              <CardTitle>Process runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {runs.data.items.length === 0 ? (
                <p>No registered processes match this scope.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        {[
                          "Started",
                          "Agent / phase",
                          "Attribution",
                          "Outcome / coverage",
                          "Input / output",
                          "Details",
                        ].map((label) => (
                          <th className="p-2" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {runs.data.items.map((run) => (
                        <tr key={run.processId} className="border-t align-top">
                          <td className="p-2 whitespace-nowrap">
                            {new Date(run.startedAt).toLocaleString()}
                          </td>
                          <td className="p-2">
                            {run.agent} / {run.phase}
                            <br />
                            <span className="text-xs text-muted-foreground">
                              {run.summary.provider} / {run.summary.model}
                            </span>
                          </td>
                          <td className="p-2">
                            {run.taskId ? (
                              <Link
                                className="underline"
                                href={`/projects/${run.projectId}?task=${run.taskId}`}
                              >
                                Task
                              </Link>
                            ) : (
                              "Shared requirement"
                            )}
                            <br />
                            <span className="text-xs">{run.requirementId}</span>
                          </td>
                          <td className="p-2">
                            {run.outcome}
                            <br />
                            <Badge variant="secondary">
                              {run.summary.completeness}
                            </Badge>
                          </td>
                          <td className="p-2">
                            {tokens(run.summary.inputTokens)} /{" "}
                            {tokens(run.summary.outputTokens)}
                          </td>
                          <td className="p-2">
                            <details>
                              <summary className="cursor-pointer underline">
                                Run details
                              </summary>
                              <dl className="space-y-1 break-all text-xs">
                                <dt>Process</dt>
                                <dd>{run.processId}</dd>
                                <dt>Source / revision</dt>
                                <dd>
                                  {run.source} / {run.revision}
                                </dd>
                                <dt>Finished</dt>
                                <dd>
                                  {run.endedAt
                                    ? new Date(run.endedAt).toLocaleString()
                                    : "Still running"}
                                </dd>
                                <dt>Cache reads / writes</dt>
                                <dd>
                                  {tokens(run.summary.cacheReadTokens)} /{" "}
                                  {tokens(run.summary.cacheWriteTokens)} (
                                  {run.summary.cacheSemantics})
                                </dd>
                                <dt>Ti run / attempt</dt>
                                <dd>
                                  {run.piRunId ?? "—"} / {run.attempt ?? "—"}
                                </dd>
                              </dl>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 25))}
                >
                  Previous
                </Button>
                <span className="text-sm">{runs.data.total} processes</span>
                <Button
                  variant="outline"
                  disabled={offset + 25 >= runs.data.total}
                  onClick={() => setOffset(offset + 25)}
                >
                  Next
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}
