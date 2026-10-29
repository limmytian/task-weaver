# Needs attention

Open **Needs attention** in the navigation to inspect shared decisions available to your current identity. These are not personal assignments; use **Personal** for your own tasks.

The workbench groups one item per active requirement, prioritizing recovery decisions over failures, delivered work awaiting review, and blocking dependencies. It includes current evidence revalidation, the latest manual/blocked recovery control, visible failed execution/delivery, review/integration status and task/requirement blockers. Resolving the underlying condition removes or relabels it on refresh. Closed requirements and archived projects leave the list.

Filter by category or project, and use Next/Previous to browse. Each request returns at most 50 items (the page uses 25); project options are independently paginated. Counts describe the current page, not a global pending total. Execution and repository observations require their existing permissions; inaccessible sources are not counted. A failed query shows unknown state and hides cached observations. Read-only users can inspect evidence but must obtain the appropriate existing permissions to decide.

Follow an item's link to the requirement's existing workflow/recovery/dependency panels. Inspect current evidence and revisions there before approving, retrying or recovering. Opening the workbench never performs those actions. Workflow decisions retain server-side authorization and concurrency checks. The list refreshes on focus and every 30 seconds; Refresh requests a fresh observation without changing your filters.
