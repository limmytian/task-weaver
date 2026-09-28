"use client";

import Link from "next/link";
import { CalendarClock, ChevronRight, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

type BreadcrumbItem = {
  label: string;
  href?: string;
};

type ProjectWorkspaceLink = {
  key: "workspace" | "schedules";
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
};

export function WorkspaceBreadcrumbs({
  items,
  className,
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex min-w-0 items-center gap-1 text-xs text-muted-foreground", className)}
    >
      {items.map((item, index) => {
        const current = index === items.length - 1;
        return (
          <div key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
            {item.href && !current ? (
              <Link
                href={item.href}
                className="shrink-0 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={cn(
                  "truncate",
                  current && "font-medium text-foreground",
                )}
              >
                {item.label}
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function ProjectWorkspaceLinks({
  projectId,
  active,
  className,
}: {
  projectId: string;
  active: "workspace" | "schedules";
  className?: string;
}) {
  const links: ProjectWorkspaceLink[] = [
    {
      key: "workspace",
      label: "Workspace",
      href: `/projects/${projectId}`,
      icon: LayoutDashboard,
    },
    {
      key: "schedules",
      label: "Schedules",
      href: `/projects/${projectId}/schedules`,
      icon: CalendarClock,
    },
  ];

  return (
    <div className={cn("grid grid-cols-2 items-center gap-1 sm:flex sm:flex-wrap", className)}>
      {links.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={active === item.key ? "page" : undefined}
          className={cn(
            "inline-flex h-10 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors sm:h-8 sm:justify-start",
            active === item.key
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <item.icon className="h-3.5 w-3.5" />
          {item.label}
        </Link>
      ))}
    </div>
  );
}
