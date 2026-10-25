/** Disposable multi-process console fixture; not an application entry point. */
import { serve } from '@hono/node-server';
import { createDb } from '@task-weaver/db';
import { createApiApplication } from './application';

if (!process.send || !process.env.TW_CONSOLE_FIXTURE_DATABASE_URL) throw new Error('Console fixture requires IPC and an isolated database');
const url = new URL(process.env.TW_CONSOLE_FIXTURE_DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/tw_console_e2e') throw new Error('Console fixture database is not isolated');
const db = createDb(url.href);
let application: ReturnType<typeof createApiApplication> | undefined;
const server = serve({ hostname: '127.0.0.1', port: Number(process.env.TW_CONSOLE_FIXTURE_PORT ?? 0), fetch: request => application ? application.app.fetch(request) : new Response(null, { status: 503 }) }, info => { process.send?.({ type: 'listening', port: info.port }); });
process.on('message', async (message: { type: string; peers?: string }) => {
  if (message.type === 'configure') {
    application = createApiApplication({ db, databaseUrl: url.href, env: { ...process.env, TW_CONSOLE_PEERS: message.peers, TW_PRESET_SKILLS_SYNC: 'disabled' } });
    process.send?.({ type: 'ready' });
  } else if (message.type === 'stop') {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await application?.stop(); await db.$client.end(); process.disconnect();
  }
});
