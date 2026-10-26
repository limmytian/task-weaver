/** Diagnostic baseline restoration only;retain predicates,ordering and the complete relation graph. */
export function fullQueueProjection(input: any): any {
  if (!input || typeof input !== "object") return input;
  const { columns: _columns, ...result } = input;
  if (result.with) result.with = Object.fromEntries(Object.entries(result.with).map(([key, value]) => [key, value === true ? true : fullQueueProjection(value)]));
  return result;
}
