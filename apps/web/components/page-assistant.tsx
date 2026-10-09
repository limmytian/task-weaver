"use client";

import { usePathname } from "next/navigation";
import { AssistantDialog } from "./assistant-dialog";
import { assistantPageContext } from "@/lib/assistant-page-context";

export function PageAssistant() {
  const context = assistantPageContext(usePathname());
  // Scope changes start a new conversation instead of reusing an incompatible history.
  return <AssistantDialog key={context.projectId ?? "global"} {...context} label="Chat" triggerClassName="shadow-md" />;
}
