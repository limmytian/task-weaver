import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../trpc/routers/_app";
import { createTRPCContext } from "../../../../trpc/init";
import { authenticationFailure } from "@task-weaver/core";

export const runtime = "nodejs";
const handler = async (req: Request) => {
  try {
    // Bound staged-plan bodies before JSON parsing, including batched calls.
    if (req.method === "POST" && new URL(req.url).pathname.split("/").pop()?.split(",").some(name => name.startsWith("plan."))) {
      const reader = req.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024 + 64 * 1024) {
              await reader.cancel();
              return Response.json({ error: "Request exceeds the staging limit" }, { status: 413, headers: { "cache-control": "no-store" } });
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        req = new Request(req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks), signal: req.signal });
      }
    }
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req,
      router: appRouter,
      createContext: createTRPCContext,
    });
    if (new URL(req.url).pathname.split("/").pop()?.split(",").some(name => ["requirement.evidence", "requirement.compareGitEvidence", "requirement.gitEvidenceFile"].includes(name))) {
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-content-type-options", "nosniff");
    }
    return response;
  } catch (error) {
    const failure = authenticationFailure(error);
    return Response.json(
      { error: failure.error, code: failure.code },
      { status: failure.status, headers: { "cache-control": "no-store" } },
    );
  }
};

export { handler as GET, handler as POST };
