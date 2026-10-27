"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Share imported component code only. Props, drafts and resource data stay in each mounted instance. */
export function deferView<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  options: {
    shouldLoad?: (props: Props) => boolean;
    fallback?: (props: Props, failed: boolean, retry: () => void) => ReactNode;
  } = {},
) {
  let imported: ComponentType<Props> | null = null;
  return function DeferredView(props: Props) {
    const [View, setView] = useState<ComponentType<Props> | null>(() => imported);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const enabled = options.shouldLoad?.(props) ?? true;
    useEffect(() => {
      if (!enabled || View) return;
      let active = true;
      load().then(component => {
        imported = component;
        if (active) setView(() => component);
      }, () => { if (active) setFailed(true); });
      return () => { active = false; };
    }, [enabled, attempt, View]);
    const retry = () => { setFailed(false); setAttempt(value => value + 1); };
    // Once loaded, retain the original component instance even when a dialog closes.
    if (View) return <View {...props} />;
    if (!enabled) return null;
    if (options.fallback) return options.fallback(props, failed, retry);
    return failed ? (
      <div role="alert" className="rounded-lg border p-4">
        <p className="text-sm">Unable to load this view.</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={retry}>Retry</Button>
      </div>
    ) : <p role="status" className="p-4 text-sm text-muted-foreground">Loading view...</p>;
  };
}
