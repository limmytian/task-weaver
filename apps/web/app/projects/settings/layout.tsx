import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Settings } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { SettingsNav } from "./settings-nav";
import { getWebRuntime, resolveWebRequestState } from "@/lib/web-runtime";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const webState = await resolveWebRequestState(getWebRuntime(), await headers());
  return (
    <>
      <header className="flex min-h-14 items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="flex items-center gap-1.5 text-lg font-semibold">
          <Settings className="h-5 w-5 text-muted-foreground" />
          Settings
        </h1>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-5 p-3 sm:p-4 md:grid-cols-[15rem_minmax(0,1fr)] md:p-6">
        <SettingsNav modules={webState.contributions.settings} />
        <main className="min-w-0">{children}</main>
      </div>
    </>
  );
}
