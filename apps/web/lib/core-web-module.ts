import { TASK_WEAVER_MODULE_API_VERSION } from "@task-weaver/module-sdk";
import { defineTaskWeaverWebModule, TASK_WEAVER_WEB_CORE_VERSION } from "./web-module-registry";

export const coreWebModule = defineTaskWeaverWebModule({
  manifest: {
    apiVersion: TASK_WEAVER_MODULE_API_VERSION,
    id: "task-weaver.web",
    name: "Task Weaver Web",
    version: TASK_WEAVER_WEB_CORE_VERSION,
    supportedCoreVersion: `^${TASK_WEAVER_WEB_CORE_VERSION}`,
    description: "Default Task Weaver Web navigation and settings",
    capabilities: ["core.web"],
    permissions: [{
      id: "core.web.access",
      description: "Access the Task Weaver Web application",
    }],
  },
  web: {
    navigation: [
      { id: "projects", label: "Projects", href: "/projects", icon: "layout" },
      { id: "personal", label: "Personal", href: "/projects/personal", icon: "inbox" },
      { id: "documents", label: "Documents", href: "/projects/documents", icon: "document" },
      { id: "repositories", label: "Repositories", href: "/projects/repositories", icon: "repository" },
      { id: "search", label: "Search", href: "/projects/search", icon: "search" },
      { id: "memories", label: "Memories", href: "/projects/memories", icon: "brain" },
      { id: "skills", label: "Skills", href: "/projects/skills", icon: "puzzle" },
      { id: "mcp", label: "MCP Servers", href: "/projects/mcp", icon: "server" },
      { id: "daemons", label: "Daemons", href: "/projects/daemons", icon: "cpu" },
      { id: "agents", label: "Ti Agent", href: "/projects/agents", icon: "agent" },
      { id: "settings", label: "Settings", href: "/projects/settings", icon: "settings" },
    ],
    settings: [
      {
        id: "api-keys",
        settings: {
          href: "/projects/settings/api-keys",
          title: "API Keys",
          description: "Agent authentication",
          icon: "key",
        },
      },
      {
        id: "embeddings",
        settings: {
          href: "/projects/settings/embeddings",
          title: "Embedding Search",
          description: "Semantic retrieval",
          icon: "storage",
        },
      },
    ],
  },
});
