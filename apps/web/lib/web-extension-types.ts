import type { ComponentType } from "react";
import type { Actor } from "@task-weaver/contracts";
import type { TaskWeaverModule } from "@task-weaver/module-sdk";

export type WebNavigationIcon =
  | "agent"
  | "brain"
  | "cpu"
  | "document"
  | "inbox"
  | "key"
  | "layout"
  | "puzzle"
  | "repository"
  | "search"
  | "server"
  | "settings"
  | "storage";

export interface WebPageProps {
  actor: Actor;
}

export interface WebPageDescriptor {
  title: string;
  description?: string;
  component: ComponentType<WebPageProps>;
}

export interface WebSettingsDescriptor {
  href: `/${string}`;
  title: string;
  description: string;
  icon?: WebNavigationIcon;
}

export type TaskWeaverWebModule = TaskWeaverModule<
  unknown,
  unknown,
  unknown,
  unknown,
  never,
  unknown,
  unknown,
  unknown,
  WebPageDescriptor,
  WebSettingsDescriptor
>;

export interface VisibleWebNavigationItem {
  id: string;
  label: string;
  href: `/${string}`;
  icon?: string;
}

export interface VisibleWebPage {
  id: string;
  route: `/${string}`;
  page: WebPageDescriptor;
}

export interface VisibleWebSettingsItem extends WebSettingsDescriptor {
  id: string;
}

export interface VisibleWebContributions {
  navigation: readonly VisibleWebNavigationItem[];
  pages: readonly VisibleWebPage[];
  settings: readonly VisibleWebSettingsItem[];
}
