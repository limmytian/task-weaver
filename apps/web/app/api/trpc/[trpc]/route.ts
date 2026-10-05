import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../trpc/routers/_app";
import { createTRPCContext } from "../../../../trpc/init";
import { authenticationFailure } from "@task-weaver/core";

export const runtime = "nodejs";
const handler = async (req: Request) => {
  try {
    return await fetchRequestHandler({
      endpoint: "/api/trpc",
      req,
      router: appRouter,
      createContext: createTRPCContext,
    });
  } catch (error) {
    const failure = authenticationFailure(error);
    return Response.json(
      { error: failure.error, code: failure.code },
      { status: failure.status, headers: { "cache-control": "no-store" } },
    );
  }
};

export { handler as GET, handler as POST };
