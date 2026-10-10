import { invalidateBrowserSession, SESSION_INVALIDATED_EVENT } from "./browser-session";
import { SseDecoder, assistantStreamEventSchema, type AssistantStreamEvent } from "@task-weaver/contracts";

export class AssistantStreamError extends Error {
  readonly data: { httpStatus: number };
  constructor(message: string, httpStatus: number) { super(message); this.data = { httpStatus }; }
}

/** Consume incrementally; a lost connection never submits the original request again. */
export async function readAssistantStream<T>(body: ReadableStream<Uint8Array>, onEvent: (event: AssistantStreamEvent) => void): Promise<T> {
  const reader = body.getReader();
  const text = new TextDecoder("utf-8", { fatal: true });
  const frames = new SseDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of frames.push(text.decode(chunk.value, { stream: true }))) {
        const event = assistantStreamEventSchema.parse(JSON.parse(frame));
        if (event.type === "failed") throw new AssistantStreamError(event.message, event.httpStatus);
        if (event.type === "completed") {
          if (!event.result || typeof event.result !== "object") throw new Error("Assistant returned an invalid result");
          return event.result as T;
        }
        onEvent(event);
      }
    }
    frames.push(text.decode()); frames.finish();
    throw new Error("Assistant stream ended before the result was saved");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function sendAssistantStream<T>(input: unknown, onEvent: (event: AssistantStreamEvent) => void): Promise<T> {
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  const timeout = setTimeout(stop, 360_000);
  if (typeof window !== "undefined") window.addEventListener(SESSION_INVALIDATED_EVENT, stop);
  try {
    const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal: cancellation.signal });
    if (!challenge.ok) throw new AssistantStreamError("Sign-in protection is unavailable", challenge.status);
    const { csrfToken } = await challenge.json() as { csrfToken: string };
    const response = await fetch("/api/assistant/stream", {
      method: "POST", credentials: "same-origin", cache: "no-store", signal: cancellation.signal,
      headers: { "content-type": "application/json", accept: "text/event-stream", "x-csrf-token": csrfToken },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new AssistantStreamError(response.status === 401 ? "Please sign in again" : "Assistant request was rejected", response.status);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Assistant streaming is unavailable");
    return await readAssistantStream<T>(response.body, onEvent);
  } catch (error) {
    if (error instanceof AssistantStreamError && error.data.httpStatus === 401) invalidateBrowserSession();
    throw error;
  } finally { clearTimeout(timeout); if (typeof window !== "undefined") window.removeEventListener(SESSION_INVALIDATED_EVENT, stop); }
}
