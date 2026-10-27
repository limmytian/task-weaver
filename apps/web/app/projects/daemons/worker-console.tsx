'use client';

import { useEffect, useRef, useState } from 'react';
import { consoleBatchSchema, type ConsoleFrame, type ConsoleTarget } from '@task-weaver/contracts';
import { appendConsoleFrames, visibleConsoleText } from './console-view';
import { Button } from '@/components/ui/button';

export function WorkerConsole({ target }: { target: ConsoleTarget }) {
  const [open, setOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('all');
  const [frames, setFrames] = useState<ConsoleFrame[]>([]);
  const [status, setStatus] = useState('Closed');
  const [notice, setNotice] = useState('Only recent retained output is available. Silence does not mean the worker is stuck.');
  const tail = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const { requirementId, taskId, runId, workerIndex, leaseGeneration } = target;
  useEffect(() => {
    if (!open) return;
    const current = ++epoch.current;
    let closed = false; let id: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    let csrf: string | undefined; let previous = 0;
    const call = async (path: string, body: unknown, keepalive = false) => {
      if (!csrf) {
        const response = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Console authentication unavailable');
        csrf = (await response.json()).csrfToken;
      }
      const response = await fetch(`/api/worker-console/${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf! }, body: JSON.stringify(body), signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Access ended; output cleared' : response.status === 404 ? 'Expired, stopped or history unavailable; reopen to request the current run' : 'Disconnected or unavailable; reopen to request recent output');
      return response.json();
    };
    const cancel = () => { if (id) void call(`${id.split('.')[0]}/${id}/cancel`, {}, true).catch(() => {}); };
    const stop = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); cancel(); };
    const hide = () => { if (document.visibilityState === 'hidden') { stop(); setOpen(false); setStatus('Closed while page hidden'); } };
    window.addEventListener('pagehide', stop); document.addEventListener('visibilitychange', hide);
    queueMicrotask(() => { if (!closed) { setFrames([]); setStatus('Requesting recent output'); setNotice('Only recent retained output is available. Silence does not mean the worker is stuck.'); } });
    const read = async () => {
      try {
        if (closed) return;
        if (!id) {
          const result = await call('open', { requirementId, taskId, runId, workerIndex, leaseGeneration, follow }); id = result.id;
          if (closed) { cancel(); return; }
        }
        const result = await call(`${id!.split('.')[0]}/${id}/read`, { follow });
        if (closed || epoch.current !== current) return;
        if (result.batch) {
          const batch = consoleBatchSchema.parse(result.batch);
          if (batch.truncated || batch.frames.length && previous && batch.frames[0]!.sequence !== previous + 1) setNotice('Output gap or truncated prefix: older output is unavailable.');
          if (batch.unavailable) setNotice('Some output was not retained or its provider format is unsupported. No complete transcript is available.');
          if (batch.frames.length) previous = batch.frames[batch.frames.length - 1]!.sequence;
          setFrames(old => {
            return appendConsoleFrames(old, batch.frames).frames;
          });
          setStatus(batch.frames.length ? 'Connected' : 'Connected · no new output');
          if (!follow) { setStatus('Recent snapshot received'); stop(); return; }
        } else setStatus(result.state === 'requesting' ? 'Waiting for daemon · request times out if offline' : 'Waiting for next batch');
        timer = setTimeout(() => { void read(); }, 1000);
      } catch (error) {
        if (closed || epoch.current !== current) return;
        setFrames([]); setStatus(error instanceof Error ? error.message : 'Console unavailable');
        setNotice('Connection ended. Reopening makes a fresh authorized request; a gap may remain.'); stop();
      }
    };
    void read();
    return () => { stop(); window.removeEventListener('pagehide', stop); document.removeEventListener('visibilitychange', hide); };
  }, [open, follow, requirementId, taskId, runId, workerIndex, leaseGeneration]);
  useEffect(() => { if (!paused) tail.current?.scrollIntoView({ block: 'nearest' }); }, [frames, paused]);
  const visible = visibleConsoleText(frames, filter);
  return <section className="mt-3 space-y-2 rounded border bg-background p-2 text-xs" aria-label="Worker console">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => { setOpen(!open); if (open) { setStatus('Stopped'); setFrames([]); } }}> {open ? 'Stop / close console' : 'Open recent console'} </Button>
      <label><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> Follow live</label>
      <label><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} /> Pause scrolling</label>
      <select aria-label="Output stream" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All streams</option><option value="stdout">stdout</option><option value="stderr">stderr</option></select>
      <Button size="sm" variant="ghost" disabled={!visible} onClick={() => { void navigator.clipboard.writeText(visible).catch(() => setStatus('Copy unavailable')); }}>Copy visible output</Button>
    </div>
    <p role="status">{status}</p>
    <p className="text-muted-foreground">{frames[0] && frames[0].sequence > 1 ? 'Output prefix is missing or was dropped from the bounded display.' : notice}</p>
    <p className="break-all text-muted-foreground">Run {target.runId} · follow ends after 15 minutes; reopen to continue. Pausing scrolling does not pause the worker.</p>
    {(open || frames.length > 0) && <div className="max-h-72 overflow-auto rounded bg-muted p-2"><ConsoleOutput text={visible} /><div ref={tail} /></div>}
  </section>;
}

export function ConsoleOutput({ text }: { text: string }) {
  return <pre className="whitespace-pre-wrap break-all" aria-label="Console output">{text}</pre>;
}
