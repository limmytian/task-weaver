import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { type Database, documents } from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type { SearchContextInput, ImportSkillInput } from "@task-weaver/contracts";
import { documentService } from "./index";
import { getPackageMetadataForDocuments } from "./skill-packages";

const CONTEXT_SUMMARY_COLUMNS = {
  id: documents.id,
  title: documents.title,
  summary: documents.summary,
  keywords: documents.keywords,
  tags: documents.tags,
  projectId: documents.projectId,
  personalOwnerId: documents.personalOwnerId,
  personalOwnerType: documents.personalOwnerType,
  updatedAt: documents.updatedAt,
};

const CONTEXT_FULL_COLUMNS = {
  ...CONTEXT_SUMMARY_COLUMNS,
  content: documents.content,
};

function buildTsQuery(query: string): string | null {
  const tsQuery = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/'/g, ""))
    .join(" & ");
  return tsQuery || null;
}

export async function searchContext(db: Database, input: SearchContextInput) {
  const tsQuery = buildTsQuery(input.intent);
  const likePattern = `%${input.intent}%`;
  const columns = input.mode === "full" ? CONTEXT_FULL_COLUMNS : CONTEXT_SUMMARY_COLUMNS;

  const conditions = [];
  conditions.push(eq(documents.docType, "skill"));

  conditions.push(buildSkillScopeCondition(input));

  if (input.tags && input.tags.length > 0) {
    conditions.push(sql`${documents.tags} && ${input.tags}`);
  }

  if (tsQuery) {
    conditions.push(
      or(
        sql`${documents.title} ILIKE ${likePattern}`,
        sql`${documents.content} ILIKE ${likePattern}`,
        sql`search_vector @@ to_tsquery('english', ${tsQuery})`,
      ),
    );

    const results = await db
      .select({
        ...columns,
        score: sql<number>`(
          0.3 * CASE WHEN ${documents.title} ILIKE ${likePattern} OR ${documents.content} ILIKE ${likePattern} THEN 1.0 ELSE 0.0 END
          + 0.7 * coalesce(ts_rank(search_vector, to_tsquery('english', ${tsQuery})), 0)
        )`.as("score"),
      })
      .from(documents)
      .where(and(...conditions))
      .orderBy(sql`score DESC`)
      .limit(input.limit);
    return enrichSkillPackageResults(db, results);
  }

  // Fallback: keyword-only search
  conditions.push(
    or(
      sql`${documents.title} ILIKE ${likePattern}`,
      sql`${documents.content} ILIKE ${likePattern}`,
    ),
  );

  const results = await db
    .select(columns)
    .from(documents)
    .where(and(...conditions))
    .limit(input.limit);
  return enrichSkillPackageResults(db, results);
}

export async function importSkill(
  db: Database,
  input: ImportSkillInput,
  actor: Actor,
) {
  const existing = await db.query.documents.findFirst({
    where: and(
      eq(documents.docType, "skill"),
      eq(documents.title, input.title),
      input.personalOwnerId && input.personalOwnerType
        ? and(
          isNull(documents.projectId),
          eq(documents.personalOwnerId, input.personalOwnerId),
          eq(documents.personalOwnerType, input.personalOwnerType),
        )!
        : input.projectId
          ? and(eq(documents.projectId, input.projectId), isNull(documents.personalOwnerId))!
          : and(isNull(documents.projectId), isNull(documents.personalOwnerId))!,
    ),
  });

  if (existing) {
    return documentService.updateDocument(db, existing.id, {
      content: input.content,
      summary: input.summary,
      keywords: input.keywords,
      tags: input.tags,
      docType: "skill",
      projectId: input.projectId ?? null,
      personalOwnerId: input.personalOwnerId ?? null,
      personalOwnerType: input.personalOwnerType ?? null,
    }, actor);
  }

  return documentService.createDocument(db, {
    title: input.title,
    content: input.content,
    summary: input.summary,
    keywords: input.keywords,
    tags: input.tags,
    docType: "skill",
    projectId: input.projectId,
    personalOwnerId: input.personalOwnerId,
    personalOwnerType: input.personalOwnerType,
    generatedBy: actor.id,
  }, actor);
}

export async function bulkImportSkills(
  db: Database,
  skills: ImportSkillInput[],
  actor: Actor,
) {
  const results = [];
  for (const skill of skills) {
    results.push(await importSkill(db, skill, actor));
  }
  return results;
}

export interface BootstrapContext {
  version: string;
  description: string;
  auth: string;
  usage: string;
  commands: { name: string; description: string }[];
  examples: string[];
}

export function getBootstrapContext(): BootstrapContext {
  return {
    version: "1.0",
    description:
      "Task Weaver — Human-AI collaborative project management. Manage projects, requirements, tasks, documents, and knowledge base.",
    auth: "Run 'tw auth setup' to configure API URL and key. Environment variables: TW_API_URL, TW_API_KEY.",
    usage:
      "Use 'tw context search <intent>' to find relevant skills for any task. Use 'tw context get <id>' to load full content.",
    commands: [
      { name: "tw context search <intent>", description: "Find relevant skills by describing what you need" },
      { name: "tw context get <id>", description: "Load full content of a specific skill" },
      { name: "tw context list", description: "List all available skills" },
      { name: "tw project list", description: "List projects" },
      { name: "tw task list --project <id>", description: "List tasks in a project" },
      { name: "tw task create --project <id> --req <id> --title <t>", description: "Create a task" },
      { name: "tw search <query>", description: "Search across all entities" },
    ],
    examples: [
      "tw context search 'how to create and manage tasks'",
      "tw context search 'sprint planning workflow'",
      "tw context search 'REST API authentication'",
      "tw context search 'document and knowledge base operations'",
    ],
  };
}

export async function listSkills(
  db: Database,
  opts?: {
    tags?: string[];
    projectId?: string;
    includeGlobal?: boolean;
    includePersonal?: boolean;
    allProjects?: boolean;
    personalOwnerId?: string;
    personalOwnerType?: "human" | "agent";
  },
) {
  const conditions = [eq(documents.docType, "skill")];

  conditions.push(buildSkillScopeCondition({ includeGlobal: true, ...opts }));

  if (opts?.tags && opts.tags.length > 0) {
    conditions.push(sql`${documents.tags} && ${opts.tags}`);
  }

  const results = await db
    .select(CONTEXT_SUMMARY_COLUMNS)
    .from(documents)
    .where(and(...conditions))
    .orderBy(documents.title);
  return enrichSkillPackageResults(db, results);
}

async function enrichSkillPackageResults<T extends { id: string }>(
  db: Database,
  results: T[],
): Promise<Array<T & { skillPackage?: unknown }>> {
  const packageMetadataByDocumentId = await getPackageMetadataForDocuments(db, results.map((result) => result.id));
  return results
    .filter((result) => {
      const metadata = packageMetadataByDocumentId.get(result.id) as { active?: boolean } | undefined;
      return !metadata || metadata.active !== false;
    })
    .map((result) => ({
      ...result,
      ...(packageMetadataByDocumentId.has(result.id)
        ? { skillPackage: packageMetadataByDocumentId.get(result.id) }
        : {}),
    }));
}

function buildSkillScopeCondition(input: {
  projectId?: string;
  includeGlobal?: boolean;
  includePersonal?: boolean;
  allProjects?: boolean;
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
}) {
  const scopes = [];

  if (input.allProjects) {
    scopes.push(isNotNull(documents.projectId));
    if (input.includeGlobal) {
      scopes.push(and(isNull(documents.projectId), isNull(documents.personalOwnerId))!);
    }
  } else if (input.projectId) {
    scopes.push(eq(documents.projectId, input.projectId));
    if (input.includeGlobal) {
      scopes.push(and(isNull(documents.projectId), isNull(documents.personalOwnerId))!);
    }
  } else {
    scopes.push(and(isNull(documents.projectId), isNull(documents.personalOwnerId))!);
  }

  if (input.includePersonal && input.personalOwnerId && input.personalOwnerType) {
    scopes.push(
      and(
        isNull(documents.projectId),
        eq(documents.personalOwnerId, input.personalOwnerId),
        eq(documents.personalOwnerType, input.personalOwnerType),
      )!,
    );
  }

  return or(...scopes)!;
}
