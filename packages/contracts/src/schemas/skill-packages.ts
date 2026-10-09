import { z } from "zod";

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const skillPackageStatusSchema = z.enum([
  "active",
  "deprecated",
  "archived",
  "deleted",
]);

export const skillPackageVersionStatusSchema = z.enum([
  "active",
  "deprecated",
  "archived",
  "deleted",
]);

export const skillPackageSourceTypeSchema = z.enum([
  "upload",
  "directory",
  "archive",
  "single_file",
  "seed",
  "external",
]);

export const skillPackageFileKindSchema = z.enum([
  "entry",
  "text",
  "asset",
  "binary",
]);

export const skillPackageStorageObjectKindSchema = z.enum([
  "archive",
  "file",
]);

export const skillPackageManifestSchema = z.record(z.unknown());

export const skillPackagePathSchema = z.string()
  .min(1)
  .max(2048)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), {
    message: "Package paths must be relative",
  })
  .refine((value) => !value.split(/[\\/]+/).includes(".."), {
    message: "Package paths must not contain path traversal segments",
  });

const skillPackageScopeFieldsSchema = z.object({
  projectId: z.string().uuid().optional(),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
});

function validateSkillPackageScope(
  value: {
    projectId?: string;
    allProjects?: boolean;
    personalOwnerId?: string;
    personalOwnerType?: "human" | "agent";
  },
  ctx: z.RefinementCtx,
) {
  if (value.projectId && value.allProjects) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectId and allProjects cannot be used together",
      path: ["allProjects"],
    });
  }
  if ((value.projectId || value.allProjects) && value.personalOwnerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A skill package can be project-scoped or personal-scoped, not both",
      path: ["personalOwnerId"],
    });
  }
  if ((value.personalOwnerId && !value.personalOwnerType) || (!value.personalOwnerId && value.personalOwnerType)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "personalOwnerId and personalOwnerType must be provided together",
      path: ["personalOwnerType"],
    });
  }
}

export const createSkillPackageSchema = skillPackageScopeFieldsSchema.extend({
  name: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  status: skillPackageStatusSchema.default("active"),
  sourceType: skillPackageSourceTypeSchema.default("upload"),
  entryPath: skillPackagePathSchema.default("SKILL.md"),
  manifest: skillPackageManifestSchema.default({}),
  summary: z.string().max(1000).optional(),
  keywords: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  primaryDocumentId: z.string().uuid().optional(),
}).superRefine(validateSkillPackageScope);

export const updateSkillPackageSchema = skillPackageScopeFieldsSchema.partial().extend({
  name: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: skillPackageStatusSchema.optional(),
  sourceType: skillPackageSourceTypeSchema.optional(),
  entryPath: skillPackagePathSchema.optional(),
  manifest: skillPackageManifestSchema.optional(),
  summary: z.string().max(1000).nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  primaryDocumentId: z.string().uuid().nullable().optional(),
}).superRefine(validateSkillPackageScope);

export const createSkillPackageVersionSchema = z.object({
  packageId: z.string().uuid(),
  version: z.string().min(1).max(100),
  status: skillPackageVersionStatusSchema.default("active"),
  sourceType: skillPackageSourceTypeSchema.default("upload"),
  entryPath: skillPackagePathSchema.default("SKILL.md"),
  manifest: skillPackageManifestSchema.default({}),
  fileManifest: skillPackageManifestSchema.default({}),
  storageBackend: z.string().min(1).max(100).default("local"),
  storageKeyPrefix: z.string().max(2048).optional(),
  fileCount: z.number().int().min(0).default(0),
  totalSizeBytes: z.number().int().min(0).default(0),
});

export const createSkillPackageStorageObjectSchema = z.object({
  packageVersionId: z.string().uuid(),
  kind: skillPackageStorageObjectKindSchema.default("file"),
  storageBackend: z.string().min(1).max(100).default("local"),
  objectKey: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(0),
  contentType: z.string().max(255).optional(),
  metadata: skillPackageManifestSchema.default({}),
});

export const createSkillPackageFileSchema = z.object({
  packageVersionId: z.string().uuid(),
  storageObjectId: z.string().uuid().optional(),
  path: skillPackagePathSchema,
  kind: skillPackageFileKindSchema,
  contentType: z.string().max(255).optional(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  isReadableText: z.boolean().default(false),
  isExecutable: z.boolean().default(false),
  indexedDocumentId: z.string().uuid().optional(),
  metadata: skillPackageManifestSchema.default({}),
});

export const registerSkillPackageFileSchema = z.object({
  path: skillPackagePathSchema,
  contentBase64: z.string().min(1),
  contentType: z.string().max(255).optional(),
  kind: skillPackageFileKindSchema.optional(),
  isReadableText: z.boolean().optional(),
  isExecutable: z.boolean().optional(),
  metadata: skillPackageManifestSchema.default({}),
});

const registerSkillPackageBaseSchema = skillPackageScopeFieldsSchema.extend({
  name: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  version: z.string().min(1).max(100).default("1.0.0"),
  sourceType: skillPackageSourceTypeSchema.default("directory"),
  entryPath: skillPackagePathSchema.default("SKILL.md"),
  manifest: skillPackageManifestSchema.default({}),
  summary: z.string().max(1000).optional(),
  keywords: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  storageBackend: z.string().min(1).max(100).default("local"),
  storageKeyPrefix: z.string().max(2048).optional(),
  files: z.array(registerSkillPackageFileSchema).min(1).max(1000),
});

export const registerSkillPackageSchema = registerSkillPackageBaseSchema
  .superRefine(validateSkillPackageScope)
  .refine((value) => value.files.some((file) => file.path === value.entryPath), {
  message: "Registered skill packages must include the entryPath file",
  path: ["entryPath"],
});

export const listSkillPackagesSchema = skillPackageScopeFieldsSchema.partial().extend({
  includeGlobal: queryBooleanSchema.default(true),
  includePersonal: queryBooleanSchema.default(false),
  allProjects: queryBooleanSchema.default(false),
  status: skillPackageStatusSchema.optional(),
  tag: z.string().optional(),
  query: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
}).superRefine(validateSkillPackageScope);

export const getSkillPackageSchema = z.object({
  packageId: z.string().uuid(),
});

export const listSkillPackageFilesSchema = z.object({
  packageId: z.string().uuid(),
  version: z.string().min(1).max(100).optional(),
});

export const readSkillPackageFileSchema = listSkillPackageFilesSchema.extend({
  path: skillPackagePathSchema,
});

export const downloadSkillPackageSchema = listSkillPackageFilesSchema;

export const verifySkillPackageStorageSchema = listSkillPackageFilesSchema;

export const reindexSkillPackageSchema = listSkillPackageFilesSchema.extend({
  paths: z.array(skillPackagePathSchema).optional(),
});

export const updateSkillPackageMetadataSchema = z.object({
  packageId: z.string().uuid(),
  name: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: skillPackageStatusSchema.optional(),
  summary: z.string().max(1000).nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
});

export const updateSkillPackageVersionStatusSchema = z.object({
  packageId: z.string().uuid(),
  version: z.string().min(1).max(100),
  status: skillPackageVersionStatusSchema,
});

export type SkillPackageStatus = z.infer<typeof skillPackageStatusSchema>;
export type SkillPackageVersionStatus = z.infer<typeof skillPackageVersionStatusSchema>;
export type SkillPackageSourceType = z.infer<typeof skillPackageSourceTypeSchema>;
export type SkillPackageFileKind = z.infer<typeof skillPackageFileKindSchema>;
export type SkillPackageStorageObjectKind = z.infer<typeof skillPackageStorageObjectKindSchema>;
export type SkillPackageManifest = z.infer<typeof skillPackageManifestSchema>;
export type CreateSkillPackageInput = z.infer<typeof createSkillPackageSchema>;
export type UpdateSkillPackageInput = z.infer<typeof updateSkillPackageSchema>;
export type CreateSkillPackageVersionInput = z.infer<typeof createSkillPackageVersionSchema>;
export type CreateSkillPackageStorageObjectInput = z.infer<typeof createSkillPackageStorageObjectSchema>;
export type CreateSkillPackageFileInput = z.infer<typeof createSkillPackageFileSchema>;
export type RegisterSkillPackageInput = z.infer<typeof registerSkillPackageSchema>;
export type RegisterSkillPackageFileInput = z.infer<typeof registerSkillPackageFileSchema>;
export type ListSkillPackagesInput = z.infer<typeof listSkillPackagesSchema>;
export type GetSkillPackageInput = z.infer<typeof getSkillPackageSchema>;
export type ListSkillPackageFilesInput = z.infer<typeof listSkillPackageFilesSchema>;
export type ReadSkillPackageFileInput = z.infer<typeof readSkillPackageFileSchema>;
export type DownloadSkillPackageInput = z.infer<typeof downloadSkillPackageSchema>;
export type VerifySkillPackageStorageInput = z.infer<typeof verifySkillPackageStorageSchema>;
export type ReindexSkillPackageInput = z.infer<typeof reindexSkillPackageSchema>;
export type UpdateSkillPackageMetadataInput = z.infer<typeof updateSkillPackageMetadataSchema>;
export type UpdateSkillPackageVersionStatusInput = z.infer<typeof updateSkillPackageVersionStatusSchema>;
