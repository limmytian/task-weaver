/** Resolve the current resource from the route instead of stale sidebar selection. */
export function assistantPageContext(pathname: string): { contextKind: "project" | "requirement" | "global"; projectId?: string; requirementId?: string } {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const match = new RegExp(`^/projects/(${uuid})(?:/|$)`, "i").exec(pathname);
  if (!match) return { contextKind: "global" };
  const requirement = new RegExp(`^/projects/(${uuid})/requirements/(${uuid})(?:/|$)`, "i").exec(pathname);
  return requirement ? { contextKind: "requirement", projectId: requirement[1], requirementId: requirement[2] } : { contextKind: "project", projectId: match[1] };
}
