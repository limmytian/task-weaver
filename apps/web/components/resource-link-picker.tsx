"use client";

import { useState } from "react";
import { z } from "zod";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryStatePanel } from "@/components/query-state-panel";

const entry = z.object({ id: z.string().uuid(), title: z.string(), status: z.string() });
const pageSchema = z.object({ items: z.array(entry), total: z.number(), pageCount: z.number() });

/** Each matching page remains reachable; unavailable entries are explicit rather than silently filtered. */
export function ResourceLinkPicker({ kind, projectId, value, onValueChange, linkedIds }: {
  kind: "task" | "requirement"; projectId: string; value: string;
  onValueChange: (id: string) => void; linkedIds: ReadonlySet<string>;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<z.infer<typeof entry> | null>(null);
  const tasks = trpc.task.list.useQuery({ projectId, view: "summary", page, pageSize: 20,
    query: query || undefined, completedWithinDays: 0 }, { enabled: kind === "task" });
  const requirements = trpc.requirement.listSummary.useQuery({ projectId, page, pageSize: 20,
    query: query || undefined }, { enabled: kind === "requirement" });
  const result = kind === "task" ? tasks : requirements;
  const parsed = result.data === undefined ? undefined : pageSchema.safeParse(result.data);
  const data = parsed?.success ? parsed.data : undefined;
  const pageCount = Math.max(1, data?.pageCount ?? 1);
  if (data && page > pageCount) setPage(pageCount);
  const rows = data?.items ?? [];
  const options = selection?.id === value && !rows.some(row => row.id === value) ? [selection, ...rows] : rows;
  const submitSearch = () => { setQuery(search.trim()); setPage(1); };
  return <div className="space-y-2">
    <div className="flex gap-2">
      <Input aria-label={`Search ${kind}s`} placeholder={`Search ${kind}s`} maxLength={500}
        value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); if (!event.nativeEvent.isComposing) submitSearch(); }
        }} />
      <Button type="button" variant="outline" onClick={submitSearch}>Search</Button>
    </div>
    <Select value={value} disabled={!data || result.isError} onValueChange={id => {
      setSelection(options.find(row => row.id === id) ?? null); onValueChange(id);
    }}>
      <SelectTrigger aria-label={`Select ${kind}`}><SelectValue placeholder={`Select ${kind}...`} /></SelectTrigger>
      <SelectContent>{options.map(row => <SelectItem key={row.id} value={row.id}
        disabled={row.status === "cancelled" || linkedIds.has(row.id)}>
        {row.title}{linkedIds.has(row.id) ? " (already linked)" : row.status === "cancelled" ? " (cancelled)" : ""}
      </SelectItem>)}</SelectContent>
    </Select>
    {result.isError || parsed && !parsed.success ? <QueryStatePanel title={`${kind} options could not be loaded`}
      onAction={() => result.refetch()} /> : <nav aria-label={`${kind} option pages`} className="flex items-center justify-between gap-2 text-xs">
      <Button type="button" size="sm" variant="outline" disabled={page <= 1 || result.isFetching}
        onClick={() => setPage(current => current - 1)}>Previous</Button>
      <span aria-live="polite">{data ? `${data.total} matching · Page ${page} of ${pageCount}` : "Loading..."}</span>
      <Button type="button" size="sm" variant="outline" disabled={!data || page >= pageCount || result.isFetching}
        onClick={() => setPage(current => current + 1)}>Next</Button>
    </nav>}
  </div>;
}
