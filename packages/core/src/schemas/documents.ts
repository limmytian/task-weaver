import { z } from "zod";

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const docTypeSchema = z.enum([
  "requirement",
  "design",
  "meeting",
  "guide",
  "reference",
  "skill",
  "other",
]);

export const createDocumentSchema = z.object({
  projectId: z.string().uuid().optional(),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  title: z.string().min(1).max(500),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  summary: z.string().max(1000).optional(),
  keywords: z.array(z.string()).optional(),
  docType: docTypeSchema.optional(),
  language: z.string().max(10).optional(),
  generatedBy: z.string().optional(),
  generationPrompt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().optional(),
});

export const updateDocumentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().optional(),
  projectId: z.string().uuid().nullable().optional(),
  personalOwnerId: z.string().nullable().optional(),
  personalOwnerType: z.enum(["human", "agent"]).nullable().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().max(1000).nullable().optional(),
  keywords: z.array(z.string()).optional(),
  docType: docTypeSchema.optional(),
  language: z.string().max(10).optional(),
  generatedBy: z.string().nullable().optional(),
  generationPrompt: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  needsReview: z.boolean().optional(),
});

export const listDocumentsSchema = z.object({
  projectId: z.string().uuid().optional(),
  includeGlobal: queryBooleanSchema.default(true),
  includePersonal: queryBooleanSchema.default(false),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  docType: docTypeSchema.optional(),
  tag: z.string().optional(),
  query: z.string().trim().min(1).max(500).optional(),
  view: z.enum(["summary", "full"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

export const searchDocumentsSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["keyword", "fulltext", "semantic", "hybrid"]).default("keyword"),
  projectId: z.string().uuid().optional(),
  includeGlobal: queryBooleanSchema.default(true),
  includePersonal: queryBooleanSchema.default(false),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  keywordWeight: z.coerce.number().min(0).max(1).default(0.3),
  fulltextWeight: z.coerce.number().min(0).max(1).default(0.7),
});

export const linkDocumentsSchema = z.object({
  targetDocId: z.string().uuid(),
  linkType: z.enum(["reference", "related", "parent"]).default("reference"),
  context: z.string().optional(),
});

export const linkDocumentToTaskSchema = z.object({
  taskId: z.string().uuid(),
  linkType: z.enum(["references", "documents", "output"]).default("references"),
});

export const listDocumentVersionsSchema = z.object({
  documentId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const compareDocumentVersionsSchema = z.object({
  documentId: z.string().uuid(),
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
});

export const revertDocumentSchema = z.object({
  version: z.number().int().min(1),
  changeDescription: z.string().optional(),
});

export const searchContextSchema = z.object({
  intent: z.string().min(1).max(500),
  tags: z.array(z.string()).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(5),
  mode: z.enum(["summary", "full"]).default("summary"),
  projectId: z.string().uuid().optional(),
  includeGlobal: queryBooleanSchema.default(true),
  includePersonal: queryBooleanSchema.default(false),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
});

export const importSkillSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  summary: z.string().max(1000).optional(),
  keywords: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  projectId: z.string().uuid().optional(),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
});

export type DocType = z.infer<typeof docTypeSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;
export type SearchDocumentsInput = z.infer<typeof searchDocumentsSchema>;
export type SearchContextInput = z.infer<typeof searchContextSchema>;
export type ImportSkillInput = z.infer<typeof importSkillSchema>;
export type ListDocumentVersionsInput = z.infer<typeof listDocumentVersionsSchema>;
export type CompareDocumentVersionsInput = z.infer<typeof compareDocumentVersionsSchema>;
export type RevertDocumentInput = z.infer<typeof revertDocumentSchema>;
