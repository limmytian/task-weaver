import { createAssistantStreamHandler } from "../../../../lib/assistant-stream-handler";
import { getWebAuthenticationRuntime } from "../../../../trpc/init";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createAssistantStreamHandler(getWebAuthenticationRuntime);
