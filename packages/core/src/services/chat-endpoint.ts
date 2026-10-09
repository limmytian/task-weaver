import https from "node:https";
import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ChatConfigurationError } from "@task-weaver/contracts";

const blocked = new BlockList();
const blocked6 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["fec0::", 10], ["64:ff9b:1::", 48], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked6.addSubnet(address, prefix, "ipv6");
export function isPublicChatAddress(address: string) {
  const family = isIP(address);
  return !!family && (family === 4 || (parseInt(address.split(":")[0]!, 16) >= 0x2000 && parseInt(address.split(":")[0]!, 16) <= 0x3fff)) && !(family === 4 ? blocked.check(address, "ipv4") : blocked6.check(address, "ipv6")) && address !== "::1";
}
export function chatEndpoint(baseUrl: string) {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ChatConfigurationError("chat_endpoint_invalid"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash)
    throw new ChatConfigurationError("chat_endpoint_invalid");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !isPublicChatAddress(hostname)) throw new ChatConfigurationError("chat_endpoint_private");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

/** Pin the validated DNS address to the TLS request; never follow redirects with credentials. */
export type ChatTurn = { content: string | null; toolCalls: { id: string; name: string; arguments: string }[] };

export async function requestChatTurn(baseUrl: string, apiKey: string, payload: unknown, deadline = performance.now() + 45_000) {
  const endpoint = chatEndpoint(baseUrl);
  if (performance.now() >= deadline) throw new ChatConfigurationError("chat_connection_failed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    dns.lookup(endpoint.hostname, { all: true }),
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ChatConfigurationError("chat_endpoint_unresolved")), Math.max(1, Math.min(5000, Math.floor(deadline - performance.now())))); }),
  ]).catch(() => { throw new ChatConfigurationError("chat_endpoint_unresolved"); }).finally(() => { if (timer) clearTimeout(timer); });
  if (!addresses.length || addresses.some(row => !isPublicChatAddress(row.address))) throw new ChatConfigurationError("chat_endpoint_private");
  const address = addresses[0]!;
  const body = JSON.stringify(payload);
  return new Promise<ChatTurn>((resolve, reject) => {
    const failure = (code: ConstructorParameters<typeof ChatConfigurationError>[0]) => reject(new ChatConfigurationError(code));
    const request = https.request(endpoint, {
      method: "POST", agent: false, family: address.family, signal: AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now()))),
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, response => {
      const status = response.statusCode ?? 500;
      if (status !== 200) { response.resume(); failure(status === 401 || status === 403 ? "chat_key_rejected" : "chat_request_failed"); return; }
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
          const content = typeof message?.content === "string" ? message.content.trim().split(apiKey).join("[redacted]") : null;
          const rawCalls = message?.tool_calls ?? [];
          if (!Array.isArray(rawCalls) || rawCalls.length > 8) throw new Error();
          const toolCalls = rawCalls.map((call: any) => {
            if (call.type !== "function" || typeof call.id !== "string" || call.id.length > 200
              || typeof call.function?.name !== "string" || call.function.name.length > 100
              || typeof call.function.arguments !== "string" || call.function.arguments.length > 10_000) throw new Error();
            return { id: call.id, name: call.function.name, arguments: call.function.arguments };
          });
          if (!content && !toolCalls.length) throw new Error();
          resolve({ content, toolCalls });
        } catch { failure("chat_response_invalid"); }
      });
    });
    request.on("error", () => failure("chat_connection_failed"));
    request.end(body);
  });
}

/** Credential tests require an ordinary text completion, not tool execution. */
export async function requestChatCompletion(baseUrl: string, apiKey: string, payload: unknown) {
  const turn = await requestChatTurn(baseUrl, apiKey, payload);
  if (!turn.content || turn.toolCalls.length) throw new ChatConfigurationError("chat_response_invalid");
  return turn.content;
}
