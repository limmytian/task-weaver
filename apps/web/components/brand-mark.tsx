import { useId } from "react";
import { cn } from "@/lib/utils";

/** Decorative when accompanied by product text; name standalone links separately. */
export function BrandMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={cn("shrink-0", className)}>
      <defs>
        <mask id={`${id}-first`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="white" />
          <path d="M34 42h16" stroke="black" strokeWidth="12" />
        </mask>
        <mask id={`${id}-second`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="white" />
          <path d="M14 22h16" stroke="black" strokeWidth="12" />
        </mask>
      </defs>
      <g fill="none" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22h22q8 0 8 8v22" stroke="var(--primary)" mask={`url(#${id}-first)`} />
        <path d="M22 12v22q0 8 8 8h22" stroke="var(--brand-secondary)" mask={`url(#${id}-second)`} />
      </g>
    </svg>
  );
}
