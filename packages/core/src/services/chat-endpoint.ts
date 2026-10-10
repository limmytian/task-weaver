import https from "node:https";
import http from "node:http";
import { readChatStream } from "./chat-stream";
import dns from "node:dns/promises";
import { ChatConfigurationError } from "@task-weaver/contracts";

export function chatEndpoint(baseUrl: string) {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ChatConfigurationError("chat_endpoint_invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ChatConfigurationError("chat_endpoint_invalid");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

/** Pin the resolved address for each request; never follow redirects with credentials. */
export type ChatTurn = { content: string | null; toolCalls: { id: string; name: string; arguments: string }[] };

export async function requestChatTurn(baseUrl: string, apiKey: string, payload: unknown, deadline = performance.now() + 45_000, onText?: (text: string) => Promise<void>, connectionTest = false) {
  const endpoint = chatEndpoint(baseUrl);
  if (performance.now() >= deadline) throw new ChatConfigurationError("chat_connection_failed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    dns.lookup(endpoint.hostname.replace(/^\[|\]$/g, ""), { all: true }),
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ChatConfigurationError("chat_endpoint_unresolved")), Math.max(1, Math.min(5000, Math.floor(deadline - performance.now())))); }),
  ]).catch(() => { throw new ChatConfigurationError("chat_endpoint_unresolved"); }).finally(() => { if (timer) clearTimeout(timer); });
  if (!addresses.length) throw new ChatConfigurationError("chat_endpoint_unresolved");
  const address = addresses[0]!;
  const body = JSON.stringify(onText ? { ...(payload as Record<string, unknown>), stream: true } : payload);
  const transport = endpoint.protocol === "http:" ? http : https;
  // Explicit agents honor deployment proxies and NO_PROXY without changing global networking.
  const agent = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    ? new transport.Agent({ proxyEnv: process.env, keepAlive: false }) : undefined;
  return new Promise<ChatTurn>((resolve, reject) => {
    const failure = (code: ConstructorParameters<typeof ChatConfigurationError>[0]) => reject(new ChatConfigurationError(code));
    const request = transport.request(endpoint, {
      method: "POST", agent: agent ?? false, family: address.family, signal: AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now()))),
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, response => {
      const status = response.statusCode ?? 500;
      if (status !== 200) { response.resume(); failure(status === 401 || status === 403 ? "chat_key_rejected" : "chat_request_failed"); return; }
      if (onText) {
        if (!response.headers["content-type"]?.includes("text/event-stream")) { response.resume(); failure("chat_response_invalid"); return; }
        void readChatStream(response, apiKey, onText).then(resolve, error => { request.destroy(); reject(error); });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) request.destroy(new Error("Response too large"));
        else chunks.push(chunk);
      });
      response.on("error", () => failure("chat_response_invalid"));
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const message = result.choices?.[0]?.message;
          const content = typeof message?.content === "string" ? (apiKey ? message.content.trim().split(apiKey).join("[redacted]") : message.content.trim()) : null;
          const rawCalls = message?.tool_calls ?? [];
          if (!Array.isArray(rawCalls) || rawCalls.length > 8) throw new Error();
          const toolCalls = rawCalls.map((call: any) => {
            if (call.type !== "function" || typeof call.id !== "string" || call.id.length > 200
              || typeof call.function?.name !== "string" || call.function.name.length > 100
              || typeof call.function.arguments !== "string" || call.function.arguments.length > 10_000) throw new Error();
            return { id: call.id, name: call.function.name, arguments: call.function.arguments };
          });
          if (!content && !toolCalls.length && !(connectionTest && typeof message?.content === "string" && ["stop", "length"].includes(result.choices?.[0]?.finish_reason))) throw new Error();
          resolve({ content, toolCalls });
        } catch { failure("chat_response_invalid"); }
      });
    });
    request.on("error", () => failure("chat_connection_failed"));
    request.end(body);
  }).finally(() => agent?.destroy());
}

/** Credential tests require an ordinary text completion, not tool execution. */
export async function requestChatCompletion(baseUrl: string, apiKey: string, payload: unknown) {
  const turn = await requestChatTurn(baseUrl, apiKey, payload);
  if (!turn.content || turn.toolCalls.length) throw new ChatConfigurationError("chat_response_invalid");
  return turn.content;
}

/** A bounded connection test accepts a valid token-limited response from thinking models. */
export async function requestChatConnection(baseUrl: string, apiKey: string, model: string) {
  await requestChatTurn(baseUrl, apiKey, { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8 }, performance.now() + 45_000, undefined, true);
}
