import {
  authenticationFailure,
  requireResourceAuthorization,
} from "@task-weaver/core";
import { getWebAuthenticationRuntime } from "../../../trpc/init";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const auth = getWebAuthenticationRuntime().auth;
    auth.assertOrigin(request.headers);
    await auth.verify(request.headers);
    // B4 must filter subscriptions and revalidate authority before any event or resume metadata is exposed.
    requireResourceAuthorization();
  } catch (error) {
    const failure = authenticationFailure(error);
    return Response.json(
      { error: failure.error, code: failure.code },
      { status: failure.status, headers: { "cache-control": "no-store" } },
    );
  }
}
