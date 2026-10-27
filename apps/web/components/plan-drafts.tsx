"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function PlanDrafts({ projectId }: { projectId: string }) {
  const router = useRouter();
  const list = trpc.plan.listDrafts.useQuery({ projectId });
  const capabilities = trpc.plan.capabilities.useQuery({ projectId });
  const create = trpc.plan.createDraft.useMutation({
    onSuccess: draft => router.push(`/projects/${projectId}/plans/${draft.id}`),
    onError: error => toast.error(error.message),
  });
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Plan drafts</h2><p className="text-sm text-muted-foreground">Prepare and review changes before creating live work.</p></div><Button disabled={create.isPending || !capabilities.data?.canWrite} onClick={() => create.mutate({ plan: { projectId, documents: [], requirements: [], requirementDependencies: [], taskDependencies: [], documentLinks: [], documentTaskLinks: [], documentRequirementLinks: [] } })}>New draft</Button></div>
    {list.isLoading && <p>Loading drafts…</p>}
    {list.error && <p role="alert">Unable to load drafts.</p>}
    {!list.isLoading && !list.data?.length && <p className="text-sm text-muted-foreground">No saved drafts.</p>}
    <ul className="space-y-2">{list.data?.map(draft => <li key={draft.id} className="rounded border p-3"><Link className="font-medium underline" href={`/projects/${projectId}/plans/${draft.id}`}>Draft {draft.id.slice(0, 8)}</Link><span className="ml-2 text-sm text-muted-foreground">{draft.source} · revision {draft.revision} · {new Date(draft.updatedAt).toLocaleString()}</span></li>)}</ul>
  </section>;
}
