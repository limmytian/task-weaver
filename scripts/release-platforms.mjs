import assert from "node:assert/strict";

export const RELEASE_PLATFORMS = ["linux/amd64", "linux/arm64"];
export function releasePlatform(value = "linux/arm64") {
  assert.ok(RELEASE_PLATFORMS.includes(value), `Unsupported release platform: ${value}`);
  return value;
}
export function platformArchitecture(value) { return releasePlatform(value).split("/")[1]; }
export function rustTargets(platform) {
  const cpu = platformArchitecture(platform) === "amd64" ? "x86_64" : "aarch64";
  return [`${cpu}-unknown-linux-musl`, `${cpu}-unknown-linux-gnu`];
}
export function sourcePlatform(lock) {
  const platforms = [...new Set(lock.images.map(image => releasePlatform(image.platform)))];
  assert.equal(platforms.length, 1, "Source evidence must bind exactly one platform");
  return platforms[0];
}
