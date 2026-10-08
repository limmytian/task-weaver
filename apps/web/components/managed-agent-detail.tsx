"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { setProjectMembershipSchema, type ProjectRole } from "@task-weaver/contracts";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/trpc/routers/_app";
import { trpc } from "@/trpc/client";
import { useIdentityConfirmation } from "@/components/identity-confirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ProjectOption = inferRouterOutputs<AppRouter>["auth"]["agentProjects"][number];

export function ManagedAgentDetail({ actorId, onClose }: { actorId: string; onClose: () => void }) {
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => { panelRef.current?.focus(); }, []);
  const detail = trpc.auth.agentDetail.useQuery({ id: actorId });
  const [view, setView] = useState<"memberships" | "available">("memberships");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const projects = trpc.auth.agentProjects.useQuery({ actorId, view, query, page, pageSize: 20 });
  const [editing, setEditing] = useState<ProjectOption | null>(null);
  return (
    <section ref={panelRef} tabIndex={-1} aria-label="Agent details" className="min-w-0 space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="break-words text-lg font-medium">{detail.data?.displayName ?? "Agent details"}</h2>
        <Button variant="outline" onClick={onClose}>Close details</Button>
      </div>
      <code className="block break-all text-xs">{actorId}</code>
      <p className="text-sm">Status: {detail.data?.status ?? "Loading…"}. Disabled identities cannot be restored.</p>
      <p className="text-sm text-muted-foreground">
        Personal access comes from the managing human&apos;s personal space; global access is read-only under the existing policy.
        Every Key further limits these rights. Project role permissions and explicit execution/tool permissions are separate.
        Changing membership never expands an existing Key or restores revoked credentials or executions.
      </p>
      <p className="break-all text-xs text-muted-foreground">Personal scope owner: {detail.data?.managedByActorId ?? "Loading…"}. This policy does not grant access to the manager&apos;s projects.</p>
      {detail.data?.status === "active" && <Link className="inline-block text-sm underline" href={`/projects/settings/api-keys?agent=${actorId}`}>Next: create a scoped Key for this Agent</Link>}
      <nav aria-label="Agent project access" className="flex flex-wrap gap-2">
        <Button variant={view === "memberships" ? "default" : "outline"} onClick={() => { setView("memberships"); setQuery(""); setPage(1); setEditing(null); }}>Current memberships</Button>
        {detail.data?.status === "active" && <Button variant={view === "available" ? "default" : "outline"} onClick={() => { setView("available"); setQuery(""); setPage(1); setEditing(null); }}>Add project access</Button>}
      </nav>
      <Input aria-label="Search authorized projects" placeholder="Search project names" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
      {(detail.error || projects.error) && <p role="alert">Agent permissions are unavailable. Refresh and check your current access.</p>}
      {projects.isFetching && <p role="status">Loading project access…</p>}
      {projects.data?.length === 0 && <p className="text-sm text-muted-foreground">
        {detail.data?.status === "disabled" ? "No historical project memberships visible to you. Disabled Agents cannot receive access." : view === "memberships" ? "No project memberships visible to you. Add access where you administer members; creating an Agent alone grants no project access." : "No matching projects where you can administer members. Instance administration alone grants no project access."}
      </p>}
      {projects.data?.map(option => (
        <div key={option.project.id} className="space-y-2 rounded-md border p-3">
          <p className="break-words font-medium">{option.project.name}</p>
          <code className="block break-all text-xs">{option.project.id}</code>
          <p className="text-sm">Role: {option.membership?.role ?? "No membership"}</p>
          <p className="break-words text-sm">Role permissions: {option.rolePermissions.join(", ") || "None"}</p>
          <p className="break-words text-sm">Explicit permissions: {option.membership?.explicitPermissions.join(", ") || "None"}</p>
          <p className="break-words text-sm">Effective project permissions: {detail.data?.status === "active" ? [...new Set([...option.rolePermissions, ...(option.membership?.explicitPermissions ?? [])])].join(", ") || "None" : "None"}. Key ceilings may further restrict these rights.</p>
          {detail.data?.status === "disabled" && <p className="text-sm text-muted-foreground">Historical membership only: this disabled Agent has no effective access.</p>}
          {option.canManage && <Button variant="outline" onClick={() => setEditing(option)}>{option.membership ? "Edit permissions" : "Assign permissions"}</Button>}
        </div>
      ))}
      <nav aria-label="Agent project pages" className="flex items-center gap-3">
        <Button variant="outline" disabled={page === 1 || projects.isFetching} onClick={() => setPage(page - 1)}>Previous</Button>
        <span className="text-sm">Page {page}</span>
        <Button variant="outline" disabled={projects.isFetching || (projects.data?.length ?? 0) < 20} onClick={() => setPage(page + 1)}>Next</Button>
      </nav>
      {editing && <AgentMembershipEditor key={editing.project.id} actorId={actorId} option={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function AgentMembershipEditor({ actorId, option, onClose }: { actorId: string; option: ProjectOption; onClose: () => void }) {
  const roleRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { roleRef.current?.focus(); }, []);
  const confirmation = useIdentityConfirmation();
  const utils = trpc.useUtils();
  const set = trpc.auth.setMember.useMutation();
  const remove = trpc.auth.removeMember.useMutation();
  const [error, setError] = useState("");
  const [role, setRole] = useState<ProjectRole>(option.membership?.role ?? "member");
  const busy = confirmation.confirming || set.isPending || remove.isPending;
  async function perform(action: () => Promise<unknown>, description: string) {
    if (!(await confirmation.confirm(description))) return;
    setError("");
    try {
      await action();
      await Promise.all([utils.auth.invalidate(), utils.apiKey.invalidate()]);
      onClose();
    } catch {
      setError("Membership update denied or unavailable. Your role or the Agent status may have changed. Refresh before retrying.");
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const member = setProjectMembershipSchema.parse({ role, explicitPermissions: data.getAll("permission") });
    await perform(() => set.mutateAsync({ projectId: option.project.id, actorId, member }), `save Agent permissions for ${option.project.name}`);
  }
  return (
    <form onSubmit={submit} aria-label="Edit Agent membership" className="space-y-3 rounded-md border p-3">
      {confirmation.dialog}
      <h3 className="break-words font-medium">Permissions for {option.project.name}</h3>
      <label htmlFor="agent-project-role" className="text-sm font-medium">Project role</label>
      <select ref={roleRef} id="agent-project-role" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={role} onChange={event => setRole(event.target.value as ProjectRole)}>
        {option.roles.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Explicit execution and tool permissions</legend>
        {option.grantablePermissions.map(permission => (
          <label key={permission} className="flex items-center gap-2 text-sm">
            <input name="permission" type="checkbox" value={permission} defaultChecked={option.membership?.explicitPermissions.includes(permission)} />{permission}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">Existing Keys keep their issued ceilings. Reduced permissions apply to subsequent protected operations.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy}>Save permissions</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel editing</Button>
        {option.membership && <Button type="button" variant="destructive" disabled={busy} onClick={() => void perform(() => remove.mutateAsync({ projectId: option.project.id, actorId }), `remove Agent access to ${option.project.name}`)}>Remove project access</Button>}
      </div>
    </form>
  );
}
