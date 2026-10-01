import { cookies, headers } from "next/headers";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { RealtimeProvider } from "@/components/realtime-provider";
import { AssistantDialog } from "@/components/assistant-dialog";
import { WebIdentityProvider } from "@/components/web-identity-provider";
import { navigation } from "@/lib/navigation";
import { resolveActor } from "@task-weaver/contracts";

export default async function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const actor = resolveActor(Object.fromEntries(requestHeaders.entries()));
  const sidebarState = cookieStore.get("sidebar_state")?.value;
  const defaultSidebarOpen = sidebarState == null ? true : sidebarState === "true";

  return (
    <WebIdentityProvider actor={actor}>
      <SidebarProvider defaultOpen={defaultSidebarOpen}>
        <AppSidebar navigation={navigation} />
        <SidebarInset className="pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-20">
          <RealtimeProvider>
            {children}
            <div className="fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 md:right-4 md:bottom-4">
              <AssistantDialog contextKind="global" label="Chat" triggerClassName="shadow-md" />
            </div>
          </RealtimeProvider>
        </SidebarInset>
      </SidebarProvider>
    </WebIdentityProvider>
  );
}
