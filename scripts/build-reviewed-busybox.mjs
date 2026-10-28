#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alpineRemoteSources, assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";
import { releasePlatform } from "./release-platforms.mjs";

const [manifest, requestedPlatform] = process.argv.slice(2);
if (!manifest || !requestedPlatform) throw new Error("Usage: node scripts/build-reviewed-busybox.mjs <source-lock.json> <linux/amd64|linux/arm64>");
const platform = releasePlatform(requestedPlatform);
const output = resolve("release-artifacts/busybox-build", platform.split("/")[1]);
rmSync(output, { recursive: true, force: true });
const sourceRoot = resolve("release-artifacts/binary-sources");
const buildScriptPath = fileURLToPath(import.meta.url);
const buildScriptSha256 = hash(readFileSync(buildScriptPath));
const lockBytes = readFileSync(resolve(manifest));
const lock = JSON.parse(lockBytes);
assert.equal(lock.busyboxBuildInputs?.configuration, "original-alpine", "Reviewed BusyBox source plan is required");
assert.deepEqual(lock.busyboxBuildInputs.staticLibraries, ["alpine-utmps", "alpine-skalibs"]);
assert.equal(lock.busyboxBuildInputs.patch, "alpine-busybox/patches/wget-CVE-2025-60876.patch");
for (const [id, commit] of [["alpine-busybox", "1e823a60eb85606954b3a5af5f8e5bbd1ea680cf"],
  ["alpine-utmps", "b8ca1510561d9fa9594fd4e3b5223d7749e6da0a"], ["alpine-skalibs", "b9c5072464571b09666b65869410ee3d40d2ebb2"]]) {
  assert.ok(lock.components.some((item) => item.id === id && item.commit === commit), `Unexpected ${id} source commit`);
}
for (const [path, sha256] of [["alpine-busybox/recipe/APKBUILD", "fb2323ac3121c6cd1122c42cabbd19ec28a29a1cf434a4c0759792c63a1c63a8"],
  ["alpine-utmps/recipe/APKBUILD", "daa2faf7b07cc8e9d8cf3f5f4adf265d99951fb7082c50f6f46c8c0d667958aa"],
  ["alpine-skalibs/recipe/APKBUILD", "a500ea39717caebfdffb608d24cb25f0d26082ed918c1e21ab0d57341bcd6aba"],
  ["alpine-busybox/recipe/busyboxconfig", "65b29f6085cd79ab5f032d7e4299534a86c3efad240e78c16186a19bf847fcca"],
  ["alpine-busybox/source/busybox-1.37.0.tar.bz2", "3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4"],
  [lock.busyboxBuildInputs.patch, "0506f13375c2425d2ff46a453616a9cb88de1a0c6878d26cd5fdc8ae9ebea51f"]]) {
  assert.ok(lock.files.some((item) => item.path === path && item.sha256 === sha256), `Unexpected locked input: ${path}`);
}
const selected = lock.files.filter((file) => ["alpine-busybox", "alpine-utmps", "alpine-skalibs"].includes(file.component));
assert.ok(selected.length > 40, "Incomplete BusyBox source inputs");
for (const file of selected) assertChecksums(file, resolve(sourceRoot, safePath(file.path)));
const pathFor = (path) => {
  const entry = selected.find((file) => file.path === path);
  assert.ok(entry, `Missing locked input: ${path}`);
  return resolve(sourceRoot, safePath(path));
};
const recipe = readFileSync(pathFor("alpine-busybox/recipe/APKBUILD"), "utf8");
const sourceBlock = recipe.match(/^source="([\s\S]*?)"/m)?.[1];
assert.ok(sourceBlock, "BusyBox recipe source list is missing");
const patches = sourceBlock.split(/\s+/).filter((item) => item.endsWith(".patch"));
assert.ok(patches.length > 40 && new Set(patches).size === patches.length);
const recipeChecksums = alpineRemoteSources(recipe).checksums;
for (const patch of patches) {
  safePath(patch);
  assert.equal(hash(readFileSync(pathFor(`alpine-busybox/recipe/${patch}`)), "sha512"), recipeChecksums.get(patch), `Patch differs from Alpine recipe: ${patch}`);
}
for (const origin of ["utmps", "skalibs"]) {
  const parsed = alpineRemoteSources(readFileSync(pathFor(`alpine-${origin}/recipe/APKBUILD`), "utf8"));
  assert.equal(parsed.files.length, 1);
  const source = parsed.files[0];
  assert.equal(hash(readFileSync(pathFor(`alpine-${origin}/source/${source.filename}`)), "sha512"), source.sha512, `Source differs from Alpine recipe: ${origin}`);
}
const expectedLibraries = platform === "linux/amd64"
  ? ["d88866df1679446da3c7e81137a10e10752aac1444d610efb5d30d341c8e9b49", "99bf46ed6677bd7880a1f4db320bdcc928baacba65bbed596bef1927a9baa99b"]
  : ["a3505c4a591ffe7433c524676f36c34c2c5a09214919c342e134bf3a394a7b17", "d5ebd65ca3d2902e78b3fd87ae90c6bc51fa1ad865a11c52232b2d03617a6c5a"];
const context = mkdtempSync(join(tmpdir(), "tw-busybox-build-"));
const copyLocked = (source, destination) => {
  const entry = selected.find((file) => file.path === source);
  assert.ok(entry, `Missing locked input: ${source}`);
  copyFileSync(pathFor(source), destination);
  assertChecksums(entry, destination);
};
const image = `task-weaver-busybox-build:${platform.split("/")[1]}`;
let container;
try {
  mkdirSync(join(context, "patches"));
  copyLocked("alpine-busybox/source/busybox-1.37.0.tar.bz2", join(context, "busybox.tar.bz2"));
  copyLocked("alpine-busybox/recipe/busyboxconfig", join(context, "busyboxconfig"));
  copyLocked(lock.busyboxBuildInputs.patch, join(context, "security.patch"));
  for (const patch of patches) copyLocked(`alpine-busybox/recipe/${patch}`, join(context, "patches", patch));
  writeFileSync(join(context, "patch-list"), `${patches.join("\n")}\n`);
  writeFileSync(join(context, "Dockerfile"), `FROM alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63\n` +
    `RUN apk add --no-cache build-base=0.5-r3 linux-headers=6.16.12-r0 utmps-dev=0.1.3.1-r0 utmps-static=0.1.3.1-r0 skalibs-static=2.14.4.0-r0 pkgconf && apk info -e gcc=15.2.0-r2 && apk info -e binutils=2.45.1-r0\n` +
    `RUN echo '${expectedLibraries[0]}  /usr/lib/libutmps.a' | sha256sum -c - && echo '${expectedLibraries[1]}  /usr/lib/libskarnet.a' | sha256sum -c -\n` +
    `ENV SOURCE_DATE_EPOCH=1767225600\nWORKDIR /work\nCOPY . /work/\n` +
    `RUN tar -xf busybox.tar.bz2 && cd busybox-1.37.0 && while IFS= read -r p; do patch -p1 < "/work/patches/$p" || exit 1; done < /work/patch-list && patch -p1 < /work/security.patch && cp /work/busyboxconfig .config && make oldconfig </dev/null && make -j4 CONFIG_EXTRA_CFLAGS="$(pkg-config --cflags --static libutmps)" CONFIG_EXTRA_LDLIBS="-Wl,--push-state,-Bstatic $(pkg-config --libs --static libutmps) -Wl,--pop-state" && ./busybox wget --help >/dev/null 2>&1\n`);
  execFileSync("docker", ["build", "--no-cache", "--platform", platform, "--tag", image, context], { stdio: "inherit" });
  const imageId = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const compilerInputs = execFileSync("docker", ["run", "--rm", "--platform", platform, "--network", "none", "--entrypoint", "sh", image,
    "-c", "sha256sum /usr/bin/gcc /usr/bin/ld /lib/apk/db/installed"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(compilerInputs.length, 3);
  assert.ok(compilerInputs.every((line) => /^[a-f0-9]{64}  \/(?:usr\/bin\/(?:gcc|ld)|lib\/apk\/db\/installed)$/.test(line)), "Invalid compiler input inventory");
  container = execFileSync("docker", ["create", "--platform", platform, image], { encoding: "utf8" }).trim();
  mkdirSync(output, { recursive: true });
  execFileSync("docker", ["cp", `${container}:/work/busybox-1.37.0/busybox`, join(output, "busybox")], { stdio: "inherit" });
  const sha256 = hash(readFileSync(join(output, "busybox")));
  assert.equal(hash(readFileSync(buildScriptPath)), buildScriptSha256, "Build script changed during compilation");
  assert.equal(hash(readFileSync(resolve(manifest))), hash(lockBytes), "Source lock changed during compilation");
  const dockerfile = readFileSync(join(context, "Dockerfile"));
  const patchList = readFileSync(join(context, "patch-list"));
  writeFileSync(join(output, "Dockerfile"), dockerfile);
  writeFileSync(join(output, "patch-list"), patchList);
  const report = { schemaVersion: 1, platform, sourceLockSha256: hash(lockBytes), builderImageId: imageId,
    buildScriptSha256, dockerfileSha256: hash(dockerfile), patchListSha256: hash(patchList),
    binarySha256: sha256, staticLibrarySha256: expectedLibraries, compilerInputs, sourceDateEpoch: 1767225600, patchCount: patches.length,
    distributionApproved: false, limitation: "Experimental local build evidence; validate output, toolchain provenance, runtime notices and replacement controls before distribution." };
  writeFileSync(join(output, "verification.json"), json(report));
  console.log(json(report));
} finally {
  if (container) execFileSync("docker", ["rm", container], { stdio: "ignore" });
  rmSync(context, { recursive: true, force: true });
}
