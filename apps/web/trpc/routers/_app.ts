import { router } from "../init";
import { projectRouter } from "./project";
import { taskRouter } from "./task";
import { requirementRouter } from "./requirement";
import { documentRouter } from "./document";
import { searchRouter } from "./search";
import { activityRouter } from "./activity";
import { apiKeyRouter } from "./api-key";
import { mcpRouter } from "./mcp";
import { memoryRouter } from "./memory";
import { skillRouter } from "./skill";
import { daemonRouter } from "./daemon";
import { scheduleRouter } from "./schedule";
import { piAgentRouter } from "./pi-agent";
import { assistantRouter } from "./assistant";
import { repositoryRouter } from "./repository";
import { embeddingRouter } from "./embedding";

export const appRouter = router({
  project: projectRouter,
  task: taskRouter,
  requirement: requirementRouter,
  document: documentRouter,
  search: searchRouter,
  activity: activityRouter,
  apiKey: apiKeyRouter,
  mcp: mcpRouter,
  memory: memoryRouter,
  skill: skillRouter,
  daemon: daemonRouter,
  schedule: scheduleRouter,
  piAgent: piAgentRouter,
  assistant: assistantRouter,
  repository: repositoryRouter,
  embedding: embeddingRouter,
});

export type AppRouter = typeof appRouter;
