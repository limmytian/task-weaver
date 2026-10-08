"use client";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import {
  projectRoleSchema,
  setProjectMembershipSchema,
  explicitProjectPermissionSchema,
  type ProjectRole,
} from "@task-weaver/contracts";
import { useIdentityConfirmation } from "@/components/identity-confirmation";
import { trpc } from "@/trpc/client";
import { useWebIdentity } from "@/components/web-identity-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ProjectMembers({ projectId }: { projectId: string }) {
  const actor = useWebIdentity();
  const members = trpc.auth.members.useQuery({ projectId });
  const candidates = trpc.auth.assignees.useQuery({ projectId });
  const agents = trpc.auth.agents.useQuery();
  const permissions = trpc.auth.permissions.useQuery();
  const grant = permissions.data?.grants.find(
    (grant) => grant.scope === "project" && grant.projectId === projectId,
  );
  const canManage = grant?.permissions.includes("project.members.manage");
  const canOwn = grant?.permissions.includes("project.ownership.manage");
  const current = members.data?.find((member) => member.actor.id === actor.id);
  const roles: ProjectRole[] = canOwn
    ? [...projectRoleSchema.options]
    : ["member", "viewer"];
  const set = trpc.auth.setMember.useMutation();
  const remove = trpc.auth.removeMember.useMutation();
  const transfer = trpc.auth.transferOwnership.useMutation();
  const [error, setError] = useState("");
  const utils = trpc.useUtils();
  const confirmation = useIdentityConfirmation();
  const busy = confirmation.confirming || set.isPending || remove.isPending || transfer.isPending;
  async function perform(action: () => Promise<unknown>) {
    setError("");
    if (!(await confirmation.confirm("save this sensitive change"))) return;
    try {
      await action();
      await utils.auth.invalidate();
    } catch {
      setError(
        "Membership change denied. Confirm your identity, current role and last-owner protections.",
      );
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await perform(async () => {
      const actorId = z.string().uuid().parse(data.get("actorId"));
      const member = setProjectMembershipSchema.parse({
        role: data.get("role"),
        explicitPermissions: data.getAll("permission"),
      });
      await set.mutateAsync({ projectId, actorId, member });
      form.reset();
    });
  }
  return (
    <section className="space-y-4 rounded-md border p-4">
      {confirmation.dialog}
      <h2 className="text-lg font-medium">Project members and permissions</h2>
      <p className="text-sm text-muted-foreground">
        Your role: {current?.role ?? "unavailable"}. Execution and tool actions
        require explicit approval. Instance administration grants no project
        membership.
      </p>
      {(error || members.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || "Project memberships are unavailable."}
        </p>
      )}
      {members.data?.map((member) => {
        const manageable =
          canManage &&
          member.actor.id !== actor.id &&
          (canOwn || (member.role !== "owner" && member.role !== "maintainer"));
        return (
          <div key={member.id} className="space-y-2 rounded-md border p-3">
            <p>
              {candidates.data?.find(
                (candidate) => candidate.id === member.actor.id,
              )?.displayName ?? member.actor.id}{" "}
              ({member.actor.type})
            </p>
            <code className="block break-all text-xs">{member.actor.id}</code>
            <p className="text-sm">
              {member.role} ·{" "}
              {member.explicitPermissions.join(", ") ||
                "No explicit execution/tool grants"}
            </p>
            {manageable && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Remove this member and revoke current access and executions?",
                    )
                  )
                    void perform(() =>
                      remove.mutateAsync({
                        projectId,
                        actorId: member.actor.id,
                      }),
                    );
                }}
              >
                Remove member
              </Button>
            )}
            {canOwn &&
              member.actor.type === "human" &&
              member.actor.id !== actor.id && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Transfer your project ownership to this human member?",
                      )
                    )
                      void perform(() =>
                        transfer.mutateAsync({
                          projectId,
                          actorId: member.actor.id,
                        }),
                      );
                  }}
                >
                  Transfer ownership
                </Button>
              )}
          </div>
        );
      })}
      {canManage ? (
        <form onSubmit={submit} className="space-y-3">
          <h3 className="font-medium">Add or update membership</h3>
          <p className="text-sm text-muted-foreground">
            Use a known stable actor ID. The server verifies eligibility and
            your grant ceiling. Existing memberships and your managed Agents are
            suggested; no instance-wide account directory is exposed.
          </p>
          <label htmlFor="member-actor" className="text-sm font-medium">
            Actor ID
          </label>
          <Input
            id="member-actor"
            name="actorId"
            list="member-options"
            required
          />
          <datalist id="member-options">
            {members.data
              ?.filter((member) => member.actor.id !== actor.id)
              .map((member) => (
                <option key={member.actor.id} value={member.actor.id}>
                  {member.actor.type}
                </option>
              ))}
            {agents.data
              ?.filter(
                (agent) =>
                  agent.status === "active" &&
                  !members.data?.some((member) => member.actor.id === agent.id),
              )
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
          </datalist>
          <label htmlFor="member-role" className="text-sm font-medium">
            Role
          </label>
          <select
            id="member-role"
            name="role"
            defaultValue="member"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            {roles.map((role) => (
              <option key={role}>{role}</option>
            ))}
          </select>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Explicit entitlements
            </legend>
            {explicitProjectPermissionSchema.options.map((permission) => (
              <label
                key={permission}
                className="flex items-center gap-2 text-sm"
              >
                <input name="permission" type="checkbox" value={permission} />
                {permission}
              </label>
            ))}
          </fieldset>
          <Button disabled={busy}>Save membership</Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Membership changes require project member administration permission.
        </p>
      )}
    </section>
  );
}
