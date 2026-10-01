"use client";

import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { VersionStatus } from "@task-weaver/contracts";

const messages: Record<VersionStatus["status"], string> = {
  not_checked: "The latest release has not been checked.",
  disabled: "Version checks are disabled by the operator.",
  current: "Your version matches the latest stable release.",
  update_available: "A newer stable release is available.",
  ahead: "Your version is newer than the latest stable release.",
  unavailable: "The release source could not be reached or verified. Try again later.",
  rate_limited: "The release source is rate limited. Try again later.",
};
export default function VersionPage() {
  const info = trpc.version.info.useQuery(undefined, { refetchOnWindowFocus: false });
  const check = trpc.version.check.useMutation();
  const result = check.data ?? info.data;
  return <Card>
    <CardHeader><CardTitle>Version</CardTitle><CardDescription>View this Web build and check the latest official stable release.</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      {info.isLoading && <p role="status">Loading build information…</p>}
      {info.error && <p role="alert">Build information could not be loaded. <Button variant="outline" onClick={() => void info.refetch()}>Retry</Button></p>}
      {result && <>
        <dl className="space-y-2">
          <div><dt className="text-sm text-muted-foreground">Installed version</dt><dd>{result.installed.version} {result.installed.development && <Badge variant="secondary">Development build</Badge>}</dd></div>
          <div><dt className="text-sm text-muted-foreground">Build commit</dt><dd className="break-all font-mono text-sm">{result.installed.commit ?? "Unknown (build metadata not provided)"}</dd></div>
          <div><dt className="text-sm text-muted-foreground">Latest stable version</dt><dd>{result.latest?.version ?? "Unknown"}</dd></div>
          <div><dt className="text-sm text-muted-foreground">Last checked</dt><dd>{result.checkedAt ? new Date(result.checkedAt).toLocaleString() : "Never"}</dd></div>
        </dl>
        <p role="status" aria-live="polite">{check.isPending ? "Checking the official release source…" : messages[result.status]}</p>
        {check.error && <p role="alert">The check could not be completed. Please try again.</p>}
        <Button disabled={check.isPending || result.status === "disabled"} onClick={() => check.mutate()}>Check for updates</Button>
        {result.nextCheckAt && <p className="text-sm text-muted-foreground">Checks are cached until {new Date(result.nextCheckAt).toLocaleString()}.</p>}
        <div className="flex flex-wrap gap-4 text-sm underline">
          <a href={result.latest?.url ?? result.releasesUrl} target="_blank" rel="noopener noreferrer">Official releases and downloads</a>
          <a href="https://github.com/limmytian/task-weaver/blob/main/docs/deployment.md" target="_blank" rel="noopener noreferrer">Upgrade guidance</a>
        </div>
        <p className="text-sm text-muted-foreground">You decide when to upgrade and perform the upgrade yourself. Checking a version does not download or install software. API and Web deployments may use different builds; this page identifies the Web build.</p>
      </>}
    </CardContent>
  </Card>;
}
