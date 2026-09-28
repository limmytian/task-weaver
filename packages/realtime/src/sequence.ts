/** Decide whether a sequenced event can be applied after a reconnect. */
export function acceptRealtimeSequence(lastSequence: number, nextSequence: number) {
  if (nextSequence <= lastSequence) return { accepted: false, missed: false };
  return {
    accepted: true,
    missed: lastSequence > 0 && nextSequence > lastSequence + 1,
  };
}
