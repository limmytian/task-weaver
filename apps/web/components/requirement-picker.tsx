"use client";

import { useState } from "react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryStatePanel } from "@/components/query-state-panel";

/** Mounted only while a free-choice selector is open; every matching page remains reachable. */
export function RequirementPicker({ projectId, value, onValueChange, invalid, allowAll = false, includeCancelled = false, includeHistory = false }: {
  projectId: string;
  value: string;
  onValueChange: (id: string) => void;
  invalid: boolean;
  allowAll?: boolean;
  includeCancelled?: boolean;
  includeHistory?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null);
  const result = trpc.requirement.listSummary.useQuery({ projectId, query: query || undefined,
    excludeStatus: includeCancelled ? undefined : "cancelled", completedWithinDays: includeHistory ? 0 : undefined, page, pageSize: 20 });
  const pageCount = Math.max(1, result.data?.pageCount ?? 1);
  // A realtime deletion/filter change can shrink the last page; retain the task draft and selection.
  if (result.data && page > pageCount) setPage(pageCount);
  const currentSelection = selected?.id === value ? selected : null;
  const items = result.data?.items ?? [];
  const pinnedSelection = currentSelection && !items.some(item => item.id === currentSelection.id) ? currentSelection : null;
  const options = pinnedSelection ? [pinnedSelection, ...items] : items;
  const searchRequirements = () => { setQuery(search.trim()); setPage(1); };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input aria-label="Search requirements" placeholder="Search requirements" value={search}
          maxLength={500} onChange={event => setSearch(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!event.nativeEvent.isComposing) searchRequirements();
            }
          }} />
        <Button type="button" variant="outline" onClick={searchRequirements}>Search</Button>
      </div>
      <Select value={value} onValueChange={id => {
        const item = options.find(option => option.id === id);
        if (item) setSelected({ id: item.id, title: item.title });
        onValueChange(id);
      }} disabled={result.isPending || result.isError}>
        <SelectTrigger aria-label="Requirement" aria-invalid={invalid}>
          <SelectValue placeholder={result.isPending ? "Loading requirements..." : "Select a requirement..."} />
        </SelectTrigger>
        <SelectContent>
          {allowAll && <SelectItem value="__all__">All Requirements</SelectItem>}
          {options.map(item => <SelectItem key={item.id} value={item.id}>
            {item.title}{pinnedSelection?.id === item.id ? " (selected)" : ""}
          </SelectItem>)}
          {!items.length && <div className="px-2 py-3 text-sm text-muted-foreground">No matching requirements.</div>}
        </SelectContent>
      </Select>
      {result.isError ? <QueryStatePanel title="Requirements could not be loaded" onAction={() => result.refetch()} /> : (
        <nav aria-label="Requirement pages" className="flex items-center justify-between gap-2 text-xs">
          <Button type="button" variant="outline" size="sm" disabled={page <= 1 || result.isFetching}
            onClick={() => setPage(current => current - 1)}>Previous</Button>
          <span aria-live="polite">{result.data ? `${result.data.total} matching · Page ${page} of ${pageCount}` : "Loading..."}</span>
          <Button type="button" variant="outline" size="sm" disabled={!result.data || page >= pageCount || result.isFetching}
            onClick={() => setPage(current => current + 1)}>Next</Button>
        </nav>
      )}
    </div>
  );
}
