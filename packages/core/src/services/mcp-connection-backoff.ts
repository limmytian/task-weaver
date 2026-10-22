/** Passive retry admission: callers explicitly retry; dispatched tools are never replayed. */
export class McpConnectionBackoff {
  private failures = new Map<string, { attempts: number; retryAt: number }>();
  constructor(private readonly now = Date.now) {}
  assertReady(key: string) {
    if ((this.failures.get(key)?.retryAt ?? 0) > this.now()) throw new Error("MCP connection is cooling down after failure; retry synchronization later");
  }
  failed(key: string) {
    const attempts = Math.min(6, (this.failures.get(key)?.attempts ?? 0) + 1);
    this.failures.delete(key);
    this.failures.set(key, { attempts, retryAt: this.now() + Math.min(30000, 1000 * 2 ** (attempts - 1)) });
    if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
  }
  succeeded(key: string) { this.failures.delete(key); }
}
