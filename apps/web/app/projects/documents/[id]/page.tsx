"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  Pencil,
  Save,
  X,
  Trash2,
  FileText,
  Link as LinkIcon,
  CheckSquare,
  Plus,
  ClipboardList,
} from "lucide-react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MarkdownEditor } from "@/components/markdown-editor";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DocumentVersionHistory } from "@/components/document-version-history";

export default function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const utils = trpc.useUtils();

  const { data: doc, isLoading } = trpc.document.get.useQuery({ id });

  useEffect(() => {
    if (doc && !editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(doc.title);
      setContent(doc.content);
    }
  }, [doc, editing]);

  const updateDocument = trpc.document.update.useMutation({
    onSuccess: () => {
      utils.document.get.invalidate({ id });
      utils.document.list.invalidate();
      setEditing(false);
    },
  });

  const deleteDocument = trpc.document.delete.useMutation({
    onSuccess: () => {
      utils.document.list.invalidate();
      router.push("/projects/documents");
      toast.success("Document deleted");
    },
    onError: (err) => toast.error("Failed to delete document", { description: err.message }),
  });

  const unlinkDoc = trpc.document.unlinkDocuments.useMutation({
    onSuccess: () => {
      utils.document.get.invalidate({ id });
    },
  });

  const unlinkFromTask = trpc.document.unlinkFromTask.useMutation({
    onSuccess: () => {
      utils.document.get.invalidate({ id });
    },
  });

  const handleSave = () => {
    updateDocument.mutate({
      id,
      data: { title: title.trim(), content: content.trim() },
    });
  };

  const handleStartEdit = () => {
    if (doc) {
      setTitle(doc.title);
      setContent(doc.content);
    }
    setEditing(true);
  };

  const handleCancelEdit = () => {
    if (doc) {
      setTitle(doc.title);
      setContent(doc.content);
    }
    setEditing(false);
  };

  if (isLoading) {
    return (
      <>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Skeleton className="h-5 w-60" />
        </header>
        <div className="p-6">
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </>
    );
  }

  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-muted-foreground">Document not found</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.push("/projects/documents")}
        >
          Back to Documents
        </Button>
      </div>
    );
  }

  return (
    <>
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 hidden h-4 sm:block" />
        <Button
          variant="ghost"
          size="icon"
          className="size-10 sm:size-7"
          aria-label="Back to documents"
          onClick={() => router.push("/projects/documents")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold sm:text-lg">
          {editing ? "Editing" : doc.title}
        </h1>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          {editing ? (
            <>
              <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={handleCancelEdit}>
                <X className="mr-1 h-4 w-4" />
                Cancel
              </Button>
              <Button
                size="sm"
                className="flex-1 sm:flex-none"
                onClick={handleSave}
                disabled={updateDocument.isPending}
              >
                <Save className="mr-1 h-4 w-4" />
                {updateDocument.isPending ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={handleStartEdit}>
                <Pencil className="mr-1 h-4 w-4" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="flex-1 sm:flex-none"
                onClick={() => setDeleteConfirmOpen(true)}
                disabled={deleteDocument.isPending}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                {deleteDocument.isPending ? "Deleting..." : "Delete"}
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-3 sm:p-4 md:p-6 lg:grid-cols-[1fr_300px]">
        <div>
          {editing ? (
            <div className="space-y-4">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="text-lg font-semibold"
                placeholder="Document title"
              />
              <MarkdownEditor
                content={content}
                onChange={setContent}
                placeholder="Start writing Markdown... (type [[ for wiki-links)"
                projectId={doc.projectId ?? undefined}
              />
            </div>
          ) : (
            <article className="prose prose-neutral dark:prose-invert max-w-none">
              <div className="mb-4 flex items-center gap-2">
                {doc.tags?.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
                <span className="text-xs text-muted-foreground">
                  Updated {new Date(doc.updatedAt).toLocaleString()}
                </span>
              </div>
              <MarkdownRenderer content={doc.content} />
            </article>
          )}
        </div>

        <div className="space-y-4">
          <DocumentSidebar
            doc={doc}
            unlinkDoc={unlinkDoc}
            unlinkFromTask={unlinkFromTask}
          />
          <DocumentVersionHistory documentId={id} />
        </div>
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete Document"
        description={`Are you sure you want to delete "${doc.title}"? This will permanently remove the document and all its links. This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleteDocument.mutate({ id })}
      />
    </>
  );
}


function DocumentSidebar({
  doc,
  unlinkDoc,
  unlinkFromTask,
}: {
  doc: {
    id: string;
    projectId: string | null;
    incomingLinks?: Array<{ id: string; sourceDoc: { id: string; title: string } }>;
    outgoingLinks?: Array<{ id: string; targetDoc: { id: string; title: string } }>;
    taskLinks?: Array<{ id: string; task: { id: string; title: string; status: string } }>;
  };
  unlinkDoc: { mutate: (input: { linkId: string }) => void };
  unlinkFromTask: { mutate: (input: { linkId: string }) => void };
}) {
  const [linkingTask, setLinkingTask] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [linkingReq, setLinkingReq] = useState(false);
  const [selectedReqId, setSelectedReqId] = useState("");
  const utils = trpc.useUtils();

  const { data: projects } = trpc.project.list.useQuery({});
  const projectId = doc.projectId ?? projects?.[0]?.id;

  const { data: tasks } = trpc.task.list.useQuery(
    { projectId: projectId! },
    { enabled: linkingTask && !!projectId },
  );

  const { data: requirements } = trpc.requirement.list.useQuery(
    { projectId: projectId! },
    { enabled: linkingReq && !!projectId },
  );

  const linkToTask = trpc.document.linkToTask.useMutation({
    onSuccess: () => {
      utils.document.get.invalidate({ id: doc.id });
      setLinkingTask(false);
      setSelectedTaskId("");
    },
  });

  const linkToReq = trpc.document.linkToRequirement.useMutation({
    onSuccess: () => {
      utils.document.get.invalidate({ id: doc.id });
      setLinkingReq(false);
      setSelectedReqId("");
    },
  });

  const existingTaskIds = new Set(doc.taskLinks?.map((l) => l.task.id) ?? []);
  const availableTasks = tasks?.filter((t) => !existingTaskIds.has(t.id) && t.status !== "cancelled");
  const availableReqs = requirements?.filter((r) => r.status !== "cancelled");

  return (
    <aside className="space-y-4">
      {doc.incomingLinks && doc.incomingLinks.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <LinkIcon className="h-4 w-4" />
              Backlinks ({doc.incomingLinks.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {doc.incomingLinks.map((link) => (
              <Link
                key={link.id}
                href={`/projects/documents/${link.sourceDoc.id}`}
                className="block rounded-md border p-2 text-sm transition-colors hover:bg-muted"
              >
                <FileText className="mr-1 inline h-3.5 w-3.5" />
                {link.sourceDoc.title}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {doc.outgoingLinks && doc.outgoingLinks.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <LinkIcon className="h-4 w-4" />
              Links ({doc.outgoingLinks.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {doc.outgoingLinks.map((link) => (
              <div
                key={link.id}
                className="flex items-center gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted"
              >
                <Link
                  href={`/projects/documents/${link.targetDoc.id}`}
                  className="flex flex-1 items-center gap-1 min-w-0"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{link.targetDoc.title}</span>
                </Link>
                <button
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => unlinkDoc.mutate({ linkId: link.id })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Linked Tasks */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <CheckSquare className="h-4 w-4" />
              Tasks ({doc.taskLinks?.length ?? 0})
            </span>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setLinkingTask(!linkingTask)}
            >
              {linkingTask ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {linkingTask && (
            <div className="space-y-2 rounded border p-2">
              <Select value={selectedTaskId} onValueChange={setSelectedTaskId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select task..." />
                </SelectTrigger>
                <SelectContent>
                  {availableTasks?.map((t) => (
                    <SelectItem key={t.id} value={t.id} className="text-xs">
                      {t.title}
                    </SelectItem>
                  ))}
                  {(!availableTasks || availableTasks.length === 0) && (
                    <div className="px-2 py-1 text-xs text-muted-foreground">No tasks available</div>
                  )}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="w-full h-7 text-xs"
                disabled={!selectedTaskId || linkToTask.isPending}
                onClick={() =>
                  linkToTask.mutate({ documentId: doc.id, taskId: selectedTaskId })
                }
              >
                {linkToTask.isPending ? "Linking..." : "Link Task"}
              </Button>
            </div>
          )}
          {doc.taskLinks?.map((link) => (
            <div
              key={link.id}
              className="flex items-start gap-2 rounded-md border p-2 text-sm"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium">{link.task.title}</p>
                <Badge variant="outline" className="mt-1 text-[10px]">
                  {link.task.status}
                </Badge>
              </div>
              <button
                className="text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
                onClick={() => unlinkFromTask.mutate({ linkId: link.id })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Link to Requirement */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Requirements
            </span>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setLinkingReq(!linkingReq)}
            >
              {linkingReq ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {linkingReq && (
            <div className="space-y-2 rounded border p-2">
              <Select value={selectedReqId} onValueChange={setSelectedReqId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select requirement..." />
                </SelectTrigger>
                <SelectContent>
                  {availableReqs?.map((r) => (
                    <SelectItem key={r.id} value={r.id} className="text-xs">
                      {r.title}
                    </SelectItem>
                  ))}
                  {(!availableReqs || availableReqs.length === 0) && (
                    <div className="px-2 py-1 text-xs text-muted-foreground">No requirements available</div>
                  )}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="w-full h-7 text-xs"
                disabled={!selectedReqId || linkToReq.isPending}
                onClick={() =>
                  linkToReq.mutate({ documentId: doc.id, requirementId: selectedReqId })
                }
              >
                {linkToReq.isPending ? "Linking..." : "Link Requirement"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}
