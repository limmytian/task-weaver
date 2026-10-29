import assert from "node:assert/strict";

const apps = ["api", "web"];

/** Tag verified digests while the caller holds the shared publication lock.
 * Cross-image writes are not atomic. Retry failures with the same version and
 * digests; conflicting immutable versions stop before any registry mutation. */
export async function promoteImagePair(adapter, candidate) {
  assert.match(candidate.version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(candidate.version.length <= 128, "Version tag exceeds OCI limits");
  for (const app of apps) {
    assert.match(candidate.digests?.[app] ?? "", /^sha256:[a-f0-9]{64}$/);
  }
  const existing = await adapter.readVersion(candidate.version);
  for (const app of apps) {
    assert.ok(existing[app] === null || existing[app] === candidate.digests[app], `Immutable ${app} tag conflicts`);
  }
  for (const app of apps) {
    if (existing[app] === null) await adapter.writeTag(app, candidate.version, candidate.digests[app]);
  }
  assert.deepEqual(await adapter.readPair(candidate.version), candidate.digests, "Version tag verification failed");
  const latest = await adapter.readVersion("latest");
  for (const app of apps) {
    if (latest[app] !== candidate.digests[app]) await adapter.writeTag(app, "latest", candidate.digests[app]);
  }
  assert.deepEqual(await adapter.readPair(candidate.version), candidate.digests, "Version tag verification failed");
  assert.deepEqual(await adapter.readPair("latest"), candidate.digests, "Latest tag verification failed");
  return { version: candidate.version, digests: candidate.digests };
}
