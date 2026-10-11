import { createAttachmentHandler } from "@/lib/attachment-handler";
import { getWebAuthenticationRuntime } from "@/trpc/init";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function transfer(request: Request, context: { params: Promise<{ id: string }> }) {
  return createAttachmentHandler(getWebAuthenticationRuntime)(request, (await context.params).id);
}
export const GET = transfer;
export const PUT = transfer;
