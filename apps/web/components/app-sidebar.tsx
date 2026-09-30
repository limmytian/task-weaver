"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Brain,
  CalendarClock,
  Cpu,
  FileText,
  FolderKanban,
  Inbox,
  LayoutDashboard,
  Pin,
  Puzzle,
  Search,
  Server,
  Settings,
  WandSparkles,
  GitFork,
  type LucideIcon,
} from "lucide-react";
import { trpc } from "@/trpc/client";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import type { VisibleWebNavigationItem } from "@/lib/web-extension-types";

const navigationIcons: Readonly<Record<string, LucideIcon>> = {
  agent: WandSparkles,
  brain: Brain,
  cpu: Cpu,
  document: FileText,
  inbox: Inbox,
  layout: LayoutDashboard,
  puzzle: Puzzle,
  repository: GitFork,
  search: Search,
  server: Server,
  settings: Settings,
};

export function AppSidebar({ navigation }: { navigation: readonly VisibleWebNavigationItem[] }) {
  const pathname = usePathname();
  const { data: pinnedProjects } = trpc.project.pinned.useQuery();

  const projectMatch = pathname.match(/^\/projects\/([a-f0-9-]{36})/);
  const currentProjectId = projectMatch?.[1];

  const pinned = pinnedProjects ?? [];
  const pinnedCurrentProject = pinned.find((project) => project.id === currentProjectId);
  const { data: currentProject } = trpc.project.get.useQuery(
    { id: currentProjectId ?? "" },
    { enabled: Boolean(currentProjectId) && !pinnedCurrentProject },
  );
  const activeProject = pinnedCurrentProject ?? currentProject;
  const currentProjectHref = currentProjectId ? `/projects/${currentProjectId}` : undefined;
  const isProjectWorkspace = Boolean(currentProjectId);

  const isNavActive = (href: string) => {
    if (href === "/projects") {
      return pathname === "/projects" || isProjectWorkspace;
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b px-4 py-3 group-data-[collapsible=icon]:px-2">
        <Link href="/projects" className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <FolderKanban className="h-5 w-5" />
          <span className="text-lg font-bold tracking-tight group-data-[collapsible=icon]:hidden">Task Weaver</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => {
                const Icon = navigationIcons[item.icon ?? ""] ?? Puzzle;
                return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isNavActive(item.href)}
                    tooltip={item.label}
                  >
                    <Link href={item.href}>
                      <Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {currentProjectHref && activeProject && (
          <SidebarGroup>
            <SidebarGroupLabel>Current Project</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      pathname === currentProjectHref ||
                      pathname.startsWith(`${currentProjectHref}/requirements`)
                    }
                    tooltip={activeProject.name}
                  >
                    <Link href={currentProjectHref}>
                      <FolderKanban className="h-4 w-4" />
                      <span className="truncate">{activeProject.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === `${currentProjectHref}/schedules`}
                    tooltip="Schedules"
                  >
                    <Link href={`${currentProjectHref}/schedules`}>
                      <CalendarClock className="h-4 w-4" />
                      <span>Schedules</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {pinned.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>
              <Pin className="mr-1 h-3 w-3" />
              Pinned Projects
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinned.map((project) => (
                  <SidebarMenuItem key={project.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={currentProjectId === project.id}
                      tooltip={project.name}
                    >
                      <Link href={`/projects/${project.id}`}>
                        <Pin className="h-4 w-4" />
                        <span className="truncate">{project.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t px-4 py-3 group-data-[collapsible=icon]:px-2">
        <div className="flex items-center justify-between group-data-[collapsible=icon]:justify-center">
          <span className="text-sm font-medium group-data-[collapsible=icon]:hidden">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
