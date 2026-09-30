import { and, eq, lt, notInArray } from "drizzle-orm";
import { type Database, executionSlices } from "@task-weaver/db";
import { NotFoundError, ValidationError } from "@task-weaver/contracts";

export const TERMINAL_EXECUTION_SLICE_STATUSES = ["done", "cancelled"] as const;

export async function assertExecutionSliceCanAdvance(
  db: Database,
  sliceId: string,
  options: { allowParallel?: boolean } = {},
) {
  const slice = await db.query.executionSlices.findFirst({
    where: eq(executionSlices.id, sliceId),
  });
  if (!slice) throw new NotFoundError("Execution slice not found");

  if (options.allowParallel ?? slice.allowParallel) return slice;

  const earlierSlices = await db.query.executionSlices.findMany({
    where: and(
      eq(executionSlices.requirementId, slice.requirementId),
      lt(executionSlices.orderIndex, slice.orderIndex),
      notInArray(executionSlices.status, [...TERMINAL_EXECUTION_SLICE_STATUSES]),
    ),
    orderBy: (candidate, { asc }) => [asc(candidate.orderIndex), asc(candidate.createdAt)],
  });

  if (earlierSlices.length > 0) {
    const blockers = earlierSlices
      .map((candidate) => `"${candidate.title}" (${candidate.status})`)
      .join(", ");
    throw new ValidationError(
      `Execution slice "${slice.title}" cannot advance before earlier slices are terminal: ${blockers}. `
      + "Mark this slice as allowParallel only when concurrent execution is intentional.",
    );
  }

  return slice;
}
