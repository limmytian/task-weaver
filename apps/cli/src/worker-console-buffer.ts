import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { consoleLimits, type ConsoleBatch, type ConsoleFrame } from '@task-weaver/contracts';

type Stream = ConsoleFrame['stream'];
/** Only diagnostic text enters the volatile ring. Raw structured records never leave this parser. */
export class WorkerConsoleBuffer {
  private readonly captureId = randomUUID();
  private frames: Array<ConsoleFrame & { at: number; bytes: number }> = [];
  private bytes = 0;
  private sequence = 1;
  private lost = false;
  private unavailable = false;
  private closed = false;
  private decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private pending = { stdout: '', stderr: '' };
  private record = '';
  private dropping = false;
  private terminal: Record<Stream, 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape'> = { stdout: 'text', stderr: 'text' };
  constructor(private readonly tool: string, private readonly secrets: () => readonly string[], private readonly now = Date.now) { this.unavailable = tool !== 'codex'; }

  push(stream: Stream, chunk: Buffer) {
    if (this.closed) return;
    if (this.tool !== 'codex') { this.unavailable = true; return; }
    // Bound temporary decoding/allocation even for a producer's unusually large write.
    for (let offset = 0; offset < chunk.length; offset += consoleLimits.frameBytes) {
      const text = this.decoders[stream].write(chunk.subarray(offset, offset + consoleLimits.frameBytes));
      if (stream === 'stderr') this.append(stream, text);
      else for (const char of text) {
        if (char === '\n') {
          if (!this.dropping && this.record) this.parseRecord(this.record);
          this.record = ''; this.dropping = false;
        } else if (!this.dropping) {
          this.record += char;
          if (this.record.length > 64 * 1024) { this.record = ''; this.dropping = true; this.unavailable = true; this.lost = true; }
        }
      }
    }
  }
  private parseRecord(line: string) {
    try {
      const event = JSON.parse(line);
      if (event.type !== 'item.completed') return;
      const item = event.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') this.append('stdout', item.text + '\n');
      else if (item?.type === 'command_execution' && typeof item.aggregated_output === 'string') this.append('stdout', item.aggregated_output);
    } catch { this.unavailable = true; }
  }
  private append(stream: Stream, text: string) {
    const secrets = this.secrets().filter(Boolean);
    if (secrets.length > 256 || secrets.some(s => s.length > 8192)) { this.unavailable = true; return; }
    let value = this.pending[stream] + text;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[redacted]');
    let hold = 0;
    for (const secret of secrets) for (let n = Math.min(secret.length - 1, value.length); n > hold; n--) {
      if (value.endsWith(secret.slice(0, n))) { hold = n; break; }
    }
    this.pending[stream] = hold ? value.slice(-hold) : '';
    value = hold ? value.slice(0, -hold) : value;
    let safe = '';
    for (const char of value) {
      const state = this.terminal[stream];
      if (state === 'escape') { this.terminal[stream] = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text'; continue; }
      if (state === 'csi') { if (char >= '@' && char <= '~') this.terminal[stream] = 'text'; continue; }
      if (state === 'osc') { if (char === '\x07') this.terminal[stream] = 'text'; else if (char === '\x1b') this.terminal[stream] = 'oscEscape'; continue; }
      if (state === 'oscEscape') { this.terminal[stream] = char === '\\' ? 'text' : 'osc'; continue; }
      if (char === '\x1b') { this.terminal[stream] = 'escape'; continue; }
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(char)) continue;
      safe += char;
    }
    let frame = ''; let bytes = 0;
    const flush = () => {
      if (!frame) return;
      this.frames.push({ stream, text: frame, sequence: this.sequence++, at: this.now(), bytes });
      this.bytes += bytes; frame = ''; bytes = 0;
    };
    for (const char of safe) {
      const size = Buffer.byteLength(char);
      if (bytes + size > consoleLimits.frameBytes) flush();
      frame += char; bytes += size;
    }
    flush(); this.prune();
  }
  private prune() {
    while (this.frames.length && (this.bytes > consoleLimits.ringBytes || this.frames.length > consoleLimits.frames || this.frames[0]!.at < this.now() - consoleLimits.ringAgeMs)) {
      this.bytes -= this.frames.shift()!.bytes; this.lost = true;
    }
  }
  snapshot(after: number, revision: number): ConsoleBatch {
    this.prune();
    const firstSequence = this.frames[0]?.sequence ?? this.sequence;
    const frames: ConsoleFrame[] = []; let bytes = 0;
    for (const frame of this.frames) {
      if (frame.sequence <= after) continue;
      if (bytes + frame.bytes > consoleLimits.batchBytes) break;
      frames.push({ sequence: frame.sequence, stream: frame.stream, text: frame.text }); bytes += frame.bytes;
    }
    return { revision, captureId: this.captureId, frames, firstSequence, nextSequence: frames.length ? frames[frames.length - 1]!.sequence + 1 : Math.max(after + 1, firstSequence), truncated: this.lost || after > 0 && after + 1 < firstSequence, unavailable: this.unavailable || this.closed };
  }
  close() {
    this.closed = true; this.frames = []; this.bytes = 0; this.record = '';
    this.pending = { stdout: '', stderr: '' };
    this.decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  }
}
