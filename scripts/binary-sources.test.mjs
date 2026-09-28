import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import test from "node:test";
import { alpineRemoteSources, assertChecksums, expandVersion, hash, publicUrl, safePath } from "./binary-source-lib.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";

test("source paths cannot escape the bundle or introduce shell options", () => {
  for (const path of ["../secret", "/etc/passwd", "-option", "a/../../b", "a//b", "a/./b", "a\\b", "a b"]) assert.throws(() => safePath(path));
  assert.equal(safePath("native-vips/vips-8.18.7.tar.xz"), "native-vips/vips-8.18.7.tar.xz");
  assert.equal(safePath("crate/tests/repr(C).rs"), "crate/tests/repr(C).rs");
});

test("source downloads reject credentials, private hosts, and cleartext URLs", () => {
  for (const url of ["http://github.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://user:password@github.com/a", "https://github.com:444/a"]) assert.throws(() => publicUrl(url));
  assert.equal(publicUrl("https://github.com/libvips/libvips/releases"), "https://github.com/libvips/libvips/releases");
});

test("platform inspection fallback validates the actual local image CPU", () => {
  const result = (architecture) => ({ status: 0, stdout: JSON.stringify([{ Id: `sha256:${"a".repeat(64)}`, Os: "linux", Architecture: architecture }]) });
  let calls = 0;
  const execute = () => ++calls === 1 ? { status: 1 } : result("arm64");
  assert.equal(inspectLocalImage("fixture", "linux/arm64", execute).Architecture, "arm64");
  assert.equal(calls, 2);
  assert.throws(() => inspectLocalImage("fixture", "linux/arm64", () => result("amd64")));
});

test("native version URLs expand only supported literals, never execute shell", () => {
  assert.equal(expandVersion("https://a/$(without_patch $VERSION_XML2)/${VERSION_XML2}", { VERSION_XML2: "2.15.4" }), "https://a/2.15/2.15.4");
  assert.equal(expandVersion("VER-${VERSION_FREETYPE//./-}", { VERSION_FREETYPE: "2.14.3" }), "VER-2-14-3");
  assert.throws(() => expandVersion("$(touch /tmp/unsafe)", {}));
  assert.throws(() => expandVersion("$UNKNOWN", {}));
});

test("Alpine sources require exact checksums and preserve source filenames", () => {
  const checksum = "a".repeat(128);
  const recipe = `pkgname=fixture\npkgver=1.2.3\npkgrel=4\nsource="source-$pkgver.tar.gz::https://github.com/fixture/archive/$pkgver.tar.gz\nlocal.patch\n"\nsha512sums="\n${checksum}  source-1.2.3.tar.gz\n"`;
  assert.deepEqual(alpineRemoteSources(recipe).files, [{ filename: "source-1.2.3.tar.gz", url: "https://github.com/fixture/archive/1.2.3.tar.gz", sha512: checksum }]);
  assert.equal(alpineRemoteSources(recipe).version, "1.2.3-r4");
  assert.throws(() => alpineRemoteSources(recipe.replace(checksum, "bad")));
  assert.throws(() => alpineRemoteSources("pkgname=unsupported\npkgver=1\npkgrel=0\n"));
  assert.equal(alpineRemoteSources("pkgname=alpine-base\npkgver=3.23.6\npkgrel=0\n").files.length, 0);
});

test("source locks verify SHA-256, Alpine SHA-512, and upstream Git blob identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-source-checksum-"));
  const path = join(dir, "fixture");
  const bytes = Buffer.from("public source fixture\n");
  writeFileSync(path, bytes);
  const file = { path: "fixture", sha256: hash(bytes), sha512: hash(bytes, "sha512"), gitBlob: hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), "sha1") };
  try {
    assert.equal(assertChecksums(file, path), file.sha256);
    for (const key of ["sha256", "sha512", "gitBlob"]) assert.throws(() => assertChecksums({ ...file, [key]: "0".repeat(file[key].length) }, path));
    assert.throws(() => assertChecksums({ path: "fixture" }, path));
    assert.equal(assertChecksums({ path: "fixture" }, path, false), file.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binary evidence verification fails on source, image, or license-text drift", () => {
  const directory = mkdtempSync(join(tmpdir(), "tw-binary-evidence-"));
  const root = join(directory, "release-artifacts/binary-sources");
  mkdirSync(root, { recursive: true });
  const save = (name, value) => writeFileSync(join(root, name), typeof value === "string" ? value : JSON.stringify(value));
  const imageId = `sha256:${"a".repeat(64)}`;
  const image = { image: "fixture", imageId, platform: "linux/arm64", report: "image.json" };
  save("source", "source");
  save("license", "notice");
  save("librsvg-post-edit-Cargo.lock", "lock");
  save("librsvg-release-Cargo.lock", "lock");
  save("lock.json", { schemaVersion: 1, images: [image], components: [{ id: "runtime", family: "runtime", version: "24.21.0" }],
    files: [{ path: "source", sha256: hash("source") }], rustVendoring: { postEditLockVerified: true, verification: "rust.json", postEditCargoLockSha256: hash("lock") } });
  save("inventory.json", { inventory: [image] });
  const report = { imageId, runtime: { version: "24.21.0" }, osSourcePackages: [], nativeLibraries: [], runtimeNoticeVerified: true, runtimeNoticesSha256: hash("notice") };
  save("image.json", report);
  save("license-extraction.json", { failures: [], evidence: [{ path: "license", sha256: hash("notice") }], componentsWithoutArchiveLicenseText: [] });
  const rust = { passed: true, newRegistryPackages: 0, postEditCargoLockSha256: hash("lock"), postEditRegistryPackages: 0 };
  save("rust.json", rust);
  save("rust-lock-verification.json", rust);
  save("license-texts.txt", "notice");
  save("runtime-source-NOTICES.txt", "notice");
  save("notice-case-resolutions.json", { sourceLockSha256: hash(readFileSync(join(root, "lock.json"))), noticeBundleSha256: hash("notice"), resolutions: [], unresolvedTechnicalCases: [] });
  save("rust-license-declarations.json", { declarations: [] });
  save("replacement.json", { passed: true, markerObserved: true, missingLibraryControlFailed: true });
  const script = join(import.meta.dirname, "verify-binary-source-evidence.mjs");
  const run = () => spawnSync(process.execPath, [script, join(root, "lock.json"), root, join(root, "replacement.json")], { cwd: directory, encoding: "utf8" });
  try {
    assert.equal(run().status, 0);
    const packageScript = join(import.meta.dirname, "package-binary-source-evidence.mjs");
    const pack = () => spawnSync(process.execPath, [packageScript, join(root, "lock.json")], { cwd: directory, encoding: "utf8" });
    assert.equal(pack().status, 0);
    const archive = join(root, "corresponding-source-candidate.tar.gz");
    const first = hash(readFileSync(archive));
    assert.equal(pack().status, 0);
    assert.equal(hash(readFileSync(archive)), first, "Repeated packaging must have identical bytes");
    const extracted = spawnSync("tar", ["-xOf", archive, "--", "source"], { encoding: "utf8" });
    assert.equal(extracted.status, 0);
    assert.equal(extracted.stdout, "source");
    save("source", "changed");
    assert.notEqual(run().status, 0);
    save("source", "source");
    save("image.json", { ...report, imageId: `sha256:${"b".repeat(64)}` });
    assert.notEqual(run().status, 0);
    save("image.json", report);
    save("license", "changed");
    assert.notEqual(run().status, 0);
    save("license", "notice");
    save("image.json", { ...report, runtimeNoticeVerified: false });
    assert.notEqual(run().status, 0, "Missing delivered notices must fail closed");
    save("image.json", report);
    save("runtime-source-NOTICES.txt", "changed");
    assert.notEqual(run().status, 0, "Notice bundle drift must fail closed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("source sidecar delivers verified source-only vendor files, not raw native payload containers", () => {
  const directory = mkdtempSync(join(tmpdir(), "tw-source-only-package-"));
  const root = join(directory, "release-artifacts/binary-sources");
  mkdirSync(root, { recursive: true });
  const save = (name, value) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), typeof value === "string" ? value : JSON.stringify(value));
  };
  const lock = { files: [{ path: "rust-crates/fixture.crate", sha256: hash("native payload") },
    { path: "rust-docs.tar.xz", kind: "notice-container", sha256: hash("docs payload") }] };
  save("lock.json", lock);
  save("rust-crates/fixture.crate", "native payload");
  save("rust-docs.tar.xz", "docs payload");
  save("local-vendor/fixture/Cargo.toml", "[package]\nname = 'fixture'\n");
  save("binary-source-verification.json", { sourceLockSha256: hash(readFileSync(join(root, "lock.json"))), sourceIntegrityPassed: true });
  for (const name of ["license-texts.txt", "license-extraction.json", "runtime-source-NOTICES.txt", "notice-case-resolutions.json",
    "librsvg-release-Cargo.lock", "librsvg-post-edit-Cargo.lock", "rust-lock-verification.json", "rust-license-declarations.json",
    "linux-rust-source-coverage.json", "aarch64-unknown-linux-musl-source-tree.txt", "aarch64-unknown-linux-gnu-source-tree.txt"]) save(name, "fixture");
  save("license-extraction.json", { evidence: [] });
  save("rust-source-delivery.json", { linuxTreeReplayPassed: true, files: [{ path: "rust-vendor/fixture/Cargo.toml",
    sourcePath: "local-vendor/fixture/Cargo.toml", sha256: hash(readFileSync(join(root, "local-vendor/fixture/Cargo.toml"))), mode: 0o644 }],
    omittedImportLibraries: [{ path: "rust-vendor/fixture/tests/native.a", sha256: hash("omitted"), reason: "native test fixture" }] });
  const pack = () => spawnSync(process.execPath, [join(import.meta.dirname, "package-binary-source-evidence.mjs"), join(root, "lock.json")], { cwd: directory, encoding: "utf8" });
  try {
    const result = pack();
    assert.equal(result.status, 0, result.stderr);
    const archive = join(root, "corresponding-source-candidate.tar.gz");
    const members = spawnSync("tar", ["-tf", archive], { encoding: "utf8" }).stdout;
    assert.match(members, /^rust-vendor\/fixture\/Cargo.toml$/m);
    assert.doesNotMatch(members, /fixture\.crate|rust-docs\.tar\.xz|native\.a|local-vendor/);
    const index = spawnSync("tar", ["-xOf", archive, "--", "rust-source-delivery.json"], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(index, /sourcePath|local-vendor/);
    save("local-vendor/fixture/Cargo.toml", "changed");
    assert.notEqual(pack().status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
