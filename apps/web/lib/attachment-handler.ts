import { authenticationFailure, handleAttachmentRequest } from "@task-weaver/core";
import type { getWebAuthenticationRuntime } from "@/trpc/init";

export function createAttachmentHandler(getRuntime: typeof getWebAuthenticationRuntime) {
  return async (request: Request, id?: string, versions = false) => {
    try {
      const { auth, db } = getRuntime();
      auth.assertOrigin(request.headers);
      const identity = await auth.verify(request.headers);
      if (request.method !== "GET") auth.authentication.assertMutation(request.headers);
      return await handleAttachmentRequest(db, identity, request, id, versions);
    } catch (error) {
      const failure = authenticationFailure(error);
      return Response.json({ error: failure.error, code: failure.code }, { status: failure.status, headers: { "cache-control": "no-store" } });
    }
  };
}
