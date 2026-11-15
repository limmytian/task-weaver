"use client";

import Link from 'next/link';
import { trpc } from '@/trpc/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function DeliveryInsights({ projectId, requirementId }: { projectId: string; requirementId?: string }) {
  const delivery = trpc.agentUsage.deliverySummary.useQuery({ projectId, requirementId }, { retry: false });
  const usage = trpc.agentUsage.summary.useQuery({ projectId, requirementId, limit: 20, offset: 0 }, { retry: false });
  return <Card><CardHeader><CardTitle>Delivery and usage evidence</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
    {delivery.isLoading && <p>Loading delivery evidence…</p>}
    {delivery.error && <p role="alert">Delivery evidence is unavailable with the current access or connection.</p>}
    {!delivery.error && delivery.data && <><p>Requirement review decisions: {delivery.data.workflow.accepted} accepted, {delivery.data.workflow.changesRequested} requested changes. Acceptance rate: {delivery.data.workflow.acceptanceRate === null ? 'unknown' : `${Math.round(delivery.data.workflow.acceptanceRate * 100)}%`} ({delivery.data.workflow.reviewDecisions} decisions).</p>
      <p>Worker reviews: {delivery.data.worker.acceptedReviews} accepted, {delivery.data.worker.changesRequested} requested changes. Additional attempts: {delivery.data.worker.additionalAttempts}. Recorded human recovery decisions: {delivery.data.humanRecoveryDecisions}.</p>
      <p>Mean closed-attempt duration: {delivery.data.worker.meanDurationSeconds === null ? 'unknown' : `${Math.round(delivery.data.worker.meanDurationSeconds)} seconds`} ({delivery.data.worker.completedDurations} observations).</p>
      <p className="text-muted-foreground">{delivery.data.coverage}</p></>}
    {usage.isLoading && <p>Loading token evidence…</p>}
    {usage.error && <p role="alert">Token evidence is unavailable with the current access or connection.</p>}
    {!usage.error && usage.data && <><p>Reported input tokens: {usage.data.inputTokens ?? 'unknown'} ({usage.data.inputReportedRuns} processes). Reported output tokens: {usage.data.outputTokens ?? 'unknown'} ({usage.data.outputReportedRuns} processes).</p><p>Complete coverage: {usage.data.coverage === null ? 'unknown' : `${Math.round(usage.data.coverage * 100)}%`}. {usage.data.complete} complete, {usage.data.partial} partial, {usage.data.unknown} unknown reports.</p><p className="text-muted-foreground">{usage.data.accountingSince} Cache counters may overlap input.</p></>}
    <p>Window: all visible retained evidence.</p><Link className="underline" href={`/projects/usage?project=${projectId}${requirementId ? `&requirement=${requirementId}` : ''}`}>Inspect process reports and coverage</Link>
    {requirementId && <p><Link className="underline" href={`/projects/${projectId}/requirements/${requirementId}#workflow`}>Inspect requirement decisions and delivered work</Link></p>}
  </CardContent></Card>;
}
