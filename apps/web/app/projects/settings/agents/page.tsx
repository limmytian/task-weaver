"use client";

import { type FormEvent, useState } from "react";
import Link from "next/link";
import { createManagedAgentSchema } from "@task-weaver/contracts";
import { useIdentityConfirmation } from "@/components/identity-confirmation";
import { ManagedAgentDetail } from "@/components/managed-agent-detail";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ManagedAgentsPage() {
  const utils = trpc.useUtils();
  const confirmation = useIdentityConfirmation();
  const [view, setView] = useState<"active" | "disabled">("active");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const agents = trpc.auth.agents.useQuery({ status: view, query, page, pageSize: 20 });
  const create = trpc.auth.createAgent.useMutation();
  const disable = trpc.auth.disableAgent.useMutation();
  const remove = trpc.auth.deleteAgent.useMutation();
  const [error, setError] = useState("");
  const busy = confirmation.confirming || create.isPending || disable.isPending || remove.isPending;
  async function refresh() {
    await Promise.all([utils.auth.invalidate(), utils.apiKey.invalidate()]);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = createManagedAgentSchema.parse(Object.fromEntries(new FormData(form)));
    if (!(await confirmation.confirm("create Agent"))) return;
    setError("");
    try {
      const agent = await create.mutateAsync(input);
      form.reset();
      setView("active"); setQuery(input.displayName); setPage(1); setSelected(agent.id);
      await refresh();
    } catch {
      setError("Agent creation denied or unavailable. Check your current permission.");
    }
  }
  async function retire(id: string, name: string, deleting: boolean) {
    if (!(await confirmation.confirm(`${deleting ? "delete retired" : "permanently disable"} Agent ${name} (${id})`))) return;
    setError("");
    try {
      if (deleting) await remove.mutateAsync({ id });
      else await disable.mutateAsync({ id });
      if (selected === id) setSelected(null);
      await refresh();
    } catch {
      setError("Agent lifecycle change denied or unavailable. Refresh and check current permissions.");
    }
  }
  return (
    <section className="space-y-5">
      {confirmation.dialog}
      <h1 className="text-xl font-semibold">Your managed Agents</h1>
      <p className="text-sm text-muted-foreground">
        Create an identity, assign project access, then issue a scoped Key. New Agents have no project access or execution permission.
        Disabling is irreversible. Deletion hides a disabled identity while preserving audit history.
      </p>
      <form onSubmit={submit} className="space-y-2 rounded-md border p-3">
        <label htmlFor="agent-name" className="text-sm font-medium">Display name</label>
        <Input id="agent-name" name="displayName" maxLength={255} required />
        <Button disabled={busy}>Create Agent</Button>
      </form>
      <nav aria-label="Agent lifecycle" className="flex flex-wrap gap-2">
        {(["active", "disabled"] as const).map(status => (
          <Button key={status} variant={view === status ? "default" : "outline"}
            aria-pressed={view === status} disabled={busy}
            onClick={() => { setView(status); setQuery(""); setPage(1); setSelected(null); }}>
            {status === "active" ? "Active Agents" : "Disabled Agents"}
          </Button>
        ))}
      </nav>
      <Input aria-label={`Search ${view} Agents`} placeholder="Search display names"
        value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
      {(error || agents.error) && <p role="alert" className="text-sm text-destructive">{error || "Managed Agents are unavailable."}</p>}
      {agents.isFetching && <p role="status" className="text-sm">Loading Agents…</p>}
      {agents.data?.length === 0 && <p className="rounded-md border p-3 text-sm">{query ? "No matching Agents." : view === "active" ? "No active Agents. Create an identity to begin." : "No disabled Agents."}</p>}
      {agents.data?.map(agent => (
        <div key={agent.id} className="space-y-2 rounded-md border p-3">
          <p className="break-words font-medium">{agent.displayName} · {agent.status}</p>
          <code className="block break-all text-xs">{agent.id}</code>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setSelected(agent.id)} aria-label={`Details for ${agent.displayName} (${agent.id})`}>Details and permissions</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void retire(agent.id, agent.displayName, view === "disabled")}>
              {view === "disabled" ? "Delete retired Agent" : "Disable Agent"}
            </Button>
          </div>
        </div>
      ))}
      <nav aria-label="Agent pages" className="flex items-center gap-3">
        <Button variant="outline" disabled={page === 1 || agents.isFetching} onClick={() => setPage(page - 1)}>Previous</Button>
        <span className="text-sm">Page {page}</span>
        <Button variant="outline" disabled={agents.isFetching || (agents.data?.length ?? 0) < 20} onClick={() => setPage(page + 1)}>Next</Button>
      </nav>
      {selected && <ManagedAgentDetail key={selected} actorId={selected} onClose={() => setSelected(null)} />}
      <Link className="text-sm underline" href="/projects/settings/api-keys">Manage scoped credentials</Link>
    </section>
  );
}
