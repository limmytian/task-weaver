/** Stop workspace operations when the owning task loses authority. */
export function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    const reason = signal.reason
    throw new Error(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Operation cancelled')
  }
}
