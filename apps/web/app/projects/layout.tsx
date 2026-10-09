import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { RealtimeProvider } from "@/components/realtime-provider";
import { PageAssistant } from "@/components/page-assistant";
import { WebIdentityProvider } from "@/components/web-identity-provider";
import { navigation } from "@/lib/navigation";
import {
  AuthenticationError,
  AuthorizationError,
} from "@task-weaver/contracts";
import { resolveWebSession } from "@/lib/authenticated-session";
import { getWebAuthenticationRuntime } from "@/trpc/init";

export default async function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [cookieStore, requestHeaders] = await Promise.all([
    cookies(),
    headers(),
  ]);
  const actor = await (async () => {
    try {
      return await resolveWebSession(
        new Headers(requestHeaders),
        getWebAuthenticationRuntime().auth,
      );
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof AuthorizationError
      )
        redirect("/login");
      throw new Error("Sign-in is unavailable");
    }
  })();
  const sidebarState = cookieStore.get("sidebar_state")?.value;
  const defaultSidebarOpen =
    sidebarState == null ? true : sidebarState === "true";

  return (
    <WebIdentityProvider actor={actor}>
      <SidebarProvider defaultOpen={defaultSidebarOpen}>
        <AppSidebar navigation={navigation} />
        <SidebarInset className="pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-20">
          <RealtimeProvider>
            {children}
            <div className="fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 md:right-4 md:bottom-4">
              <PageAssistant />
            </div>
          </RealtimeProvider>
        </SidebarInset>
      </SidebarProvider>
    </WebIdentityProvider>
  );
}
