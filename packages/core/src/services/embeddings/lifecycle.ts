import type {
  EmbeddingGenerationStatus,
  EmbeddingJobStatus,
  EmbeddingProfileStatus,
} from "@task-weaver/contracts";

const PROFILE_TRANSITIONS: Record<EmbeddingProfileStatus, readonly EmbeddingProfileStatus[]> = {
  disabled: ["enabled", "failed"],
  enabled: ["disabled", "failed"],
  failed: ["disabled", "enabled"],
};

const GENERATION_TRANSITIONS: Record<
  EmbeddingGenerationStatus,
  readonly EmbeddingGenerationStatus[]
> = {
  building: ["active", "failed"],
  active: ["retired"],
  failed: [],
  retired: [],
};

const JOB_TRANSITIONS: Record<EmbeddingJobStatus, readonly EmbeddingJobStatus[]> = {
  queued: ["running", "cancelling", "cancelled", "failed"],
  running: ["pausing", "cancelling", "completed", "failed"],
  pausing: ["paused", "cancelling", "failed"],
  paused: ["queued", "cancelling", "cancelled", "failed"],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  completed: [],
  failed: ["queued"],
};

export class EmbeddingLifecycleError extends Error {
  constructor(
    readonly entity: "profile" | "generation" | "job",
    readonly from: string,
    readonly to: string,
  ) {
    super(`Embedding ${entity} cannot transition from '${from}' to '${to}'`);
    this.name = "EmbeddingLifecycleError";
  }
}

function canTransition<TStatus extends string>(
  transitions: Record<TStatus, readonly TStatus[]>,
  from: TStatus,
  to: TStatus,
) {
  return from === to || transitions[from].includes(to);
}

export function canTransitionEmbeddingProfile(
  from: EmbeddingProfileStatus,
  to: EmbeddingProfileStatus,
) {
  return canTransition(PROFILE_TRANSITIONS, from, to);
}

export function canTransitionEmbeddingGeneration(
  from: EmbeddingGenerationStatus,
  to: EmbeddingGenerationStatus,
) {
  return canTransition(GENERATION_TRANSITIONS, from, to);
}

export function canTransitionEmbeddingJob(from: EmbeddingJobStatus, to: EmbeddingJobStatus) {
  return canTransition(JOB_TRANSITIONS, from, to);
}

export function assertEmbeddingProfileTransition(
  from: EmbeddingProfileStatus,
  to: EmbeddingProfileStatus,
) {
  if (!canTransitionEmbeddingProfile(from, to)) {
    throw new EmbeddingLifecycleError("profile", from, to);
  }
}

export function assertEmbeddingGenerationTransition(
  from: EmbeddingGenerationStatus,
  to: EmbeddingGenerationStatus,
) {
  if (!canTransitionEmbeddingGeneration(from, to)) {
    throw new EmbeddingLifecycleError("generation", from, to);
  }
}

export function assertEmbeddingJobTransition(from: EmbeddingJobStatus, to: EmbeddingJobStatus) {
  if (!canTransitionEmbeddingJob(from, to)) {
    throw new EmbeddingLifecycleError("job", from, to);
  }
}
