import { createWorkerConsoleProxy } from '@/lib/worker-console-proxy';
import { getWebAuthenticationRuntime } from '@/trpc/init';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return createWorkerConsoleProxy(getWebAuthenticationRuntime)(request, (await context.params).path);
}
