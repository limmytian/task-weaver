"use client";

import { useState } from "react";
import { toast } from "sonner";
import { inboundRuleSchema } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function InboundEventsPage() {
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery();
  const [projectId, setProjectId] = useState("");
  const [requirementId, setRequirementId] = useState("");
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("build.completed");
  const [title, setTitle] = useState("External event {{data.title}}");
  const [secret, setSecret] = useState("");
  const [selected, setSelected] = useState("");
  const [eventId, setEventId] = useState("");
  const [editing, setEditing] = useState("");
  const [rules, setRules] = useState("");
  const [offset, setOffset] = useState(0);
  const requirements = trpc.requirement.list.useQuery({ projectId }, { enabled: !!projectId });
  const sources = trpc.inbound.list.useQuery({ projectId }, { enabled: !!projectId });
  const history = trpc.inbound.history.useQuery({ id: selected, filters: { offset, limit: 20 } }, { enabled: !!selected, refetchInterval: selected ? 5000 : false });
  const actions = trpc.inbound.actions.useQuery({ id: selected, eventId }, { enabled: !!selected && !!eventId });
  const failure = (error: { message: string }) => toast.error(error.message);
  const refresh = async () => { await utils.inbound.invalidate(); };
  const create = trpc.inbound.create.useMutation({ onSuccess: async source => { setSecret(source.secret); setSelected(source.id); setName(""); await refresh(); }, onError: failure });
  const update = trpc.inbound.update.useMutation({ onSuccess: async source => { if (source.secret) setSecret(source.secret); setEditing(""); await refresh(); }, onError: failure });
  const remove = trpc.inbound.delete.useMutation({ onSuccess: async () => { setSelected(""); await refresh(); }, onError: failure });
  const retry = trpc.inbound.retry.useMutation({ onSuccess: refresh, onError: failure });
  return <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
    <div><h1 className="text-2xl font-semibold">Inbound Events</h1><p className="text-sm text-muted-foreground">Receive signed events and apply bounded actions within a project and requirement.</p></div>
    <label className="block text-sm">Project<select className="mt-1 block w-full rounded-md border bg-background p-2" value={projectId} onChange={event => { setProjectId(event.target.value); setRequirementId(""); setSelected(""); setEventId(""); }}>
      <option value="">Select a project</option>{projects.data?.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
    </select></label>
    {sources.error && <p role="alert" className="text-destructive">{sources.error.message}</p>}
    {projectId && <Card><CardHeader><CardTitle>Create source</CardTitle></CardHeader><CardContent>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); create.mutate({ name, projectId, requirementId, rules: [{ id: crypto.randomUUID(), eventTypes: [eventType], conditions: [], actions: [{ type: "create_task", title }] }] }); }}>
        <label className="block text-sm">Name<Input value={name} required onChange={event => setName(event.target.value)} /></label>
        <label className="block text-sm">Requirement<select className="mt-1 block w-full rounded-md border bg-background p-2" value={requirementId} required onChange={event => setRequirementId(event.target.value)}><option value="">Select a requirement</option>{requirements.data?.map(requirement => <option key={requirement.id} value={requirement.id}>{requirement.title}</option>)}</select></label>
        <label className="block text-sm">Event type<Input value={eventType} required onChange={event => setEventType(event.target.value)} /></label>
        <label className="block text-sm">New task title<Input value={title} required onChange={event => setTitle(event.target.value)} /></label>
        <p className="text-sm text-muted-foreground">Use {"{{data.title}}"} to insert an event value. Each matching event creates one task under the selected requirement.</p>
        <Button disabled={!requirementId || create.isPending}>Create source</Button>
      </form>
    </CardContent></Card>}
    {secret && <Card><CardHeader><CardTitle>Signing secret</CardTitle></CardHeader><CardContent className="space-y-2"><p className="text-sm">Copy this secret now. Sign the timestamp and raw request body using HMAC-SHA256.</p><pre className="overflow-auto rounded bg-muted p-3">{secret}</pre><Button variant="outline" onClick={() => setSecret("")}>Dismiss</Button></CardContent></Card>}
    {sources.data?.map(source => <Card key={source.id}><CardContent className="space-y-3 pt-5"><h2 className="font-medium">{source.name} · {source.active ? "Active" : "Paused"}</h2>
      <p className="break-all text-sm text-muted-foreground">Endpoint path: {source.endpoint}</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setSelected(source.id); setOffset(0); setEventId(""); }}>History</Button>
        <Button variant="outline" onClick={() => { setEditing(source.id); setRules(JSON.stringify(source.rules, null, 2)); }}>Edit rules</Button>
        <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: source.id, data: { active: !source.active } })}>{source.active ? "Pause" : "Resume"}</Button>
        <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: source.id, data: { rotateSecret: true } })}>Rotate secret</Button>
        <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: source.id })}>Delete</Button></div>
      {editing === source.id && <form className="space-y-2" onSubmit={event => { event.preventDefault(); try { update.mutate({ id: source.id, data: { rules: inboundRuleSchema.array().min(1).max(20).parse(JSON.parse(rules)) } }); } catch { toast.error("Enter valid bounded action rules"); } }}>
        <label className="block text-sm">Action rules<Textarea className="min-h-64 font-mono" value={rules} onChange={event => setRules(event.target.value)} /></label>
        <p className="text-sm text-muted-foreground">Supported actions: create task, add comment, update task, record evidence and run an existing schedule. Project and requirement scope are fixed.</p>
        <Button disabled={update.isPending}>Save rules</Button><Button variant="ghost" type="button" onClick={() => setEditing("")}>Cancel</Button>
      </form>}
    </CardContent></Card>)}
    {selected && <Card><CardHeader><CardTitle>Verified event history</CardTitle></CardHeader><CardContent className="space-y-3">
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.map(event => <div key={event.id} className="space-y-2 border-b pb-3 text-sm"><p>{event.eventType} · {event.status} · attempts {event.attempts}</p><p className="break-all text-muted-foreground">{event.externalId} · {new Date(event.receivedAt).toLocaleString()}</p>{event.errorCode && <p>{event.errorCode}</p>}
        <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setEventId(event.id)}>Actions</Button>{event.status === "failed" && <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ id: selected, eventId: event.id })}>Retry</Button>}</div>
      </div>)}
      <div className="flex gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button><Button variant="outline" disabled={(history.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Next</Button></div>
      {eventId && <section className="space-y-2"><h3 className="font-medium">Committed actions</h3>{actions.error && <p role="alert">{actions.error.message}</p>}{actions.data?.map(action => <p key={action.id} className="break-all text-sm">{action.actionType} · {action.entityId}</p>)}</section>}
    </CardContent></Card>}
  </main>;
}
