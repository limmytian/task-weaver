export async function readTextPreview(response: Response, maximumBytes = 1024 * 1024) {
  if (!response.ok || !response.body) throw new Error("Text preview unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - bytes;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) { truncated = true; await reader.cancel(); break; }
    }
    return { text: text + decoder.decode(), truncated };
  } finally { reader.releaseLock(); }
}
