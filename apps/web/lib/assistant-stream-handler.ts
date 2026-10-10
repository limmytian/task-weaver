import { authenticationFailure, createAssistantService, streamAssistantMessageSchema, assistantStreamEventSchema } from "@task-weaver/core";
import type { getWebAuthenticationRuntime } from "@/trpc/init";

export function createAssistantStreamHandler(getRuntime: typeof getWebAuthenticationRuntime) {
  return async function POST(request: Request) {
    try {
      const { auth, db } = getRuntime();
      auth.assertOrigin(request.headers);
      const identity = await auth.verify(request.headers);
      auth.authentication.assertMutation(request.headers);
      let value: unknown;
      try { value = await request.json(); } catch { return Response.json({ error: "Invalid Chat request" }, { status: 400 }); }
      const parsed = streamAssistantMessageSchema.safeParse(value);
      if (!parsed.success) return Response.json({ error: "Invalid Chat request" }, { status: 400 });
      const service = createAssistantService(identity);
      // Fail authorization before opening a stream, including ownership of resumed conversations.
      await service.buildAssistantContext(db, { ...parsed.data.context, conversationId: parsed.data.conversationId });
      const encoder = new TextEncoder();
      let connected = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: unknown) => {
            const checked = assistantStreamEventSchema.parse(event);
            if (!connected) return;
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(checked)}\n\n`)); }
            catch { connected = false; }
          };
          const heartbeat = setInterval(() => {
            if (connected) { try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { connected = false; } }
          }, 15_000);
          // Disconnecting only detaches the display; persisted work is recovered by request ID.
          void service.sendReadOnlyMessage(db, parsed.data, async event => { send(event); })
            .then(async result => {
              await service.getConversation(db, result.conversation.id);
              send({ type: "completed", result });
            })
            .catch(error => {
              const failure = authenticationFailure(error);
              send({ type: "failed", message: failure.error, code: failure.code, httpStatus: failure.status });
            })
            .finally(() => { clearInterval(heartbeat); if (connected) { connected = false; controller.close(); } });
        },
        cancel() { connected = false; },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store, no-transform", "x-accel-buffering": "no" } });
    } catch (error) {
      const failure = authenticationFailure(error);
      return Response.json({ error: failure.error, code: failure.code }, { status: failure.status, headers: { "cache-control": "no-store" } });
    }
  }

}
