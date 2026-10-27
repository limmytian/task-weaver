import { consoleLimits, type ConsoleFrame } from '@task-weaver/contracts';
export function appendConsoleFrames(current: ConsoleFrame[], incoming: ConsoleFrame[]) {
  const frames = [...current, ...incoming];
  const encoder = new TextEncoder();
  let bytes = frames.reduce((n, frame) => n + encoder.encode(frame.text).length, 0);
  let dropped = false;
  while (frames.length && (frames.length > consoleLimits.frames || bytes > consoleLimits.ringBytes)) {
    bytes -= encoder.encode(frames.shift()!.text).length; dropped = true;
  }
  return { frames, dropped };
}
export function visibleConsoleText(frames: ConsoleFrame[], filter: string) {
  return frames.filter(frame => filter === 'all' || frame.stream === filter).map(frame => `[${frame.stream}] ${frame.text}`).join('');
}
