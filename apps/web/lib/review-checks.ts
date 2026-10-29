export type ReviewCheckStatus = "passed" | "failed";

export type ReviewCheckRecord = {
  stage?: unknown;
  decision?: unknown;
  reason?: unknown;
  actorId?: unknown;
  actorType?: unknown;
  createdAt?: unknown;
  checks?: unknown;
};

/** Only explicitly recorded decisions are submitted to the workflow. */
export function recordedReviewChecks(names: string[], decisions: Record<string, ReviewCheckStatus | undefined>) {
  return names.flatMap((name) => {
    const status = decisions[name];
    return status ? [{ name, status }] : [];
  });
}

/** Maps configured requirement checks to the latest recorded acceptance decision. */
export function latestRequirementReviewChecks(names: string[], records: ReviewCheckRecord[]) {
  const latestAcceptance = records.find((record) => record.stage === "acceptance");
  const checks = Array.isArray(latestAcceptance?.checks) ? latestAcceptance.checks : [];
  const decisions = new Map<string, ReviewCheckStatus>();

  for (const check of checks) {
    if (!check || typeof check !== "object") continue;
    const value = check as { name?: unknown; status?: unknown };
    if (typeof value.name === "string" && (value.status === "passed" || value.status === "failed")) {
      decisions.set(value.name, value.status);
    }
  }

  return {
    record: latestAcceptance,
    checks: names.map((name) => ({ name, status: decisions.get(name) ?? "not_recorded" as const })),
  };
}
