/** Cached detail data must not remain visible after a fresh server denial. */
export function resourceAccessLost(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  return !!data && typeof data === "object" && "code" in data
    && ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(String(data.code));
}
