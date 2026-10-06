/**
 * GraphQL schema for Task Weaver.
 *
 * Uses graphql-yoga with code-first SDL schema.
 * Resolvers delegate to existing core services — no direct DB access.
 */
import { createSchema } from "graphql-yoga";
import { GraphQLError, defaultFieldResolver, isObjectType } from "graphql";
import type { Database } from "@task-weaver/db";
import {
  createResourceServices,
  authenticationFailure,
  AuthenticationError,
  NotFoundError,
  requireResourceAuthorization,
  type AuthenticationRuntime,
  type VerifiedRequestContext,
} from "@task-weaver/core";

export interface GraphQLContext {
  db: Database;
  auth: AuthenticationRuntime;
  headers: Headers;
  identity: VerifiedRequestContext;
}

const typeDefs = /* GraphQL */ `
  type AuthenticatedActor {
    id: ID!
    type: ActorType!
    status: String!
  }
  # ---- Enums ----

  enum ProjectStatus {
    active
    archived
  }

  enum TaskStatus {
    todo
    in_progress
    in_review
    done
    cancelled
  }

  enum TaskPriority {
    low
    medium
    high
    urgent
  }

  enum RequirementStatus {
    draft
    approved
    in_progress
    in_review
    ready_to_merge
    done
    cancelled
    archived
  }

  enum RequirementPriority {
    low
    medium
    high
    critical
  }

  enum DocumentType {
    requirement
    design
    meeting
    guide
    reference
    other
  }

  enum ActorType {
    human
    agent
  }

  # ---- Core types ----

  type Project {
    id: ID!
    name: String!
    description: String
    status: ProjectStatus!
    createdBy: String!
    createdAt: String!
    updatedAt: String!

    requirements(
      status: RequirementStatus
      priority: RequirementPriority
    ): [Requirement!]!
    tasks(
      status: TaskStatus
      assignee: String
      priority: TaskPriority
    ): [Task!]!
    documents(docType: DocumentType): [Document!]!
    stats: ProjectStats!
  }

  type ProjectStats {
    totalTasks: Int!
    byStatus: [StatusCount!]!
    byPriority: [PriorityCount!]!
    blockedTasks: Int!
    avgCompletionDays: Float
    requirementProgress: [RequirementProgress!]!
  }

  type StatusCount {
    status: String!
    count: Int!
  }

  type PriorityCount {
    priority: String!
    count: Int!
  }

  type RequirementProgress {
    id: ID!
    title: String!
    status: String!
    totalTasks: Int!
    doneTasks: Int!
  }

  type Requirement {
    id: ID!
    projectId: ID!
    title: String!
    description: String
    status: RequirementStatus!
    priority: RequirementPriority!
    tags: [String!]
    createdBy: String!
    createdAt: String!
    updatedAt: String!

    project: Project!
    tasks(status: TaskStatus): [Task!]!
    linkedDocuments: [DocumentRequirementLink!]!
  }

  type Task {
    id: ID!
    projectId: ID
    requirementId: ID
    scope: String!
    personalOwnerId: String
    personalOwnerType: ActorType
    title: String!
    description: String
    status: TaskStatus!
    priority: TaskPriority!
    assignee: String
    assigneeType: ActorType
    tags: [String!]
    expectedAt: String
    completedAt: String
    createdBy: String!
    createdAt: String!
    updatedAt: String!

    project: Project
    requirement: Requirement
    comments: [Comment!]!
    notes: [Note!]!
    dependencies: [TaskDependency!]!
    linkedDocuments: [DocumentTaskLink!]!
  }

  type Comment {
    id: ID!
    taskId: ID!
    content: String!
    authorId: String!
    authorType: ActorType!
    createdAt: String!
  }

  type Note {
    id: ID!
    taskId: ID!
    content: String!
    authorId: String!
    authorType: ActorType!
    pinned: Boolean!
    createdAt: String!
  }

  type TaskDependency {
    id: ID!
    taskId: ID!
    dependsOnTaskId: ID!
    type: String!
    dependsOn: Task
  }

  type Document {
    id: ID!
    projectId: ID
    title: String!
    content: String!
    tags: [String!]
    summary: String
    keywords: [String!]
    docType: DocumentType!
    language: String!
    readingTimeMin: Int
    generatedBy: String
    confidence: Float
    needsReview: Boolean!
    createdBy: String!
    createdAt: String!
    updatedAt: String!

    project: Project
    outgoingLinks: [DocumentLink!]!
    incomingLinks: [DocumentLink!]!
    linkedTasks: [DocumentTaskLink!]!
    linkedRequirements: [DocumentRequirementLink!]!
    recommendations(limit: Int, types: [String!]): [Recommendation!]!
  }

  type DocumentLink {
    id: ID!
    sourceDocId: ID!
    targetDocId: ID!
    linkType: String!
    context: String
    sourceDoc: Document
    targetDoc: Document
  }

  type DocumentTaskLink {
    id: ID!
    documentId: ID!
    taskId: ID!
    linkType: String!
    document: Document
    task: Task
  }

  type DocumentRequirementLink {
    id: ID!
    documentId: ID!
    requirementId: ID!
    linkType: String!
    document: Document
    requirement: Requirement
  }

  type Recommendation {
    id: ID!
    type: String!
    title: String!
    score: Float!
    reason: String!
  }

  # ---- Queries ----

  type Query {
    currentActor: AuthenticatedActor!
    project(id: ID!): Project
    projects(status: ProjectStatus): [Project!]!

    task(id: ID!): Task
    tasks(
      projectId: ID!
      status: TaskStatus
      assignee: String
      priority: TaskPriority
    ): [Task!]!

    requirement(id: ID!): Requirement
    requirements(
      projectId: ID!
      status: RequirementStatus
      priority: RequirementPriority
    ): [Requirement!]!

    document(id: ID!): Document
    documents(
      projectId: ID
      docType: DocumentType
      includeGlobal: Boolean
    ): [Document!]!

    searchDocuments(
      query: String!
      mode: String
      projectId: ID
      limit: Int
    ): [Document!]!
  }
`;

const resolvers = {
  Query: {
    currentActor: async (_: unknown, _args: unknown, ctx: GraphQLContext) =>
      (await ctx.auth.verify(ctx.headers)).actor,
    project: async (
      _: unknown,
      { id }: { id: string },
      ctx: GraphQLContext,
    ) => {
      try {
        return await createResourceServices(ctx.identity).projectService.getProject(ctx.db, id);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    projects: async (
      _: unknown,
      { status }: { status?: string },
      ctx: GraphQLContext,
    ) => {
      return createResourceServices(ctx.identity).projectService.listProjects(ctx.db, { status: status as any });
    },

    task: async (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      try {
        return await createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, id);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    tasks: async (
      _: unknown,
      args: {
        projectId: string;
        status?: string;
        assignee?: string;
        priority?: string;
      },
      ctx: GraphQLContext,
    ) => {
      return createResourceServices(ctx.identity).taskService.listTasks(ctx.db, {
        scope: "project",
        projectId: args.projectId,
        status: args.status as any,
        assignee: args.assignee,
        priority: args.priority as any,
      });
    },

    requirement: async (
      _: unknown,
      { id }: { id: string },
      ctx: GraphQLContext,
    ) => {
      try {
        return await createResourceServices(ctx.identity).requirementService.getRequirement(ctx.db, id);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    requirements: async (
      _: unknown,
      args: { projectId: string; status?: string; priority?: string },
      ctx: GraphQLContext,
    ) => {
      return createResourceServices(ctx.identity).requirementService.listRequirements(ctx.db, {
        projectId: args.projectId,
        status: args.status as any,
        priority: args.priority as any,
      });
    },

    document: async (
      _: unknown,
      { id }: { id: string },
      ctx: GraphQLContext,
    ) => {
      try {
        return await createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, id);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    documents: async (
      _: unknown,
      args: { projectId?: string; docType?: string; includeGlobal?: boolean },
      ctx: GraphQLContext,
    ) => {
      return createResourceServices(ctx.identity).documentService.listDocuments(ctx.db, {
        projectId: args.projectId,
        docType: args.docType as any,
        includeGlobal: args.includeGlobal ?? true,
        includePersonal: false,
      });
    },

    searchDocuments: async (
      _: unknown,
      args: {
        query: string;
        mode?: string;
        projectId?: string;
        limit?: number;
      },
      ctx: GraphQLContext,
    ) => {
      const results = await createResourceServices(ctx.identity).documentService.searchDocuments(ctx.db, {
        query: args.query,
        mode: (args.mode as any) ?? "keyword",
        projectId: args.projectId,
        includeGlobal: true,
        includePersonal: false,
        limit: args.limit ?? 20,
        keywordWeight: 0.3,
        fulltextWeight: 0.7,
      });
      return results.map((r: any) => r.document ?? r);
    },
  },

  // ---- Nested resolvers ----

  Project: {
    requirements: async (
      project: any,
      args: { status?: string; priority?: string },
      ctx: GraphQLContext,
    ) => {
      return createResourceServices(ctx.identity).requirementService.listRequirements(ctx.db, {
        projectId: project.id,
        status: args.status as any,
        priority: args.priority as any,
      });
    },

    tasks: async (
      project: any,
      args: { status?: string; assignee?: string; priority?: string },
      ctx: GraphQLContext,
    ) => {
      return createResourceServices(ctx.identity).taskService.listTasks(ctx.db, {
        scope: "project",
        projectId: project.id,
        status: args.status as any,
        assignee: args.assignee,
        priority: args.priority as any,
      });
    },

    documents: async (
      project: any,
      args: { docType?: string },
      ctx: GraphQLContext,
    ) => {
      return createResourceServices(ctx.identity).documentService.listDocuments(ctx.db, {
        projectId: project.id,
        docType: args.docType as any,
        includeGlobal: false,
        includePersonal: false,
      });
    },

    stats: async (project: any, _args: unknown, ctx: GraphQLContext) => {
      return { ...await createResourceServices(ctx.identity).projectService.getProjectStats(ctx.db, project.id), authorizationProjectId: project.id };
    },
  },

  Requirement: {
    project: async (req: any, _args: unknown, ctx: GraphQLContext) => {
      // If already loaded (from getRequirement with `with: { project }`)
      if (req.project) return req.project;
      return createResourceServices(ctx.identity).projectService.getProject(ctx.db, req.projectId);
    },

    tasks: async (req: any, args: { status?: string }, ctx: GraphQLContext) => {
      // If already loaded
      if (req.tasks && !args.status) return req.tasks;
      return createResourceServices(ctx.identity).taskService.listTasks(ctx.db, {
        scope: "project",
        projectId: req.projectId,
        requirementId: req.id,
        status: args.status as any,
      });
    },

    linkedDocuments: async (req: any, _args: unknown, ctx: GraphQLContext) => {
      if (req.documentLinks) return req.documentLinks;
      const full = await createResourceServices(ctx.identity).requirementService.getRequirement(ctx.db, req.id);
      return (full as any).documentLinks ?? [];
    },
  },

  Task: {
    project: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (!task.projectId) return null;
      if (task.project) return task.project;
      return createResourceServices(ctx.identity).projectService.getProject(ctx.db, task.projectId);
    },

    requirement: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (!task.requirementId) return null;
      if (task.requirement) return task.requirement;
      return createResourceServices(ctx.identity).requirementService.getRequirement(ctx.db, task.requirementId);
    },

    comments: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.comments) return task.comments;
      const detail = await createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).comments ?? [];
    },

    notes: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.notes) return task.notes;
      const detail = await createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).notes ?? [];
    },

    dependencies: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.dependencies) return task.dependencies;
      const detail = await createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).dependencies ?? [];
    },

    linkedDocuments: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.documentLinks) return task.documentLinks;
      const detail = await createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).documentLinks ?? [];
    },
  },

  Document: {
    project: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.project) return doc.project;
      if (!doc.projectId) return null;
      try {
        return await createResourceServices(ctx.identity).projectService.getProject(ctx.db, doc.projectId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    outgoingLinks: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.outgoingLinks) return doc.outgoingLinks;
      const detail = await createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).outgoingLinks ?? [];
    },

    incomingLinks: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.incomingLinks) return doc.incomingLinks;
      const detail = await createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).incomingLinks ?? [];
    },

    linkedTasks: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.taskLinks) return doc.taskLinks;
      const detail = await createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).taskLinks ?? [];
    },

    linkedRequirements: async (
      doc: any,
      _args: unknown,
      ctx: GraphQLContext,
    ) => {
      if (doc.requirementLinks) return doc.requirementLinks;
      const detail = await createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).requirementLinks ?? [];
    },

    recommendations: async (
      doc: any,
      args: { limit?: number; types?: string[] },
      ctx: GraphQLContext,
    ) => {
      const result = await createResourceServices(ctx.identity).recommendationService.getDocumentRecommendations(
        ctx.db,
        doc.id,
        {
          limit: args.limit ?? 10,
          types: args.types as any,
          projectId: doc.projectId ?? undefined,
        },
      );
      return result.recommendations.map(row => ({ ...row, authorizationDocumentId: doc.id }));
    },
  },

  ProjectStats: {
    byStatus: (stats: any) => {
      if (Array.isArray(stats.byStatus)) return stats.byStatus;
      return Object.entries(stats.byStatus ?? {}).map(([status, count]) => ({
        authorizationProjectId: stats.authorizationProjectId,
        status,
        count,
      }));
    },
    byPriority: (stats: any) => {
      if (Array.isArray(stats.byPriority)) return stats.byPriority;
      return Object.entries(stats.byPriority ?? {}).map(
        ([priority, count]) => ({
          authorizationProjectId: stats.authorizationProjectId,
          priority,
          count,
        }),
      );
    },
  },

  DocumentLink: {
    sourceDoc: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.sourceDoc) return link.sourceDoc;
      try {
        return await createResourceServices(ctx.identity).documentService.getDocumentDetail(
          ctx.db,
          link.sourceDocId,
        );
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    targetDoc: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.targetDoc) return link.targetDoc;
      try {
        return await createResourceServices(ctx.identity).documentService.getDocumentDetail(
          ctx.db,
          link.targetDocId,
        );
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  },

  DocumentTaskLink: {
    document: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.document) return link.document;
      try {
        return await createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, link.documentId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    task: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.task) return link.task;
      try {
        return await createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, link.taskId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  },

  DocumentRequirementLink: {
    document: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.document) return link.document;
      try {
        return await createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, link.documentId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    requirement: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.requirement) return link.requirement;
      try {
        return await createResourceServices(ctx.identity).requirementService.getRequirement(
          ctx.db,
          link.requirementId,
        );
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  },

  TaskDependency: {
    dependsOn: async (dep: any, _args: unknown, ctx: GraphQLContext) => {
      if (dep.dependsOn) return dep.dependsOn;
      try {
        return await createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, dep.dependsOnTaskId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  },
};

export const schema = createSchema<GraphQLContext>({ typeDefs, resolvers });

// Guard explicit AND default nested resolvers. A cached context or caller-supplied root value is not authority.
for (const type of Object.values(schema.getTypeMap())) {
  if (!isObjectType(type) || type.name.startsWith("__")) continue;
  for (const [name, field] of Object.entries(type.getFields())) {
    const resolve = field.resolve ?? defaultFieldResolver;
    field.resolve = async (source, args, context: GraphQLContext, info) => {
      try {
        if (!context?.auth || !(context.headers instanceof Headers))
          throw new AuthenticationError();
        context.auth.assertOrigin(context.headers);
        const identity = await context.auth.verify(context.headers);
        const liveContext = { ...context, identity };
        const services = createResourceServices(identity);
        if (type.name === "Query") {
          if (!["currentActor", "project", "projects", "task", "tasks", "requirement", "requirements", "document", "documents", "searchDocuments"].includes(name)) requireResourceAuthorization();
        } else if (type.name === "Project") {
          await services.projectService.getProject(context.db, source.id);
        } else if (type.name === "Task") {
          await services.taskService.getTask(context.db, source.id);
        } else if (type.name === "Requirement") {
          await services.requirementService.getRequirement(context.db, source.id);
        } else if (type.name === "Document") {
          await services.documentService.getDocument(context.db, source.id);
        } else if (["Comment", "Note", "TaskDependency"].includes(type.name)) {
          await services.taskService.getTask(context.db, source.taskId);
          if (source.dependsOnTaskId) await services.taskService.getTask(context.db, source.dependsOnTaskId);
        } else if (type.name === "DocumentLink") {
          await services.documentService.getDocument(context.db, source.sourceDocId);
          await services.documentService.getDocument(context.db, source.targetDocId);
        } else if (["DocumentTaskLink", "DocumentRequirementLink"].includes(type.name)) {
          await services.documentService.getDocument(context.db, source.documentId);
          if (source.taskId) await services.taskService.getTask(context.db, source.taskId);
          if (source.requirementId) await services.requirementService.getRequirement(context.db, source.requirementId);
        } else if (["ProjectStats", "StatusCount", "PriorityCount"].includes(type.name)) {
          await services.projectService.getProject(context.db, source.authorizationProjectId);
        } else if (type.name === "RequirementProgress") {
          await services.requirementService.getRequirement(context.db, source.id);
        } else if (type.name === "Recommendation") {
          await services.documentService.getDocument(context.db, source.authorizationDocumentId);
          if (source.type === "document") await services.documentService.getDocument(context.db, source.id);
          else if (source.type === "task") await services.taskService.getTask(context.db, source.id);
          else await services.requirementService.getRequirement(context.db, source.id);
        } else if (type.name !== "AuthenticatedActor") requireResourceAuthorization();
        return await resolve(source, args, liveContext, info);
      } catch (error) {
        const failure = authenticationFailure(error);
        throw new GraphQLError(failure.error, {
          extensions: { code: failure.code, http: { status: failure.status } },
        });
      }
    };
  }
}
