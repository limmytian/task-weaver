import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { safePath } from "./binary-source-lib.mjs";

import { releasePlatform } from "./release-platforms.mjs";

export function imageArchiveConfig(archive, imageRef, platform = "linux/arm64") {
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "manifest.json"], { encoding: "utf8" }));
  const entries = manifest.filter(({ RepoTags }) => RepoTags?.includes(imageRef));
  assert.equal(entries.length, 1, "Archive must contain one tagged runtime image");
  const bytes = execFileSync("tar", ["-xOf", archive, safePath(entries[0].Config)], { maxBuffer: 16 * 1024 * 1024 });
  const configuration = JSON.parse(bytes);
  assert.equal(`${configuration.os}/${configuration.architecture}`, releasePlatform(platform));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
