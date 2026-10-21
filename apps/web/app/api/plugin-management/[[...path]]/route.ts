import { createPluginManagementHandler } from "@/lib/plugin-management-handler";
import { getWebAuthenticationRuntime } from "@/trpc/init";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return createPluginManagementHandler(getWebAuthenticationRuntime)(request, (await context.params).path ?? []);
}
export { handle as GET, handle as POST };
