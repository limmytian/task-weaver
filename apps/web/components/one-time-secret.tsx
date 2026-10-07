"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function OneTimeSecret({
  value,
  label,
  onDismiss,
}: {
  value: string;
  label: string;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <label htmlFor="one-time-secret" className="text-sm font-medium">
        {label}
      </label>
      <Input
        id="one-time-secret"
        type={visible ? "text" : "password"}
        value={value}
        readOnly
        autoComplete="off"
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">
        Store or deliver this secret through a trusted channel. It will not be
        shown again after dismissal. Never put it in a URL.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setVisible(!visible)}
        >
          {visible ? "Hide secret" : "Reveal secret"}
        </Button>
        <Button type="button" variant="outline" onClick={onDismiss}>
          Dismiss secret
        </Button>
      </div>
    </div>
  );
}
