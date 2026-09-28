"use client";

import { useMemo, useState } from "react";
import { Bot, CheckCircle2, Loader2, Send, ShieldCheck, Sparkles, UserRound, XCircle } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";

type AssistantContextKind = "global" | "project" | "requirement" | "task" | "schedule";
type AssistantWorkflow =
  | "project_health"
  | "stale_tasks"
  | "failed_pi_runs"
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
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [actions, setActions] = useState<AssistantAction[]>([]);
  const [input, setInput] = useState("");

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
      piRuns: 8,
      textChars: 1200,
    },
  }), [contextKind, projectId, requirementId, taskId, scheduleId]);

  const sendMessage = trpc.assistant.sendMessage.useMutation({
    onSuccess: (result) => {
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
      if (result.modelError) {
        toast.info("Assistant answered without a configured Ti model", {
          description: result.modelError,
        });
      }
    },
    onError: (err) => {
      toast.error("Assistant failed", { description: err.message });
    },
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

  const workflowLabels: Array<{ workflow: AssistantWorkflow; label: string }> = [
    { workflow: "project_health", label: "Health" },
    { workflow: "stale_tasks", label: "Stale" },
    { workflow: "failed_pi_runs", label: "Ti runs" },
    { workflow: "schedule_maintenance", label: "Schedules" },
    { workflow: "requirement_next_steps", label: "Next steps" },
  ];

  const submit = (
    mode: "ask" | "propose_task" = "ask",
    workflow?: AssistantWorkflow,
  ) => {
    const message = input.trim();
    const effectiveMessage = message || workflowLabels.find((item) => item.workflow === workflow)?.label || "";
    if (!effectiveMessage || sendMessage.isPending) return;
    setInput("");
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
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className={triggerClassName}>
          <Sparkles className="mr-1 h-4 w-4" />
          {label}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4">
          <div className="flex items-center justify-between gap-3 pr-8">
            <SheetTitle className="flex items-center gap-2 text-left">
              <Bot className="h-5 w-5" />
              Ti assistant
            </SheetTitle>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">
                {contextKind}
              </Badge>
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <ShieldCheck className="h-3 w-3" />
                approval
              </Badge>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-4 px-5 py-5">
            {messages.length === 0 ? (
              <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                Ask about personal tasks, project status, risks, stale work, schedule health, or the next useful maintenance step.
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className="flex gap-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
                    {message.role === "assistant" ? (
                      <Bot className="h-4 w-4" />
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
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask about status, risks, or next steps"
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
      </SheetContent>
    </Sheet>
  );
}
