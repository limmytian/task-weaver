import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function safePath(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.+@/(),=-]+$/.test(value) ||
      value.startsWith("/") || value.startsWith("-") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Unsafe source-bundle path.");
  }
  return value;
}

export function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^(?:github\.com|api\.github\.com|raw\.githubusercontent\.com|gist\.githubusercontent\.com|gist\.github\.com|patch-diff\.githubusercontent\.com|codeload\.github\.com|download\.gnome\.org|storage\.googleapis\.com|gitlab\.com|gitlab\.freedesktop\.org|cairographics\.org|busybox\.net|gcc\.gnu\.org|musl\.libc\.org|dev\.gentoo\.org|gitlab\.alpinelinux\.org|salsa\.debian\.org|static\.crates\.io|nodejs\.org|distfiles\.alpinelinux\.org|static\.rust-lang\.org)$/.test(url.hostname)) {
    throw new Error("Source URL must use an approved public HTTPS upstream.");
  }
  return url.href;
}

// Only safe public metadata GETs use this policy. Artifact writes and downloads
// retain their own identity/checksum checks and are never replayed by this helper.
export function getText(url, {
  execute = spawnSync,
  now = () => performance.now(),
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  let current = publicUrl(url);
  const deadline = now() + 90_000;
  let requests = 0;
  let retries = 0;
  let redirects = 0;
  const fail = (reason) => {
    throw new Error(`Upstream metadata unavailable: ${new URL(current).hostname}; ${reason}; requests=${requests}`);
  };
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) fail("deadline exhausted");
    requests += 1;
    // Disable curlrc and automatic redirects: every target must pass publicUrl.
    // The final two lines are curl metadata, separate from the response body.
    const result = execute("curl", ["--disable", "--globoff", "--silent", "--show-error", "--proto", "=https",
      "--connect-timeout", "10", "--max-time", String(Math.min(45_000, remaining) / 1000),
      "--write-out", "\\n%{http_code}\\n%{redirect_url}", current],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: Math.max(1, Math.floor(remaining)) });
    if (now() >= deadline) fail("deadline exhausted");
    if (result.error || result.signal) fail("transport process failed");
    let transient = false;
    let reason;
    if (result.status !== 0) {
      // TLS, authentication, malformed URLs and local errors fail closed.
      transient = [5, 6, 7, 18, 28, 52, 55, 56, 92].includes(result.status);
      reason = `curl exit ${Number.isInteger(result.status) ? result.status : "unknown"}`;
    } else {
      const match = /\n(\d{3})\n([^\n]*)$/.exec(result.stdout ?? "");
      if (!match) fail("invalid response metadata");
      const status = Number(match[1]);
      if (status >= 200 && status < 300) return result.stdout.slice(0, match.index);
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (!match[2] || ++redirects > 5) fail("redirect budget exhausted");
        // Do not include a rejected URL or upstream stderr in diagnostics.
        try { current = publicUrl(match[2]); } catch { fail("redirect target rejected"); }
        continue;
      }
      transient = [408, 429, 500, 502, 503, 504].includes(status);
      reason = `HTTP ${status}`;
    }
    if (!transient || retries >= 2) fail(reason);
    const delay = 250 * 2 ** retries++;
    if (deadline - now() <= delay) fail("deadline exhausted");
    sleep(delay);
  }
}

export function expandVersion(value, variables) {
  const result = value.replace(/\$\(without_(?:patch|prerelease) \$([A-Z0-9_]+)\)/g,
    (match, key) => match.includes("without_patch") ? variables[key]?.replace(/\.\d+$/, "") : variables[key]?.replace(/-[a-z0-9]+$/i, ""))
    .replace(/\$\{([A-Z0-9_]+)\/\/\.\/([-_])\}/g, (_, key, separator) => variables[key]?.replaceAll(".", separator))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => variables[braced ?? plain] ?? "$UNRESOLVED");
  if (result.includes("$") || result.includes("undefined")) throw new Error("Unresolved upstream source URL variable.");
  return result;
}

export function alpineRemoteSources(recipe) {
  const variables = Object.fromEntries([...recipe.matchAll(/^([A-Za-z_]+)=["']?([A-Za-z0-9_.-]+)["']?\s*$/gm)].map((match) => [match[1], match[2]]));
  variables._pkgbase = variables.pkgver?.split("_git")[0];
  const block = recipe.match(/^source="([\s\S]*?)"/m)?.[1] ??
    (["alpine-keys", "alpine-base"].includes(variables.pkgname) ? "" : undefined);
  if (block === undefined) throw new Error("Unsupported Alpine source declaration.");
  const checksums = new Map([...recipe.matchAll(/^([a-f0-9]{128})\s+([^\s]+)\s*$/gm)].map((match) => [match[2], match[1]]));
  const files = [];
  for (const token of block.split(/\s+/).filter((token) => token.includes("https://"))) {
    const expanded = expandVersion(token, variables);
    const [filename, url] = expanded.includes("::") ? expanded.split("::") : [new URL(expanded).pathname.split("/").at(-1), expanded];
    safePath(filename);
    if (!checksums.has(filename)) throw new Error(`Missing Alpine source checksum: ${filename}`);
    files.push({ filename, url: publicUrl(url), sha512: checksums.get(filename) });
  }
  return { version: `${variables.pkgver}-r${variables.pkgrel}`, checksums, files };
}

export function assertChecksums(file, path, requireSha256 = true) {
  const bytes = readFileSync(path);
  if (requireSha256 && !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) throw new Error(`Missing locked checksum: ${file.path}`);
  if (file.sha256 && hash(bytes) !== file.sha256) throw new Error(`SHA-256 mismatch: ${file.path}`);
  if (file.sha512 && hash(bytes, "sha512") !== file.sha512) throw new Error(`Alpine SHA-512 mismatch: ${file.path}`);
  if (file.gitBlob && hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), "sha1") !== file.gitBlob) {
    throw new Error(`Upstream Git blob mismatch: ${file.path}`);
  }
  return hash(bytes);
}
