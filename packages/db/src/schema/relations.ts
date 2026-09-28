import { relations } from "drizzle-orm";
import { projects } from "./projects";
import {
  taskClaims,
  taskComments,
  taskDependencies,
  taskNotes,
  tasks,
  taskStatusLog,
} from "./tasks";
import {
  documentLinks,
  documentRequirementLinks,
  documents,
  documentTaskLinks,
  documentVersions,
} from "./documents";
import {
  documentEmbeddings,
  documentEmbeddingStates,
  embeddingDocumentChunks,
  embeddingGenerations,
  embeddingJobItems,
  embeddingJobs,
  embeddingLifecycleEvents,
  embeddingProfiles,
} from "./embeddings";
import { executionSlices, requirementClaims, requirementDependencies, requirements } from "./requirements";
import {
  repositories,
  repositoryCheckoutBindings,
  requirementRepositories,
  taskRepositories,
} from "./repositories";
import { daemons } from "./daemons";
import { activityLog } from "./activity";
import { mcpServers } from "./mcp-servers";
import { scheduleRuns, schedules } from "./schedules";
import { piAgentModelConfigs, piAgentPolicies, piAgentRuns } from "./pi-agent";
import { assistantActions, assistantConversations, assistantMessages } from "./assistant";
import { reviewChecks, reviewDecisions, reviewFindings, reviewPolicies, reviewRuns } from "./reviews";
import {
  skillPackageFiles,
  skillPackages,
  skillPackageStorageObjects,
  skillPackageVersions,
} from "./skill-packages";

// -- Project relations --

export const projectsRelations = relations(projects, ({ many }) => ({
  tasks: many(tasks),
  documents: many(documents),
  requirements: many(requirements),
  mcpServers: many(mcpServers),
  skillPackages: many(skillPackages),
  reviewPolicies: many(reviewPolicies),
  embeddingProfiles: many(embeddingProfiles),
}));

// -- Requirement relations --

export const requirementsRelations = relations(
  requirements,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [requirements.projectId],
      references: [projects.id],
    }),
    claim: one(requirementClaims),
    tasks: many(tasks),
    executionSlices: many(executionSlices),
    dependencies: many(requirementDependencies, { relationName: "requirementDependencies" }),
    dependents: many(requirementDependencies, { relationName: "requirementDependents" }),
    documentLinks: many(documentRequirementLinks),
    schedules: many(schedules),
    assistantConversations: many(assistantConversations),
    repositories: many(requirementRepositories),
    reviewPolicies: many(reviewPolicies),
    reviewRuns: many(reviewRuns),
  }),
);

export const executionSlicesRelations = relations(
  executionSlices,
  ({ one, many }) => ({
    requirement: one(requirements, {
      fields: [executionSlices.requirementId],
      references: [requirements.id],
    }),
    tasks: many(tasks),
  }),
);

export const requirementClaimsRelations = relations(requirementClaims, ({ one }) => ({
  requirement: one(requirements, {
    fields: [requirementClaims.requirementId],
    references: [requirements.id],
  }),
}));

export const requirementDependenciesRelations = relations(
  requirementDependencies,
  ({ one }) => ({
    requirement: one(requirements, {
      fields: [requirementDependencies.requirementId],
      references: [requirements.id],
      relationName: "requirementDependencies",
    }),
    dependsOn: one(requirements, {
      fields: [requirementDependencies.dependsOnRequirementId],
      references: [requirements.id],
      relationName: "requirementDependents",
    }),
  }),
);

export const documentRequirementLinksRelations = relations(
  documentRequirementLinks,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentRequirementLinks.documentId],
      references: [documents.id],
    }),
    requirement: one(requirements, {
      fields: [documentRequirementLinks.requirementId],
      references: [requirements.id],
    }),
  }),
);

// -- Task relations --

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  requirement: one(requirements, {
    fields: [tasks.requirementId],
    references: [requirements.id],
  }),
  executionSlice: one(executionSlices, {
    fields: [tasks.executionSliceId],
    references: [executionSlices.id],
  }),
  claim: one(taskClaims),
  statusLogs: many(taskStatusLog),
  comments: many(taskComments),
  notes: many(taskNotes),
  dependencies: many(taskDependencies, { relationName: "taskDependencies" }),
  dependents: many(taskDependencies, { relationName: "taskDependents" }),
  documentLinks: many(documentTaskLinks),
  daemons: many(daemons),
  scheduleRuns: many(scheduleRuns),
  assistantConversations: many(assistantConversations),
  repositories: many(taskRepositories),
}));

// -- Repository relations --

export const repositoriesRelations = relations(repositories, ({ many }) => ({
  requirements: many(requirementRepositories),
  tasks: many(taskRepositories),
  checkoutBindings: many(repositoryCheckoutBindings),
}));

export const requirementRepositoriesRelations = relations(
  requirementRepositories,
  ({ one, many }) => ({
    requirement: one(requirements, {
      fields: [requirementRepositories.requirementId],
      references: [requirements.id],
    }),
    repository: one(repositories, {
      fields: [requirementRepositories.repositoryId],
      references: [repositories.id],
    }),
    reviewRuns: many(reviewRuns),
  }),
);

export const reviewPoliciesRelations = relations(reviewPolicies, ({ one }) => ({
  project: one(projects, {
    fields: [reviewPolicies.projectId],
    references: [projects.id],
  }),
  requirement: one(requirements, {
    fields: [reviewPolicies.requirementId],
    references: [requirements.id],
  }),
}));

export const reviewRunsRelations = relations(reviewRuns, ({ one, many }) => ({
  requirement: one(requirements, {
    fields: [reviewRuns.requirementId],
    references: [requirements.id],
  }),
  requirementRepository: one(requirementRepositories, {
    fields: [reviewRuns.requirementRepositoryId],
    references: [requirementRepositories.id],
  }),
  checks: many(reviewChecks),
  findings: many(reviewFindings),
  decisions: many(reviewDecisions),
}));

export const reviewChecksRelations = relations(reviewChecks, ({ one }) => ({
  reviewRun: one(reviewRuns, {
    fields: [reviewChecks.reviewRunId],
    references: [reviewRuns.id],
  }),
}));

export const reviewFindingsRelations = relations(reviewFindings, ({ one }) => ({
  reviewRun: one(reviewRuns, {
    fields: [reviewFindings.reviewRunId],
    references: [reviewRuns.id],
  }),
}));

export const reviewDecisionsRelations = relations(reviewDecisions, ({ one }) => ({
  reviewRun: one(reviewRuns, {
    fields: [reviewDecisions.reviewRunId],
    references: [reviewRuns.id],
  }),
}));

export const taskRepositoriesRelations = relations(taskRepositories, ({ one }) => ({
  task: one(tasks, {
    fields: [taskRepositories.taskId],
    references: [tasks.id],
  }),
  repository: one(repositories, {
    fields: [taskRepositories.repositoryId],
    references: [repositories.id],
  }),
}));

export const repositoryCheckoutBindingsRelations = relations(
  repositoryCheckoutBindings,
  ({ one }) => ({
    repository: one(repositories, {
      fields: [repositoryCheckoutBindings.repositoryId],
      references: [repositories.id],
    }),
  }),
);

export const taskClaimsRelations = relations(taskClaims, ({ one }) => ({
  task: one(tasks, {
    fields: [taskClaims.taskId],
    references: [tasks.id],
  }),
}));

export const taskStatusLogRelations = relations(taskStatusLog, ({ one }) => ({
  task: one(tasks, {
    fields: [taskStatusLog.taskId],
    references: [tasks.id],
  }),
}));

export const taskCommentsRelations = relations(taskComments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskComments.taskId],
    references: [tasks.id],
  }),
}));

export const taskNotesRelations = relations(taskNotes, ({ one }) => ({
  task: one(tasks, {
    fields: [taskNotes.taskId],
    references: [tasks.id],
  }),
}));

export const taskDependenciesRelations = relations(
  taskDependencies,
  ({ one }) => ({
    task: one(tasks, {
      fields: [taskDependencies.taskId],
      references: [tasks.id],
      relationName: "taskDependencies",
    }),
    dependsOn: one(tasks, {
      fields: [taskDependencies.dependsOnTaskId],
      references: [tasks.id],
      relationName: "taskDependents",
    }),
  }),
);

// -- Document relations --

export const documentsRelations = relations(documents, ({ one, many }) => ({
  project: one(projects, {
    fields: [documents.projectId],
    references: [projects.id],
  }),
  outgoingLinks: many(documentLinks, { relationName: "sourceDoc" }),
  incomingLinks: many(documentLinks, { relationName: "targetDoc" }),
  taskLinks: many(documentTaskLinks),
  requirementLinks: many(documentRequirementLinks),
  versions: many(documentVersions),
  primaryForSkillPackages: many(skillPackages),
  skillPackageFiles: many(skillPackageFiles),
  embeddingChunks: many(embeddingDocumentChunks),
  embeddingStates: many(documentEmbeddingStates),
}));

// -- Embedding relations --

export const embeddingProfilesRelations = relations(embeddingProfiles, ({ one, many }) => ({
  project: one(projects, {
    fields: [embeddingProfiles.projectId],
    references: [projects.id],
  }),
  activeGeneration: one(embeddingGenerations, {
    fields: [embeddingProfiles.activeGenerationId],
    references: [embeddingGenerations.id],
    relationName: "activeEmbeddingGeneration",
  }),
  generations: many(embeddingGenerations, { relationName: "profileEmbeddingGenerations" }),
  documentStates: many(documentEmbeddingStates),
  jobs: many(embeddingJobs),
  lifecycleEvents: many(embeddingLifecycleEvents),
}));

export const embeddingGenerationsRelations = relations(
  embeddingGenerations,
  ({ one, many }) => ({
    profile: one(embeddingProfiles, {
      fields: [embeddingGenerations.profileId],
      references: [embeddingProfiles.id],
      relationName: "profileEmbeddingGenerations",
    }),
    activeForProfile: one(embeddingProfiles, {
      fields: [embeddingGenerations.id],
      references: [embeddingProfiles.activeGenerationId],
      relationName: "activeEmbeddingGeneration",
    }),
    chunks: many(embeddingDocumentChunks),
    embeddings: many(documentEmbeddings),
    documentStates: many(documentEmbeddingStates),
    jobs: many(embeddingJobs),
    lifecycleEvents: many(embeddingLifecycleEvents),
  }),
);

export const embeddingDocumentChunksRelations = relations(
  embeddingDocumentChunks,
  ({ one, many }) => ({
    generation: one(embeddingGenerations, {
      fields: [embeddingDocumentChunks.generationId],
      references: [embeddingGenerations.id],
    }),
    document: one(documents, {
      fields: [embeddingDocumentChunks.documentId],
      references: [documents.id],
    }),
    embeddings: many(documentEmbeddings),
  }),
);

export const documentEmbeddingsRelations = relations(documentEmbeddings, ({ one }) => ({
  generation: one(embeddingGenerations, {
    fields: [documentEmbeddings.generationId],
    references: [embeddingGenerations.id],
  }),
  chunk: one(embeddingDocumentChunks, {
    fields: [documentEmbeddings.chunkId],
    references: [embeddingDocumentChunks.id],
  }),
}));

export const documentEmbeddingStatesRelations = relations(
  documentEmbeddingStates,
  ({ one }) => ({
    profile: one(embeddingProfiles, {
      fields: [documentEmbeddingStates.profileId],
      references: [embeddingProfiles.id],
    }),
    generation: one(embeddingGenerations, {
      fields: [documentEmbeddingStates.generationId],
      references: [embeddingGenerations.id],
    }),
    document: one(documents, {
      fields: [documentEmbeddingStates.documentId],
      references: [documents.id],
    }),
  }),
);

export const embeddingJobsRelations = relations(embeddingJobs, ({ one, many }) => ({
  profile: one(embeddingProfiles, {
    fields: [embeddingJobs.profileId],
    references: [embeddingProfiles.id],
  }),
  generation: one(embeddingGenerations, {
    fields: [embeddingJobs.generationId],
    references: [embeddingGenerations.id],
  }),
  items: many(embeddingJobItems),
  lifecycleEvents: many(embeddingLifecycleEvents),
}));

export const embeddingJobItemsRelations = relations(embeddingJobItems, ({ one }) => ({
  job: one(embeddingJobs, {
    fields: [embeddingJobItems.jobId],
    references: [embeddingJobs.id],
  }),
}));

export const embeddingLifecycleEventsRelations = relations(
  embeddingLifecycleEvents,
  ({ one }) => ({
    profile: one(embeddingProfiles, {
      fields: [embeddingLifecycleEvents.profileId],
      references: [embeddingProfiles.id],
    }),
    generation: one(embeddingGenerations, {
      fields: [embeddingLifecycleEvents.generationId],
      references: [embeddingGenerations.id],
    }),
    job: one(embeddingJobs, {
      fields: [embeddingLifecycleEvents.jobId],
      references: [embeddingJobs.id],
    }),
  }),
);

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}));

export const documentLinksRelations = relations(documentLinks, ({ one }) => ({
  sourceDoc: one(documents, {
    fields: [documentLinks.sourceDocId],
    references: [documents.id],
    relationName: "sourceDoc",
  }),
  targetDoc: one(documents, {
    fields: [documentLinks.targetDocId],
    references: [documents.id],
    relationName: "targetDoc",
  }),
}));

export const documentTaskLinksRelations = relations(
  documentTaskLinks,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentTaskLinks.documentId],
      references: [documents.id],
    }),
    task: one(tasks, {
      fields: [documentTaskLinks.taskId],
      references: [tasks.id],
    }),
  }),
);

// -- MCP relations --

export const mcpServersRelations = relations(mcpServers, ({ one }) => ({
  project: one(projects, {
    fields: [mcpServers.projectId],
    references: [projects.id],
  }),
}));

// -- Skill package relations --

export const skillPackagesRelations = relations(skillPackages, ({ one, many }) => ({
  project: one(projects, {
    fields: [skillPackages.projectId],
    references: [projects.id],
  }),
  primaryDocument: one(documents, {
    fields: [skillPackages.primaryDocumentId],
    references: [documents.id],
  }),
  versions: many(skillPackageVersions),
}));

export const skillPackageVersionsRelations = relations(
  skillPackageVersions,
  ({ one, many }) => ({
    package: one(skillPackages, {
      fields: [skillPackageVersions.packageId],
      references: [skillPackages.id],
    }),
    files: many(skillPackageFiles),
    storageObjects: many(skillPackageStorageObjects),
  }),
);

export const skillPackageStorageObjectsRelations = relations(
  skillPackageStorageObjects,
  ({ one, many }) => ({
    packageVersion: one(skillPackageVersions, {
      fields: [skillPackageStorageObjects.packageVersionId],
      references: [skillPackageVersions.id],
    }),
    files: many(skillPackageFiles),
  }),
);

export const skillPackageFilesRelations = relations(skillPackageFiles, ({ one }) => ({
  packageVersion: one(skillPackageVersions, {
    fields: [skillPackageFiles.packageVersionId],
    references: [skillPackageVersions.id],
  }),
  storageObject: one(skillPackageStorageObjects, {
    fields: [skillPackageFiles.storageObjectId],
    references: [skillPackageStorageObjects.id],
  }),
  indexedDocument: one(documents, {
    fields: [skillPackageFiles.indexedDocumentId],
    references: [documents.id],
  }),
}));

// -- Schedule relations --

export const schedulesRelations = relations(schedules, ({ one, many }) => ({
  project: one(projects, {
    fields: [schedules.projectId],
    references: [projects.id],
  }),
  requirement: one(requirements, {
    fields: [schedules.requirementId],
    references: [requirements.id],
  }),
  runs: many(scheduleRuns),
}));

export const scheduleRunsRelations = relations(scheduleRuns, ({ one }) => ({
  schedule: one(schedules, {
    fields: [scheduleRuns.scheduleId],
    references: [schedules.id],
  }),
  generatedTask: one(tasks, {
    fields: [scheduleRuns.generatedTaskId],
    references: [tasks.id],
  }),
  piAgentRun: one(piAgentRuns),
}));

// -- Ti server-agent / Pi engine relations --

export const piAgentModelConfigsRelations = relations(piAgentModelConfigs, () => ({}));

export const piAgentPoliciesRelations = relations(piAgentPolicies, () => ({}));

export const piAgentRunsRelations = relations(piAgentRuns, ({ one }) => ({
  task: one(tasks, {
    fields: [piAgentRuns.taskId],
    references: [tasks.id],
  }),
  scheduleRun: one(scheduleRuns, {
    fields: [piAgentRuns.scheduleRunId],
    references: [scheduleRuns.id],
  }),
}));

// -- Assistant relations --

export const assistantConversationsRelations = relations(
  assistantConversations,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [assistantConversations.projectId],
      references: [projects.id],
    }),
    requirement: one(requirements, {
      fields: [assistantConversations.requirementId],
      references: [requirements.id],
    }),
    task: one(tasks, {
      fields: [assistantConversations.taskId],
      references: [tasks.id],
    }),
    schedule: one(schedules, {
      fields: [assistantConversations.scheduleId],
      references: [schedules.id],
    }),
    messages: many(assistantMessages),
    actions: many(assistantActions),
  }),
);

export const assistantMessagesRelations = relations(
  assistantMessages,
  ({ one, many }) => ({
    conversation: one(assistantConversations, {
      fields: [assistantMessages.conversationId],
      references: [assistantConversations.id],
    }),
    piAgentRun: one(piAgentRuns, {
      fields: [assistantMessages.piAgentRunId],
      references: [piAgentRuns.id],
    }),
    actions: many(assistantActions),
  }),
);

export const assistantActionsRelations = relations(assistantActions, ({ one }) => ({
  conversation: one(assistantConversations, {
    fields: [assistantActions.conversationId],
    references: [assistantConversations.id],
  }),
  message: one(assistantMessages, {
    fields: [assistantActions.messageId],
    references: [assistantMessages.id],
  }),
  activityLog: one(activityLog, {
    fields: [assistantActions.activityLogId],
    references: [activityLog.id],
  }),
}));
