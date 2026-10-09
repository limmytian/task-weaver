/** Resolve the current project from the route rather than stale sidebar selection. */
export function assistantPageContext(pathname: string): { contextKind: "project" | "global"; projectId?: string } {
  const match = /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(pathname);
  return match ? { contextKind: "project", projectId: match[1] } : { contextKind: "global" };
}
