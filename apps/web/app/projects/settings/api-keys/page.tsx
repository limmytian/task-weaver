"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  issueOwnedApiKeySchema,
  managedAgentProjectsSchema,
  type AuthorizationGrant,
  type AuthorizationPermission,
} from "@task-weaver/contracts";
import { useWebIdentity } from "@/components/web-identity-provider";
import { OneTimeSecret } from "@/components/one-time-secret";
import { useIdentityConfirmation } from "@/components/identity-confirmation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
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
  const keys = trpc.apiKey.list.useQuery(target);
  const options = trpc.apiKey.grantOptions.useQuery(target);
  const create = trpc.apiKey.create.useMutation();
  const rotate = trpc.apiKey.rotate.useMutation();
  const revoke = trpc.apiKey.revoke.useMutation();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const confirmation = useIdentityConfirmation();
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<
    Record<string, AuthorizationPermission[]>
  >({});
  const [expiry, setExpiry] = useState("90");
  const busy = confirmation.confirming || create.isPending || rotate.isPending || revoke.isPending;
  const grantId = (grant: AuthorizationGrant) =>
    grant.scope === "project"
      ? `project:${grant.projectId}`
      : grant.scope === "personal"
        ? `personal:${grant.actorId}`
        : grant.scope;
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
      const grants = (options.data ?? []).flatMap((grant) => {
        const permissions =
          selected[grantId(grant)]?.filter((permission) =>
            grant.permissions.includes(permission),
          ) ?? [];
        return permissions.length ? [{ ...grant, permissions }] : [];
      });
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
      setSelected({});
    });
  }
  return (
    <section className="space-y-5">
      {confirmation.dialog}
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
        <select
          id="key-subject"
          value={subject}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          onChange={(event) => {
            setSubject(event.target.value);
            setSelected({});
            setSecret(null);
            setError("");
          }}
        >
          <option value={identity.id}>You (human)</option>
          {selectedAgent.data?.status === "active" && !agents.data?.some(agent => agent.id === selectedAgent.data?.id) && <option value={selectedAgent.data.id}>{selectedAgent.data.displayName} · {selectedAgent.data.id} (managed Agent)</option>}
          {agents.data
            ?.filter((agent) => agent.status === "active")
            .map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName} · {agent.id} (managed Agent)
              </option>
            ))}
        </select>
      </div>
      {secret && (
        <OneTimeSecret
          key={secret}
          value={secret}
          label="New API Key (shown once)"
          onDismiss={() => setSecret(null)}
        />
      )}
      {(error || keys.error || options.error) && (
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
        <select
          id="key-expiry"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        >
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">One year</option>
          <option value="custom">Custom date</option>
          <option value="never">Never (still revocable)</option>
        </select>
        {expiry === "custom" && (
          <Input
            aria-label="Custom expiry"
            name="expiresAt"
            type="datetime-local"
            required
          />
        )}
        <div className="space-y-3">
          {options.data?.map((grant) => (
            <fieldset
              key={grantId(grant)}
              className="min-w-0 rounded-md border p-3"
            >
              <legend className="break-all px-1 text-sm">
                {grantId(grant)}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {grant.permissions.map((permission) => (
                  <label
                    key={permission}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={
                        selected[grantId(grant)]?.includes(permission) ?? false
                      }
                      onChange={(event) =>
                        setSelected((previous) => ({
                          ...previous,
                          [grantId(grant)]: event.target.checked
                            ? [...(previous[grantId(grant)] ?? []), permission]
                            : (previous[grantId(grant)] ?? []).filter(
                                (item) => item !== permission,
                              ),
                        }))
                      }
                    />
                    {permission}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <Button
          disabled={
            busy ||
            options.isLoading ||
            options.isError ||
            !Object.values(selected).some((value) => value.length)
          }
        >
          Create scoped Key
        </Button>
      </form>
      <div className="space-y-3">
        {keys.data
          ?.filter((key) => !key.revokedAt)
          .map((key) => (
            <div key={key.id} className="space-y-2 rounded-md border p-3">
              <p className="font-medium">{key.name}</p>
              <p className="text-xs text-muted-foreground">
                {key.prefix}… ·{" "}
                {key.expiresAt
                  ? `Expires ${new Date(key.expiresAt).toLocaleString()}`
                  : "No time-based expiry"}
              </p>
              <ul className="space-y-1 text-xs">
                {key.grants.map((grant, index) => (
                  <li className="break-all" key={index}>
                    {grantId(grant)}: {grant.permissions.join(", ")}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
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
    </section>
  );
}
