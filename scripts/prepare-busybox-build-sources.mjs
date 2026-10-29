#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { alpineRemoteSources, getText, json, safePath } from "./binary-source-lib.mjs";

const [manifest] = process.argv.slice(2);
if (!manifest) throw new Error("Usage: node scripts/prepare-busybox-build-sources.mjs <source-lock.json>");
const lock = JSON.parse(readFileSync(resolve(manifest)));
assert.equal(lock.schemaVersion, 1);
assert.ok(Array.isArray(lock.files) && Array.isArray(lock.components));
assert.ok(lock.components.some((item) => item.id === "alpine-busybox" && item.commit === "1e823a60eb85606954b3a5af5f8e5bbd1ea680cf"), "Unexpected BusyBox source baseline");
assert.ok(lock.files.some((item) => item.component === "alpine-busybox" && item.path.endsWith("/busyboxconfig") && item.sha256 === "65b29f6085cd79ab5f032d7e4299534a86c3efad240e78c16186a19bf847fcca"), "Unexpected BusyBox configuration");
assert.ok(lock.files.some((item) => item.component === "alpine-busybox" && item.path.endsWith("/busybox-1.37.0.tar.bz2") && item.sha256 === "3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4"), "Unexpected BusyBox source archive");
for (const { origin, commit, version } of [
  { origin: "utmps", commit: "b8ca1510561d9fa9594fd4e3b5223d7749e6da0a", version: "0.1.3.1-r0" },
  { origin: "skalibs", commit: "b9c5072464571b09666b65869410ee3d40d2ebb2", version: "2.14.4.0-r0" },
]) {
  const component = `alpine-${origin}`;
  assert.ok(!lock.components.some((item) => item.id === component), `Component already exists: ${component}`);
  const directory = JSON.parse(getText(`https://api.github.com/repos/alpinelinux/aports/contents/main/${origin}?ref=${commit}`));
  assert.ok(Array.isArray(directory) && directory.every((entry) => entry.type === "file"));
  const apk = directory.find((entry) => entry.name === "APKBUILD");
  assert.ok(apk);
  const parsed = alpineRemoteSources(getText(apk.download_url));
  assert.equal(parsed.version, version, `Unexpected ${origin} recipe version`);
  assert.equal(parsed.files.length, 1, `Unexpected ${origin} source layout`);
  lock.components.push({ id: component, family: "busybox-build-input", origin, commit, version, license: "ISC" });
  for (const entry of directory) lock.files.push({ component, kind: "recipe", url: entry.download_url,
    path: `${component}/recipe/${safePath(entry.name)}`, gitBlob: entry.sha,
    ...(parsed.checksums.has(entry.name) ? { sha512: parsed.checksums.get(entry.name) } : {}) });
  for (const entry of parsed.files) lock.files.push({ component, kind: "source", url: entry.url,
    path: `${component}/source/${safePath(entry.filename)}`, sha512: entry.sha512 });
}
const patchPath = "alpine-busybox/patches/wget-CVE-2025-60876.patch";
assert.ok(!lock.files.some((file) => file.path === patchPath));
lock.files.push({ component: "alpine-busybox", kind: "patch", path: patchPath,
  url: "https://raw.githubusercontent.com/buildroot/buildroot/ffbffaea9f3fa08a5bdbad772441ee8e0e506401/package/busybox/0014-wget-dont-allow-control-characters-or-spaces-in-the-URL.patch",
  sha256: "0506f13375c2425d2ff46a453616a9cb88de1a0c6878d26cd5fdc8ae9ebea51f" });
lock.busyboxBuildInputs = { schemaVersion: 1, patch: patchPath, configuration: "original-alpine",
  staticLibraries: ["alpine-utmps", "alpine-skalibs"], distributionApproved: false,
  limitation: "Source acquisition plan only; no build provenance, output binding, notice review, or publication approval." };
const output = resolve("release-artifacts/binary-sources");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "busybox-build-source-plan.json"), json(lock));
console.log("Prepared pinned BusyBox patch and static-library source plan; acquire and review before use.");
