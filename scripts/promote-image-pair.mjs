import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createImagePromotionAdapter } from "./image-promotion-adapter.mjs";
import { promoteImagePair } from "./image-promotion-orchestrator.mjs";
import { promotionIdentity } from "./image-promotion-identity.mjs";

const [mode, ...args] = process.argv.slice(2);
assert.ok(["main", "release"].includes(mode), "Expected main or release");
assert.equal(args.length, 3);
const [version, apiDigest, webDigest] = args;
const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
assert.match(repository ?? "", /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
const runId = process.env.GITHUB_RUN_ID;
const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
assert.match(runId ?? "", /^[1-9]\d*$/);
assert.ok(Number.isSafeInteger(attempt) && attempt > 0);
const git = (...input) => execFileSync("git", input, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
if (mode !== "main") {
  assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(git("cat-file", "-t", `refs/tags/v${version}`), "tag", "Formal release requires an annotated tag");
  assert.equal(git("rev-parse", `refs/tags/v${version}^{commit}`), commit, "Formal release tag must identify this checkout");
}
if (mode === "release") {
  for (const [app, digest] of [["api", apiDigest], ["web", webDigest]]) {
    const recorded = JSON.parse(readFileSync(`release-artifacts/bundle/${app}-image.json`, "utf8"));
    assert.equal(recorded.image, `ghcr.io/${repository}-${app}:${version}`);
    assert.equal(recorded.digest, digest);
  }
}
const run = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
const identity = promotionIdentity(run, { repository, runId, attempt, kind: mode === "main" ? "main" : "release", commit, version });
const adapter = createImagePromotionAdapter({ repository });
const result = await promoteImagePair(adapter, { ...identity, digests: { api: apiDigest, web: webDigest } });
console.log(`Verified version and latest image tags for ${result.version}: ${JSON.stringify(result.digests)}`);
