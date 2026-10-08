"use client";
import { type FormEvent, useState } from "react";
import Link from "next/link";
import { createManagedAgentSchema } from "@task-weaver/contracts";
import { useIdentityConfirmation } from "@/components/identity-confirmation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ManagedAgentsPage() {
  const utils = trpc.useUtils();
  const confirmation = useIdentityConfirmation();
  const agents = trpc.auth.agents.useQuery();
  const create = trpc.auth.createAgent.useMutation();
  const disable = trpc.auth.disableAgent.useMutation();
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError("");
    if (!(await confirmation.confirm("create Agent"))) return;
    try {
      await create.mutateAsync(
        createManagedAgentSchema.parse(Object.fromEntries(new FormData(form))),
      );
      form.reset();
      await utils.auth.agents.invalidate();
    } catch {
      setError(
        "Agent creation denied or unavailable. Check your current permission.",
      );
    }
  }
  return (
    <section className="space-y-4">
      {confirmation.dialog}
      <h1 className="text-xl font-semibold">Your managed Agents</h1>
      <p className="text-sm text-muted-foreground">
        Agents have independent identities. Managing an Agent does not grant
        access to its personal content. Project membership and execution
        permissions are assigned separately.
      </p>
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="agent-name" className="text-sm font-medium">
          Display name
        </label>
        <Input id="agent-name" name="displayName" maxLength={255} required />
        <Button disabled={confirmation.confirming || create.isPending}>Create Agent</Button>
      </form>
      {(error || agents.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || "Managed Agents are unavailable."}
        </p>
      )}
      {agents.data?.map((agent) => (
        <div key={agent.id} className="space-y-2 rounded-md border p-3">
          <p>
            {agent.displayName} · {agent.status}
          </p>
          <code className="block break-all text-xs">{agent.id}</code>
          <div className="flex flex-wrap gap-2">
            <Link
              className="text-sm underline"
              href="/projects/settings/api-keys"
            >
              Manage scoped credentials
            </Link>
            <Button
              variant="destructive"
              disabled={confirmation.confirming || disable.isPending || agent.status !== "active"}
              onClick={async () => {
                if (
                  !window.confirm(
                    "Disable this Agent and revoke its credentials and executions?",
                  )
                )
                  return;
                if (!(await confirmation.confirm("disable Agent"))) return;
                try {
                  await disable.mutateAsync({ id: agent.id });
                  await utils.auth.agents.invalidate();
                } catch {
                  setError(
                    "Agent disable denied. Confirm your identity and current permission.",
                  );
                }
              }}
            >
              Disable Agent
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
