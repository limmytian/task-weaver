import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

const refPattern = /^refs\/heads\/image-promotion-journal$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

/** Registry and Git journal adapter. The remote journal ref must be protected so
 * only the common promotion workflow can write it. Callers hold the shared lock. */
export function createImagePromotionAdapter({ repository, registry = "ghcr.io", remote = "origin", ref = "refs/heads/image-promotion-journal" }) {
  assert.match(repository ?? "", /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
  assert.match(registry, /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/);
  assert.match(ref, refPattern);
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
  function readRef() {
    const output = run("git", ["ls-remote", "--refs", remote, ref]).trim();
    const lines = output ? output.split("\n") : [];
    assert.equal(lines.length, 1, "Promotion journal ref must exist exactly once");
    const [revision, actualRef] = lines[0].split(/\s+/);
    assert.equal(actualRef, ref); assert.match(revision, /^[a-f0-9]{40}$/);
    run("git", ["fetch", "--no-tags", remote, revision]);
    const state = JSON.parse(run("git", ["show", `${revision}:journal.json`]));
    return { revision, state };
  }
  return {
    async readJournal() { return readRef(); },
    async compareAndSwap(revision, state) {
      assert.match(revision, /^[a-f0-9]{40}$/);
      const blob = run("git", ["hash-object", "-w", "--stdin"], { input: `${JSON.stringify(state, null, 2)}\n` }).trim();
      const tree = run("git", ["mktree"], { input: `100644 blob ${blob}\tjournal.json\n` }).trim();
      const commit = run("git", ["-c", "user.name=Task Weaver promotion", "-c", "user.email=promotion@users.noreply.github.com", "commit-tree", tree, "-p", revision, "-m", "Update image promotion journal"]).trim();
      const result = spawnSync("git", ["push", `--force-with-lease=${ref}:${revision}`, remote, `${commit}:${ref}`], { encoding: "utf8" });
      if (result.status !== 0) throw new Error("Journal update failed or outcome is uncertain; inspect the remote journal before retrying");
      return commit;
    },
    async readPair(tag) { return { api: inspect("api", tag, false), web: inspect("web", tag, false) }; },
    async readVersion(tag) { return { api: inspect("api", tag, true), web: inspect("web", tag, true) }; },
    async writeTag(app, tag, digest) {
      assert.ok(["api", "web"].includes(app)); assert.match(digest, digestPattern);
      assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
      run("docker", ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", `${image(app)}:${tag}`, `${image(app)}@${digest}`]);
    },
  };
}
