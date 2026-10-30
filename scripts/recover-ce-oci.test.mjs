import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverPublishedEvidence } from "./recover-ce-oci.mjs";

const hash = raw => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
test("file-only recovery verifies both original signed indexes and reviewed child configs before writing", () => {
  for (const failure of [null, "signature", "config", "tag", "provenance", "digest"]) {
    const directory = mkdtempSync(join(tmpdir(), "tw-release-recovery-"));
    try {
      const version = "1.2.3", commit = "a".repeat(40), repository = "limmytian/task-weaver";
      const configs = { amd64: `sha256:${"b".repeat(64)}`, arm64: `sha256:${"c".repeat(64)}` };
      const children = Object.fromEntries(Object.entries(configs).map(([arch, digest]) => [arch, JSON.stringify({ config: { digest } })]));
      const index = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: Object.entries(children).map(([arch, raw]) => ({ platform: { os: "linux", architecture: arch }, digest: hash(raw), size: raw.length })) });
      const digests = { api: hash(index), web: hash(index) };
      const platforms = Object.fromEntries(Object.entries(children).map(([arch, raw]) => [`linux/${arch}`, { digest: hash(raw), configDigest: configs[arch], image: `fixture-${arch}`, localImageId: configs[arch] }]));
      writeFileSync(join(directory, "ce-candidate-set.json"), JSON.stringify({ version, commit }));
      for (const arch of ["amd64", "arm64"]) writeFileSync(join(directory, `ce-candidate-${arch}.json`), JSON.stringify({ version, commit, images: ["api", "web"].map(app => ({ app, platform: `linux/${arch}`, configDigest: failure === "config" && app === "web" ? configs[arch].replace(/b|c/g, "d") : configs[arch] })) }));
      const calls = [];
      const execute = (command, args) => {
        calls.push([command, ...args]);
        if (command === "git") return commit;
        if (command === "docker") {
          assert.deepEqual(args.slice(0, 3), ["buildx", "imagetools", "inspect"]);
          assert.equal(args.at(-1), "--raw");
          const ref = args[3];
          if (failure === "tag" && ref.endsWith(":" + version)) return "{}";
          for (const [arch, raw] of Object.entries(children)) if (ref.endsWith(hash(raw)) || ref.endsWith("-" + arch)) return raw;
          return index;
        }
        assert.equal(command, "cosign");
        assert.ok(args.includes(`https://github.com/${repository}/.github/workflows/ce-release.yml@refs/tags/v${version}`));
        if (failure === "signature") throw new Error("Invalid signature");
        const digest = args.at(-1).split("@")[1];
        if (args[0] === "verify") return JSON.stringify([{ critical: { image: { "docker-manifest-digest": digest } } }]);
        assert.equal(args[0], "verify-attestation");
        const statement = { subject: [{ digest: { sha256: digest.slice(7) } }], predicate: { Data: JSON.stringify({ version, commit: failure === "provenance" ? "d".repeat(40) : commit, platforms }) } };
        return JSON.stringify({ payload: Buffer.from(JSON.stringify(statement)).toString("base64") });
      };
      if (failure === "digest") digests.web = `sha256:${"e".repeat(64)}`;
      const run = () => recoverPublishedEvidence(version, repository, digests, execute, directory);
      if (failure) {
        assert.throws(run);
        assert.equal(existsSync(join(directory, "api-image.json")), false, "A failing pair must not produce deployable evidence");
      } else {
        run();
        assert.equal(existsSync(join(directory, "web-image.json")), true);
        assert.equal(calls.filter(call => call[1] === "verify").length, 6);
      }
      assert.ok(calls.every(call => !call.some(arg => ["push", "tag", "create", "sign", "attest"].includes(arg))), "Recovery cannot write to the registry");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
