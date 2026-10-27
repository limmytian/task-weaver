/** Server-only opt-in cap. Defaults stay unchanged; raising capacity requires a separate review. */
export function databasePoolOptions(environment: Record<string, string | undefined>): { maxConnections: number } {
  const value = environment.TW_DATABASE_POOL_MAX;
  if (value === undefined) return { maxConnections: 10 };
  if (!/^(?:[1-9]|10)$/.test(value))
    throw new Error("TW_DATABASE_POOL_MAX must be an integer between 1 and 10");
  return { maxConnections: Number(value) };
}
