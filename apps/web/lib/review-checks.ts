export type ReviewCheckStatus = "passed" | "failed";

/** Only explicitly recorded decisions are submitted to the workflow. */
export function recordedReviewChecks(names: string[], decisions: Record<string, ReviewCheckStatus | undefined>) {
  return names.flatMap((name) => {
    const status = decisions[name];
    return status ? [{ name, status }] : [];
  });
}
