"use client";

import { AssistantSettings } from "./assistant-settings";
import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Edit2,
  History,
  Loader2,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

type AssistantContextKind = "global" | "project" | "requirement" | "task" | "schedule";
type AssistantWorkflow =
  | "project_health"
  | "stale_tasks"
  | "failed_ti_runs"
  | "schedule_maintenance"
  | "requirement_next_steps"
  | "personal_inbox_cleanup";

type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type AssistantAction = {
  id: string;
  actionType: string;
  status: string;
  preview: string | null;
  errorMessage?: string | null;
};

export function AssistantDialog({
  contextKind,
  projectId,
  requirementId,
  taskId,
  scheduleId,
  label = "Ti assistant",
  triggerClassName,
}: {
  contextKind: AssistantContextKind;
  projectId?: string;
  requirementId?: string;
  taskId?: string;
  scheduleId?: string;
  label?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [actions, setActions] = useState<AssistantAction[]>([]);
  const [input, setInput] = useState("");
  const sending = useRef(false);
  const composing = useRef(false);
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingConvId, setDeletingConvId] = useState<string | null>(null);

  const utils = trpc.useUtils();

  const context = useMemo(() => ({
    contextKind,
    projectId,
    requirementId,
    taskId,
    scheduleId,
    includeGlobal: true,
    includePersonal: true,
    limits: {
      recentActivity: 10,
      recentMessages: 12,
      requirements: 12,
      tasks: 25,
      schedules: 10,
      documents: 8,
      memories: 8,
      mcpTools: 12,
      tiRuns: 8,
      textChars: 1200,
    },
  }), [contextKind, projectId, requirementId, taskId, scheduleId]);

  const conversationsQuery = trpc.assistant.listConversations.useQuery(
    {
      contextKind,
      projectId,
      requirementId,
      taskId,
      scheduleId,
      limit: 30,
    },
    { enabled: open && showHistory },
  );

  const sendMessage = trpc.assistant.sendMessage.useMutation({
    onSuccess: (result) => {
      setInput("");
      setConversationId(result.conversation.id);
      setMessages((current) => [
        ...current,
        {
          id: result.userMessage.id,
          role: "user",
          content: result.userMessage.content,
        },
        {
          id: result.assistantMessage.id,
          role: "assistant",
          content: result.assistantMessage.content,
        },
      ]);
      setActions((current) => [...result.actions, ...current]);
      utils.assistant.listConversations.invalidate();
      if (result.modelError) {
        toast.info("Assistant answered without a configured Ti model", {
          description: result.modelError,
        });
      }
    },
    onError: (err) => {
      toast.error("Assistant failed", { description: err.message });
    },
    onSettled: () => { sending.current = false; },
  });

  const renameMutation = trpc.assistant.renameConversation.useMutation({
    onSuccess: () => {
      toast.success("Conversation renamed");
      setEditingConvId(null);
      utils.assistant.listConversations.invalidate();
    },
    onError: (err) => toast.error("Failed to rename conversation", { description: err.message }),
  });

  const deleteMutation = trpc.assistant.deleteConversation.useMutation({
    onSuccess: () => {
      toast.success("Conversation deleted");
      if (deletingConvId === conversationId) {
        handleNewChat();
      }
      setDeletingConvId(null);
      utils.assistant.listConversations.invalidate();
    },
    onError: (err) => toast.error("Failed to delete conversation", { description: err.message }),
  });

  const executeAction = trpc.assistant.executeAction.useMutation({
    onSuccess: (updated) => {
      setActions((current) => current.map((action) => action.id === updated.id ? updated : action));
      toast.success("Assistant action executed");
    },
    onError: (err) => toast.error("Action failed", { description: err.message }),
  });

  const rejectAction = trpc.assistant.updateActionStatus.useMutation({
    onSuccess: (updated) => {
      setActions((current) => current.map((action) => action.id === updated.id ? updated : action));
    },
    onError: (err) => toast.error("Could not update action", { description: err.message }),
  });

  const handleSelectConversation = async (id: string) => {
    try {
      const data = await utils.assistant.getConversation.fetch({ id });
      setConversationId(data.conversation.id);
      setMessages(data.messages.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
      })));
      setActions(data.actions.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        status: a.status,
        preview: a.preview,
        errorMessage: a.errorMessage,
      })));
      setShowHistory(false);
    } catch (err: unknown) {
      toast.error("Failed to load conversation", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleNewChat = () => {
    setConversationId(undefined);
    setMessages([]);
    setActions([]);
    setInput("");
    setShowHistory(false);
  };

  const workflowLabels: Array<{ workflow: AssistantWorkflow; label: string }> = [
    { workflow: "project_health", label: "Health" },
    { workflow: "stale_tasks", label: "Stale" },
    { workflow: "failed_ti_runs", label: "Ti runs" },
    { workflow: "schedule_maintenance", label: "Schedules" },
    { workflow: "requirement_next_steps", label: "Next steps" },
  ];

  const submit = (
    mode: "ask" | "propose_task" = "ask",
    workflow?: AssistantWorkflow,
  ) => {
    const message = input.trim();
    const effectiveMessage = message || workflowLabels.find((item) => item.workflow === workflow)?.label || "";
    if (!effectiveMessage || sendMessage.isPending || sending.current || composing.current) return;
    sending.current = true;
    sendMessage.mutate({
      conversationId,
      context,
      message: effectiveMessage,
      workflow,
      proposedActions: mode === "propose_task" && projectId && requirementId
        ? [{
          actionType: "create_task",
          payload: {
            projectId,
            requirementId,
            title: effectiveMessage.slice(0, 120),
            description: effectiveMessage,
            priority: "medium",
          },
          preview: `Create follow-up task: ${effectiveMessage.slice(0, 160)}`,
        }]
        : [],
    });
  };

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size="sm" variant="outline" className={triggerClassName}>
            <Sparkles aria-hidden="true" className="mr-1 h-4 w-4" />
            {label}
          </Button>
        </SheetTrigger>
        <SheetContent className="flex w-full flex-col p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-5 py-4">
            <div className="flex items-center justify-between gap-3 pr-8">
              <div className="flex items-center gap-2">
                <SheetTitle className="flex items-center gap-2 text-left">
                  <Sparkles aria-hidden="true" className="h-5 w-5" />
                  Ti assistant
                </SheetTitle>
                <Badge variant="outline" className="text-[10px]">
                  {contextKind}
                </Badge>
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <ShieldCheck className="h-3 w-3" />
                  approval
                </Badge>
              </div>

              <div className="flex items-center gap-1">
                <AssistantSettings />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={handleNewChat}
                  title="Start a new conversation"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New
                </Button>
                <Button
                  size="sm"
                  variant={showHistory ? "secondary" : "ghost"}
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => setShowHistory(!showHistory)}
                  title="View conversation history"
                >
                  <History className="h-3.5 w-3.5" />
                  History
                </Button>
              </div>
            </div>
          </SheetHeader>

          {showHistory ? (
            <div className="flex flex-1 flex-col overflow-hidden bg-muted/10">
              <div className="flex items-center justify-between border-b px-5 py-2.5 text-xs text-muted-foreground">
                <span className="font-medium">Previous Conversations</span>
                <span>{conversationsQuery.data?.length ?? 0} saved</span>
              </div>
              <ScrollArea className="flex-1">
                <div className="space-y-1 p-3">
                  {conversationsQuery.isLoading ? (
                    <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading conversations...
                    </div>
                  ) : !conversationsQuery.data || conversationsQuery.data.length === 0 ? (
                    <div className="p-8 text-center text-sm text-muted-foreground">
                      No past conversations found.
                    </div>
                  ) : (
                    conversationsQuery.data.map((c) => {
                      const isCurrent = c.id === conversationId;
                      const isEditing = editingConvId === c.id;

                      return (
                        <div
                          key={c.id}
                          className={`group flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors ${
                            isCurrent
                              ? "border-primary/50 bg-primary/5"
                              : "border-transparent hover:border-border hover:bg-muted/50"
                          }`}
                        >
                          {isEditing ? (
                            <div className="flex flex-1 items-center gap-1.5">
                              <Input
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                className="h-7 text-xs"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && editingTitle.trim()) {
                                    renameMutation.mutate({ id: c.id, title: editingTitle.trim() });
                                  } else if (e.key === "Escape") {
                                    setEditingConvId(null);
                                  }
                                }}
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                onClick={() => {
                                  if (editingTitle.trim()) {
                                    renameMutation.mutate({ id: c.id, title: editingTitle.trim() });
                                  }
                                }}
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => setEditingConvId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 flex-col text-left"
                                onClick={() => handleSelectConversation(c.id)}
                              >
                                <span className="truncate font-medium">
                                  {c.title || "Untitled Conversation"}
                                </span>
                                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                  <Clock className="h-3 w-3" />
                                  {new Date(c.lastMessageAt ?? c.createdAt).toLocaleString()}
                                </span>
                              </button>

                              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                  title="Rename"
                                  onClick={() => {
                                    setEditingConvId(c.id);
                                    setEditingTitle(c.title || "");
                                  }}
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  title="Delete"
                                  onClick={() => setDeletingConvId(c.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </div>
          ) : (
            <>
              <ScrollArea className="flex-1">
                <div className="space-y-4 px-5 py-5">
                  {messages.length === 0 ? (
                    <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                      <Sparkles aria-hidden="true" className="mb-2 h-5 w-5" />
                      Ask about personal tasks, project status, risks, stale work, schedule health, or the next useful maintenance step.
                    </div>
                  ) : (
                    messages.map((message) => (
                      <div key={message.id} className="flex gap-3">
                        <div role="img" aria-label={message.role === "assistant" ? "Ti assistant" : "You"} className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
                          {message.role === "assistant" ? (
                            <Sparkles aria-hidden="true" className="h-4 w-4" />
                          ) : (
                            <UserRound className="h-4 w-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 text-xs font-medium text-muted-foreground">
                            {message.role === "assistant" ? "Assistant" : "You"}
                          </div>
                          <div className="whitespace-pre-wrap text-sm leading-relaxed">
                            {message.content}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  {actions.length > 0 && (
                    <div className="space-y-2">
                      {actions.map((action) => (
                        <div key={action.id} className="rounded-md border bg-background p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="mb-1 flex items-center gap-2">
                                <Badge variant="outline" className="text-[10px]">
                                  {action.actionType}
                                </Badge>
                                <Badge variant={action.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">
                                  {action.status}
                                </Badge>
                              </div>
                              <p className="text-sm leading-relaxed">
                                {action.preview ?? "Assistant action proposal"}
                              </p>
                              {action.errorMessage && (
                                <p className="mt-1 text-xs text-destructive">{action.errorMessage}</p>
                              )}
                            </div>
                            {action.status === "proposed" && (
                              <div className="flex shrink-0 items-center gap-1">
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="h-8 w-8"
                                  title="Approve"
                                  onClick={() => executeAction.mutate({ id: action.id })}
                                  disabled={executeAction.isPending || rejectAction.isPending}
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  title="Reject"
                                  onClick={() => rejectAction.mutate({ id: action.id, data: { status: "rejected" } })}
                                  disabled={executeAction.isPending || rejectAction.isPending}
                                >
                                  <XCircle className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {sendMessage.isPending && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Reading current context...
                    </div>
                  )}
                </div>
              </ScrollArea>

              <div className="border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {workflowLabels.map((item) => (
                    <Button
                      key={item.workflow}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => submit("ask", item.workflow)}
                      disabled={sendMessage.isPending}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onCompositionStart={() => { composing.current = true; }}
                    onCompositionEnd={() => { composing.current = false; }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                    placeholder="Ask about status, risks, or next steps (Enter to send, Shift+Enter for newline)"
                    className="min-h-20 resize-none"
                    disabled={sendMessage.isPending}
                  />
                  <Button
                    size="icon"
                    className="h-10 w-10 shrink-0"
                    onClick={() => submit()}
                    disabled={!input.trim() || sendMessage.isPending}
                    title="Send"
                  >
                    {sendMessage.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {projectId && requirementId && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => submit("propose_task")}
                    disabled={!input.trim() || sendMessage.isPending}
                  >
                    Propose task
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={deletingConvId !== null} onOpenChange={(open) => !open && setDeletingConvId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this conversation and its associated message history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deletingConvId) {
                  deleteMutation.mutate({ id: deletingConvId });
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
