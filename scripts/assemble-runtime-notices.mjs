#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";

const [manifest] = process.argv.slice(2);
if (!manifest) throw new Error("Usage: node scripts/assemble-runtime-notices.mjs <verified-source-lock.json>");
const root = resolve("release-artifacts/binary-sources");
const lock = JSON.parse(readFileSync(resolve(manifest)));
const extraction = JSON.parse(readFileSync(resolve(root, "license-extraction.json")));
const declarations = JSON.parse(readFileSync(resolve(root, "rust-license-declarations.json")));
const coverage = JSON.parse(readFileSync(resolve(root, "linux-rust-source-coverage.json")));
assert.equal(extraction.failures.length, 0);
assert.equal(coverage.passed, true);
assert.equal(coverage.sourceOnlyVendorReplayPassed, true);
const sections = ["Task Weaver runtime and corresponding-source notices\n\n" +
  "Upstream text content is preserved below with LF line endings; original byte hashes refer to the corresponding-source sidecar.\n" +
  "The source inventory includes optional, development and non-target components;\n" +
  "inclusion is not a claim that every listed component is linked into the application.\n" +
  "License declarations and published authors are provenance, not invented copyright-holder statements.\n" +
  "Standard license texts supplement the original notices and do not replace upstream attribution.\n"];
const resolutions = [];
for (const component of extraction.componentsWithoutArchiveLicenseText) {
  if (component.startsWith("rust-")) {
    const declaration = declarations.declarations.find((entry) => entry.component === component);
    assert.ok(declaration?.license && coverage.excludedComponents.includes(component), `Unresolved Linux build notice: ${component}`);
    resolutions.push({ component, kind: "not-in-conservative-linux-build-graph", license: declaration.license,
      handling: "Preserve all publisher-provided archive source, author/license metadata, and supplemental standard texts; do not invent a missing notice." });
  } else {
    assert.ok(["alpine-alpine-keys", "alpine-alpine-base"].includes(component), `Unreviewed source notice case: ${component}`);
    const recipe = lock.files.find((entry) => entry.component === component && entry.path.endsWith("/APKBUILD"));
    assertChecksums(recipe, resolve(root, safePath(recipe.path)));
    const text = readFileSync(resolve(root, recipe.path), "utf8");
    assert.match(text, /^license="MIT"$/m);
    sections.push(`Component: ${component}\nOriginal publisher license/source declaration\nUpstream: ${recipe.url}\nSHA-256: ${recipe.sha256}\n\n${text}\n`);
    resolutions.push({ component, kind: "publisher-source-declaration", license: "MIT", declarationSha256: recipe.sha256,
      handling: "Preserve the exact source declaration and all provided maintainer/contributor attribution; no separate copyright notice was provided in the recipe directory." });
  }
}
for (const declaration of declarations.declarations) {
  sections.push(`Component: ${declaration.component}\nPublished package license: ${declaration.license ?? declaration.licenseFile}\n` +
    `Published authors field: ${declaration.publishedAuthorsField ?? "Not supplied"}\nPublished repository: ${declaration.repository ?? "Not supplied"}\n` +
    `Source archive SHA-256: ${declaration.archiveSha256}\nPublished Cargo metadata SHA-256: ${declaration.publishedMetadataSha256}\n`);
}
for (const item of extraction.evidence) {
  const bytes = readFileSync(resolve(root, safePath(item.path)));
  assert.equal(hash(bytes), item.sha256);
  sections.push(`Component: ${item.component}\nOriginal upstream file: ${item.member ?? item.path}\nSHA-256: ${item.sha256}\n\n${bytes.toString("utf8")}\n`);
}
const text = (sections.join("\n---\n\n") + "\n---\n\nEnd of preserved upstream notices.\n").replace(/\r\n/g, "\n");
writeFileSync(resolve(root, "runtime-source-NOTICES.txt"), text);
writeFileSync(resolve(root, "notice-case-resolutions.json"), json({ schemaVersion: 1, sourceLockSha256: hash(readFileSync(resolve(manifest))),
  noticeBundleSha256: hash(text), resolutions, unresolvedTechnicalCases: [], distributionApproved: false,
  limitation: "Evidence and distribution handling review, not legal certification or the owner's publication checkpoint." }));
console.log(`Assembled ${extraction.evidence.length} verbatim texts and ${declarations.declarations.length} publisher declarations; ${resolutions.length} notice cases have explicit handling.`);
