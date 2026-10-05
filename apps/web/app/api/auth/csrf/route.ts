import {
  authenticationFailure,
  takeAuthenticationResult,
} from "@task-weaver/core";
import { getWebAuthenticationRuntime } from "../../../../trpc/init";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const auth = getWebAuthenticationRuntime().auth;
    auth.assertOrigin(request.headers);
    if (request.headers.has("authorization"))
      await auth.verify(request.headers);
    const headers = new Headers({ "cache-control": "no-store" });
    const body = takeAuthenticationResult(
      auth.authentication.csrfChallenge(request.headers),
      headers,
    );
    return Response.json(body, { headers });
  } catch (error) {
    const failure = authenticationFailure(error);
    return Response.json(
      { error: failure.error, code: failure.code },
      { status: failure.status, headers: { "cache-control": "no-store" } },
    );
  }
}
