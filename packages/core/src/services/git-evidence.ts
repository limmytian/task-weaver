import { and, eq } from "drizzle-orm";
import { evidenceGitComparisons, requirementRepositories, repositories, type Database } from "@task-weaver/db";
import { NotFoundError, ValidationError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "./resource-services";
import { gitRepositoryIdentity, readTrustedCommit, pinTrustedGitComparison, readTrustedGitComparison } from "./trusted-forge";

/** Resolve repository settings from an authorized output, never a browser URL. */
export function createGitEvidenceService(identity: VerifiedRequestContext, options: { fetch?: typeof fetch } = {}) {
  const resolve = async (db: Database, requirementId: string, outputId: string) => {
    const descriptor = await createResourceServices(identity).requirementService.describeWorkflowEvidence(db, requirementId, outputId);
    if (descriptor.kind !== "git" || descriptor.availability !== "available") throw new NotFoundError("Git evidence is unavailable");
    const link = await db.query.requirementRepositories.findFirst({ where: and(eq(requirementRepositories.id, descriptor.requirementRepositoryId), eq(requirementRepositories.requirementId, requirementId)) });
    if (!link) throw new NotFoundError("Git evidence is unavailable");
    const repository = await db.query.repositories.findFirst({ where: eq(repositories.id, link.repositoryId) });
    if (!repository || !link.baseBranch) throw new NotFoundError("Git evidence is unavailable");
    return { descriptor, link, repository };
  };
  const sameSource = (left: Awaited<ReturnType<typeof resolve>>, right: Awaited<ReturnType<typeof resolve>>) =>
    left.descriptor.headCommit === right.descriptor.headCommit && left.link.id === right.link.id && left.link.repositoryId === right.link.repositoryId && left.repository.canonicalKey === right.repository.canonicalKey && left.repository.host === right.repository.host && left.repository.provider === right.repository.provider && left.repository.namespace === right.repository.namespace && left.repository.name === right.repository.name;
  const repositoryIdentity = (repository: Awaited<ReturnType<typeof resolve>>["repository"]) => JSON.stringify([repository.canonicalKey, repository.provider, repository.host, repository.namespace, repository.name]);
  return {
    async commit(db: Database, requirementId: string, outputId: string, parent?: string) {
      const source = await resolve(db, requirementId, outputId);
      const result = await readTrustedCommit(source.repository, source.descriptor.headCommit, parent, options);
      const current = await resolve(db, requirementId, outputId);
      if (!sameSource(source, current)) throw new ValidationError("Git evidence changed while reading the commit");
      return result;
    },
    async compare(db: Database, requirementId: string, outputId: string, mode: "historical" | "current" = "historical") {
      const source = await resolve(db, requirementId, outputId);
      const baseline = source.descriptor.gitBaseline;
      if (mode === "historical" && (!baseline || baseline.repositoryKey !== gitRepositoryIdentity(source.repository) || baseline.headCommit !== source.descriptor.headCommit)) throw new ValidationError("This output has no trusted historical delivery baseline. Choose current target or inspect the delivered commit; a past baseline cannot be reconstructed.");
      const pinned = mode === "historical"
        ? { baseCommit: baseline!.baseCommit, headCommit: baseline!.headCommit, comparisonCommit: baseline!.comparisonCommit, mode: "merge-base" as const }
        : await pinTrustedGitComparison(source.repository, source.link.baseBranch!, source.descriptor.headCommit, options);
      const result = await readTrustedGitComparison(source.repository, pinned, options);
      const current = await resolve(db, requirementId, outputId);
      if (!sameSource(source, current) || source.link.baseBranch !== current.link.baseBranch) throw new ValidationError("Git evidence changed while opening the comparison");
      const repositoryKey = repositoryIdentity(source.repository);
      const [inserted] = await db.insert(evidenceGitComparisons).values({ requirementId, outputId, repositoryId: source.repository.id, repositoryKey, baseCommit: pinned.baseCommit, headCommit: pinned.headCommit, comparisonCommit: pinned.comparisonCommit }).onConflictDoNothing().returning();
      const saved = inserted ?? await db.query.evidenceGitComparisons.findFirst({ where: and(eq(evidenceGitComparisons.outputId, outputId), eq(evidenceGitComparisons.repositoryId, source.repository.id), eq(evidenceGitComparisons.repositoryKey, repositoryKey), eq(evidenceGitComparisons.baseCommit, pinned.baseCommit), eq(evidenceGitComparisons.headCommit, pinned.headCommit), eq(evidenceGitComparisons.comparisonCommit, pinned.comparisonCommit)) });
      if (!saved) throw new ValidationError("Git comparison could not be saved");
      return { ...pinned, comparisonId: saved!.id, truncated: result.truncated, files: result.files.map(({ patch: _patch, ...file }) => file) };
    },
    async file(db: Database, requirementId: string, outputId: string, comparisonId: string, path: string) {
      const saved = await db.query.evidenceGitComparisons.findFirst({ where: and(eq(evidenceGitComparisons.id, comparisonId), eq(evidenceGitComparisons.requirementId, requirementId), eq(evidenceGitComparisons.outputId, outputId)) });
      if (!saved) throw new NotFoundError("Git comparison is unavailable");
      const source = await resolve(db, requirementId, outputId);
      if (saved.repositoryId !== source.repository.id || saved.repositoryKey !== repositoryIdentity(source.repository) || saved.headCommit !== source.descriptor.headCommit) throw new ValidationError("Git evidence identity changed");
      const result = await readTrustedGitComparison(source.repository, { baseCommit: saved.baseCommit, headCommit: saved.headCommit, comparisonCommit: saved.comparisonCommit, mode: "merge-base" }, options);
      const current = await resolve(db, requirementId, outputId);
      if (!sameSource(source, current)) throw new ValidationError("Git evidence changed while reading the comparison");
      const file = result.files.find(item => item.path === path);
      if (!file) throw new NotFoundError("Git comparison file is unavailable");
      return file;
    },
  };
}
