"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, Key } from "lucide-react";
import { cn } from "@/lib/utils";

const modules = [
  {
    href: "/projects/settings/api-keys",
    title: "API Keys",
    description: "Agent authentication",
    icon: Key,
  },
  {
    href: "/projects/settings/embeddings",
    title: "Embedding Search",
    description: "Semantic retrieval",
    icon: Database,
  },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <aside className="min-w-0">
      <div className="md:sticky md:top-4">
        <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Configuration
        </p>
        <nav className="grid grid-cols-2 gap-2 md:grid-cols-1" aria-label="Settings modules">
          {modules.map((module) => {
            const active = pathname === module.href;
            return (
              <Link
                key={module.href}
                href={module.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 items-start gap-3 rounded-lg border px-3 py-3 transition-colors",
                  active
                    ? "border-primary/30 bg-primary/5 text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <module.icon className={cn("mt-0.5 h-4 w-4 shrink-0", active && "text-primary")} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{module.title}</span>
                  <span className="mt-0.5 hidden text-xs text-muted-foreground sm:block">
                    {module.description}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
