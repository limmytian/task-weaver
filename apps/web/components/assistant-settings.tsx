"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type AssistantPolicy, assistantPolicySchema } from "@task-weaver/contracts";

const actions = [
  ["create_task", "Create task", "Create a task under an accessible requirement."],
  ["update_task", "Update task", "Change task details or status."],
  ["create_schedule", "Create schedule", "Schedule future work."],
  ["pause_schedule", "Pause schedule", "Stop future runs of a schedule."],
  ["queue_ti_run", "Queue task run", "Request a Ti run, subject to task execution policy."],
  ["add_comment", "Add comment", "Write a comment on a task."],
  ["add_note", "Add note", "Attach a note to a task."],
  ["draft_document", "Draft document", "Create a document for review."],
] as const;
const modeLabels = { disabled: "Manual confirmation", dry_run: "Preview only", live: "Automatic selected actions" };

export function AssistantSettings() {
  const utils = trpc.useUtils();
  const query = trpc.assistant.getPolicy.useQuery();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AssistantPolicy | null>(null);
  const save = trpc.assistant.updatePolicy.useMutation({
    onSuccess: async () => { await utils.assistant.getPolicy.invalidate(); toast.success("Assistant settings saved"); setOpen(false); },
    onError: error => toast.error("Settings could not be saved", { description: error.message }),
  });
  const mode = query.data?.assistantAutoEnabled ? query.data.assistantAutoMode : "disabled";
  return <Dialog open={open} onOpenChange={value => {
    setOpen(value);
    if (value && query.data) setDraft(assistantPolicySchema.parse(Object.fromEntries(Object.keys(assistantPolicySchema.shape).map(key => [key, query.data![key as keyof AssistantPolicy]]))));
  }}>
    <Badge variant="secondary" className="text-[10px]">{modeLabels[mode]}</Badge>
    <DialogTrigger asChild><Button size="icon" variant="ghost" aria-label="Assistant action settings" disabled={!query.data}><Settings className="h-4 w-4" /></Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Assistant action settings</DialogTitle><DialogDescription>Applies to all chats for your account. Task execution settings are managed separately on Agents.</DialogDescription></DialogHeader>
      {draft && <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(draft); }}>
        <fieldset className="space-y-2"><legend className="font-medium">Mode</legend>
          {Object.entries(modeLabels).map(([value, label]) => <label key={value} className="flex items-start gap-2 text-sm"><input type="radio" name="assistant-mode" value={value} checked={(draft.assistantAutoEnabled ? draft.assistantAutoMode : "disabled") === value} onChange={() => setDraft({ ...draft, assistantAutoEnabled: value !== "disabled", assistantAutoMode: value as AssistantPolicy["assistantAutoMode"] })} /><span>{label}<span className="block text-xs text-muted-foreground">{value === "disabled" ? "Review and approve each change." : value === "dry_run" ? "Inspect proposals without automatic writes." : "Execute checked actions when resource permissions and limits allow."}</span></span></label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="font-medium">Allowed actions</legend>
          {actions.map(([value, label, description]) => <label key={value} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.assistantActionAllowlist.includes(value)} onChange={event => setDraft({ ...draft, assistantActionAllowlist: event.target.checked ? [...draft.assistantActionAllowlist, value] : draft.assistantActionAllowlist.filter(item => item !== value) })} /><span>{label}<span className="block text-xs text-muted-foreground">{description}</span></span></label>)}
          <p className="text-xs text-muted-foreground">No checked actions means no automatic changes.</p>
          {!!query.data?.unsupportedActions.length && <p className="text-sm text-destructive">Unsupported saved actions were excluded. Review your selection before saving.</p>}
        </fieldset>
        <details><summary className="cursor-pointer font-medium">Advanced settings</summary><div className="grid gap-3 py-3 sm:grid-cols-2">
          {([["assistantDailyActionLimit", "Daily action limit", 0], ["assistantRunTimeoutSeconds", "Timeout (seconds)", 30], ["assistantDefaultMaxRetries", "Retries", 0]] as const).map(([field, label, min]) => <label key={field} className="space-y-1 text-sm">{label}<Input type="number" min={min} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: Number(event.target.value) })} /></label>)}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.assistantUncertainToReview} onChange={event => setDraft({ ...draft, assistantUncertainToReview: event.target.checked })} />Send uncertain actions to review</label>
        </div></details>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>Cancel</Button><Button type="submit" disabled={save.isPending}>Save settings</Button></div>
      </form>}
    </DialogContent>
  </Dialog>;
}
