/** Read a bounded prefix of an already verified object and reject an incomplete stream. */
export async function readEvidencePreview(response: Response, expectedBytes: number, limit: number) {
  if (!response.ok || !response.body || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Evidence preview unavailable");
  const target = Math.min(expectedBytes, limit);
  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = []; let size = 0;
  try {
    while (size < target) {
      const item = await reader.read();
      if (item.done) throw new Error("Evidence preview was interrupted");
      const piece = item.value.subarray(0, target - size);
      parts.push(piece.slice().buffer); size += piece.length;
    }
    await reader.cancel();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return { parts, truncated: expectedBytes > target };
}
