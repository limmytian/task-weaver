import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function inspectLocalImage(image, platform, execute = spawnSync) {
  assert.match(platform, /^linux\/(?:arm64|amd64)$/);
  let result = execute("docker", ["image", "inspect", "--platform", platform, image], { encoding: "utf8" });
  if (result.status !== 0) {
    // Some local containerd stores run compatible images but cannot inspect a
    // platform-qualified tag. Validate the default result, never assume its CPU.
    result = execute("docker", ["image", "inspect", image], { encoding: "utf8" });
  }
  if (result.status !== 0) throw new Error(`Local image inspection failed for ${image}`);
  const details = JSON.parse(result.stdout)[0];
  assert.equal(`${details.Os}/${details.Architecture}`, platform, "Local image platform mismatch");
  assert.match(details.Id, /^sha256:[a-f0-9]{64}$/);
  return details;
}

export function redactScannerHostPaths(report) {
  const redact = value => {
    if (typeof value === "string") return value
      .replace(/(?:\/Users\/|\/home\/)[^/\s"<>]+(?:\/[^\s"<>]*)?/g, "<local-path-redacted>")
      .replace(/[A-Za-z]:[\\/]Users[\\/][^\s"<>]+/g, "<local-path-redacted>");
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const redacted = redact(report);
  const databaseConfiguration = redacted.descriptor?.configuration?.db;
  if (databaseConfiguration && typeof databaseConfiguration["cache-dir"] === "string") {
    databaseConfiguration["cache-dir"] = "<local-cache-redacted>";
  }
  const databaseStatus = redacted.descriptor?.db?.status;
  if (databaseStatus && typeof databaseStatus.path === "string") {
    databaseStatus.path = "<local-cache-redacted>";
  }
  return redacted;
}
