export async function readTextPreview(response: Response, maximumBytes = 1024 * 1024, sampled = false) {
  if (!response.ok || !response.body) throw new Error("Text preview unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  let truncated = sampled;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - bytes;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) { truncated = true; await reader.cancel(); break; }
    }
    // A truncated sample can end in the middle of a UTF-8 sequence.
    if (!truncated) text += decoder.decode();
    if (text.includes("\0")) throw new Error("Text preview has unsupported encoding");
    return { text, truncated };
  } finally { reader.releaseLock(); }
}
