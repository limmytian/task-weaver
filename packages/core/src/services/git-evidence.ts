import { and, eq } from "drizzle-orm";
import { requirementRepositories, repositories, type Database } from "@task-weaver/db";
import { NotFoundError, ValidationError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "./resource-services";
import { pinTrustedGitComparison, readTrustedGitComparison } from "./trusted-forge";

/** Resolve all repository settings from an authorized output, never a browser URL. */
export function createGitEvidenceService(identity: VerifiedRequestContext, options: { fetch?: typeof fetch } = {}) {
  return {
    async compare(db: Database, requirementId: string, outputId: string) {
      const resources = createResourceServices(identity);
      const descriptor = await resources.requirementService.describeWorkflowEvidence(db, requirementId, outputId);
      if (descriptor.kind !== "git" || descriptor.availability !== "available") throw new NotFoundError("Git evidence is unavailable");
      const link = await db.query.requirementRepositories.findFirst({ where: and(eq(requirementRepositories.id, descriptor.requirementRepositoryId), eq(requirementRepositories.requirementId, requirementId)) });
      if (!link) throw new NotFoundError("Git evidence is unavailable");
      const repository = await db.query.repositories.findFirst({ where: eq(repositories.id, link.repositoryId) });
      if (!repository || !link.baseBranch) throw new NotFoundError("Git evidence is unavailable");
      const pinned = await pinTrustedGitComparison(repository, link.baseBranch, descriptor.headCommit, options);
      const result = await readTrustedGitComparison(repository, pinned, options);
      // Check both authorization and the registered source again after network I/O.
      const current = await resources.requirementService.describeWorkflowEvidence(db, requirementId, outputId);
      const currentLink = await db.query.requirementRepositories.findFirst({ where: and(eq(requirementRepositories.id, link.id), eq(requirementRepositories.requirementId, requirementId)) });
      const currentRepository = await db.query.repositories.findFirst({ where: eq(repositories.id, link.repositoryId) });
      if (current.kind !== "git" || current.availability !== "available" || current.headCommit !== descriptor.headCommit || current.requirementRepositoryId !== link.id || !currentLink || currentLink.repositoryId !== link.repositoryId || currentLink.baseBranch !== link.baseBranch || !currentRepository || currentRepository.host !== repository.host || currentRepository.provider !== repository.provider || currentRepository.namespace !== repository.namespace || currentRepository.name !== repository.name) throw new ValidationError("Git evidence changed while opening the comparison");
      return result;
    },
  };
}
