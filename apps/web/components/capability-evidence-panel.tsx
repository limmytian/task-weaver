"use client";

import { useState } from "react";
import Link from "next/link";
import type { CapabilityEvidenceView } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";

const labels = { skill: "Skill instructions", skill_package: "Skill package", memory: "Memory", mcp_tool: "MCP tool" };
export function CapabilityEvidenceViewContent({ data }: { data: CapabilityEvidenceView }) {
  return <div className="space-y-3">
    <p>{data.totalVisibleReferences} currently visible reference groups · {data.reportedProgressReferences} progress-report references. Progress reports do not verify capability use.</p>
    {data.summary.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left"><caption className="text-left text-muted-foreground">Reference groups by observed action/outcome, not call totals</caption><thead><tr><th>Action</th><th>Outcome</th><th>Visible references</th></tr></thead><tbody>{data.summary.map(row => <tr key={`${row.action}:${row.outcome}`}><td>{row.action}</td><td>{row.outcome}</td><td>{row.references}</td></tr>)}</tbody></table></div>}
    <p className="text-muted-foreground">These are unique per-run or per-credential asset/action/version/hash/outcome observations, not API-call totals or a measure of task quality. Nested success layers are combined. Current asset access is checked before pagination and counts.</p>
    <p className="text-muted-foreground">Coverage is incomplete. Missing, inaccessible, expired/revoked or unattributed references are not counted. Discovery coverage, task usefulness, context tokens and model cost remain unknown. A zero visible count does not prove no use.</p>
    <p className="text-muted-foreground">Whole-process token reports, when available, remain in <Link className="underline" href="/projects/usage">Usage</Link>; they cannot be apportioned to individual capabilities here.</p>
    {data.items.length === 0 ? <p>No currently visible references in this page/window.</p> : <ul className="space-y-3">{data.items.map(item => <li key={item.id} className="space-y-1 rounded border p-3">
      <p className="font-medium">{labels[item.kind]} · {item.action} · {item.outcome === "observed" ? "API response observed; task outcome unverified" : item.outcome === "error" ? "API error recorded" : "Outcome unknown"}</p>
      <p>{item.attribution === "run" ? "Attributed to a daemon run; this historical observation is not execution authority." : "Credential observation; no daemon run is inferred."}</p>
      {item.sourceFreshness && <p>Memory source freshness at observation: {item.sourceFreshness}. Recheck before reuse.</p>}
      <p className="text-muted-foreground">Latest observation: {item.recordedAt}. API duration: {item.durationMs === null ? "Unknown" : `${item.durationMs} ms (one observation; not model or total task latency)`}.</p>
      <details className="break-all text-xs text-muted-foreground"><summary className="cursor-pointer">Reference details</summary><p>Asset: {item.assetId}</p><p>Version: {item.assetVersion ?? "Unknown"}</p><p>Hash: {item.assetSha256 ?? "Unknown"} · {item.assetHashKind ?? "Unknown kind"}</p>{item.runId && <p>Run: {item.runId}</p>}</details>
    </li>)}</ul>}
    <details><summary className="cursor-pointer">Usefulness review rubric</summary><ul className="mt-2 list-inside list-disc space-y-1"><li>Verify the actual task artifact, correctness and instruction adherence.</li><li>Check whether recalled content was relevant and its source remains fresh.</li><li>Inspect exact external schemas/dependencies and reconcile uncertain outcomes.</li><li>Compare measured latency/context/model cost only where coverage exists.</li><li>Useful abstention is valid. More calls or saved memories do not establish better results.</li></ul></details>
  </div>;
}
export function CapabilityEvidencePanel({ projectId }: { projectId: string }) {
  const [offset, setOffset] = useState(0);
  const query = trpc.skill.evidence.useQuery({ projectId, days: 7, limit: 20, offset }, { retry: false, refetchOnWindowFocus: true });
  return <section aria-label="Capability use evidence" className="space-y-3 rounded-lg border p-4 text-sm">
    <div className="flex items-center justify-between gap-2"><h2 className="font-medium">Capability use evidence · last 7 days</h2><Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh evidence</Button></div>
    {query.error ? <p role="alert">Evidence is unavailable or current project audit/read access is missing. No zero-usage conclusion can be drawn.</p> : query.data ? <><CapabilityEvidenceViewContent data={query.data} /><div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(current => Math.max(0, current - 20))}>Previous references</Button><Button size="sm" variant="outline" disabled={offset + query.data.items.length >= query.data.totalVisibleReferences || query.isFetching} onClick={() => setOffset(current => current + 20)}>Next references</Button></div></> : <p role="status">Loading permission-filtered evidence…</p>}
  </section>;
}
