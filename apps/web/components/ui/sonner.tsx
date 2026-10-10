"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    // Allow focus to enter a notification without the modal immediately pulling it back.
    const allowToastFocus = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-sonner-toaster]")) event.stopPropagation();
    };
    document.addEventListener("focusout", allowToastFocus, true);
    return () => document.removeEventListener("focusout", allowToastFocus, true);
  }, []);
  return (
    // Keep toast gestures from stealing text selection or dismissing an open modal.
    <div onPointerDownCapture={event => event.stopPropagation()} onFocusCapture={event => event.stopPropagation()}>
      <Sonner
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        className="toaster group pointer-events-auto [&_[data-title]]:select-text [&_[data-description]]:select-text [&_[data-description]]:max-h-48 [&_[data-description]]:overflow-y-auto [&_[data-description]]:whitespace-pre-wrap [&_[data-icon]]:h-auto"
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--success-bg": "var(--popover)",
            "--success-text": "var(--popover-foreground)",
            "--success-border": "var(--border)",
            "--error-bg": "var(--popover)",
            "--error-text": "var(--popover-foreground)",
            "--error-border": "var(--destructive)",
          } as React.CSSProperties
        }
        {...props}
      />
    </div>
  );
};

export { Toaster };
