"use client";

import { AssistantDialog } from "@/components/assistant-dialog";

import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Archive, CalendarClock, Play, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function localDateTimeValue(date = new Date(Date.now() + 60 * 60_000)) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

const TI_SERVER_AGENT_ID = "task-weaver:ti-agent";

export default function ProjectSchedulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"one_off" | "recurring">("one_off");
  const [description, setDescription] = useState("");
  const [requirementId, setRequirementId] = useState("");
  const [startsAt, setStartsAt] = useState(localDateTimeValue());
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [recurrenceRule, setRecurrenceRule] = useState("FREQ=DAILY;INTERVAL=1");
  const [catchUpPolicy, setCatchUpPolicy] = useState<"none" | "latest" | "all">("latest");
  const [expiryWindowMinutes, setExpiryWindowMinutes] = useState("1440");
  const [autoRun, setAutoRun] = useState("false");
  const [modelChoice, setModelChoice] = useState("__default__");
  const [requestedPiProvider, setRequestedPiProvider] = useState("");
  const [requestedPiModel, setRequestedPiModel] = useState("");

  const { data: project, isLoading: projectLoading } = trpc.project.get.useQuery({ id });
  const { data: requirements } = trpc.requirement.list.useQuery({ projectId: id });
  const { data: schedules, isLoading } = trpc.schedule.list.useQuery({ projectId: id });
  const { data: modelConfigs } = trpc.tiAgent.listConfigs.useQuery({ includeDisabled: false });

  const requirementTitleById = useMemo(
    () => new Map((requirements ?? []).map((requirement) => [requirement.id, requirement.title])),
    [requirements],
  );

  const resetForm = () => {
    setTitle("");
    setKind("one_off");
    setDescription("");
    setRequirementId("");
    setStartsAt(localDateTimeValue());
    setTaskTitle("");
    setTaskDescription("");
    setPriority("medium");
    setRecurrenceRule("FREQ=DAILY;INTERVAL=1");
    setCatchUpPolicy("latest");
    setExpiryWindowMinutes("1440");
    setAutoRun("false");
    setModelChoice("__default__");
    setRequestedPiProvider("");
    setRequestedPiModel("");
  };

  const createSchedule = trpc.schedule.create.useMutation({
    onSuccess: () => {
      toast.success("Schedule created");
      utils.schedule.list.invalidate();
      resetForm();
    },
    onError: (err) => toast.error(err.message),
  });

  const archiveSchedule = trpc.schedule.archive.useMutation({
    onSuccess: () => {
      toast.success("Schedule archived");
      utils.schedule.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const runNow = trpc.schedule.runNow.useMutation({
    onSuccess: () => {
      toast.success("Generated task created");
      utils.schedule.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const acquireDue = trpc.schedule.acquireDue.useMutation({
    onSuccess: () => {
      toast.success("Due schedules processed");
      utils.schedule.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = () => {
    if (!title.trim() || !requirementId || !startsAt || !taskTitle.trim()) return;
    const selectedModel = modelConfigs?.find((config) => config.id === modelChoice);
    const piProvider = autoRun === "true"
      ? selectedModel?.provider ?? (modelChoice === "__custom__" ? requestedPiProvider.trim() : "")
      : "";
    const piModel = autoRun === "true"
      ? selectedModel?.model ?? (modelChoice === "__custom__" ? requestedPiModel.trim() : "")
      : "";
    createSchedule.mutate({
      projectId: id,
      requirementId,
      targetScope: "project",
      kind,
      title,
      description: description || undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      startsAt: new Date(startsAt),
      recurrenceSyntax: kind === "recurring" ? "rrule" : undefined,
      recurrenceRule: kind === "recurring" ? recurrenceRule : undefined,
      catchUpPolicy,
      expiryWindowMinutes: expiryWindowMinutes ? Number(expiryWindowMinutes) : undefined,
      taskTemplate: {
        title: taskTitle,
        description: taskDescription || undefined,
        priority,
      },
      autoRun: autoRun === "true",
      assignedExecutor: autoRun === "true" ? TI_SERVER_AGENT_ID : undefined,
      assignedExecutorType: autoRun === "true" ? "agent" : undefined,
      requestedProvider: piProvider || undefined,
      requestedModel: piModel || undefined,
    });
  };

  if (projectLoading) {
    return (
      <>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Skeleton className="h-5 w-40" />
        </header>
        <main className="p-6">
          <Skeleton className="h-96" />
        </main>
      </>
    );
  }

  return (
    <>
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 hidden h-4 sm:block" />
        <Button variant="ghost" size="icon" className="size-10 sm:size-7" aria-label="Back to project" onClick={() => router.push(`/projects/${id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <CalendarClock className="h-5 w-5" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold sm:text-lg">{project?.name ?? "Project"} schedules</h1>
        <div className="w-full sm:ml-auto sm:w-auto">
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => acquireDue.mutate({ projectId: id, limit: 20 })}
            disabled={acquireDue.isPending}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            Process Due
          </Button>
        </div>
      </header>

      <main className="grid gap-4 p-3 sm:p-4 md:gap-6 md:p-6 xl:grid-cols-[420px_1fr]">
        <section className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="h-4 w-4" />
                New Schedule
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input placeholder="Schedule title" value={title} onChange={(event) => setTitle(event.target.value)} />
              <Textarea
                placeholder="Description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <Select value={requirementId || undefined} onValueChange={setRequirementId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Requirement" />
                </SelectTrigger>
                <SelectContent>
                  {(requirements ?? []).map((requirement) => (
                    <SelectItem key={requirement.id} value={requirement.id}>
                      {requirement.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Select value={kind} onValueChange={(value: "one_off" | "recurring") => setKind(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_off">One-off</SelectItem>
                    <SelectItem value="recurring">Recurring</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
              </div>
              {kind === "recurring" && (
                <Input value={recurrenceRule} onChange={(event) => setRecurrenceRule(event.target.value)} />
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Select value={catchUpPolicy} onValueChange={(value: "none" | "latest" | "all") => setCatchUpPolicy(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No catch-up</SelectItem>
                    <SelectItem value="latest">Latest only</SelectItem>
                    <SelectItem value="all">All missed</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min="1"
                  value={expiryWindowMinutes}
                  onChange={(event) => setExpiryWindowMinutes(event.target.value)}
                />
              </div>
              <Input placeholder="Generated task title" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
              <Textarea
                placeholder="Generated task description"
                value={taskDescription}
                onChange={(event) => setTaskDescription(event.target.value)}
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Select value={priority} onValueChange={(value: "low" | "medium" | "high" | "urgent") => setPriority(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={autoRun} onValueChange={setAutoRun}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">Manual</SelectItem>
                    <SelectItem value="true">Auto-run</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {autoRun === "true" && (
                <div className="space-y-2">
                  <Select value={modelChoice} onValueChange={setModelChoice}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Use default Ti model</SelectItem>
                      {(modelConfigs ?? []).map((config) => (
                        <SelectItem key={config.id} value={config.id}>
                          {config.label || `${config.provider}:${config.model}`}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">Custom model</SelectItem>
                    </SelectContent>
                  </Select>
                  {modelChoice === "__custom__" && (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Input
                        placeholder="Ti provider"
                        value={requestedPiProvider}
                        onChange={(event) => setRequestedPiProvider(event.target.value)}
                      />
                      <Input
                        placeholder="Ti model"
                        value={requestedPiModel}
                        onChange={(event) => setRequestedPiModel(event.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}
              <Button
                className="w-full"
                onClick={submit}
                disabled={!title.trim() || !requirementId || !taskTitle.trim() || createSchedule.isPending}
              >
                Create Schedule
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-64" />
          ) : (schedules ?? []).length === 0 ? (
            <div className="flex min-h-64 items-center justify-center border border-dashed text-sm text-muted-foreground">
              No schedules
            </div>
          ) : (
            (schedules ?? []).map((schedule) => (
              <Card key={schedule.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{schedule.title}</CardTitle>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Badge variant="outline">{schedule.kind}</Badge>
                        <Badge variant={schedule.status === "active" ? "default" : "secondary"}>{schedule.status}</Badge>
                        <Badge variant="secondary">{schedule.catchUpPolicy}</Badge>
                        {schedule.assignedExecutor === TI_SERVER_AGENT_ID && (
                          <Badge variant="outline">Ti agent</Badge>
                        )}
                        {schedule.requestedModel && (
                          <Badge variant="outline">{schedule.requestedProvider ?? "ti"}:{schedule.requestedModel}</Badge>
                        )}
                      </div>
                    </div>
                    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
                      <AssistantDialog contextKind="schedule" projectId={id} requirementId={schedule.requirementId ?? undefined} scheduleId={schedule.id} label="Chat" />
                      <Button size="sm" variant="outline" onClick={() => runNow.mutate({ id: schedule.id })}>
                        <Play className="mr-1 h-4 w-4" />
                        Run
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => archiveSchedule.mutate({ id: schedule.id })}>
                        <Archive className="mr-1 h-4 w-4" />
                        Archive
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid gap-2 md:grid-cols-3">
                    <div>
                      <div className="text-xs text-muted-foreground">Requirement</div>
                      <div>{requirementTitleById.get(schedule.requirementId ?? "") ?? "-"}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Next Run</div>
                      <div>{formatDate(schedule.nextRunAt)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Generated Task</div>
                      <div>{schedule.taskTitle}</div>
                    </div>
                  </div>
                  {schedule.runs.length > 0 && (
                    <div className="overflow-x-auto border">
                      <table className="w-full min-w-[560px] text-left text-xs">
                        <thead className="bg-muted">
                          <tr>
                            <th className="px-3 py-2 font-medium">Planned</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2 font-medium">Generated Task</th>
                            <th className="px-3 py-2 font-medium">Ti Model</th>
                            <th className="px-3 py-2 font-medium">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {schedule.runs.map((run) => (
                            <tr key={run.id} className="border-t">
                              <td className="px-3 py-2">{formatDate(run.plannedFor)}</td>
                              <td className="px-3 py-2">{run.status}</td>
                              <td className="px-3 py-2">{run.generatedTaskId ?? "-"}</td>
                              <td className="px-3 py-2">{run.requestedModel ?? run.actualModel ?? "-"}</td>
                              <td className="px-3 py-2">{run.skippedReason ?? "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </section>
      </main>
    </>
  );
}
