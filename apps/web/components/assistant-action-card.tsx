"use client";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
export type AssistantActionView = {
  id: string; messageId?: string | null; actionType: string; status: string; preview: string | null;
  payload?: Record<string, unknown>; executionResult?: Record<string, unknown> | null; errorMessage?: string | null;
};
const labels: Record<string, string> = { proposed: "Awaiting approval", approved: "Approved", executing: "Running", succeeded: "Completed", rejected: "Rejected", failed: "Failed" };
export function AssistantActionCard({ action, allowed, busy, onApprove, onReject }: {
  action: AssistantActionView; allowed: boolean; busy: boolean; onApprove: () => void; onReject: () => void;
}) {
  const operation = typeof action.payload?.operation === "string" ? action.payload.operation : action.actionType;
  const title = operation.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
  return <div className="min-w-0 rounded-xl border bg-background p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{action.actionType === "platform_operation" ? title : action.preview ?? title}</span>
      <Badge variant={action.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">{labels[action.status] ?? action.status}</Badge>
    </div>
    {action.status === "proposed" && <>
      <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">Review changes</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2">{JSON.stringify(action.payload, null, 2)}</pre>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-8 gap-1.5" onClick={onApprove} disabled={!allowed || busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <CheckCircle2 className="h-3.5 w-3.5"/>}Approve
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onReject} disabled={busy}><XCircle className="h-3.5 w-3.5"/>Reject</Button>
        {!allowed && <span className="text-xs text-muted-foreground">Enable operations in Chat settings to approve.</span>}
      </div>
    </>}
    {action.executionResult && <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">View recorded result</summary>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2">{JSON.stringify(action.executionResult, null, 2)}</pre>
    </details>}
    {action.errorMessage && <p className="mt-2 break-words text-xs text-destructive">{action.errorMessage}</p>}
  </div>;
}
