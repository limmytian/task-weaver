"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  issueOwnedApiKeySchema,
  managedAgentProjectsSchema,
} from "@task-weaver/contracts";
import { useWebIdentity } from "@/components/web-identity-provider";
import { OneTimeSecret } from "@/components/one-time-secret";
import { useIdentityConfirmation } from "@/components/identity-confirmation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { KeyGrantPicker, type NamedGrant } from "@/components/key-grant-picker";
import { KeyDetailDialog } from "@/components/key-detail-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

export default function ApiKeysSettingsPage() {
  const identity = useWebIdentity();
  const [agentSearch, setAgentSearch] = useState("");
  const [agentPage, setAgentPage] = useState(1);
  const agents = trpc.auth.agents.useQuery({ status: "active", query: agentSearch, page: agentPage, pageSize: 20 });
  const [subject, setSubject] = useState(identity.id);
  const selectedAgent = trpc.auth.agentDetail.useQuery({ id: subject }, { enabled: subject !== identity.id, retry: false });
  const [linkedAgentId, setLinkedAgentId] = useState<string | null>(null);
  const linkedAgent = trpc.auth.agentDetail.useQuery({ id: linkedAgentId ?? identity.id }, { enabled: linkedAgentId !== null, retry: false });
  useEffect(() => {
    const actorId = new URLSearchParams(window.location.search).get("agent");
    if (managedAgentProjectsSchema.safeParse({ actorId }).success) setLinkedAgentId(actorId);
  }, []);
  useEffect(() => {
    if (linkedAgent.data?.status === "active") setSubject(linkedAgent.data.id);
  }, [linkedAgent.data]);
  const target = { actorId: subject };
  const [keyPage, setKeyPage] = useState(1);
  const keys = trpc.apiKey.summaries.useQuery({ ...target, page: keyPage, pageSize: 20 });
  const [detailId, setDetailId] = useState<string | null>(null);
  const create = trpc.apiKey.create.useMutation();
  const rotate = trpc.apiKey.rotate.useMutation();
  const revoke = trpc.apiKey.revoke.useMutation();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const confirmation = useIdentityConfirmation();
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<NamedGrant[]>([]);
  const [expiry, setExpiry] = useState("90");
  const busy = confirmation.confirming || create.isPending || rotate.isPending || revoke.isPending;
  async function perform(action: () => Promise<void>) {
    setSecret(null);
    setError("");
    if (!(await confirmation.confirm("save this sensitive change"))) return;
    try {
      await action();
      await utils.apiKey.invalidate();
    } catch {
      setError(
        "Credential operation denied or unavailable. Confirm your identity and current scope before retrying.",
      );
    } finally {
      create.reset();
      rotate.reset();
      revoke.reset();
      queryClient.getMutationCache().clear();
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await perform(async () => {
      const grants = selected.map(item => item.grant);
      const expiresAt =
        expiry === "never"
          ? null
          : expiry === "custom"
            ? new Date(String(data.get("expiresAt"))).toISOString()
            : new Date(Date.now() + Number(expiry) * 86400000).toISOString();
      const result = await create.mutateAsync(
        issueOwnedApiKeySchema.parse({
          actorId: subject,
          name: data.get("name"),
          expiresAt,
          grants,
        }),
      );
      setSecret(result.rawKey);
      form.reset();
      setSelected([]);
    });
  }
  return (
    <section className="space-y-5">
      {confirmation.dialog}
      {detailId && <KeyDetailDialog key={detailId} actorId={subject} id={detailId} onClose={() => setDetailId(null)} />}
      <h1 className="text-xl font-semibold">Scoped API Keys</h1>
      <p className="text-sm text-muted-foreground">
        Human Keys act as that human. Agent Keys retain an independent identity.
        Issuance is limited by your current authority and the subject&apos;s
        rights; membership changes and revocation remain effective.
      </p>
      {linkedAgentId && (linkedAgent.error || linkedAgent.data?.status === "disabled") && <p role="alert">The requested Agent is unavailable or retired. Choose an active credential owner.</p>}
      <div className="space-y-2">
        <Input aria-label="Search active credential Agents" placeholder="Search active Agent names" value={agentSearch} onChange={event => { setAgentSearch(event.target.value); setAgentPage(1); }} />
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={agentPage === 1 || agents.isFetching} onClick={() => setAgentPage(agentPage - 1)}>Previous Agents</Button>
          <span className="text-sm">Page {agentPage}</span>
          <Button variant="outline" disabled={agents.isFetching || (agents.data?.length ?? 0) < 20} onClick={() => setAgentPage(agentPage + 1)}>Next Agents</Button>
        </div>
        <label htmlFor="key-subject" className="text-sm font-medium">
          Credential owner
        </label>
        <Select value={subject} onValueChange={value => {
          setSubject(value); setKeyPage(1); setDetailId(null); setSelected([]); setSecret(null); setError("");
        }}>
          <SelectTrigger id="key-subject" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={identity.id}>You (human)</SelectItem>
            {selectedAgent.data?.status === "active" && !agents.data?.some(agent => agent.id === selectedAgent.data?.id) && <SelectItem value={selectedAgent.data.id}>{selectedAgent.data.displayName} (managed Agent)</SelectItem>}
            {agents.data?.filter(agent => agent.status === "active").map(agent => <SelectItem key={agent.id} value={agent.id}>{agent.displayName} (managed Agent)</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {secret && (
        <OneTimeSecret
          key={secret}
          value={secret}
          label="New API Key (shown once)"
          onDismiss={() => setSecret(null)}
        />
      )}
      {(error || keys.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ||
            "You cannot manage this subject's credentials, or its current scope is unavailable."}
        </p>
      )}
      <form onSubmit={submit} className="space-y-4 rounded-md border p-4">
        <h2 className="font-medium">Create Key</h2>
        <label className="text-sm font-medium" htmlFor="key-name">
          Name
        </label>
        <Input id="key-name" name="name" maxLength={255} required />
        <label className="text-sm font-medium" htmlFor="key-expiry">
          Expiry
        </label>
        <Select value={expiry} onValueChange={setExpiry}>
          <SelectTrigger id="key-expiry" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="30">30 days</SelectItem>
            <SelectItem value="90">90 days</SelectItem>
            <SelectItem value="365">One year</SelectItem>
            <SelectItem value="custom">Custom date</SelectItem>
            <SelectItem value="never">Never (still revocable)</SelectItem>
          </SelectContent>
        </Select>
        {expiry === "custom" && (
          <Input
            aria-label="Custom expiry"
            name="expiresAt"
            type="datetime-local"
            required
          />
        )}
        <KeyGrantPicker key={subject} actorId={subject} selected={selected} onChange={setSelected} disabled={busy} />
        <Button
          disabled={
            busy ||
            selected.length === 0 || selected.length > 100
          }
        >
          Create scoped Key
        </Button>
      </form>
      <div className="space-y-3">
        {keys.data?.items
          .filter((key) => !key.revokedAt)
          .map((key) => (
            <div key={key.id} className="space-y-2 rounded-md border p-3">
              <p className="font-medium">{key.name}</p>
              <p className="text-xs text-muted-foreground">
                {key.prefix}… ·{" "}
                {key.expiresAt
                  ? `Expires ${new Date(key.expiresAt).toLocaleString()}`
                  : "No time-based expiry"}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy} onClick={() => { setSecret(null); setDetailId(key.id); }}>Details / edit grants</Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Rotate this Key and invalidate its previous credential?",
                      )
                    )
                      void perform(async () => {
                        setSecret(
                          (await rotate.mutateAsync({ id: key.id, ...target }))
                            .rawKey,
                        );
                      });
                  }}
                >
                  Rotate
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Revoke this Key and dependent executions?",
                      )
                    )
                      void perform(async () => {
                        await revoke.mutateAsync({ id: key.id, ...target });
                      });
                  }}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
      </div>
      <nav aria-label="Key pages" className="flex items-center gap-2"><Button variant="outline" disabled={busy || keys.isFetching || keyPage === 1} onClick={() => setKeyPage(keyPage - 1)}>Previous Keys</Button><span>Page {keyPage}</span><Button variant="outline" disabled={busy || keys.isFetching || !keys.data?.hasNext} onClick={() => setKeyPage(keyPage + 1)}>Next Keys</Button></nav>
    </section>
  );
}
