"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function CopyErrorDetails() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <button type="button" aria-label="Copy error details" title={copied ? "Copied" : failed ? "Copy failed — select the text to copy" : "Copy error details"}
    className="flex size-7 shrink-0 items-center justify-center rounded border border-current/30 hover:bg-black/10 focus-visible:outline-2"
    onClick={async event => {
      const notification = event.currentTarget.closest("[data-sonner-toast]");
      const text = [notification?.querySelector("[data-title]")?.textContent, notification?.querySelector("[data-description]")?.textContent].filter(Boolean).join("\n");
      try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); }
      catch { setFailed(true); }
    }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button>;
}

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    // Keep toast gestures from stealing text selection or dismissing an open modal.
    <div onPointerDownCapture={event => event.stopPropagation()}>
      <Sonner
        className="toaster group pointer-events-auto [&_[data-title]]:select-text [&_[data-description]]:select-text [&_[data-description]]:max-h-48 [&_[data-description]]:overflow-y-auto [&_[data-description]]:whitespace-pre-wrap [&_[data-icon]]:h-auto"
        style={
          {
            "--normal-bg": "hsl(var(--popover))",
            "--normal-text": "hsl(var(--popover-foreground))",
            "--normal-border": "hsl(var(--border))",
            "--success-bg": "hsl(var(--popover))",
            "--success-text": "hsl(var(--popover-foreground))",
            "--success-border": "hsl(var(--border))",
            "--error-bg": "hsl(var(--destructive))",
            "--error-text": "hsl(var(--destructive-foreground))",
            "--error-border": "hsl(var(--destructive))",
          } as React.CSSProperties
        }
        {...props}
        icons={{ error: <CopyErrorDetails />, ...props.icons }}
      />
    </div>
  );
};

export { Toaster };
