import { z } from "zod";
import { router, ordinaryResourceProcedure } from "../init";
import {
  createResourceServices,
  personalResourceOwnerId,
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
  list: ordinaryResourceProcedure
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
      return createResourceServices(ctx.identity).contextService.listSkills(ctx.db, {
        ...input,
        personalOwnerId: input?.personalOwnerId ?? personalResourceOwnerId(ctx.identity),
        personalOwnerType: input?.personalOwnerType ?? "human",
      });
    }),

  get: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.getDocument(ctx.db, input.id);
    }),

  create: ordinaryResourceProcedure
    .input(importSkillSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).contextService.importSkill(ctx.db, input, ctx.actor);
    }),

  update: ordinaryResourceProcedure
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
      return createResourceServices(ctx.identity).documentService.updateDocument(
        ctx.db,
        input.id,
        {
          ...input.data,
          docType: "skill",
        },
        ctx.actor,
      );
    }),

  delete: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.deleteDocument(ctx.db, input.id, ctx.actor);
    }),

  packageList: ordinaryResourceProcedure
    .input(listSkillPackagesSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.listPackages(ctx.db, input);
    }),

  packageGet: ordinaryResourceProcedure
    .input(getSkillPackageSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.getPackage(ctx.db, input.packageId);
    }),

  packageRegister: ordinaryResourceProcedure
    .input(registerSkillPackageSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.registerPackage(
        ctx.db,
        input,
        ctx.actor,
        createSkillPackageStorage(),
      );
    }),

  packageFiles: ordinaryResourceProcedure
    .input(listSkillPackageFilesSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.listPackageFiles(ctx.db, input);
    }),

  packageRead: ordinaryResourceProcedure
    .input(readSkillPackageFileSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.readPackageTextFile(
        ctx.db,
        input,
        createSkillPackageStorage(),
      );
    }),

  packageDownload: ordinaryResourceProcedure
    .input(downloadSkillPackageSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.downloadPackage(
        ctx.db,
        input,
        createSkillPackageStorage(),
      );
    }),

  packageHealth: ordinaryResourceProcedure
    .input(verifySkillPackageStorageSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.verifyPackageStorage(
        ctx.db,
        input,
        createSkillPackageStorage(),
      );
    }),

  packageReindex: ordinaryResourceProcedure
    .input(reindexSkillPackageSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.reindexPackageTextFiles(
        ctx.db,
        input,
        ctx.actor,
        createSkillPackageStorage(),
      );
    }),

  packageUpdate: ordinaryResourceProcedure
    .input(updateSkillPackageMetadataSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.updatePackageMetadata(ctx.db, input, ctx.actor);
    }),

  packageVersionStatus: ordinaryResourceProcedure
    .input(updateSkillPackageVersionStatusSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).skillPackageService.updatePackageVersionStatus(ctx.db, input, ctx.actor);
    }),
});
