/** A tab-wide boundary shared by HTTP queries, identity checks and event streams. */
export const SESSION_INVALIDATED_EVENT = "tw:session-invalidated";
let invalidated = false;

export function invalidateBrowserSession() {
  if (invalidated || typeof window === "undefined") return;
  invalidated = true;
  window.dispatchEvent(new Event(SESSION_INVALIDATED_EVENT));
  // A full navigation discards the App Router's previous account data too.
  window.location.replace("/login?reason=session-ended");
}

export function announceSessionChange() {
  if (typeof window === "undefined") return;
  const channel = new BroadcastChannel("tw-session");
  channel.postMessage("changed");
  channel.close();
}
