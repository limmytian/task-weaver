import { createAttachmentHandler } from "@/lib/attachment-handler";
import { getWebAuthenticationRuntime } from "@/trpc/init";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => createAttachmentHandler(getWebAuthenticationRuntime)(request);
