"use client";
import { useState } from "react";
import type { AuthorizationGrant } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type NamedGrant = { grant: AuthorizationGrant; label: string };
export const grantId = (grant: AuthorizationGrant) => grant.scope === "project" ? `project:${grant.projectId}` : grant.scope === "personal" ? `personal:${grant.actorId}` : grant.scope;
export function KeyGrantPicker({ actorId, selected, onChange, disabled = false }: { actorId: string; selected: NamedGrant[]; onChange: (items: NamedGrant[]) => void; disabled?: boolean }) {
  const utils = trpc.useUtils();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const options = trpc.apiKey.pagedGrantOptions.useQuery({ actorId, query, page, pageSize: 20 });
  disabled = disabled || bulkBusy;
  const items = options.data?.items ?? [];
  function toggle(items: NamedGrant[], checked: boolean) {
    const next = new Map(selected.map(item => [grantId(item.grant), item]));
    for (const item of items) {
      if (checked) next.set(grantId(item.grant), item);
      else next.delete(grantId(item.grant));
    }
    onChange([...next.values()]);
  }
  async function selectMatching(search: string) {
    setBulkBusy(true); setBulkError("");
    try {
      const collected: NamedGrant[] = [];
      for (let current = 1; ; current++) {
        const result = await utils.apiKey.pagedGrantOptions.fetch({ actorId, query: search, page: current, pageSize: 20 });
        collected.push(...result.items);
        if (new Set([...selected, ...collected].map(item => grantId(item.grant))).size > 100) throw new Error("The matching selection exceeds 100 scopes. Narrow the search or select individual scopes.");
        if (!result.hasNext) break;
      }
      toggle(collected, true);
    } catch (error) { setBulkError(error instanceof Error ? error.message : "Unable to load eligible scopes."); }
    finally { setBulkBusy(false); }
  }
  const count = selected.reduce((sum, item) => sum + item.grant.permissions.length, 0);
  const pageCount = items.reduce((sum, item) => sum + item.grant.permissions.filter(permission => selected.find(value => grantId(value.grant) === grantId(item.grant))?.grant.permissions.includes(permission)).length, 0);
  const pageTotal = items.reduce((sum, item) => sum + item.grant.permissions.length, 0);
  return <div className="space-y-3">
    <p className="text-sm">{selected.length} scopes · {count} permissions selected. Maximum 100 explicit scopes per Key; future projects are never included.</p>
    <Input aria-label="Search permission scopes" placeholder="Search authorized project or scope names" value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); setPage(1); }} />
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label="Select all permissions on this page" disabled={disabled || !pageTotal} checked={pageTotal > 0 && pageCount === pageTotal} ref={node => { if (node) node.indeterminate = pageCount > 0 && pageCount < pageTotal; }} onChange={event => toggle(items, event.target.checked)} />This page ({pageCount}/{pageTotal})</label>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => toggle(items, false)}>Clear this page</Button>
      <Button type="button" variant="outline" disabled={disabled || !selected.length} onClick={() => onChange([])}>Clear all selections</Button>
    </div>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled} onClick={() => void selectMatching(query)}>Select all matching scopes</Button><Button type="button" variant="outline" disabled={disabled} onClick={() => void selectMatching("")}>Select all eligible scopes</Button></div>
    <p className="text-xs text-muted-foreground">Matching uses the current name filter across pages. Eligible ignores the filter. Both fetch current finite permissions on demand; selections stay explicit across pages.</p>
    {bulkError && <p role="alert">{bulkError}</p>}
    {options.error && <p role="alert">Authorized scopes could not be loaded. Retry or refresh before saving.</p>}
    {options.isFetching && <p role="status">Loading authorized scopes…</p>}
    {!options.isFetching && !items.length && <p>No matching authorized scopes.</p>}
    {items.map(item => {
      const current = selected.find(value => grantId(value.grant) === grantId(item.grant));
      const permissions = current?.grant.permissions ?? [];
      return <details key={grantId(item.grant)} className="min-w-0 rounded-md border bg-muted/30 p-3">
        <summary className="cursor-pointer break-words text-sm">{item.label} · {permissions.length}/{item.grant.permissions.length} selected</summary>
        <p className="my-2 break-all text-xs text-muted-foreground">{grantId(item.grant)}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label={`All permissions for ${item.label}`} disabled={disabled} checked={item.grant.permissions.every(permission => permissions.includes(permission))} ref={node => { if (node) node.indeterminate = permissions.length > 0 && !item.grant.permissions.every(permission => permissions.includes(permission)); }} onChange={event => toggle([item], event.target.checked)} />All in this scope</label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{item.grant.permissions.map(permission => <label key={permission} className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-primary" disabled={disabled} checked={permissions.includes(permission)} onChange={event => {
          const next = event.target.checked ? [...new Set([...permissions, permission])] : permissions.filter(value => value !== permission);
          const others = selected.filter(value => grantId(value.grant) !== grantId(item.grant));
          onChange(next.length ? [...others, { ...item, grant: { ...item.grant, permissions: next } }] : others);
        }} />{permission.replaceAll(".", " ")}</label>)}</div>
      </details>;
    })}
    <nav aria-label="Permission pages" className="flex items-center gap-2"><Button type="button" variant="outline" disabled={disabled || page === 1 || options.isFetching} onClick={() => setPage(page - 1)}>Previous scopes</Button><span>Page {page}</span><Button type="button" variant="outline" disabled={disabled || !options.data?.hasNext || options.isFetching} onClick={() => setPage(page + 1)}>Next scopes</Button></nav>
    {selected.length > 100 && <p role="alert">This selection exceeds the existing 100-scope limit. Remove scopes before saving.</p>}
    <details><summary className="cursor-pointer text-sm">Review all selected scopes ({selected.length})</summary><ul className="space-y-2 text-xs">{selected.map(item => <li className="break-words" key={grantId(item.grant)}>{item.label} <span className="break-all">({grantId(item.grant)})</span>: {item.grant.permissions.join(", ")} <button type="button" disabled={disabled} className="underline" onClick={() => toggle([item], false)}>Remove {item.label}</button></li>)}</ul></details>
  </div>;
}
