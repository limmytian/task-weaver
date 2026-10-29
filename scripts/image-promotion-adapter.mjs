import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

/** Registry operations used while the caller holds the shared publication lock. */
export function createImagePromotionAdapter({ repository, registry = "ghcr.io" }) {
  assert.match(repository ?? "", /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
  assert.match(registry, /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/);
  const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  const image = app => `${registry}/${repository}-${app}`;
  function inspect(app, tag, missingAllowed) {
    const result = spawnSync("docker", ["buildx", "imagetools", "inspect", `${image(app)}:${tag}`, "--format", "{{json .Manifest}}"], { encoding: "utf8" });
    if (result.status !== 0) {
      if (missingAllowed && /manifest unknown|not found|404/i.test(result.stderr) && !/unauthorized|denied|forbidden/i.test(result.stderr)) return null;
      throw new Error(`Cannot inspect ${app}:${tag}: ${result.stderr.trim().slice(0, 500)}`);
    }
    const manifest = JSON.parse(result.stdout); const digest = manifest.digest ?? manifest.Digest;
    assert.match(digest ?? "", digestPattern, "Registry returned no digest");
    return digest;
  }
  return {
    async readPair(tag) { return { api: inspect("api", tag, false), web: inspect("web", tag, false) }; },
    async readVersion(tag) { return { api: inspect("api", tag, true), web: inspect("web", tag, true) }; },
    async writeTag(app, tag, digest) {
      assert.ok(["api", "web"].includes(app)); assert.match(digest, digestPattern);
      assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
      run("docker", ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", `${image(app)}:${tag}`, `${image(app)}@${digest}`]);
    },
  };
}
