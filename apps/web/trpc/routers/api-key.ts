import { z } from "zod";
import {
  issueOwnedApiKeySchema,
  keyGrantOptionsSchema,
  updateApiKeyGrantsSchema,
  credentialSubjectSchema,
  takeAuthenticationResult,
} from "@task-weaver/core";
import { router, protectedProcedure } from "../init";
const reference = credentialSubjectSchema.extend({ id: z.string().uuid() });
export const apiKeyRouter = router({
  summaries: protectedProcedure.input(keyGrantOptionsSchema).query(({ ctx, input }) => ctx.auth.identity.keySummaries(ctx.req.headers, input)),
  pagedGrantOptions: protectedProcedure.input(keyGrantOptionsSchema).query(({ ctx, input }) => ctx.auth.identity.pagedKeyGrantOptions(ctx.req.headers, input)),
  detail: protectedProcedure.input(reference).query(({ ctx, input }) => ctx.auth.identity.keyDetail(ctx.req.headers, input.actorId ?? ctx.identity.actor.id, input.id)),
  updateGrants: protectedProcedure.input(reference.merge(updateApiKeyGrantsSchema)).mutation(({ ctx, input }) => {
    const { actorId, id, ...change } = input;
    return ctx.auth.identity.updateKeyGrants(ctx.req.headers, actorId ?? ctx.identity.actor.id, id, change);
  }),
  grantOptions: protectedProcedure
    .input(credentialSubjectSchema.optional())
    .query(({ ctx, input }) =>
      ctx.auth.identity.keyGrantOptions(
        ctx.req.headers,
        input?.actorId ?? ctx.identity.actor.id,
      ),
    ),
  list: protectedProcedure
    .input(credentialSubjectSchema.optional())
    .query(({ ctx, input }) =>
      ctx.auth.identity.listKeys(
        ctx.req.headers,
        input?.actorId ?? ctx.identity.actor.id,
      ),
    ),
  create: protectedProcedure
    .input(issueOwnedApiKeySchema)
    .mutation(async ({ ctx, input }) => {
      const { actorId, ...key } = input;
      return takeAuthenticationResult(
        await ctx.auth.identity.issueKey(
          ctx.req.headers,
          actorId ?? ctx.identity.actor.id,
          key,
        ),
        ctx.responseHeaders,
      );
    }),
  revoke: protectedProcedure
    .input(reference)
    .mutation(({ ctx, input }) =>
      ctx.auth.identity.revokeKey(
        ctx.req.headers,
        input.actorId ?? ctx.identity.actor.id,
        input.id,
      ),
    ),
  rotate: protectedProcedure
    .input(reference)
    .mutation(async ({ ctx, input }) =>
      takeAuthenticationResult(
        await ctx.auth.identity.rotateKey(
          ctx.req.headers,
          input.actorId ?? ctx.identity.actor.id,
          input.id,
        ),
        ctx.responseHeaders,
      ),
    ),
});
