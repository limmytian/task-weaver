import { APPLICATION_VERSION, RELEASES_URL, versionStatusSchema, type VersionStatus } from "@task-weaver/contracts";

const API_URL = "https://api.github.com/repos/limmytian/task-weaver/releases/latest";
const PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function parseVersion(input: string) {
  const match = PATTERN.exec(input);
  if (!match || match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error("Invalid semantic version");
  return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") };
}
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    if (numericX !== numericY) return numericX ? -1 : 1;
    return numericX ? (BigInt(x) > BigInt(y) ? 1 : -1) : (x > y ? 1 : -1);
  }
  return 0;
}
export function installedBuild(environment: NodeJS.ProcessEnv = process.env): VersionStatus["installed"] {
  const commit = /^[a-f0-9]{40}$/.test(environment.TW_BUILD_COMMIT ?? "") ? environment.TW_BUILD_COMMIT! : null;
  return { version: APPLICATION_VERSION, commit, development: environment.NODE_ENV !== "production" || !commit };
}
export function createVersionChecker(options: { fetch?: typeof fetch; now?: () => number; enabled?: () => boolean; installed?: () => VersionStatus["installed"] } = {}) {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? (() => process.env.TW_VERSION_CHECK_ENABLED !== "false");
  const installed = options.installed ?? installedBuild;
  let cached: VersionStatus | null = null;
  let pending: Promise<VersionStatus> | null = null;
  let expires = 0;
  const initial = (status: "disabled" | "not_checked"): VersionStatus => ({ installed: installed(), status, latest: null, checkedAt: null, nextCheckAt: null, releasesUrl: RELEASES_URL });
  const info = () => enabled() ? cached ?? initial("not_checked") : initial("disabled");
  async function perform(): Promise<VersionStatus> {
    const start = now();
    const result = initial("not_checked");
    result.checkedAt = new Date(start).toISOString();
    let ttl = 60_000;
    try {
      const response = await request(API_URL, { signal: AbortSignal.timeout(5000), redirect: "error", headers: { Accept: "application/vnd.github+json", "User-Agent": "Task-Weaver-Version-Check" } });
      if (response.status === 403 || response.status === 429) {
        result.status = "rate_limited";
        ttl = 300_000;
        await response.body?.cancel();
      } else {
        if (!response.ok) { await response.body?.cancel(); throw new Error("Release source unavailable"); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing response body");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65_536) throw new Error("Release response exceeds limit");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel(); }
        const release = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") throw new Error("Stable release required");
        const version = release.tag_name.replace(/^v/, "");
        if (parseVersion(version).prerelease) throw new Error("Prerelease rejected");
        const url = `${RELEASES_URL}/tag/v${version}`;
        if (release.html_url !== url) throw new Error("Unexpected release link");
        const comparison = compareVersions(result.installed.version, version);
        result.status = comparison < 0 ? "update_available" : comparison > 0 ? "ahead" : "current";
        result.latest = { version, url, publishedAt: typeof release.published_at === "string" && Number.isFinite(Date.parse(release.published_at)) ? release.published_at : null };
        ttl = 300_000;
      }
    } catch { result.status = "unavailable"; }
    expires = start + ttl;
    result.nextCheckAt = new Date(expires).toISOString();
    cached = versionStatusSchema.parse(result);
    return cached;
  }
  return { info, check: async () => {
    if (!enabled()) return initial("disabled");
    if (pending) return pending;
    if (cached && now() < expires) return cached;
    pending = perform();
    try { return await pending; } finally { pending = null; }
  } };
}
export const versionChecker = createVersionChecker();
