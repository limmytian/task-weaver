"use client";

import type { ProjectCapabilityReadiness } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";

const labels = { skill: "Skill instructions", skill_package: "Skill packages", memory: "Memories", mcp_tool: "MCP tools" };
export function CapabilityReadinessView({ data }: { data: ProjectCapabilityReadiness }) {
  return <div className="space-y-3">
    <p>Project reads: {data.readPermission}. External invocation permission: {data.invokePermission}. Individual assets still require current inspection and authorization.</p>
    <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th>Capability</th><th>Registered</th><th>Content candidates</th></tr></thead><tbody>{data.inventory.map(item => <tr key={item.kind}><th className="font-normal">{labels[item.kind]}</th><td>{item.access === "missing" ? "Unknown (access missing)" : item.registered}</td><td>{item.access === "missing" ? "Unknown" : item.contentCandidates}</td></tr>)}</tbody></table></div>
    <p className="text-muted-foreground">Counts cover this project only. Personal/shared assets are not merged. Candidate metadata does not prove readable storage, fresh memory sources or executable assets; inspect selected content on demand.</p>
    {data.inventory.every(item => item.access === "missing" || item.registered === 0) && <p>No registered capability content is visible in the readable categories. Categories without access remain unknown. Optional capabilities may be skipped; do not repeatedly search an empty inventory.</p>}
    <p>API runtime profiles: {data.hostedExecution === null ? "Unknown for current grants/tool policy; inspect existing runtime access before diagnosing missing configuration." : data.hostedExecution.state === "available" ? "A profile is available; exact asset dependencies, image/graph pins and approvals still require inspection." : `${data.hostedExecution.reason}: ${data.hostedExecution.remediation}`}</p>
    <details><summary className="cursor-pointer">First-use checklist</summary><ol className="mt-2 list-inside list-decimal space-y-1">{data.checklist.map(step => <li key={step}>{step}</li>)}</ol></details>
  </div>;
}
export function CapabilityReadinessPanel({ projectId }: { projectId: string }) {
  const query = trpc.skill.readiness.useQuery({ projectId }, { retry: false, refetchOnWindowFocus: true });
  return <section aria-label="Project capability readiness" className="space-y-3 rounded-lg border p-4 text-sm">
    <div className="flex items-center justify-between gap-2"><h2 className="font-medium">Project capability readiness</h2><Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh readiness</Button></div>
    {query.error ? <p role="alert">API capability readiness is unavailable or access changed. Runtime and inventory are unknown; check the existing API, project access and capability configuration. No Web runtime state was substituted.</p> : query.data ? <CapabilityReadinessView data={query.data} /> : <p role="status">Loading API capability readiness…</p>}
  </section>;
}
