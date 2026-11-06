import { StringDecoder } from 'node:string_decoder'

/** Advisory only: command output can be influenced by the executor. Never retain it. */
export class ThinSandboxDiagnostic {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private skipping = false
  private observed = false

  push(chunk: Buffer) {
    for (const part of this.decoder.write(chunk).split(/(?<=\n)/)) {
      if (this.skipping) { if (part.endsWith('\n')) this.skipping = false; continue }
      this.pending += part
      if (Buffer.byteLength(this.pending) > 64 * 1024) {
        this.pending = ''; this.skipping = !part.endsWith('\n'); continue
      }
      if (part.endsWith('\n')) { this.inspect(this.pending); this.pending = '' }
    }
  }

  private inspect(line: string) {
    try {
      const event = JSON.parse(line)
      const item = event?.item
      if (event?.type !== 'item.completed' || item?.type !== 'command_execution' || typeof item.exit_code !== 'number' || item.exit_code === 0 || typeof item.aggregated_output !== 'string') return
      if (/^bwrap: (?:loopback: Failed RTM_NEWADDR|Failed to make \/ slave|setting up uid map):/m.test(item.aggregated_output)) this.observed = true
    } catch { /* Ignore non-JSON output. */ }
  }

  finish() {
    this.pending += this.decoder.end()
    if (this.pending) this.inspect(this.pending)
    return this.observed ? 'A command reported a possible sandbox initialization failure; inspect the executor session before retrying' : null
  }
}
