#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  {
    file: "components/query-state-panel.tsx",
    label: "shared query feedback panel",
    patterns: [
      /export function QueryStatePanel/,
      /onAction/,
      /actionLabel/,
      /RefreshCw/,
    ],
  },
  {
    file: "app/projects/page.tsx",
    label: "Projects command center states",
    patterns: [
      /QueryStatePanel/,
      /Search projects/,
      /Pinned/,
      /sm:grid-cols-2/,
      /aria-label=\{isPinned \? "Unpin project" : "Pin project"\}/,
    ],
  },
  {
    file: "app/projects/documents/page.tsx",
    label: "Documents discovery and preview states",
    patterns: [
      /QueryStatePanel/,
      /Search documents/,
      /DocumentPreview/,
      /All tags/,
      /xl:grid-cols-\[minmax\(0,1fr\)_360px\]/,
    ],
  },
  {
    file: "components/personal-inbox-view.tsx",
    label: "Personal inbox responsive capture and feedback",
    patterns: [
      /QueryStatePanel/,
      /Search personal tasks/,
      /tw-personal-inbox-view/,
      /aria-label="Expected date"/,
      /All priorities/,
    ],
  },
  {
    file: "components/create-requirement-dialog.tsx",
    label: "Requirement create validation and discard protection",
    patterns: [
      /ConfirmDialog/,
      /aria-invalid=\{Boolean\(titleError\)\}/,
      /disabled=\{!canSubmit\}/,
      /Discard requirement draft/,
      /autoFocus/,
    ],
  },
  {
    file: "components/create-task-dialog.tsx",
    label: "Task create validation and discard protection",
    patterns: [
      /ConfirmDialog/,
      /aria-invalid=\{Boolean\(titleError\)\}/,
      /aria-invalid=\{Boolean\(requirementError\)\}/,
      /disabled=\{!canSubmit\}/,
      /Discard task draft/,
    ],
  },
  {
    file: "components/task-detail-sheet.tsx",
    label: "Task detail lifecycle feedback",
    patterns: [
      /Task status updated/,
      /Failed to update task status/,
      /Saving changes/,
      /disabled=\{task\.status === "cancelled" \|\| updateStatus\.isPending/,
      /Failed to unlink document/,
    ],
  },
  {
    file: "components/project-navigation.tsx",
    label: "Project navigation accessibility",
    patterns: [
      /aria-label="Breadcrumb"/,
      /aria-current=\{active === item\.key \? "page" : undefined\}/,
      /focus-visible:ring-2/,
      /ProjectWorkspaceLinks/,
    ],
  },
  {
    file: "app/projects/search/page.tsx",
    label: "Search result feedback and explicit actions",
    patterns: [
      /ResultFilter/,
      /QueryStatePanel/,
      /All results/,
      /ExternalLink/,
      /No matching results/,
    ],
  },
  {
    file: "app/projects/daemons/page.tsx",
    label: "Daemon operational visibility feedback",
    patterns: [
      /QueryStatePanel/,
      /RefreshCw/,
      /staleCount/,
      /workerCount/,
      /refetchInterval: 30_000/,
      /OperatorActionDialog/,
      /TimelineDialog/,
      /aria-label="Pipeline lifecycle controls"/,
      /aria-live="polite"/,
      /sm:max-w-3xl/,
      /max-h-\[85vh\]/,
      /Show run history for/,
    ],
  },
  {
    file: "hooks/use-realtime.ts",
    label: "Daemon realtime timeline invalidation",
    patterns: [
      /daemon_progress_updated/,
      /utils\.daemon\.overview\.invalidate\(\)/,
      /utils\.daemon\.metrics\.invalidate\(\)/,
      /utils\.daemon\.timeline\.invalidate\(\)/,
      /utils\.daemon\.queues\.invalidate\(\)/,
    ],
  },
  {
    file: "app/projects/repositories/page.tsx",
    label: "Repository catalog responsive and recoverable states",
    patterns: [
      /QueryStatePanel/,
      /role="status" aria-live="polite"/,
      /md:hidden/,
      /aria-label=\{`Archive \$\{repository\.displayName\}`\}/,
      /pending=\{archive\.isPending\}/,
    ],
  },
  {
    file: "app/projects/repositories/[id]/page.tsx",
    label: "Repository detail delivery and activity feedback",
    patterns: [
      /Partial repository delivery/,
      /DeliveryCard/,
      /Retry activity/,
      /repository\.visibility/,
      /could not be copied/,
    ],
  },
  {
    file: "components/repository-form-dialog.tsx",
    label: "Repository form validation and discard protection",
    patterns: [
      /ConfirmDialog/,
      /aria-invalid=\{Boolean\(fieldErrors\.host\)\}/,
      /role="alert"/,
      /Discard repository changes/,
      /secretEndpointPattern/,
      /autoFocus/,
    ],
  },
  {
    file: "components/repository-links.tsx",
    label: "Repository linking partial success and retry feedback",
    patterns: [
      /Promise\.allSettled/,
      /Successful links were preserved/,
      /Search repositories to link/,
      /Remove repository from Task scope/,
      /links\.refetch/,
      /catalog\.refetch/,
    ],
  },
];

const failures = [];

for (const check of checks) {
  const fullPath = resolve(webRoot, check.file);
  const source = readFileSync(fullPath, "utf8");

  for (const pattern of check.patterns) {
    if (!pattern.test(source)) {
      failures.push(`${check.label}: ${check.file} is missing ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Interaction regression checks failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Interaction regression checks passed (${checks.length} surfaces).`);
