"use client";

import { useState, useMemo } from "react";
import { trpc } from "@/trpc/client";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Server,
  Search,
  Plus,
  Trash2,
  RefreshCw,
  Cpu,
  Settings,
  HelpCircle,
  AlertCircle,
  Network,
} from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";

type TransportType = "stdio" | "sse" | "streamable-http";

type StdioConfig = { command: string; args?: string[]; env?: Record<string, string> };
type HttpConfig = { url: string; headers?: Record<string, string> };
type McpServerConfig = StdioConfig | HttpConfig;

export default function McpPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("__all__");

  // Detail Sheet state
  const [detailServerId, setDetailServerId] = useState<string | null>(null);

  // Sync state
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // Create Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newTransport, setNewTransport] = useState<TransportType>("sse");
  const [newProjectId, setNewProjectId] = useState("__global__");
  const [newTags, setNewTags] = useState("");
  const [newActive, setNewActive] = useState(true);
  const [newTtl, setNewTtl] = useState(60);
  const [newClientId, setNewClientId] = useState("web-client");

  // Stdio config fields
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newEnvJson, setNewEnvJson] = useState("{}");

  // HTTP config fields
  const [newUrl, setNewUrl] = useState("");
  const [newHeadersJson, setNewHeadersJson] = useState("{}");

  // Edit Dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editServerId, setEditServerId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTransport, setEditTransport] = useState<TransportType>("sse");
  const [editProjectId, setEditProjectId] = useState("__global__");
  const [editTags, setEditTags] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editTtl, setEditTtl] = useState(60);
  const [editClientId, setEditClientId] = useState("");

  // Stdio edit config fields
  const [editCommand, setEditCommand] = useState("");
  const [editArgs, setEditArgs] = useState("");
  const [editEnvJson, setEditEnvJson] = useState("{}");

  // HTTP edit config fields
  const [editUrl, setEditUrl] = useState("");
  const [editHeadersJson, setEditHeadersJson] = useState("{}");

  // Delete Confirm state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteServerId, setDeleteServerId] = useState<string | null>(null);
  const [deleteServerName, setDeleteServerName] = useState("");

  const utils = trpc.useUtils();

  const { data: projects } = trpc.project.list.useQuery();
  const selectedProjectFilter = selectedProjectId === "__all__" ? undefined : selectedProjectId;
  const { data: servers, isLoading: listLoading } = trpc.mcp.list.useQuery(
    selectedProjectFilter ? { projectId: selectedProjectFilter, includeGlobal: true } : undefined,
  );
  const projectNameById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects],
  );

  const { data: serverDetail, isLoading: detailLoading } = trpc.mcp.get.useQuery(
    { id: detailServerId ?? "" },
    { enabled: !!detailServerId }
  );

  const createServerMutation = trpc.mcp.create.useMutation({
    onSuccess: () => {
      toast.success("MCP server registered successfully");
      utils.mcp.list.invalidate();
      setCreateOpen(false);
      resetCreateForm();
    },
    onError: (err) => {
      toast.error(`Failed to register server: ${err.message}`);
    },
  });

  const updateServerMutation = trpc.mcp.update.useMutation({
    onSuccess: () => {
      toast.success("MCP server updated successfully");
      utils.mcp.list.invalidate();
      if (detailServerId) {
        utils.mcp.get.invalidate({ id: detailServerId });
      }
      setEditOpen(false);
    },
    onError: (err) => {
      toast.error(`Failed to update server: ${err.message}`);
    },
  });

  const deleteServerMutation = trpc.mcp.delete.useMutation({
    onSuccess: () => {
      toast.success("MCP server deleted successfully");
      utils.mcp.list.invalidate();
      setDeleteConfirmOpen(false);
      setDetailServerId(null);
    },
    onError: (err) => {
      toast.error(`Failed to delete server: ${err.message}`);
    },
  });

  const syncToolsMutation = trpc.mcp.sync.useMutation({
    onMutate: (variables) => {
      setSyncingId(variables.id);
    },
    onSuccess: (data) => {
      toast.success(`Successfully synchronized ${data.count} tools`);
      utils.mcp.list.invalidate();
      if (detailServerId) {
        utils.mcp.get.invalidate({ id: detailServerId });
      }
    },
    onError: (err) => {
      toast.error(`Sync failed: ${err.message}`);
    },
    onSettled: () => {
      setSyncingId(null);
    },
  });

  const resetCreateForm = () => {
    setNewName("");
    setNewDescription("");
    setNewTransport("sse");
    setNewProjectId("__global__");
    setNewTags("");
    setNewActive(true);
    setNewTtl(60);
    setNewClientId("web-client");
    setNewCommand("");
    setNewArgs("");
    setNewEnvJson("{}");
    setNewUrl("");
    setNewHeadersJson("{}");
  };

  const handleOpenEdit = (server: NonNullable<typeof servers>[number]) => {
    if (!server) return;
    setEditServerId(server.id);
    setEditName(server.name);
    setEditDescription(server.description ?? "");
    setEditTransport(server.transport as TransportType);
    setEditProjectId(server.projectId ?? "__global__");
    setEditTags(server.tags?.join(", ") ?? "");
    setEditActive(server.active);
    setEditTtl(server.ttl);
    setEditClientId(server.clientId ?? "");

    if (server.transport === "stdio") {
      const config = server.config as { command: string; args?: string[]; env?: Record<string, string> };
      setEditCommand(config?.command ?? "");
      setEditArgs(config?.args?.join(", ") ?? "");
      setEditEnvJson(JSON.stringify(config?.env ?? {}, null, 2));
      setEditUrl("");
      setEditHeadersJson("{}");
    } else {
      const config = server.config as { url: string; headers?: Record<string, string> };
      setEditUrl(config?.url ?? "");
      setEditHeadersJson(JSON.stringify(config?.headers ?? {}, null, 2));
      setEditCommand("");
      setEditArgs("");
      setEditEnvJson("{}");
    }
    setEditOpen(true);
  };

  const parseJsonSafe = (json: string, defaultVal: unknown) => {
    try {
      return json.trim() ? JSON.parse(json) : defaultVal;
    } catch {
      return defaultVal;
    }
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      toast.error("Name is required");
      return;
    }

    let config: McpServerConfig = {} as McpServerConfig;
    if (newTransport === "stdio") {
      if (!newCommand.trim()) {
        toast.error("Stdio command is required");
        return;
      }
      config = {
        command: newCommand.trim(),
        args: newArgs.split(",").map(a => a.trim()).filter(Boolean),
        env: parseJsonSafe(newEnvJson, {}),
      };
    } else {
      if (!newUrl.trim()) {
        toast.error("Connection URL is required");
        return;
      }
      config = {
        url: newUrl.trim(),
        headers: parseJsonSafe(newHeadersJson, {}),
      };
    }

    createServerMutation.mutate({
      name: newName.trim(),
      description: newDescription.trim() || undefined,
      projectId: newProjectId === "__global__" ? undefined : newProjectId,
      transport: newTransport,
      config,
      tags: newTags.split(",").map(t => t.trim()).filter(Boolean),
      active: newActive,
      ttl: newTtl,
      clientId: newTransport === "stdio" ? newClientId : undefined,
    });
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editServerId || !editName.trim()) {
      toast.error("Name is required");
      return;
    }

    let config: McpServerConfig = {} as McpServerConfig;
    if (editTransport === "stdio") {
      if (!editCommand.trim()) {
        toast.error("Stdio command is required");
        return;
      }
      config = {
        command: editCommand.trim(),
        args: editArgs.split(",").map(a => a.trim()).filter(Boolean),
        env: parseJsonSafe(editEnvJson, {}),
      };
    } else {
      if (!editUrl.trim()) {
        toast.error("Connection URL is required");
        return;
      }
      config = {
        url: editUrl.trim(),
        headers: parseJsonSafe(editHeadersJson, {}),
      };
    }

    updateServerMutation.mutate({
      id: editServerId,
      data: {
        name: editName.trim(),
        description: editDescription.trim() || null,
        projectId: editProjectId === "__global__" ? null : editProjectId,
        transport: editTransport,
        config,
        tags: editTags.split(",").map(t => t.trim()).filter(Boolean),
        active: editActive,
        ttl: editTtl,
        clientId: editTransport === "stdio" ? editClientId : undefined,
      },
    });
  };

  const handleOpenDelete = (id: string, name: string) => {
    setDeleteServerId(id);
    setDeleteServerName(name);
    setDeleteConfirmOpen(true);
  };

  const filteredServers = useMemo(() => {
    if (!servers) return [];
    return servers.filter((s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  }, [servers, searchQuery]);

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-lg font-semibold flex items-center gap-1.5">
          <Server className="h-5 w-5 text-emerald-500" />
          MCP Server Registries
        </h1>
        <Button size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Register Server
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Search */}
        <div className="flex max-w-2xl flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search MCP servers by name, tags..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All scopes</SelectItem>
              {projects?.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Server grid */}
        {listLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="space-y-2">
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-4 w-1/3" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-1/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredServers.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-12 text-center border-dashed">
            <Network className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="font-semibold text-lg">No MCP Servers Registered</h3>
            <p className="text-sm text-muted-foreground max-w-sm mt-1">
              Connect external tools via stdio or SSE protocols to expand your agent&apos;s capabilities.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredServers.map((server) => {
              const config = server.config as McpServerConfig;
              const isStdio = server.transport === "stdio";
              const connectionInfo = isStdio ? (config as StdioConfig)?.command : (config as HttpConfig)?.url;
              const status = server.status ?? "disconnected";
              const isSyncing = syncingId === server.id;

              return (
                <Card
                  key={server.id}
                  onClick={() => setDetailServerId(server.id)}
                  className="group relative flex flex-col justify-between overflow-hidden border bg-card/60 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-emerald-500/50 hover:bg-card hover:shadow-lg cursor-pointer"
                >
                  <div className="p-5 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold text-base leading-snug group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                          {server.name}
                        </h3>
                        <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                          {server.transport}
                        </span>
                      </div>

                      {/* Status dot indicator */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={`relative flex h-2.5 w-2.5 rounded-full ${
                          status === "connected" ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" :
                          status === "error" ? "bg-red-500" :
                          "bg-slate-400"
                        }`} />
                        <span className="text-[10px] capitalize font-medium text-muted-foreground">
                          {status}
                        </span>
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {server.description || "No description provided."}
                    </p>

                    <Badge variant={server.projectId ? "outline" : "secondary"} className="w-fit text-[9px]">
                      {server.projectId ? `Project: ${projectNameById.get(server.projectId) ?? "Scoped"}` : "Global"}
                    </Badge>

                    <div className="rounded bg-muted/60 p-2 font-mono text-[10px] break-all truncate text-muted-foreground border">
                      {connectionInfo || "No config info"}
                    </div>

                    {server.tags && server.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {server.tags.map((t) => (
                          <Badge key={t} variant="outline" className="text-[9px] bg-emerald-50/20 text-emerald-700 border-emerald-200/50 dark:bg-emerald-950/20 dark:text-emerald-300">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border-t px-5 py-3 flex items-center justify-between text-xs bg-accent/20">
                    <span className="text-[10px] text-muted-foreground">
                      Active: {server.active ? "Yes" : "No"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        syncToolsMutation.mutate({ id: server.id });
                      }}
                      disabled={isSyncing}
                    >
                      <RefreshCw className={`mr-1 h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} />
                      Sync Tools
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail & Tools Sheet */}
      <Sheet open={!!detailServerId} onOpenChange={(open) => !open && setDetailServerId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto flex flex-col p-6 space-y-6">
          {detailLoading ? (
            <div className="space-y-6 py-6">
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : serverDetail ? (
            <>
              <SheetHeader className="text-left space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <SheetTitle className="text-2xl font-bold pr-6">
                    {serverDetail.server.name}
                  </SheetTitle>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => handleOpenEdit(serverDetail.server)}>
                      <Settings className="mr-1 h-3.5 w-3.5" /> Configure
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => handleOpenDelete(serverDetail.server.id, serverDetail.server.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <SheetDescription className="text-sm">
                  {serverDetail.server.description || "No description provided."}
                </SheetDescription>

                <div className="flex flex-wrap gap-2 text-xs pt-1">
                  <Badge variant="secondary" className="uppercase font-mono">
                    {serverDetail.server.transport}
                  </Badge>
                  <Badge variant={serverDetail.server.projectId ? "outline" : "secondary"}>
                    {serverDetail.server.projectId ? `Project: ${projectNameById.get(serverDetail.server.projectId) ?? "Scoped"}` : "Global"}
                  </Badge>

                  <div className="flex items-center gap-1.5">
                    <span className={`h-2.5 w-2.5 rounded-full ${
                      serverDetail.server.status === "connected" ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" :
                      serverDetail.server.status === "error" ? "bg-red-500" :
                      "bg-slate-400"
                    }`} />
                    <span className="capitalize font-semibold">
                      {serverDetail.server.status ?? "disconnected"}
                    </span>
                  </div>

                  {serverDetail.server.active ? (
                    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 bg-emerald-500/5">Active</Badge>
                  ) : (
                    <Badge variant="outline">Inactive</Badge>
                  )}
                </div>
              </SheetHeader>

              {serverDetail.server.statusMessage && (
                <div className="flex gap-2.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Last Connection Error:</span>
                    <p className="mt-0.5 font-mono break-all">{serverDetail.server.statusMessage}</p>
                  </div>
                </div>
              )}

              <Separator />

              {/* Config Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Registry Parameters
                </h4>
                <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-xs">
                  {serverDetail.server.transport === "stdio" ? (
                    <>
                      {(() => {
                        const cfg = serverDetail.server.config as StdioConfig;
                        return (
                          <>
                            <div>
                              <span className="font-medium text-muted-foreground">Stdio Command: </span>
                              <code className="font-semibold text-foreground">{cfg?.command}</code>
                            </div>
                            {cfg?.args && cfg.args.length > 0 && (
                              <div>
                                <span className="font-medium text-muted-foreground">Arguments: </span>
                                <code className="font-semibold text-foreground">{cfg.args.join(" ")}</code>
                              </div>
                            )}
                            {cfg?.env && Object.keys(cfg.env).length > 0 && (
                              <div>
                                <span className="font-medium text-muted-foreground">Env overrides: </span>
                                <pre className="mt-1 font-mono text-[10px] bg-background p-2 rounded border max-h-24 overflow-y-auto">
                                  {JSON.stringify(cfg.env, null, 2)}
                                </pre>
                              </div>
                            )}
                          </>
                        );
                      })()}
                      { serverDetail.server.clientId && (
                        <div>
                          <span className="font-medium text-muted-foreground">Client ID: </span>
                          <code className="font-semibold text-foreground">{ serverDetail.server.clientId }</code>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {(() => {
                        const cfg = serverDetail.server.config as HttpConfig;
                        return (
                          <>
                            <div>
                              <span className="font-medium text-muted-foreground">SSE / Webhook URL: </span>
                              <code className="font-semibold text-foreground break-all">{cfg?.url}</code>
                            </div>
                            {cfg?.headers && Object.keys(cfg.headers).length > 0 && (
                              <div>
                                <span className="font-medium text-muted-foreground">Headers: </span>
                                <pre className="mt-1 font-mono text-[10px] bg-background p-2 rounded border max-h-24 overflow-y-auto">
                                  {JSON.stringify(cfg.headers, null, 2)}
                                </pre>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </>
                  )}
                  <div>
                    <span className="font-medium text-muted-foreground">TTL Keep-Alive: </span>
                    <span className="font-semibold text-foreground">{ serverDetail.server.ttl } seconds</span>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Synced Tools list */}
              <div className="flex-1 min-w-0 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Cpu className="h-4 w-4" />
                    Synchronized Tools ({serverDetail.tools.length})
                  </h4>
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => syncToolsMutation.mutate({ id: serverDetail.server.id })}
                    disabled={syncingId === serverDetail.server.id}
                  >
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncingId === serverDetail.server.id ? "animate-spin" : ""}`} />
                    Sync Now
                  </Button>
                </div>

                {serverDetail.tools.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
                    No tools synced yet. Trigger a manual sync to pull tools from the server.
                  </div>
                ) : (
                  <div className="space-y-4 max-h-[350px] overflow-y-auto pr-1">
                    {serverDetail.tools.map((tool) => (
                      <div key={tool.id} className="rounded-lg border p-4 bg-background/50 hover:bg-background/80 transition-colors space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-sm font-bold text-indigo-600 dark:text-indigo-400">
                            {tool.name}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {tool.description || "No description provided."}
                        </p>
                        {tool.inputSchema && (
                          <div className="mt-2 text-[10px]">
                            <span className="font-medium text-muted-foreground">Arguments Schema:</span>
                            <pre className="mt-1 font-mono bg-muted/60 p-2 rounded border max-h-32 overflow-y-auto">
                              {JSON.stringify(tool.inputSchema, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Register Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md w-full overflow-y-auto max-h-[90vh]">
          <form onSubmit={handleCreateSubmit}>
            <DialogHeader>
              <DialogTitle>Register MCP Server</DialogTitle>
              <DialogDescription>
                Register an external Model Context Protocol host for agents to invoke local utilities.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Server Name</label>
                <Input
                  placeholder="e.g. Filesystem Tools"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</label>
                <Textarea
                  placeholder="E.g. Exposes read/write endpoints to work folders"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={2}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Scope</label>
                <Select value={newProjectId} onValueChange={setNewProjectId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__global__">Global</SelectItem>
                    {projects?.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transport Type</label>
                  <Select value={newTransport} onValueChange={(v) => setNewTransport(v as TransportType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio (Local script/binary)</SelectItem>
                      <SelectItem value="sse">sse (Server-sent events)</SelectItem>
                      <SelectItem value="streamable-http">streamable-http (HTTP stream)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags (comma-separated)</label>
                  <Input
                    placeholder="fs, system"
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                  />
                </div>
              </div>

              {/* Dynamic Transport Fields */}
              {newTransport === "stdio" ? (
                <div className="space-y-4 border rounded-lg p-3 bg-muted/20">
                  <div className="text-xs font-semibold text-muted-foreground border-b pb-1.5">Stdio Host Configuration</div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Executable Command</label>
                    <Input
                      placeholder="e.g. node or python3"
                      value={newCommand}
                      onChange={(e) => setNewCommand(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Arguments (comma-separated)</label>
                    <Input
                      placeholder="e.g. /path/to/server.js, --option"
                      value={newArgs}
                      onChange={(e) => setNewArgs(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      Env Overrides (JSON format)
                      <span title="Enter a JSON dictionary. E.g. { 'NODE_ENV': 'production' }">
                        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                      </span>
                    </label>
                    <Textarea
                      placeholder="{}"
                      value={newEnvJson}
                      onChange={(e) => setNewEnvJson(e.target.value)}
                      rows={2}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Client ID</label>
                      <Input
                        value={newClientId}
                        onChange={(e) => setNewClientId(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">TTL Timeout (s)</label>
                      <Input
                        type="number"
                        value={newTtl}
                        onChange={(e) => setNewTtl(Number(e.target.value))}
                        required
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 border rounded-lg p-3 bg-muted/20">
                  <div className="text-xs font-semibold text-muted-foreground border-b pb-1.5">HTTP/SSE Connection Setup</div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Server Connection URL</label>
                    <Input
                      placeholder="e.g. http://localhost:3010/sse"
                      type="url"
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      Request Headers (JSON format)
                      <span title="Enter a JSON dictionary of HTTP headers.">
                        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                      </span>
                    </label>
                    <Textarea
                      placeholder="{}"
                      value={newHeadersJson}
                      onChange={(e) => setNewHeadersJson(e.target.value)}
                      rows={2}
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <label className="text-sm font-medium">Activate immediately</label>
                  <p className="text-xs text-muted-foreground">If active, agents can use its tools immediately</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={newActive}
                  onClick={() => setNewActive(!newActive)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${newActive ? "bg-emerald-500" : "bg-muted"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out ${newActive ? "translate-x-5" : "translate-x-0"}`}
                  />
                </button>
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createServerMutation.isPending}>
                {createServerMutation.isPending ? "Registering..." : "Register"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md w-full overflow-y-auto max-h-[90vh]">
          <form onSubmit={handleEditSubmit}>
            <DialogHeader>
              <DialogTitle>Configure MCP Server</DialogTitle>
              <DialogDescription>
                Modify registry connection settings.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Server Name</label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</label>
                <Textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={2}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Scope</label>
                <Select value={editProjectId} onValueChange={setEditProjectId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__global__">Global</SelectItem>
                    {projects?.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transport Type</label>
                  <Select value={editTransport} onValueChange={(v) => setEditTransport(v as TransportType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio (Local script/binary)</SelectItem>
                      <SelectItem value="sse">sse (Server-sent events)</SelectItem>
                      <SelectItem value="streamable-http">streamable-http (HTTP stream)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags (comma-separated)</label>
                  <Input
                    placeholder="fs, system"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                  />
                </div>
              </div>

              {/* Dynamic Transport Fields */}
              {editTransport === "stdio" ? (
                <div className="space-y-4 border rounded-lg p-3 bg-muted/20">
                  <div className="text-xs font-semibold text-muted-foreground border-b pb-1.5">Stdio Host Configuration</div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Executable Command</label>
                    <Input
                      placeholder="e.g. node"
                      value={editCommand}
                      onChange={(e) => setEditCommand(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Arguments (comma-separated)</label>
                    <Input
                      placeholder="e.g. /path/to/server.js"
                      value={editArgs}
                      onChange={(e) => setEditArgs(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      Env Overrides (JSON format)
                    </label>
                    <Textarea
                      value={editEnvJson}
                      onChange={(e) => setEditEnvJson(e.target.value)}
                      rows={2}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Client ID</label>
                      <Input
                        value={editClientId}
                        onChange={(e) => setEditClientId(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">TTL Timeout (s)</label>
                      <Input
                        type="number"
                        value={editTtl}
                        onChange={(e) => setEditTtl(Number(e.target.value))}
                        required
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 border rounded-lg p-3 bg-muted/20">
                  <div className="text-xs font-semibold text-muted-foreground border-b pb-1.5">HTTP/SSE Connection Setup</div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Server Connection URL</label>
                    <Input
                      placeholder="e.g. http://localhost:3010/sse"
                      type="url"
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      Request Headers (JSON format)
                    </label>
                    <Textarea
                      placeholder="{}"
                      value={editHeadersJson}
                      onChange={(e) => setEditHeadersJson(e.target.value)}
                      rows={2}
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <label className="text-sm font-medium">Active</label>
                  <p className="text-xs text-muted-foreground">If active, agents can use its tools immediately</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={editActive}
                  onClick={() => setEditActive(!editActive)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${editActive ? "bg-emerald-500" : "bg-muted"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out ${editActive ? "translate-x-5" : "translate-x-0"}`}
                  />
                </button>
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateServerMutation.isPending}>
                {updateServerMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Unregister MCP Server"
        description={`Are you sure you want to permanently delete the server registry for "${deleteServerName}"? Connected sessions will be terminated and agents will no longer have access to its tools. This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteServerId) deleteServerMutation.mutate({ id: deleteServerId });
        }}
      />
    </>
  );
}
