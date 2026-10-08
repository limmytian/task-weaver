import { z } from "zod";
import {
  accountLoginSchema,
  bootstrapAccountSchema,
  activateAccountSchema,
  provisionAccountSchema,
  reauthenticateAccountSchema,
  changeAccountPasswordSchema,
  changeAccountStateSchema,
  createManagedAgentSchema,
  managedAgentListSchema,
  managedAgentProjectsSchema,
  setProjectMembershipSchema,
  transferProjectOwnershipSchema,
  createProjectSchema,
  takeAuthenticationResult,
} from "@task-weaver/core";
import {
  router,
  publicProcedure,
  protectedProcedure,
  adminProcedure,
} from "../init";

const reference = z.object({ id: z.string().uuid() }).strict();
const membership = z
  .object({ projectId: z.string().uuid(), actorId: z.string().uuid() })
  .strict();
export const authRouter = router({
  setupStatus: publicProcedure.query(async ({ ctx }) =>
    takeAuthenticationResult(await ctx.auth.authentication.setupStatus(), ctx.responseHeaders),
  ),
  csrf: publicProcedure.query(({ ctx }) =>
    takeAuthenticationResult(
      ctx.auth.authentication.csrfChallenge(ctx.req.headers),
      ctx.responseHeaders,
    ),
  ),
  login: publicProcedure
    .input(accountLoginSchema)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.authentication.login(
          ctx.req.headers,
          input,
          "next-direct-address-unavailable",
        ),
        ctx.responseHeaders,
      ),
    ),
  bootstrap: publicProcedure
    .input(bootstrapAccountSchema)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.authentication.bootstrap(
          ctx.req.headers,
          input,
          "next-direct-address-unavailable",
        ),
        ctx.responseHeaders,
      ),
    ),
  activate: publicProcedure
    .input(activateAccountSchema)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.authentication.activate(
          ctx.req.headers,
          input,
          "next-direct-address-unavailable",
        ),
        ctx.responseHeaders,
      ),
    ),
  permissions: protectedProcedure.query(({ ctx }) =>
    ctx.auth.identity.permissions(ctx.req.headers),
  ),
  assignees: protectedProcedure
    .input(z.object({ projectId: z.string().uuid().optional() }).strict())
    .query(({ ctx, input }) =>
      ctx.auth.identity.listAssignees(ctx.req.headers, input.projectId),
    ),
  current: protectedProcedure.query(({ ctx }) =>
    ctx.auth.authentication.current(ctx.req.headers),
  ),
  logout: protectedProcedure.mutation(async ({ ctx }) =>
    takeAuthenticationResult(
      await ctx.auth.authentication.logout(ctx.req.headers),
      ctx.responseHeaders,
    ),
  ),
  reauthenticate: protectedProcedure
    .input(reauthenticateAccountSchema)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.authentication.reauthenticate(
          ctx.req.headers,
          input,
          "next-direct-address-unavailable",
        ),
        ctx.responseHeaders,
      ),
    ),
  password: protectedProcedure
    .input(changeAccountPasswordSchema)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.authentication.changePassword(
          ctx.req.headers,
          input,
          "next-direct-address-unavailable",
        ),
        ctx.responseHeaders,
      ),
    ),
  sessions: protectedProcedure.query(({ ctx }) =>
    ctx.auth.authentication.listSessions(ctx.req.headers),
  ),
  revokeSession: protectedProcedure
    .input(reference)
    .mutation(({ ctx, input }) =>
      ctx.auth.authentication.revokeSession(ctx.req.headers, input.id),
    ),
  accounts: adminProcedure.query(({ ctx }) =>
    ctx.auth.authentication.listAccounts(ctx.req.headers),
  ),
  provision: adminProcedure
    .input(provisionAccountSchema)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.authentication.provision(ctx.req.headers, input),
        ctx.responseHeaders,
      ),
    ),
  recover: adminProcedure
    .input(reference)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.authentication.recover(ctx.req.headers, input.id),
        ctx.responseHeaders,
      ),
    ),
  accountState: adminProcedure
    .input(reference.extend({ state: changeAccountStateSchema }))
    .mutation(({ ctx, input }) =>
      ctx.auth.authentication.setAccountState(
        ctx.req.headers,
        input.id,
        input.state,
      ),
    ),
  agents: protectedProcedure.input(managedAgentListSchema.optional()).query(({ ctx, input }) =>
    ctx.auth.identity.listAgents(ctx.req.headers, input),
  ),
  agentDetail: protectedProcedure.input(reference).query(({ ctx, input }) =>
    ctx.auth.identity.agentDetail(ctx.req.headers, input.id),
  ),
  agentProjects: protectedProcedure.input(managedAgentProjectsSchema).query(({ ctx, input }) =>
    ctx.auth.identity.agentProjects(ctx.req.headers, input),
  ),
  deleteAgent: protectedProcedure.input(reference).mutation(({ ctx, input }) =>
    ctx.auth.identity.deleteAgent(ctx.req.headers, input.id),
  ),
  createAgent: protectedProcedure
    .input(createManagedAgentSchema)
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.createAgent(ctx.req.headers, input),
    ),
  disableAgent: protectedProcedure
    .input(reference)
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.disableAgent(ctx.req.headers, input.id),
    ),
  disableAgentAsAdministrator: adminProcedure
    .input(reference)
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.disableAgentAsAdministrator(ctx.req.headers, input.id),
    ),
  createProject: protectedProcedure
    .input(createProjectSchema.strict())
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.createProject(ctx.req.headers, input),
    ),
  members: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }).strict())
    .query(({ ctx, input }) =>
      ctx.auth.identity.listMemberships(ctx.req.headers, input.projectId),
    ),
  setMember: protectedProcedure
    .input(membership.extend({ member: setProjectMembershipSchema }))
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.setMembership(
        ctx.req.headers,
        input.projectId,
        input.actorId,
        input.member,
      ),
    ),
  removeMember: protectedProcedure
    .input(membership)
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.removeMembership(
        ctx.req.headers,
        input.projectId,
        input.actorId,
      ),
    ),
  transferOwnership: protectedProcedure
    .input(
      transferProjectOwnershipSchema.extend({ projectId: z.string().uuid() }),
    )
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.transferOwnership(
        ctx.req.headers,
        input.projectId,
        input.actorId,
      ),
    ),
});
