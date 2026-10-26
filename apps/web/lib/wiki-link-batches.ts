export type WikiLinkTarget = { id: string; title: string };

/** Keep the server's 50-title bound without truncation or parallel request fanout. */
export async function resolveWikiLinkBatches(
  titles: readonly string[],
  read: (titles: string[], signal: AbortSignal) => Promise<WikiLinkTarget[]>,
  signal: AbortSignal,
): Promise<WikiLinkTarget[]> {
  const unique = [...new Set(titles)];
  const result: WikiLinkTarget[] = [];
  for (let offset = 0; offset < unique.length; offset += 50) {
    signal.throwIfAborted();
    const page = await read(unique.slice(offset, offset + 50), signal);
    signal.throwIfAborted();
    result.push(...page);
  }
  return result;
}
