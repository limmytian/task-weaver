"use client";

import { useState, useMemo } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/trpc/client";
import type { AppRouter } from "@/trpc/routers/_app";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Sparkles,
  Search,
  Plus,
  Trash2,
  Edit,
  Tag,
  BookOpen,
  Folder,
  Calendar,
  Package,
  Archive,
  Files,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ConfirmDialog } from "@/components/confirm-dialog";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type SkillPackageListItem = RouterOutputs["skill"]["packageList"]["items"][number];
type SkillPackageDetailVersion = NonNullable<RouterOutputs["skill"]["packageGet"]>["versions"][number];
type SkillPackageFileItem = RouterOutputs["skill"]["packageFiles"]["items"][number];

export default function SkillsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("__all__");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("__all__");
  const [activeTab, setActiveTab] = useState("skills");

  // Detail Sheet state
  const [detailSkillId, setDetailSkillId] = useState<string | null>(null);
  const [detailPackageId, setDetailPackageId] = useState<string | null>(null);

  // Create Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newSummary, setNewSummary] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newProjId, setNewProjId] = useState<string>("__global__");

  // Edit Dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editSkillId, setEditSkillId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editKeywords, setEditKeywords] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editProjId, setEditProjId] = useState<string>("__global__");

  // Delete Confirm state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSkillId, setDeleteSkillId] = useState<string | null>(null);
  const [deleteSkillTitle, setDeleteSkillTitle] = useState("");

  const utils = trpc.useUtils();

  const { data: skills, isLoading: listLoading } = trpc.skill.list.useQuery({
    allProjects: true,
  });
  const { data: packageResult, isLoading: packagesLoading } = trpc.skill.packageList.useQuery({
    allProjects: true,
    includeGlobal: true,
    includePersonal: false,
    limit: 100,
  });
  const { data: projects } = trpc.project.list.useQuery();

  const { data: selectedSkillDetail, isLoading: detailLoading } = trpc.skill.get.useQuery(
    { id: detailSkillId ?? "" },
    { enabled: !!detailSkillId }
  );
  const { data: selectedPackageDetail, isLoading: packageDetailLoading } = trpc.skill.packageGet.useQuery(
    { packageId: detailPackageId ?? "" },
    { enabled: !!detailPackageId }
  );
  const { data: selectedPackageFiles } = trpc.skill.packageFiles.useQuery(
    { packageId: detailPackageId ?? "" },
    { enabled: !!detailPackageId }
  );
  const { data: selectedPackageHealth } = trpc.skill.packageHealth.useQuery(
    { packageId: detailPackageId ?? "" },
    { enabled: !!detailPackageId }
  );

  const createSkillMutation = trpc.skill.create.useMutation({
    onSuccess: () => {
      toast.success("Skill created successfully");
      utils.skill.list.invalidate();
      setCreateOpen(false);
      resetCreateForm();
    },
    onError: (err) => {
      toast.error(`Failed to create skill: ${err.message}`);
    },
  });

  const updateSkillMutation = trpc.skill.update.useMutation({
    onSuccess: () => {
      toast.success("Skill updated successfully");
      utils.skill.list.invalidate();
      if (detailSkillId) {
        utils.skill.get.invalidate({ id: detailSkillId });
      }
      setEditOpen(false);
    },
    onError: (err) => {
      toast.error(`Failed to update skill: ${err.message}`);
    },
  });

  const deleteSkillMutation = trpc.skill.delete.useMutation({
    onSuccess: () => {
      toast.success("Skill deleted successfully");
      utils.skill.list.invalidate();
      setDeleteConfirmOpen(false);
      setDetailSkillId(null);
    },
    onError: (err) => {
      toast.error(`Failed to delete skill: ${err.message}`);
    },
  });

  const updatePackageMutation = trpc.skill.packageUpdate.useMutation({
    onSuccess: () => {
      toast.success("Package updated successfully");
      utils.skill.packageList.invalidate();
      if (detailPackageId) {
        utils.skill.packageGet.invalidate({ packageId: detailPackageId });
      }
    },
    onError: (err) => {
      toast.error(`Failed to update package: ${err.message}`);
    },
  });

  const reindexPackageMutation = trpc.skill.packageReindex.useMutation({
    onSuccess: (result) => {
      toast.success(`Reindexed ${result.reindexed.length} package files`);
      utils.skill.packageList.invalidate();
      if (detailPackageId) {
        utils.skill.packageGet.invalidate({ packageId: detailPackageId });
        utils.skill.packageFiles.invalidate({ packageId: detailPackageId });
        utils.skill.packageHealth.invalidate({ packageId: detailPackageId });
      }
    },
    onError: (err) => {
      toast.error(`Failed to reindex package: ${err.message}`);
    },
  });

  const resetCreateForm = () => {
    setNewTitle("");
    setNewSummary("");
    setNewContent("");
    setNewKeywords("");
    setNewTags("");
    setNewProjId("__global__");
  };

  const handleOpenEdit = (skill: typeof selectedSkillDetail) => {
    if (!skill) return;
    setEditSkillId(skill.id);
    setEditTitle(skill.title);
    setEditSummary(skill.summary ?? "");
    setEditContent(skill.content);
    setEditKeywords(skill.keywords?.join(", ") ?? "");
    setEditTags(skill.tags?.join(", ") ?? "");
    setEditProjId(skill.projectId ?? "__global__");
    setEditOpen(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) {
      toast.error("Title and Content are required");
      return;
    }
    createSkillMutation.mutate({
      title: newTitle.trim(),
      content: newContent.trim(),
      summary: newSummary.trim() || undefined,
      keywords: newKeywords.split(",").map(k => k.trim()).filter(Boolean),
      tags: newTags.split(",").map(t => t.trim()).filter(Boolean),
      projectId: newProjId === "__global__" ? undefined : newProjId,
    });
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editSkillId || !editTitle.trim() || !editContent.trim()) {
      toast.error("Title and Content are required");
      return;
    }
    updateSkillMutation.mutate({
      id: editSkillId,
      data: {
        title: editTitle.trim(),
        content: editContent.trim(),
        summary: editSummary.trim() || null,
        keywords: editKeywords.split(",").map(k => k.trim()).filter(Boolean),
        tags: editTags.split(",").map(t => t.trim()).filter(Boolean),
        projectId: editProjId === "__global__" ? null : editProjId,
      },
    });
  };

  const handleOpenDelete = (id: string, title: string) => {
    setDeleteSkillId(id);
    setDeleteSkillTitle(title);
    setDeleteConfirmOpen(true);
  };

  const allTags = useMemo(() => {
    const set = new Set<string>();
    skills?.forEach((s) => s.tags?.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [skills]);

  const filteredSkills = useMemo(() => {
    if (!skills) return [];
    return skills.filter((skill) => {
      const matchesSearch =
        skill.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        skill.summary?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        skill.keywords?.some((k) => k.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesTag = selectedTag === "__all__" || skill.tags?.includes(selectedTag);

      const matchesProject =
        selectedProjectId === "__all__" ||
        (selectedProjectId === "__global__" && !skill.projectId) ||
        skill.projectId === selectedProjectId;

      return matchesSearch && matchesTag && matchesProject;
    });
  }, [skills, searchQuery, selectedTag, selectedProjectId]);

  const packages = useMemo<SkillPackageListItem[]>(
    () => packageResult?.items ?? [],
    [packageResult?.items],
  );
  const packageVersions = useMemo<SkillPackageDetailVersion[]>(
    () => selectedPackageDetail?.versions ?? [],
    [selectedPackageDetail?.versions],
  );
  const packageFiles = useMemo<SkillPackageFileItem[]>(
    () => selectedPackageFiles?.items ?? [],
    [selectedPackageFiles?.items],
  );

  const filteredPackages = useMemo(() => {
    return packages.filter((pkg) => {
      const matchesSearch =
        pkg.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        pkg.summary?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        pkg.keywords?.some((k: string) => k.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesTag = selectedTag === "__all__" || pkg.tags?.includes(selectedTag);

      const matchesProject =
        selectedProjectId === "__all__" ||
        (selectedProjectId === "__global__" && !pkg.projectId) ||
        pkg.projectId === selectedProjectId;

      return matchesSearch && matchesTag && matchesProject;
    });
  }, [packages, searchQuery, selectedTag, selectedProjectId]);

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-lg font-semibold flex items-center gap-1.5">
          <Sparkles className="h-5 w-5 text-indigo-500" />
          Skills Directory
        </h1>
        <Button size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Import Skill
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[260px]">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search skills by title, keywords..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          <Select value={selectedTag} onValueChange={setSelectedTag}>
            <SelectTrigger className="w-[160px]">
              <Tag className="mr-2 h-4 w-4 text-muted-foreground" />
              <SelectValue placeholder="All Tags" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Tags</SelectItem>
              {allTags.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>

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

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="skills">Skill Documents</TabsTrigger>
            <TabsTrigger value="packages">Packages</TabsTrigger>
          </TabsList>

          <TabsContent value="skills" className="mt-4">
        {listLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="min-h-[160px]">
                <CardHeader className="space-y-2">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-10 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredSkills.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-12 text-center border-dashed">
            <BookOpen className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="font-semibold text-lg">No Skills Found</h3>
            <p className="text-sm text-muted-foreground max-w-sm mt-1">
              There are no agent skills registered matching your filters. Create a new skill to extend the agent&apos;s capabilities.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredSkills.map((skill) => {
              const project = projects?.find(p => p.id === skill.projectId);
              return (
                <Card
                  key={skill.id}
                  onClick={() => setDetailSkillId(skill.id)}
                  className="group relative flex flex-col justify-between overflow-hidden border bg-card/60 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-indigo-500/50 hover:bg-card hover:shadow-lg cursor-pointer"
                >
                  <div className="p-5 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-semibold text-base tracking-tight leading-snug group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                        {skill.title}
                      </h3>
                      <Badge variant={skill.projectId ? "outline" : "secondary"} className="shrink-0 text-[10px]">
                        {skill.projectId ? "Project" : "Global"}
                      </Badge>
                    </div>

                    {skill.summary ? (
                      <p className="text-xs text-muted-foreground line-clamp-3">
                        {skill.summary}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground/60 italic">
                        No description provided.
                      </p>
                    )}

                    {skill.tags && skill.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {skill.tags.slice(0, 3).map((t) => (
                          <Badge key={t} variant="outline" className="text-[9px] bg-indigo-50/20 text-indigo-700 border-indigo-200/50 dark:bg-indigo-950/20 dark:text-indigo-300">
                            {t}
                          </Badge>
                        ))}
                        {skill.tags.length > 3 && (
                          <Badge variant="outline" className="text-[9px] text-muted-foreground">
                            +{skill.tags.length - 3}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="border-t px-5 py-3 flex items-center justify-between text-[11px] text-muted-foreground bg-accent/20">
                    <span className="truncate max-w-[120px] flex items-center gap-1 font-medium">
                      <Folder className="h-3 w-3 shrink-0" />
                      {project ? project.name : "Global Context"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {new Date(skill.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
          </TabsContent>

          <TabsContent value="packages" className="mt-4">
            {packagesLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Card key={i} className="min-h-[160px]">
                    <CardHeader className="space-y-2">
                      <Skeleton className="h-5 w-3/4" />
                      <Skeleton className="h-4 w-1/2" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-10 w-full" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : filteredPackages.length === 0 ? (
              <Card className="flex flex-col items-center justify-center p-12 text-center border-dashed">
                <Package className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="font-semibold text-lg">No Packages Found</h3>
                <p className="text-sm text-muted-foreground max-w-sm mt-1">
                  Register a package with the CLI to preserve multi-file skills and installable assets.
                </p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredPackages.map((pkg) => {
                  const project = projects?.find(p => p.id === pkg.projectId);
                  const latestVersion = pkg.versions?.[0];
                  return (
                    <Card
                      key={pkg.id}
                      onClick={() => setDetailPackageId(pkg.id)}
                      className="group relative flex flex-col justify-between overflow-hidden border bg-card/60 transition-all duration-300 hover:-translate-y-1 hover:border-foreground/30 hover:bg-card hover:shadow-lg cursor-pointer"
                    >
                      <div className="p-5 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-semibold text-base tracking-tight leading-snug">
                            {pkg.name}
                          </h3>
                          <Badge variant={pkg.status === "active" ? "secondary" : "outline"} className="shrink-0 text-[10px]">
                            {pkg.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-3">
                          {pkg.summary || pkg.description || "No package summary provided."}
                        </p>
                        <div className="flex flex-wrap gap-1 pt-1">
                          <Badge variant="outline" className="text-[9px]">
                            v{latestVersion?.version ?? "none"}
                          </Badge>
                          <Badge variant="outline" className="text-[9px]">
                            {latestVersion?.fileCount ?? 0} files
                          </Badge>
                          {pkg.tags?.slice(0, 2).map((tag: string) => (
                            <Badge key={tag} variant="outline" className="text-[9px]">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="border-t px-5 py-3 flex items-center justify-between text-[11px] text-muted-foreground bg-accent/20">
                        <span className="truncate max-w-[120px] flex items-center gap-1 font-medium">
                          <Folder className="h-3 w-3 shrink-0" />
                          {project ? project.name : "Global Context"}
                        </span>
                        <span className="flex items-center gap-1">
                          <Package className="h-3 w-3" />
                          {pkg.sourceType}
                        </span>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Skill Detail Sheet */}
      <Sheet open={!!detailSkillId} onOpenChange={(open) => !open && setDetailSkillId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto flex flex-col p-6 space-y-6">
          {detailLoading ? (
            <div className="space-y-6 py-6">
              <Skeleton className="h-8 w-3/4" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-48 w-full" />
            </div>
          ) : selectedSkillDetail ? (
            <>
              <SheetHeader className="text-left space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <SheetTitle className="text-2xl font-bold pr-6">
                    {selectedSkillDetail.title}
                  </SheetTitle>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => handleOpenEdit(selectedSkillDetail)}>
                      <Edit className="mr-1 h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => handleOpenDelete(selectedSkillDetail.id, selectedSkillDetail.title)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <SheetDescription className="text-sm">
                  {selectedSkillDetail.summary || "No description provided."}
                </SheetDescription>

                <div className="flex flex-wrap gap-2 text-xs pt-1">
                  <div className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground">
                    <Folder className="h-3 w-3" />
                    <span>
                      Scope:{" "}
                      <strong>
                        {projects?.find(p => p.id === selectedSkillDetail.projectId)?.name || "Global Context"}
                      </strong>
                    </span>
                  </div>
                  <div className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    <span>
                      Updated: <strong>{new Date(selectedSkillDetail.updatedAt).toLocaleDateString()}</strong>
                    </span>
                  </div>
                </div>
              </SheetHeader>

              <Separator />

              {/* Tags & Keywords */}
              {(selectedSkillDetail.tags?.length || selectedSkillDetail.keywords?.length) && (
                <div className="space-y-3">
                  {selectedSkillDetail.tags && selectedSkillDetail.tags.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1 w-20 shrink-0">
                        <Tag className="h-3 w-3" /> Tags:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedSkillDetail.tags.map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedSkillDetail.keywords && selectedSkillDetail.keywords.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1 w-20 shrink-0">
                        <Sparkles className="h-3 w-3" /> Keywords:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedSkillDetail.keywords.map((k) => (
                          <Badge key={k} variant="outline" className="text-[10px]">
                            {k}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <Separator />

              {/* Markdown Content */}
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
                  Instruction / Skill Content
                </h4>
                <div className="rounded-lg border bg-muted/40 p-5 overflow-auto max-h-[500px]">
                  <MarkdownRenderer
                    content={selectedSkillDetail.content}
                    className="prose prose-sm dark:prose-invert max-w-none text-sm break-words"
                  />
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={!!detailPackageId} onOpenChange={(open) => !open && setDetailPackageId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto flex flex-col p-6 space-y-6">
          {packageDetailLoading ? (
            <div className="space-y-6 py-6">
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : selectedPackageDetail ? (
            <>
              <SheetHeader className="text-left space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <SheetTitle className="text-2xl font-bold pr-6">
                    {selectedPackageDetail.name}
                  </SheetTitle>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={updatePackageMutation.isPending || selectedPackageDetail.status === "deprecated"}
                      onClick={() => updatePackageMutation.mutate({ packageId: selectedPackageDetail.id, status: "deprecated" })}
                    >
                      <Archive className="mr-1 h-3.5 w-3.5" /> Deprecate
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={updatePackageMutation.isPending || selectedPackageDetail.status === "archived"}
                      onClick={() => updatePackageMutation.mutate({ packageId: selectedPackageDetail.id, status: "archived" })}
                    >
                      Archive
                    </Button>
                  </div>
                </div>
                <SheetDescription className="text-sm">
                  {selectedPackageDetail.summary || selectedPackageDetail.description || "No package summary provided."}
                </SheetDescription>
                <div className="flex flex-wrap gap-2 text-xs pt-1">
                  <Badge variant="secondary">{selectedPackageDetail.status}</Badge>
                  <Badge variant="outline">{selectedPackageDetail.sourceType}</Badge>
                  <Badge variant="outline">{selectedPackageDetail.entryPath}</Badge>
                  {selectedPackageHealth && (
                    <Badge variant={selectedPackageHealth.failed === 0 ? "secondary" : "destructive"} className="gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      {selectedPackageHealth.ok}/{selectedPackageHealth.checked} OK
                    </Badge>
                  )}
                </div>
              </SheetHeader>

              <Separator />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    Storage Health
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    {selectedPackageHealth
                      ? `${selectedPackageHealth.failed} storage issues across ${selectedPackageHealth.checked} files`
                      : "Checking storage objects"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reindexPackageMutation.isPending}
                  onClick={() => reindexPackageMutation.mutate({ packageId: selectedPackageDetail.id })}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> Reindex
                </Button>
              </div>

              <Separator />

              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Versions
                </h4>
                <div className="space-y-2">
                  {packageVersions.map((version) => (
                    <div key={version.id} className="flex items-center justify-between rounded border p-3 text-sm">
                      <div>
                        <p className="font-medium">v{version.version}</p>
                        <p className="text-xs text-muted-foreground">
                          {version.fileCount} files · {version.totalSizeBytes} bytes · {version.status}
                        </p>
                      </div>
                      <Badge variant={version.status === "active" ? "secondary" : "outline"}>
                        {version.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <Files className="h-4 w-4" /> Files
                </h4>
                <div className="space-y-2">
                  {packageFiles.map((file) => (
                    <div key={file.id} className="flex items-center justify-between rounded border p-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-mono text-xs truncate">{file.path}</p>
                        <p className="text-xs text-muted-foreground">
                          {file.kind} · {file.sizeBytes} bytes · {file.isReadableText ? "text" : "binary"}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {file.isExecutable ? "exec" : file.contentType ?? "file"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl w-full">
          <form onSubmit={handleCreateSubmit}>
            <DialogHeader>
              <DialogTitle>Import Skill</DialogTitle>
              <DialogDescription>
                Define a new capability instructions manual (Markdown format) for AI agents to query.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</label>
                  <Input
                    placeholder="e.g. Code Review Workflow"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    required
                  />
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
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Summary / Short Description</label>
                <Input
                  placeholder="Provide a quick summary of what this skill does..."
                  value={newSummary}
                  onChange={(e) => setNewSummary(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags (comma-separated)</label>
                  <Input
                    placeholder="git, review, standards"
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Keywords (comma-separated)</label>
                  <Input
                    placeholder="pr, reviews, checklist, quality"
                    value={newKeywords}
                    onChange={(e) => setNewKeywords(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Markdown Content / Manual</label>
                <Textarea
                  placeholder="# Review Checklist&#10;1. Ensure all test cases pass...&#10;2. Verify schema migration SQL scripts..."
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                  required
                />
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createSkillMutation.isPending || !newTitle.trim() || !newContent.trim()}>
                {createSkillMutation.isPending ? "Importing..." : "Import Skill"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-xl w-full">
          <form onSubmit={handleEditSubmit}>
            <DialogHeader>
              <DialogTitle>Edit Skill</DialogTitle>
              <DialogDescription>
                Modify the capability instructions manual. Updates take effect immediately.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</label>
                  <Input
                    placeholder="Title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project Scope</label>
                  <Select value={editProjId} onValueChange={editProjId => setEditProjId(editProjId)}>
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
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Summary / Short Description</label>
                <Input
                  placeholder="Summary"
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags (comma-separated)</label>
                  <Input
                    placeholder="git, review, standards"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Keywords (comma-separated)</label>
                  <Input
                    placeholder="pr, reviews, checklist, quality"
                    value={editKeywords}
                    onChange={(e) => setEditKeywords(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Markdown Content / Manual</label>
                <Textarea
                  placeholder="Content"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                  required
                />
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateSkillMutation.isPending || !editTitle.trim() || !editContent.trim()}>
                {updateSkillMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete Skill"
        description={`Are you sure you want to permanently delete the skill "${deleteSkillTitle}"? This will restrict AI agents from referencing this instruction block. This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteSkillId) deleteSkillMutation.mutate({ id: deleteSkillId });
        }}
      />
    </>
  );
}
