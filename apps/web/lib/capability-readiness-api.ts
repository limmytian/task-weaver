import { AuthenticationError, AuthorizationError, NotFoundError, projectCapabilityReadinessQuerySchema, projectCapabilityReadinessSchema } from "@task-weaver/core";

/** Read from the configured API with the current request identity, never Web runtime guesses. */
export async function readProjectCapabilityReadiness(request: Request, projectId: string) {
  const input = projectCapabilityReadinessQuerySchema.parse({ projectId });
  const headers = new Headers();
  for (const name of ["authorization", "cookie", "origin", "x-csrf-token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const apiUrl = process.env.TW_API_URL || "http://localhost:3001";
  const response = await fetch(`${apiUrl}/api/v1/context/readiness?projectId=${input.projectId}`, {
    method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) throw new AuthenticationError();
  if (response.status === 403) throw new AuthorizationError();
  if (response.status === 404) throw new NotFoundError("Resource not found");
  if (!response.ok) throw new Error("API capability readiness is unavailable");
  return projectCapabilityReadinessSchema.parse(await response.json());
}
