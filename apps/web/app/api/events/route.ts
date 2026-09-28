import { initRealtime, serializeRealtimeEvent, subscribe } from "@task-weaver/realtime";

let realtimeReady: Promise<void> | null = null;

function ensureRealtime() {
  if (!realtimeReady) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    realtimeReady = initRealtime(url);
  }
  return realtimeReady;
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureRealtime();
  const after = new URL(request.url).searchParams.get("after");
  const lastSequence = after?.match(/-(\d+)$/)?.[1] ? Number(after.match(/-(\d+)$/)?.[1]) : null;

  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: string, id?: string) => {
        controller.enqueue(
          encoder.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${data}\n\n`),
        );
      };

      send("connected", JSON.stringify({ lastEventId: after ?? null, resume: after ? "best_effort" : "fresh" }));

      unsubscribe = subscribe((event) => {
        if (lastSequence !== null && event.sequence !== undefined && event.sequence <= lastSequence) return;
        send(event.type, serializeRealtimeEvent(event), event.eventId);
      });

      heartbeat = setInterval(() => {
        send("heartbeat", "");
      }, 30_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
