"use client";

import { FormEvent, useEffect, useState } from "react";
import { Sparkles, CheckCircle2, CircleHelp, ListChecks, Plus, ShieldCheck, Star } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const TI_SERVER_AGENT_ID = "task-weaver:ti-agent";

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "outline";
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "running") return "default";
  return "secondary";
}

function HelpTooltip({ children }: { children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Field help"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-72 leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

function FieldLabel({ label, help }: { label: string; help?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {help && <HelpTooltip>{help}</HelpTooltip>}
    </span>
  );
}

export default function AgentsPage() {
  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="flex items-center gap-1.5 text-lg font-semibold">
          <Sparkles aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
          Ti Agent
        </h1>
        <p className="hidden text-sm text-muted-foreground md:block">
          Server-side assistant settings, model routing, and run history.
        </p>
      </header>

      <main className="mx-auto grid w-full max-w-6xl gap-6 p-6 xl:grid-cols-[420px_1fr]">
        <section className="space-y-6">
          <PolicyCard />
          <ModelConfigCard />
        </section>
        <section className="space-y-6">
          <ModelListCard />
          <RunsCard />
        </section>
      </main>
    </>
  );
}

function PolicyCard() {
  const utils = trpc.useUtils();
  const { data: policy, isLoading } = trpc.tiAgent.getPolicy.useQuery();
  const [enabled, setEnabled] = useState("false");
  const [executionMode, setExecutionMode] = useState<"disabled" | "dry_run" | "live">("disabled");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState("1");
  const [dailyRunLimit, setDailyRunLimit] = useState("25");
  const [monthlyRunLimit, setMonthlyRunLimit] = useState("500");
  const [runTimeoutSeconds, setRunTimeoutSeconds] = useState("600");
  const [defaultMaxRetries, setDefaultMaxRetries] = useState("0");
  const [assistantAutoEnabled, setAssistantAutoEnabled] = useState("false");
  const [assistantAutoMode, setAssistantAutoMode] = useState<"disabled" | "dry_run" | "live">("disabled");
  const [assistantActionAllowlist, setAssistantActionAllowlist] = useState("create_task,add_comment,add_note,draft_document");
  const [assistantDailyActionLimit, setAssistantDailyActionLimit] = useState("10");
  const [assistantRunTimeoutSeconds, setAssistantRunTimeoutSeconds] = useState("300");
  const [assistantDefaultMaxRetries, setAssistantDefaultMaxRetries] = useState("0");
  const [assistantUncertainToReview, setAssistantUncertainToReview] = useState("true");

  /* eslint-disable react-hooks/set-state-in-effect -- Sync loaded policy into editable form controls. */
  useEffect(() => {
    if (!policy) return;
    setEnabled(String(policy.enabled));
    setExecutionMode(policy.executionMode);
    setMaxConcurrentRuns(String(policy.maxConcurrentRuns));
    setDailyRunLimit(String(policy.dailyRunLimit));
    setMonthlyRunLimit(String(policy.monthlyRunLimit));
    setRunTimeoutSeconds(String(policy.runTimeoutSeconds));
    setDefaultMaxRetries(String(policy.defaultMaxRetries));
    setAssistantAutoEnabled(String(policy.assistantAutoEnabled ?? false));
    setAssistantAutoMode(policy.assistantAutoMode ?? "disabled");
    setAssistantActionAllowlist((policy.assistantActionAllowlist ?? []).join(","));
    setAssistantDailyActionLimit(String(policy.assistantDailyActionLimit ?? 10));
    setAssistantRunTimeoutSeconds(String(policy.assistantRunTimeoutSeconds ?? 300));
    setAssistantDefaultMaxRetries(String(policy.assistantDefaultMaxRetries ?? 0));
    setAssistantUncertainToReview(String(policy.assistantUncertainToReview ?? true));
  }, [policy]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const savePolicy = trpc.tiAgent.upsertPolicy.useMutation({
    onSuccess: () => {
      toast.success("Ti agent policy saved");
      utils.tiAgent.getPolicy.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    savePolicy.mutate({
      enabled: enabled === "true",
      executionMode,
      maxConcurrentRuns: Number(maxConcurrentRuns),
      dailyRunLimit: Number(dailyRunLimit),
      monthlyRunLimit: Number(monthlyRunLimit),
      runTimeoutSeconds: Number(runTimeoutSeconds),
      defaultMaxRetries: Number(defaultMaxRetries),
      assistantAutoEnabled: assistantAutoEnabled === "true",
      assistantAutoMode,
      assistantActionAllowlist: assistantActionAllowlist
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      assistantDailyActionLimit: Number(assistantDailyActionLimit),
      assistantRunTimeoutSeconds: Number(assistantRunTimeoutSeconds),
      assistantDefaultMaxRetries: Number(assistantDefaultMaxRetries),
      assistantUncertainToReview: assistantUncertainToReview === "true",
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Execution Policy
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Controls when Ti may run assigned tasks or apply assistant proposals.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <FieldLabel label="Policy" help="Master switch for server-side Ti runs. Disabled means assigned tasks and schedules will not execute automatically." />
                <Select value={enabled} onValueChange={setEnabled}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">Disabled</SelectItem>
                    <SelectItem value="true">Enabled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <FieldLabel label="Run mode" help="Dry run records proposed execution without applying changes. Live allows Ti to perform the configured work." />
                <Select
                  value={executionMode}
                  onValueChange={(value: "disabled" | "dry_run" | "live") => setExecutionMode(value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disabled">No execution</SelectItem>
                    <SelectItem value="dry_run">Dry run</SelectItem>
                    <SelectItem value="live">Live</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Concurrent runs"
                help="Maximum Ti executions allowed at the same time for this owner."
                value={maxConcurrentRuns}
                onChange={setMaxConcurrentRuns}
                min={1}
              />
              <NumberField
                label="Run timeout"
                help="Maximum seconds a server-side Ti run can hold its lease before being considered expired."
                value={runTimeoutSeconds}
                onChange={setRunTimeoutSeconds}
                min={30}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Daily limit" help="Maximum Ti runs per day. Use 0 to block all daily runs." value={dailyRunLimit} onChange={setDailyRunLimit} min={0} />
              <NumberField label="Monthly limit" help="Maximum Ti runs per month. Use 0 to block all monthly runs." value={monthlyRunLimit} onChange={setMonthlyRunLimit} min={0} />
            </div>
            <NumberField label="Default retries" help="How many times a failed Ti run may be retried when a task or schedule does not override it." value={defaultMaxRetries} onChange={setDefaultMaxRetries} min={0} />
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium">Assistant maintenance</p>
                    <HelpTooltip>Controls whether chat assistant proposals can be applied automatically. Manual chat responses still work when this is disabled.</HelpTooltip>
                  </div>
                  <p className="text-xs text-muted-foreground">Automatic execution is disabled unless explicitly enabled.</p>
                </div>
                <Select value={assistantAutoEnabled} onValueChange={setAssistantAutoEnabled}>
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">Disabled</SelectItem>
                    <SelectItem value="true">Enabled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Select
                value={assistantAutoMode}
                onValueChange={(value: "disabled" | "dry_run" | "live") => setAssistantAutoMode(value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="disabled">No automatic actions</SelectItem>
                  <SelectItem value="dry_run">Dry-run proposals only</SelectItem>
                  <SelectItem value="live">Live allowed actions</SelectItem>
                </SelectContent>
              </Select>
              <label className="space-y-1.5">
                <FieldLabel label="Action allowlist" help="Comma-separated assistant action types that may be proposed or auto-applied, such as create_task or draft_document." />
                <Input value={assistantActionAllowlist} onChange={(event) => setAssistantActionAllowlist(event.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Daily actions" help="Maximum assistant actions per day. Use 0 to block automatic assistant actions." value={assistantDailyActionLimit} onChange={setAssistantDailyActionLimit} min={0} />
                <NumberField label="Action timeout" help="Maximum seconds an assistant action may run before it is treated as expired." value={assistantRunTimeoutSeconds} onChange={setAssistantRunTimeoutSeconds} min={30} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Action retries" help="How many times a failed assistant action may retry." value={assistantDefaultMaxRetries} onChange={setAssistantDefaultMaxRetries} min={0} />
                <label className="space-y-1.5">
                  <FieldLabel label="Uncertain actions" help="When enabled, low-confidence assistant actions require review even if live mode is allowed." />
                  <Select value={assistantUncertainToReview} onValueChange={setAssistantUncertainToReview}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Route to review</SelectItem>
                      <SelectItem value="false">Use policy mode</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={savePolicy.isPending}>
              Save Policy
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function NumberField({
  label,
  help,
  value,
  onChange,
  min,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
}) {
  return (
    <label className="space-y-1.5">
      <FieldLabel label={label} help={help} />
      <Input type="number" min={min} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ModelConfigCard() {
  const utils = trpc.useUtils();
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [apiKeyRef, setApiKeyRef] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<"unknown" | "valid" | "invalid" | "missing">("unknown");
  const [enabled, setEnabled] = useState("true");
  const [isDefault, setIsDefault] = useState("false");

  const upsertConfig = trpc.tiAgent.upsertConfig.useMutation({
    onSuccess: () => {
      toast.success("Model config saved");
      utils.tiAgent.listConfigs.invalidate();
      setModel("");
      setBaseUrl("");
      setLabel("");
      setApiKeyRef("");
      setCredentialStatus("unknown");
      setEnabled("true");
      setIsDefault("false");
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!provider.trim() || !model.trim()) return;
    upsertConfig.mutate({
      provider: provider.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim() || undefined,
      label: label.trim() || undefined,
      apiKeyRef: apiKeyRef.trim() || undefined,
      credentialStatus,
      enabled: enabled === "true",
      isDefaultAgent: isDefault === "true",
      isDefaultChat: isDefault === "true",
    });
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plus className="h-4 w-4" />
          Add Model
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Register an OpenAI-compatible chat endpoint for Ti. Store the secret value outside this form and reference it here.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5">
              <FieldLabel label="Provider" help="Logical provider name used for routing, for example openai, azure, local, or your gateway name." />
              <Input placeholder="openai" value={provider} onChange={(event) => setProvider(event.target.value)} />
            </label>
            <label className="space-y-1.5">
              <FieldLabel label="Model" help="Exact model identifier sent to the OpenAI-compatible chat API, such as gpt-4.1-mini or qwen3-coder." />
              <Input placeholder="gpt-5.4-mini" value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
          </div>
          <div className="grid gap-4">
            <label className="space-y-1.5">
              <FieldLabel label="Base URL" help="OpenAI-compatible API base URL. Leave empty if the provider integration uses its built-in default." />
              <Input placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label className="space-y-1.5">
              <FieldLabel label="Display name" help="Human-readable name shown in model lists. It does not affect routing." />
              <Input placeholder="OpenAI fast model" value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <label className="space-y-1.5">
              <FieldLabel label="API key reference" help="Reference to a secret, such as an environment variable name. Do not paste raw API keys here unless your deployment intentionally stores them this way." />
              <Input placeholder="OPENAI_API_KEY or secret://openai/default" value={apiKeyRef} onChange={(event) => setApiKeyRef(event.target.value)} />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <FieldLabel label="Credentials" help="Availability marker for this model route. Invalid or missing credentials are skipped when resolving a usable default model." />
              <Select
                value={credentialStatus}
                onValueChange={(value: "unknown" | "valid" | "invalid" | "missing") => setCredentialStatus(value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unknown">Unknown</SelectItem>
                  <SelectItem value="valid">Valid</SelectItem>
                  <SelectItem value="invalid">Invalid</SelectItem>
                  <SelectItem value="missing">Missing</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <FieldLabel label="Availability" help="Disabled model routes stay saved but cannot be selected as default or used as fallback." />
              <Select value={enabled} onValueChange={setEnabled}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Enabled</SelectItem>
                  <SelectItem value="false">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <FieldLabel label="Default" help="The default enabled model is used when a task, schedule, or chat request does not ask for a specific provider and model." />
              <Select value={isDefault} onValueChange={setIsDefault}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">Fallback</SelectItem>
                  <SelectItem value="true">Default</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={!provider.trim() || !model.trim() || upsertConfig.isPending}>
            Save Model
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ModelListCard() {
  const utils = trpc.useUtils();
  const { data: configs, isLoading } = trpc.tiAgent.listConfigs.useQuery({ includeDisabled: true });
  const setDefault = trpc.tiAgent.setDefaultConfig.useMutation({
    onSuccess: () => {
      toast.success("Default model updated");
      utils.tiAgent.listConfigs.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="h-4 w-4" />
          Configured Models
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Model routes used by Ti runs and assistant chat fallback.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-40" />
        ) : !configs || configs.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center border border-dashed text-sm text-muted-foreground">
            No model configs
          </div>
        ) : (
          <div className="space-y-3">
            {configs.map((config) => (
              <div key={config.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{config.label || `${config.provider}:${config.model}`}</span>
                    {(config.isDefaultAgent || config.isDefaultChat) && (
                      <Badge variant="default">
                        <Star className="mr-1 h-3 w-3" />
                        Default
                      </Badge>
                    )}
                    <Badge variant={config.enabled ? "outline" : "secondary"}>{config.enabled ? "enabled" : "disabled"}</Badge>
                    <Badge variant={config.credentialStatus === "invalid" || config.credentialStatus === "missing" ? "destructive" : "secondary"}>
                      {config.credentialStatus}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {config.provider}:{config.model}
                    {config.baseUrl ? ` - ${config.baseUrl}` : ""}
                    {config.apiKeyRef ? ` - ${config.apiKeyRef}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(config.isDefaultAgent && config.isDefaultChat) || !config.enabled || setDefault.isPending}
                  onClick={() => setDefault.mutate({ configId: config.id, target: "both" })}
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                  Make Default
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RunsCard() {
  const { data: runs, isLoading } = trpc.tiAgent.listRuns.useQuery({
    assignedAgentId: TI_SERVER_AGENT_ID,
    limit: 25,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles aria-hidden="true" className="h-4 w-4" />
          Recent Ti Runs
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Server-side executions created from assigned tasks or schedules.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-56" />
        ) : !runs || runs.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 border border-dashed text-sm text-muted-foreground">
            <Sparkles aria-hidden="true" className="h-5 w-5" />
            No Ti agent runs
          </div>
        ) : (
          <div className="overflow-x-auto border">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Task</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Lease</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t align-top">
                    <td className="px-3 py-2">{formatDate(run.createdAt)}</td>
                    <td className="px-3 py-2">
                      <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="max-w-[220px] truncate">{run.task?.title ?? run.taskId ?? "-"}</div>
                    </td>
                    <td className="px-3 py-2">
                      {run.actualProvider && run.actualModel
                        ? `${run.actualProvider}:${run.actualModel}`
                        : "-"}
                    </td>
                    <td className="px-3 py-2">{run.leaseOwnerId ?? "-"}</td>
                    <td className="px-3 py-2">
                      <div className="max-w-[260px] truncate">
                        {run.errorMessage ?? run.outputSummary ?? "-"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
