"use client";

import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { RecoveryObservationView } from "@/components/recovery-observation-view";

export function RequirementRecoveryPanel({ requirementId }: { requirementId: string }) {
  const query = trpc.requirement.recoveryState.useQuery({ id: requirementId }, {
    retry: false, refetchInterval: 15_000, refetchOnReconnect: true, refetchOnWindowFocus: true,
  });
  return <section aria-label="Execution recovery" className="space-y-3 rounded-md border p-3">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">Execution recovery</h3><Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh recovery state</Button></div>
    {query.error ? <p role="alert">Recovery state is unavailable or access changed. Refresh after verifying your project access; previous observations cannot authorize an action.</p> : query.data ? <RecoveryObservationView view={query.data} /> : <p role="status">Loading recovery observations…</p>}
  </section>;
}
