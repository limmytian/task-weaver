export interface NavigationItem { id: string; label: string; href: `/${string}`; icon?: string }
export interface SettingsItem { id: string; href: `/${string}`; title: string; description: string; icon?: string }
export const navigation: readonly NavigationItem[] = [
      { id: "projects", label: "Projects", href: "/projects", icon: "layout" },
      { id: "personal", label: "Personal", href: "/projects/personal", icon: "inbox" },
      { id: "documents", label: "Documents", href: "/projects/documents", icon: "document" },
      { id: "repositories", label: "Repositories", href: "/projects/repositories", icon: "repository" },
      { id: "search", label: "Search", href: "/projects/search", icon: "search" },
      { id: "memories", label: "Memories", href: "/projects/memories", icon: "brain" },
      { id: "skills", label: "Skills", href: "/projects/skills", icon: "puzzle" },
      { id: "mcp", label: "MCP Servers", href: "/projects/mcp", icon: "server" },
      { id: "daemons", label: "Daemons", href: "/projects/daemons", icon: "cpu" },
      { id: "usage", label: "Agent Usage", href: "/projects/usage", icon: "cpu" },
      { id: "agents", label: "Ti Agent", href: "/projects/agents", icon: "agent" },
      { id: "settings", label: "Settings", href: "/projects/settings", icon: "settings" },
    ];
export const settings: readonly SettingsItem[] = [
  { id: "version", href: "/projects/settings/version", title: "Version", description: "Build and release information", icon: "server" },
  { id: "api-keys", href: "/projects/settings/api-keys", title: "API Keys", description: "Agent authentication", icon: "key" },
  { id: "embeddings", href: "/projects/settings/embeddings", title: "Embedding Search", description: "Semantic retrieval", icon: "storage" },
];
