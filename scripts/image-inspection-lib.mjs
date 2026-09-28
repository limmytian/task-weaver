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
