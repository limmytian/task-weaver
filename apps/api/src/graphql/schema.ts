/**
 * GraphQL schema for Task Weaver.
 *
 * Uses graphql-yoga with code-first SDL schema.
 * Resolvers delegate to existing core services — no direct DB access.
 */
import { createSchema } from "graphql-yoga";
import type { Database } from "@task-weaver/db";
import {
  projectService,
  taskService,
  documentService,
  requirementService,
  recommendationService,
} from "@task-weaver/core";

export interface GraphQLContext {
  db: Database;
}

const typeDefs = /* GraphQL */ `
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

    requirements(status: RequirementStatus, priority: RequirementPriority): [Requirement!]!
    tasks(status: TaskStatus, assignee: String, priority: TaskPriority): [Task!]!
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
    projectId: ID!
    requirementId: ID!
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

    project: Project!
    requirement: Requirement!
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
    project(id: ID!): Project
    projects(status: ProjectStatus): [Project!]!

    task(id: ID!): Task
    tasks(projectId: ID!, status: TaskStatus, assignee: String, priority: TaskPriority): [Task!]!

    requirement(id: ID!): Requirement
    requirements(projectId: ID!, status: RequirementStatus, priority: RequirementPriority): [Requirement!]!

    document(id: ID!): Document
    documents(projectId: ID, docType: DocumentType, includeGlobal: Boolean): [Document!]!

    searchDocuments(query: String!, mode: String, projectId: ID, limit: Int): [Document!]!
  }
`;

const resolvers = {
  Query: {
    project: async (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      try {
        return await projectService.getProject(ctx.db, id);
      } catch {
        return null;
      }
    },

    projects: async (
      _: unknown,
      { status }: { status?: string },
      ctx: GraphQLContext,
    ) => {
      return projectService.listProjects(ctx.db, { status: status as any });
    },

    task: async (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      try {
        return await taskService.getTaskDetail(ctx.db, id);
      } catch {
        return null;
      }
    },

    tasks: async (
      _: unknown,
      args: { projectId: string; status?: string; assignee?: string; priority?: string },
      ctx: GraphQLContext,
    ) => {
      return taskService.listTasks(ctx.db, {
        scope: "project",
        projectId: args.projectId,
        status: args.status as any,
        assignee: args.assignee,
        priority: args.priority as any,
      });
    },

    requirement: async (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      try {
        return await requirementService.getRequirement(ctx.db, id);
      } catch {
        return null;
      }
    },

    requirements: async (
      _: unknown,
      args: { projectId: string; status?: string; priority?: string },
      ctx: GraphQLContext,
    ) => {
      return requirementService.listRequirements(ctx.db, {
        projectId: args.projectId,
        status: args.status as any,
        priority: args.priority as any,
      });
    },

    document: async (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      try {
        return await documentService.getDocumentDetail(ctx.db, id);
      } catch {
        return null;
      }
    },

    documents: async (
      _: unknown,
      args: { projectId?: string; docType?: string; includeGlobal?: boolean },
      ctx: GraphQLContext,
    ) => {
      return documentService.listDocuments(ctx.db, {
        projectId: args.projectId,
        docType: args.docType as any,
        includeGlobal: args.includeGlobal ?? true,
        includePersonal: false,
      });
    },

    searchDocuments: async (
      _: unknown,
      args: { query: string; mode?: string; projectId?: string; limit?: number },
      ctx: GraphQLContext,
    ) => {
      const results = await documentService.searchDocuments(ctx.db, {
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
      return requirementService.listRequirements(ctx.db, {
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
      return taskService.listTasks(ctx.db, {
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
      return documentService.listDocuments(ctx.db, {
        projectId: project.id,
        docType: args.docType as any,
        includeGlobal: false,
        includePersonal: false,
      });
    },

    stats: async (project: any, _args: unknown, ctx: GraphQLContext) => {
      return projectService.getProjectStats(ctx.db, project.id);
    },
  },

  Requirement: {
    project: async (req: any, _args: unknown, ctx: GraphQLContext) => {
      // If already loaded (from getRequirement with `with: { project }`)
      if (req.project) return req.project;
      return projectService.getProject(ctx.db, req.projectId);
    },

    tasks: async (
      req: any,
      args: { status?: string },
      ctx: GraphQLContext,
    ) => {
      // If already loaded
      if (req.tasks && !args.status) return req.tasks;
      return taskService.listTasks(ctx.db, {
        scope: "project",
        projectId: req.projectId,
        requirementId: req.id,
        status: args.status as any,
      });
    },

    linkedDocuments: async (req: any, _args: unknown, ctx: GraphQLContext) => {
      if (req.documentLinks) return req.documentLinks;
      const full = await requirementService.getRequirement(ctx.db, req.id);
      return (full as any).documentLinks ?? [];
    },
  },

  Task: {
    project: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.project) return task.project;
      return projectService.getProject(ctx.db, task.projectId);
    },

    requirement: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.requirement) return task.requirement;
      return requirementService.getRequirement(ctx.db, task.requirementId);
    },

    comments: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.comments) return task.comments;
      const detail = await taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).comments ?? [];
    },

    notes: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.notes) return task.notes;
      const detail = await taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).notes ?? [];
    },

    dependencies: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.dependencies) return task.dependencies;
      const detail = await taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).dependencies ?? [];
    },

    linkedDocuments: async (task: any, _args: unknown, ctx: GraphQLContext) => {
      if (task.documentLinks) return task.documentLinks;
      const detail = await taskService.getTaskDetail(ctx.db, task.id);
      return (detail as any).documentLinks ?? [];
    },
  },

  Document: {
    project: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.project) return doc.project;
      if (!doc.projectId) return null;
      try {
        return await projectService.getProject(ctx.db, doc.projectId);
      } catch {
        return null;
      }
    },

    outgoingLinks: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.outgoingLinks) return doc.outgoingLinks;
      const detail = await documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).outgoingLinks ?? [];
    },

    incomingLinks: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.incomingLinks) return doc.incomingLinks;
      const detail = await documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).incomingLinks ?? [];
    },

    linkedTasks: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.taskLinks) return doc.taskLinks;
      const detail = await documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).taskLinks ?? [];
    },

    linkedRequirements: async (doc: any, _args: unknown, ctx: GraphQLContext) => {
      if (doc.requirementLinks) return doc.requirementLinks;
      const detail = await documentService.getDocumentDetail(ctx.db, doc.id);
      return (detail as any).requirementLinks ?? [];
    },

    recommendations: async (
      doc: any,
      args: { limit?: number; types?: string[] },
      ctx: GraphQLContext,
    ) => {
      const result = await recommendationService.getDocumentRecommendations(
        ctx.db,
        doc.id,
        {
          limit: args.limit ?? 10,
          types: args.types as any,
          projectId: doc.projectId ?? undefined,
        },
      );
      return result.recommendations;
    },
  },

  ProjectStats: {
    byStatus: (stats: any) => {
      if (Array.isArray(stats.byStatus)) return stats.byStatus;
      return Object.entries(stats.byStatus ?? {}).map(([status, count]) => ({
        status,
        count,
      }));
    },
    byPriority: (stats: any) => {
      if (Array.isArray(stats.byPriority)) return stats.byPriority;
      return Object.entries(stats.byPriority ?? {}).map(([priority, count]) => ({
        priority,
        count,
      }));
    },
  },

  DocumentLink: {
    sourceDoc: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.sourceDoc) return link.sourceDoc;
      try {
        return await documentService.getDocumentDetail(ctx.db, link.sourceDocId);
      } catch {
        return null;
      }
    },
    targetDoc: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.targetDoc) return link.targetDoc;
      try {
        return await documentService.getDocumentDetail(ctx.db, link.targetDocId);
      } catch {
        return null;
      }
    },
  },

  DocumentTaskLink: {
    document: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.document) return link.document;
      try {
        return await documentService.getDocumentDetail(ctx.db, link.documentId);
      } catch {
        return null;
      }
    },
    task: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.task) return link.task;
      try {
        return await taskService.getTaskDetail(ctx.db, link.taskId);
      } catch {
        return null;
      }
    },
  },

  DocumentRequirementLink: {
    document: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.document) return link.document;
      try {
        return await documentService.getDocumentDetail(ctx.db, link.documentId);
      } catch {
        return null;
      }
    },
    requirement: async (link: any, _args: unknown, ctx: GraphQLContext) => {
      if (link.requirement) return link.requirement;
      try {
        return await requirementService.getRequirement(ctx.db, link.requirementId);
      } catch {
        return null;
      }
    },
  },

  TaskDependency: {
    dependsOn: async (dep: any, _args: unknown, ctx: GraphQLContext) => {
      if (dep.dependsOn) return dep.dependsOn;
      try {
        return await taskService.getTaskDetail(ctx.db, dep.dependsOnTaskId);
      } catch {
        return null;
      }
    },
  },
};

export const schema = createSchema<GraphQLContext>({ typeDefs, resolvers });
