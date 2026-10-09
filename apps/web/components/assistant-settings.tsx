"use client";
import { useState } from "react";
import { Settings } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
export function AssistantSettings() {
    const utils = trpc.useUtils();
    const query = trpc.assistant.getPolicy.useQuery();
    const [open, setOpen] = useState(false);
    const [allowed, setAllowed] = useState(false);
    const enabled = !!query.data?.assistantAutoEnabled && query.data.assistantAutoMode === "live";
    const save = trpc.assistant.updatePolicy.useMutation({
        onSuccess: async () => { await utils.assistant.getPolicy.invalidate(); toast.success("Assistant settings saved"); setOpen(false); },
        onError: error => toast.error("Settings could not be saved", { description: error.message }),
    });
    return <Dialog open={open} onOpenChange={value => { setOpen(value); if (value)
        setAllowed(enabled); }}>
    <Badge variant="secondary" className="text-[10px]">{enabled ? "Operations allowed" : "Read only"}</Badge>
    <DialogTrigger asChild><Button size="icon" variant="ghost" aria-label="Assistant operation settings" disabled={!query.data}><Settings className="h-4 w-4"/></Button></DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>Assistant operation permission</DialogTitle><DialogDescription>Applies to all chats for your account. Resource permissions and project execution policies still apply.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate({ assistantAutoEnabled: allowed, assistantAutoMode: allowed ? "live" : "disabled", assistantUncertainToReview: false }); }}>
        <fieldset className="space-y-3">
          <label className="flex items-start gap-2 text-sm"><input type="radio" name="operations" checked={!allowed} onChange={() => setAllowed(false)}/><span>Do not allow operations<span className="block text-xs text-muted-foreground">The assistant can query data but cannot make changes.</span></span></label>
          <label className="flex items-start gap-2 text-sm"><input type="radio" name="operations" checked={allowed} onChange={() => setAllowed(true)}/><span>Allow operations<span className="block text-xs text-muted-foreground">The assistant can execute platform operations using your account permissions. Results are recorded in the conversation.</span></span></label>
        </fieldset>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>Cancel</Button><Button type="submit" disabled={save.isPending}>Save settings</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
