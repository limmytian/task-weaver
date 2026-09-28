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
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Brain,
  Search,
  Plus,
  Trash2,
  Edit,
  Tag,
  Clock,
  Folder,
  Calendar,
} from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";

type MemoryType = "user" | "feedback" | "project" | "reference" | "other";

const memoryTypeColors: Record<MemoryType, string> = {
  user: "bg-blue-500/10 text-blue-700 border-blue-200/50 dark:bg-blue-950/20 dark:text-blue-300 dark:border-blue-800/30",
  feedback: "bg-amber-500/10 text-amber-700 border-amber-200/50 dark:bg-amber-950/20 dark:text-amber-300 dark:border-amber-800/30",
  project: "bg-purple-500/10 text-purple-700 border-purple-200/50 dark:bg-purple-950/20 dark:text-purple-300 dark:border-purple-800/30",
  reference: "bg-emerald-500/10 text-emerald-700 border-emerald-200/50 dark:bg-emerald-950/20 dark:text-emerald-300 dark:border-emerald-800/30",
  other: "bg-slate-500/10 text-slate-700 border-slate-200/50 dark:bg-slate-950/20 dark:text-slate-300 dark:border-slate-800/30",
};

export default function MemoriesPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTypeTab, setSelectedTypeTab] = useState<string>("all");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("__all__");

  // Detail Sheet state
  const [detailMemoryId, setDetailMemoryId] = useState<string | null>(null);

  // Create Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newType, setNewType] = useState<MemoryType>("other");
  const [newProjId, setNewProjId] = useState<string>("__global__");
  const [newTags, setNewTags] = useState("");
  const [newExpiryPreset, setNewExpiryPreset] = useState<string>("never");
  const [newCustomExpiry, setNewCustomExpiry] = useState("");

  // Edit Dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editMemoryId, setEditMemoryId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editType, setEditType] = useState<MemoryType>("other");
  const [editTags, setEditTags] = useState("");
  const [editExpiryPreset, setEditExpiryPreset] = useState<string>("never");
  const [editCustomExpiry, setEditCustomExpiry] = useState("");

  // Delete Confirm state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteMemoryId, setDeleteMemoryId] = useState<string | null>(null);
  const [deleteMemoryTitle, setDeleteMemoryTitle] = useState("");

  const utils = trpc.useUtils();

  const { data: memories, isLoading: listLoading } = trpc.memory.list.useQuery({
    limit: 100,
  });
  const { data: projects } = trpc.project.list.useQuery();

  const { data: selectedMemoryDetail, isLoading: detailLoading } = trpc.memory.get.useQuery(
    { id: detailMemoryId ?? "" },
    { enabled: !!detailMemoryId }
  );

  const createMemoryMutation = trpc.memory.create.useMutation({
    onSuccess: () => {
      toast.success("Memory recorded successfully");
      utils.memory.list.invalidate();
      setCreateOpen(false);
      resetCreateForm();
    },
    onError: (err) => {
      toast.error(`Failed to record memory: ${err.message}`);
    },
  });

  const updateMemoryMutation = trpc.memory.update.useMutation({
    onSuccess: () => {
      toast.success("Memory updated successfully");
      utils.memory.list.invalidate();
      if (detailMemoryId) {
        utils.memory.get.invalidate({ id: detailMemoryId });
      }
      setEditOpen(false);
    },
    onError: (err) => {
      toast.error(`Failed to update memory: ${err.message}`);
    },
  });

  const deleteMemoryMutation = trpc.memory.delete.useMutation({
    onSuccess: () => {
      toast.success("Memory forgotten successfully");
      utils.memory.list.invalidate();
      setDeleteConfirmOpen(false);
      setDetailMemoryId(null);
    },
    onError: (err) => {
      toast.error(`Failed to forget memory: ${err.message}`);
    },
  });

  const resetCreateForm = () => {
    setNewTitle("");
    setNewContent("");
    setNewType("other");
    setNewProjId("__global__");
    setNewTags("");
    setNewExpiryPreset("never");
    setNewCustomExpiry("");
  };

  const getExpiryDateStr = (preset: string, customVal: string): string | undefined => {
    if (preset === "never") return undefined;
    if (preset === "7d") {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    if (preset === "30d") {
      return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    }
    if (preset === "90d") {
      return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    }
    if (preset === "custom" && customVal) {
      return new Date(customVal).toISOString();
    }
    return undefined;
  };

  const handleOpenEdit = (memory: typeof selectedMemoryDetail) => {
    if (!memory) return;
    setEditMemoryId(memory.id);
    setEditTitle(memory.title);
    setEditContent(memory.content);
    setEditType(memory.memoryType as MemoryType);
    setEditTags(memory.tags?.join(", ") ?? "");
    if (!memory.expiresAt) {
      setEditExpiryPreset("never");
      setEditCustomExpiry("");
    } else {
      setEditExpiryPreset("custom");
      setEditCustomExpiry(new Date(memory.expiresAt).toISOString().split("T")[0] ?? "");
    }
    setEditOpen(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) {
      toast.error("Title and Content are required");
      return;
    }
    const expiresAt = getExpiryDateStr(newExpiryPreset, newCustomExpiry);
    createMemoryMutation.mutate({
      title: newTitle.trim(),
      content: newContent.trim(),
      memoryType: newType,
      projectId: newProjId === "__global__" ? undefined : newProjId,
      tags: newTags.split(",").map(t => t.trim()).filter(Boolean),
      expiresAt,
    });
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editMemoryId || !editTitle.trim() || !editContent.trim()) {
      toast.error("Title and Content are required");
      return;
    }
    const expiresAt = getExpiryDateStr(editExpiryPreset, editCustomExpiry);
    updateMemoryMutation.mutate({
      id: editMemoryId,
      data: {
        title: editTitle.trim(),
        content: editContent.trim(),
        memoryType: editType,
        tags: editTags.split(",").map(t => t.trim()).filter(Boolean),
        expiresAt: expiresAt || null,
      },
    });
  };

  const handleOpenDelete = (id: string, title: string) => {
    setDeleteMemoryId(id);
    setDeleteMemoryTitle(title);
    setDeleteConfirmOpen(true);
  };

  const filteredMemories = useMemo(() => {
    if (!memories) return [];
    return memories.filter((mem) => {
      const matchesSearch =
        mem.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mem.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mem.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesType =
        selectedTypeTab === "all" || mem.memoryType === selectedTypeTab;

      const matchesProject =
        selectedProjectId === "__all__" ||
        (selectedProjectId === "__global__" && !mem.projectId) ||
        mem.projectId === selectedProjectId;

      return matchesSearch && matchesType && matchesProject;
    });
  }, [memories, searchQuery, selectedTypeTab, selectedProjectId]);

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-lg font-semibold flex items-center gap-1.5">
          <Brain className="h-5 w-5 text-pink-500" />
          Agent Memories
        </h1>
        <Button size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Record Memory
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4 justify-between">
          <Tabs value={selectedTypeTab} onValueChange={setSelectedTypeTab} className="w-auto">
            <TabsList>
              <TabsTrigger value="all">All Types</TabsTrigger>
              <TabsTrigger value="user">User</TabsTrigger>
              <TabsTrigger value="feedback">Feedback</TabsTrigger>
              <TabsTrigger value="project">Project</TabsTrigger>
              <TabsTrigger value="reference">Reference</TabsTrigger>
              <TabsTrigger value="other">Other</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-[260px] min-w-[200px]">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search memories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger className="w-[180px]">
                <Folder className="mr-2 h-4 w-4 text-muted-foreground" />
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Scopes</SelectItem>
                <SelectItem value="__global__">Global Scope</SelectItem>
                {projects?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Content list */}
        {listLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="space-y-2">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-4 w-1/2" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-12 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredMemories.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-12 text-center border-dashed">
            <Brain className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="font-semibold text-lg">No Memories Recorded</h3>
            <p className="text-sm text-muted-foreground max-w-sm mt-1">
              There are no memories registered matching your criteria. Record a new memory manually to teach the agent contextual facts.
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredMemories.map((mem) => {
              const project = projects?.find(p => p.id === mem.projectId);
              // eslint-disable-next-line react-hooks/purity
              const isExpired = mem.expiresAt ? new Date(mem.expiresAt).getTime() < Date.now() : false;
              return (
                <Card
                  key={mem.id}
                  onClick={() => setDetailMemoryId(mem.id)}
                  className={`group border bg-card/60 backdrop-blur-sm transition-all duration-200 hover:border-pink-500/40 hover:bg-card hover:shadow-md cursor-pointer ${isExpired ? "opacity-60 border-destructive/20" : ""}`}
                >
                  <div className="p-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
                    <div className="space-y-2 flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={`${memoryTypeColors[mem.memoryType as MemoryType] ?? ""}`}>
                          {mem.memoryType}
                        </Badge>
                        <Badge variant={mem.projectId ? "outline" : "secondary"} className="text-[10px]">
                          {mem.projectId ? `Project: ${project?.name ?? "Linked"}` : "Global"}
                        </Badge>
                        {mem.expiresAt && (
                          <Badge variant={isExpired ? "destructive" : "outline"} className="text-[10px] flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {isExpired ? "Expired" : `Expires ${new Date(mem.expiresAt).toLocaleDateString()}`}
                          </Badge>
                        )}
                      </div>

                      <h3 className="font-semibold text-base leading-snug group-hover:text-pink-600 dark:group-hover:text-pink-400 transition-colors">
                        {mem.title}
                      </h3>

                      <p className="text-xs text-muted-foreground line-clamp-2 break-words">
                        {mem.content}
                      </p>

                      {mem.tags && mem.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {mem.tags.map((t) => (
                            <Badge key={t} variant="secondary" className="text-[9px] px-1.5 py-0">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0 md:self-center text-xs text-muted-foreground">
                      <Calendar className="h-3.5 w-3.5" />
                      <span>{new Date(mem.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Memory Detail Sheet */}
      <Sheet open={!!detailMemoryId} onOpenChange={(open) => !open && setDetailMemoryId(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto flex flex-col p-6 space-y-6">
          {detailLoading ? (
            <div className="space-y-6 py-6">
              <Skeleton className="h-8 w-3/4" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-28 w-full" />
            </div>
          ) : selectedMemoryDetail ? (
            <>
              <SheetHeader className="text-left space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <SheetTitle className="text-xl font-bold pr-6">
                    {selectedMemoryDetail.title}
                  </SheetTitle>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => handleOpenEdit(selectedMemoryDetail)}>
                      <Edit className="mr-1 h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => handleOpenDelete(selectedMemoryDetail.id, selectedMemoryDetail.title)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Forget
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 text-xs pt-1">
                  <Badge variant="outline" className={`${memoryTypeColors[selectedMemoryDetail.memoryType as MemoryType] ?? ""}`}>
                    Type: {selectedMemoryDetail.memoryType}
                  </Badge>
                  <div className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground">
                    <Folder className="h-3 w-3" />
                    <span>
                      Scope:{" "}
                      <strong>
                        {projects?.find(p => p.id === selectedMemoryDetail.projectId)?.name || "Global Context"}
                      </strong>
                    </span>
                  </div>
                  <div className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    <span>
                      Recorded: <strong>{new Date(selectedMemoryDetail.createdAt).toLocaleDateString()}</strong>
                    </span>
                  </div>
                  {selectedMemoryDetail.expiresAt && (
                    <div className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span>
                        Expires: <strong>{new Date(selectedMemoryDetail.expiresAt).toLocaleDateString()}</strong>
                      </span>
                    </div>
                  )}
                </div>
              </SheetHeader>

              <Separator />

              {/* Tags */}
              {selectedMemoryDetail.tags && selectedMemoryDetail.tags.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1 w-20 shrink-0">
                    <Tag className="h-3 w-3" /> Tags:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedMemoryDetail.tags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[10px]">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <Separator />

              {/* Content Body */}
              <div className="flex-1 min-w-0 space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Memory Statement
                </h4>
                <div className="rounded-lg border bg-muted/40 p-4 font-normal text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {selectedMemoryDetail.content}
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md w-full">
          <form onSubmit={handleCreateSubmit}>
            <DialogHeader>
              <DialogTitle>Record Memory</DialogTitle>
              <DialogDescription>
                Record facts or workspace context so that agents can recall them in subsequent operations.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Memory Title</label>
                <Input
                  placeholder="e.g. Limmy's preferred coding standards"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Type</label>
                  <Select value={newType} onValueChange={(v) => setNewType(v as MemoryType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User Fact</SelectItem>
                      <SelectItem value="feedback">Feedback / Review</SelectItem>
                      <SelectItem value="project">Project Context</SelectItem>
                      <SelectItem value="reference">Reference Data</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project Scope</label>
                  <Select value={newProjId} onValueChange={setNewProjId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__global__">Global Context (All Projects)</SelectItem>
                      {projects?.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags (comma-separated)</label>
                <Input
                  placeholder="coding, preference, workflow"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expiration</label>
                  <Select value={newExpiryPreset} onValueChange={setNewExpiryPreset}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="never">Never (Persistent)</SelectItem>
                      <SelectItem value="7d">7 Days</SelectItem>
                      <SelectItem value="30d">30 Days</SelectItem>
                      <SelectItem value="90d">90 Days</SelectItem>
                      <SelectItem value="custom">Custom Date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {newExpiryPreset === "custom" && (
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Choose Date</label>
                    <Input
                      type="date"
                      value={newCustomExpiry}
                      onChange={(e) => setNewCustomExpiry(e.target.value)}
                      required
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Memory Statement / Content</label>
                <Textarea
                  placeholder="Record what the agent should remember. E.g. 'The developer prefers async/await over raw promises and uses tabs for formatting.'"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  rows={4}
                  required
                />
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMemoryMutation.isPending || !newTitle.trim() || !newContent.trim()}>
                {createMemoryMutation.isPending ? "Recording..." : "Record Memory"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md w-full">
          <form onSubmit={handleEditSubmit}>
            <DialogHeader>
              <DialogTitle>Edit Memory</DialogTitle>
              <DialogDescription>
                Modify details or content of the memory.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Memory Title</label>
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Type</label>
                  <Select value={editType} onValueChange={(v) => setEditType(v as MemoryType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User Fact</SelectItem>
                      <SelectItem value="feedback">Feedback / Review</SelectItem>
                      <SelectItem value="project">Project Context</SelectItem>
                      <SelectItem value="reference">Reference Data</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expiration</label>
                  <Select value={editExpiryPreset} onValueChange={setEditExpiryPreset}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="never">Never (Persistent)</SelectItem>
                      <SelectItem value="7d">7 Days</SelectItem>
                      <SelectItem value="30d">30 Days</SelectItem>
                      <SelectItem value="90d">90 Days</SelectItem>
                      <SelectItem value="custom">Custom Date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags (comma-separated)</label>
                  <Input
                    placeholder="coding, preference"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                  />
                </div>
                {editExpiryPreset === "custom" && (
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Choose Date</label>
                    <Input
                      type="date"
                      value={editCustomExpiry}
                      onChange={(e) => setEditCustomExpiry(e.target.value)}
                      required
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Memory Statement / Content</label>
                <Textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={4}
                  required
                />
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMemoryMutation.isPending || !editTitle.trim() || !editContent.trim()}>
                {updateMemoryMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Forget Memory"
        description={`Are you sure you want to forget the memory "${deleteMemoryTitle}"? The agent will no longer recall this information. This action cannot be undone.`}
        confirmLabel="Forget"
        destructive
        onConfirm={() => {
          if (deleteMemoryId) deleteMemoryMutation.mutate({ id: deleteMemoryId });
        }}
      />
    </>
  );
}
