"use client";

import { useState } from "react";
import { toast } from "sonner";
import { webhookEventTypes } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type EventType = typeof webhookEventTypes[number];
export default function WebhooksPage() {
  const utils = trpc.useUtils();
  const hooks = trpc.webhook.list.useQuery({});
  const projects = trpc.project.list.useQuery();
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState("");
  const [url, setUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [events, setEvents] = useState<EventType[]>(["task.created"]);
  const [secret, setSecret] = useState("");
  const [offset, setOffset] = useState(0);
  const [deliveryId, setDeliveryId] = useState("");
  const history = trpc.webhook.deliveries.useQuery({ id: selected, filters: { limit: 20, offset } }, { enabled: !!selected, refetchInterval: selected ? 5000 : false });
  const attempts = trpc.webhook.attempts.useQuery({ id: selected, deliveryId }, { enabled: !!selected && !!deliveryId });
  const refresh = async () => { await utils.webhook.invalidate(); };
  const failure = (error: { message: string }) => toast.error(error.message);
  const create = trpc.webhook.create.useMutation({ onSuccess: async result => { setSecret(result.secret); setSelected(result.id); setUrl(""); await refresh(); }, onError: failure });
  const update = trpc.webhook.update.useMutation({ onSuccess: async result => { if (result.secret) setSecret(result.secret); setEditing(""); await refresh(); }, onError: failure });
  const remove = trpc.webhook.delete.useMutation({ onSuccess: async () => { setSelected(""); await refresh(); }, onError: failure });
  const sendTest = trpc.webhook.test.useMutation({ onSuccess: async result => { toast(result.status === "success" ? "Test delivered" : "Test recorded; inspect delivery history"); await refresh(); }, onError: failure });
  const replay = trpc.webhook.replay.useMutation({ onSuccess: async () => { toast("Replay recorded"); await refresh(); }, onError: failure });
  return <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
    <div><h1 className="text-2xl font-semibold">Webhooks</h1><p className="text-sm text-muted-foreground">Manage outbound events and inspect delivery attempts. Receivers should deduplicate using the event and delivery IDs.</p></div>
    {hooks.error && <p role="alert" className="text-destructive">{hooks.error.message}</p>}
    <Card><CardHeader><CardTitle>{editing ? "Edit webhook" : "Create webhook"}</CardTitle></CardHeader><CardContent>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (editing) update.mutate({ id: editing, data: { url, events } }); else create.mutate({ url, events, projectId: projectId || undefined }); }}>
        <label className="block text-sm">Receiver URL<Input type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/events" /></label>
        {!editing && <label className="block text-sm">Project<select className="mt-1 block w-full rounded-md border bg-background p-2" value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">Global (instance administrators)</option>{projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></label>}
        <fieldset><legend className="mb-2 text-sm">Events</legend><div className="grid gap-2 sm:grid-cols-3">{webhookEventTypes.map(type => <label key={type} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={events.includes(type)} onChange={event => setEvents(event.target.checked ? [...events, type] : events.filter(value => value !== type))} />{type}
        </label>)}</div></fieldset>
        <Button type="submit" disabled={!events.length || create.isPending || update.isPending}>{editing ? "Save changes" : "Create"}</Button>
        {editing && <Button type="button" variant="ghost" onClick={() => { setEditing(""); setUrl(""); }}>Cancel</Button>}
      </form>
    </CardContent></Card>
    {secret && <Card><CardHeader><CardTitle>Signing secret</CardTitle></CardHeader><CardContent className="space-y-2"><p className="text-sm">Copy this secret now. It is shown only when created or rotated.</p><pre className="overflow-auto rounded bg-muted p-3">{secret}</pre><Button variant="outline" onClick={() => setSecret("")}>Dismiss</Button></CardContent></Card>}
    <section className="space-y-3" aria-label="Configured webhooks">{hooks.data?.map(hook => <Card key={hook.id}><CardContent className="space-y-3 pt-5">
      <div className="break-all font-medium">{hook.url}</div><p className="text-sm text-muted-foreground">{hook.active ? "Active" : "Paused"} · {hook.events.join(", ")}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => { setSelected(hook.id); setOffset(0); setDeliveryId(""); }}>History</Button>
        <Button variant="outline" onClick={() => { setEditing(hook.id); setUrl(hook.url); setEvents(hook.events as EventType[]); }}>Edit</Button>
        <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: hook.id, data: { active: !hook.active } })}>{hook.active ? "Pause" : "Resume"}</Button>
        <Button variant="outline" disabled={!hook.active || sendTest.isPending} onClick={() => { setSelected(hook.id); sendTest.mutate({ id: hook.id }); }}>Send test</Button>
        <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: hook.id, data: { rotateSecret: true } })}>Rotate secret</Button>
        <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: hook.id })}>Delete</Button>
      </div>
    </CardContent></Card>)}</section>
    {!hooks.isLoading && !hooks.data?.length && <p className="text-muted-foreground">No webhooks accessible to this account.</p>}
    {selected && <Card><CardHeader><CardTitle>Delivery history</CardTitle></CardHeader><CardContent className="space-y-4">
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.map(delivery => <div key={delivery.id} className="space-y-2 border-b pb-3 text-sm">
        <p>{delivery.eventType} · {delivery.status} · HTTP {delivery.httpStatus ?? "—"} · retries {delivery.retryCount}</p>
        <p className="break-all text-muted-foreground">Event {delivery.eventId ?? "legacy"} · Delivery {delivery.id}</p>
        {delivery.errorCode && <p>{delivery.errorCode}{delivery.nextRetryAt ? ` · next retry ${new Date(delivery.nextRetryAt).toLocaleString()}` : " · automatic retries stopped"}</p>}
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setDeliveryId(delivery.id)}>Attempts</Button>
          <Button size="sm" variant="outline" disabled={replay.isPending || delivery.status === "pending"} onClick={() => replay.mutate({ id: selected, deliveryId: delivery.id })}>Replay</Button></div>
      </div>)}
      <div className="flex gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button><Button variant="outline" disabled={(history.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Next</Button></div>
      {deliveryId && <div className="space-y-2"><h3 className="font-medium">Attempts</h3>{attempts.error && <p role="alert">{attempts.error.message}</p>}{attempts.data?.map(attempt => <p key={attempt.id} className="text-sm">#{attempt.attempt + 1} · {attempt.outcome} · {attempt.httpStatus ?? "—"} {attempt.errorCode ?? ""} · {new Date(attempt.startedAt).toLocaleString()}</p>)}</div>}
    </CardContent></Card>}
  </main>;
}
