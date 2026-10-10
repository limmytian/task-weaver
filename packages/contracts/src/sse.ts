/** Incremental SSE framing, shared by provider and browser transports. */
export class SseDecoder {
  private pending = "";
  private data: string[] = [];
  private size = 0;
  constructor(private readonly maxEventSize = 1_048_576) {}
  push(text: string): string[] {
    this.pending += text;
    if (this.pending.length + this.size > this.maxEventSize) throw new Error("SSE event exceeds its size limit");
    const events: string[] = [];
    let position: number;
    while ((position = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, position).replace(/\r$/, "");
      this.pending = this.pending.slice(position + 1);
      if (!line) {
        if (this.data.length) events.push(this.data.join("\n"));
        this.data = []; this.size = 0;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.data.push(value); this.size += value.length;
      }
    }
    return events;
  }
  finish() {
    if (this.pending.trim() || this.data.length) throw new Error("SSE stream ended with an incomplete event");
  }
}
