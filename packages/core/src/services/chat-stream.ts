import { SseDecoder, ChatConfigurationError } from "@task-weaver/contracts";
import type { ChatTurn } from "./chat-endpoint";

/** Suppress credentials even when a provider splits them across text deltas. */
export class SecretTextBuffer {
  private pending = "";
  constructor(private readonly secret: string) {}
  push(text: string) {
    if (!this.secret) return text;
    this.pending = (this.pending + text).split(this.secret).join("[redacted]");
    let held = Math.min(this.pending.length, this.secret.length - 1);
    while (held > 0 && !this.pending.endsWith(this.secret.slice(0, held))) held--;
    const visible = this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(this.pending.length - held);
    return visible;
  }
  finish() { const text = this.pending; this.pending = ""; return text; }
}

/** Assemble tool calls before returning a turn; incomplete streams never execute tools. */
export async function readChatStream(source: AsyncIterable<Uint8Array>, apiKey: string, onText: (text: string) => Promise<void>): Promise<ChatTurn> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const frames = new SseDecoder();
  const filter = new SecretTextBuffer(apiKey);
  const calls = new Map<number, { id: string; name: string; arguments: string; type: string }>();
  let content = "", size = 0, done = false, finish: string | undefined;
  const publish = async (text: string) => { if (text) { content += text; await onText(text); } };
  for await (const chunk of source) {
    size += chunk.length;
    if (size > 1_048_576) throw new ChatConfigurationError("chat_response_invalid");
    for (const frame of frames.push(decoder.decode(chunk, { stream: true }))) {
      if (done) throw new ChatConfigurationError("chat_response_invalid");
      if (frame === "[DONE]") { done = true; continue; }
      let value: any;
      try { value = JSON.parse(frame); } catch { throw new ChatConfigurationError("chat_response_invalid"); }
      if (value.error) throw new ChatConfigurationError("chat_request_failed");
      const choice = value.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (delta.content != null) {
        if (typeof delta.content !== "string") throw new ChatConfigurationError("chat_response_invalid");
        await publish(filter.push(delta.content));
      }
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls)) throw new ChatConfigurationError("chat_response_invalid");
        for (const item of delta.tool_calls) {
          if (!Number.isInteger(item.index) || item.index < 0 || item.index >= 8) throw new ChatConfigurationError("chat_response_invalid");
          const call = calls.get(item.index) ?? { id: "", name: "", arguments: "", type: "" };
          for (const [field, fragment] of [["id", item.id], ["type", item.type], ["name", item.function?.name], ["arguments", item.function?.arguments]] as const) {
            if (fragment !== undefined) {
              if (typeof fragment !== "string") throw new ChatConfigurationError("chat_response_invalid");
              if (field === "arguments") call[field] += fragment;
              else if (fragment) {
                // Some compatible gateways repeat fixed metadata on argument deltas.
                if (call[field] && call[field] !== fragment) throw new ChatConfigurationError("chat_response_invalid");
                call[field] = fragment;
              }
            }
          }
          if (call.id.length > 200 || call.name.length > 100 || call.arguments.length > 10_000 || call.type.length > 20) throw new ChatConfigurationError("chat_response_invalid");
          calls.set(item.index, call);
        }
      }
    }
  }
  frames.push(decoder.decode()); frames.finish();
  if (!done || !["stop", "tool_calls"].includes(finish ?? "")) throw new ChatConfigurationError("chat_response_invalid");
  await publish(filter.finish());
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    if (call.type !== "function" || !call.id || !call.name) throw new ChatConfigurationError("chat_response_invalid");
    try { JSON.parse(call.arguments); } catch { throw new ChatConfigurationError("chat_response_invalid"); }
    return { id: call.id, name: call.name, arguments: call.arguments };
  });
  if (!content.trim() && !toolCalls.length) throw new ChatConfigurationError("chat_response_invalid");
  return { content: content.trim() || null, toolCalls };
}
