import { z } from "zod";
import { router, resourceProcedure } from "../init";
import {
  contextService,
  documentService,
  skillPackageService,
  skillPackageStorageService,
  importSkillSchema,
  registerSkillPackageSchema,
  listSkillPackagesSchema,
  getSkillPackageSchema,
  listSkillPackageFilesSchema,
  readSkillPackageFileSchema,
  downloadSkillPackageSchema,
  verifySkillPackageStorageSchema,
  reindexSkillPackageSchema,
  updateSkillPackageMetadataSchema,
  updateSkillPackageVersionStatusSchema,
} from "@task-weaver/core";
import { resolve } from "node:path";

function createSkillPackageStorage() {
  const baseDir = process.env.SKILL_PACKAGE_STORAGE_DIR
    ?? resolve(process.cwd(), "data", "skill-packages");
  const maxObjectBytes = process.env.SKILL_PACKAGE_MAX_OBJECT_BYTES
    ? Number(process.env.SKILL_PACKAGE_MAX_OBJECT_BYTES)
    : undefined;
  return new skillPackageStorageService.LocalSkillPackageStorageAdapter(baseDir, { maxObjectBytes });
}

export const skillRouter = router({
  list: resourceProcedure
    .input(
      z.object({
        tags: z.array(z.string()).optional(),
        projectId: z.string().uuid().optional(),
        allProjects: z.boolean().optional(),
        includeGlobal: z.boolean().optional(),
        includePersonal: z.boolean().optional(),
        personalOwnerId: z.string().optional(),
        personalOwnerType: z.enum(["human", "agent"]).optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      return contextService.listSkills(ctx.db, {
        ...input,
        personalOwnerId: input?.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input?.personalOwnerType ?? ctx.actor.type,
      });
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return documentService.getDocument(ctx.db, input.id);
    }),

  create: resourceProcedure
    .input(importSkillSchema)
    .mutation(async ({ ctx, input }) => {
      return contextService.importSkill(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: z.object({
          title: z.string().min(1).max(500).optional(),
          content: z.string().optional(),
          summary: z.string().max(1000).nullable().optional(),
          keywords: z.array(z.string()).optional(),
          tags: z.array(z.string()).optional(),
          projectId: z.string().uuid().nullable().optional(),
          personalOwnerId: z.string().nullable().optional(),
          personalOwnerType: z.enum(["human", "agent"]).nullable().optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return documentService.updateDocument(
        ctx.db,
        input.id,
        {
          ...input.data,
          docType: "skill",
        },
        ctx.actor,
      );
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return documentService.deleteDocument(ctx.db, input.id, ctx.actor);
    }),

  packageList: resourceProcedure
    .input(listSkillPackagesSchema)
    .query(async ({ ctx, input }) => {
      return skillPackageService.listPackages(ctx.db, input);
    }),

  packageGet: resourceProcedure
    .input(getSkillPackageSchema)
    .query(async ({ ctx, input }) => {
      return skillPackageService.getPackage(ctx.db, input.packageId);
    }),

  packageRegister: resourceProcedure
    .input(registerSkillPackageSchema)
    .mutation(async ({ ctx, input }) => {
      return skillPackageService.registerPackage(
        ctx.db,
        input,
        ctx.actor,
        createSkillPackageStorage(),
      );
    }),

  packageFiles: resourceProcedure
    .input(listSkillPackageFilesSchema)
    .query(async ({ ctx, input }) => {
      return skillPackageService.listPackageFiles(ctx.db, input);
    }),

  packageRead: resourceProcedure
    .input(readSkillPackageFileSchema)
    .query(async ({ ctx, input }) => {
      return skillPackageService.readPackageTextFile(
        ctx.db,
        input,
        createSkillPackageStorage(),
      );
    }),

  packageDownload: resourceProcedure
    .input(downloadSkillPackageSchema)
    .query(async ({ ctx, input }) => {
      return skillPackageService.downloadPackage(
        ctx.db,
        input,
        createSkillPackageStorage(),
      );
    }),

  packageHealth: resourceProcedure
    .input(verifySkillPackageStorageSchema)
    .query(async ({ ctx, input }) => {
      return skillPackageService.verifyPackageStorage(
        ctx.db,
        input,
        createSkillPackageStorage(),
      );
    }),

  packageReindex: resourceProcedure
    .input(reindexSkillPackageSchema)
    .mutation(async ({ ctx, input }) => {
      return skillPackageService.reindexPackageTextFiles(
        ctx.db,
        input,
        ctx.actor,
        createSkillPackageStorage(),
      );
    }),

  packageUpdate: resourceProcedure
    .input(updateSkillPackageMetadataSchema)
    .mutation(async ({ ctx, input }) => {
      return skillPackageService.updatePackageMetadata(ctx.db, input, ctx.actor);
    }),

  packageVersionStatus: resourceProcedure
    .input(updateSkillPackageVersionStatusSchema)
    .mutation(async ({ ctx, input }) => {
      return skillPackageService.updatePackageVersionStatus(ctx.db, input, ctx.actor);
    }),
});
