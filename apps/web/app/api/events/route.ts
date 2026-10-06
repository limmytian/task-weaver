import { initRealtime } from "@task-weaver/realtime";
import {
  authenticationFailure,
  createAuthorizedEventStream,
} from "@task-weaver/core";
import { getWebAuthenticationRuntime } from "../../../trpc/init";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const { auth, db } = getWebAuthenticationRuntime();
    auth.assertOrigin(request.headers);
    const context = await auth.verify(request.headers);
    await initRealtime(process.env.DATABASE_URL!);
    return await createAuthorizedEventStream(db, context, request);
  } catch (error) {
    const failure = authenticationFailure(error);
    return Response.json(
      { error: failure.error, code: failure.code },
      { status: failure.status, headers: { "cache-control": "no-store" } },
    );
  }
}
