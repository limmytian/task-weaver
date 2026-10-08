import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const version = process.argv[2];
const previousTag = process.argv[3];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/ce-release-notes.mjs <version> [previous-tag]");
}

for (const name of ["contracts", "db", "realtime", "core", "partners-gateway"]) {
  const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
  if (manifest.version !== version) throw new Error(`${manifest.name} does not match release version ${version}`);
}

if (previousTag) {
  execFileSync("git", ["rev-parse", "--verify", `refs/tags/${previousTag}`], { stdio: "ignore" });
}
const curatedNotes = resolve(`docs/releases/${version}.md`);
if (existsSync(curatedNotes)) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceBase = `https://github.com/limmytian/task-weaver/blob/${commit}/docs/releases/`;
  const releaseNotes = (path) => readFileSync(path, "utf8").replace(
    /\]\(([^)]+)\)/g,
    (match, target) => /^[a-z][a-z\d+.-]*:|^#/i.test(target)
      ? match : `](${new URL(target, sourceBase).href})`,
  );
  const destination = resolve("release-artifacts/RELEASE_NOTES.md");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, releaseNotes(curatedNotes));
  const translation = resolve(`docs/releases/${version}.zh-CN.md`);
  if (existsSync(translation)) {
    writeFileSync(resolve("release-artifacts/RELEASE_NOTES.zh-CN.md"), releaseNotes(translation));
  }
  console.log(destination);
} else {
  const revision = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const output = execFileSync("git", ["log", "--format=%h%x09%s%x09%b%x00", revision], { encoding: "utf8" });
  const sections = new Map([
    ["Breaking changes", []],
    ["Features", []],
    ["Fixes", []],
    ["Maintenance", []],
  ]);
  for (const record of output.split("\0")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [hash, subject, ...body] = trimmed.split("\t");
    if (!hash || !subject) continue;
    const breaking = /\bBREAKING CHANGE:/i.test(body.join("\t")) || /^[a-z]+(?:\([^)]*\))?!:/.test(subject);
    const type = subject.match(/^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/);
    const section = breaking ? "Breaking changes" : type?.[1] === "feat" ? "Features" : type?.[1] === "fix" ? "Fixes" : "Maintenance";
    const summary = type?.[2] ?? subject;
    sections.get(section).push(`- ${summary} (${hash})`);
  }
  const lines = [`# Task Weaver ${version}`, "", `Changes since ${previousTag ?? "the initial public commit"}.`, ""];
  for (const [title, entries] of sections) {
    if (entries.length === 0) continue;
    lines.push(`## ${title}`, "", ...entries, "");
  }
  lines.push("## Release review", "", "- Confirm API and database migration notes against the actual diff.", "- Confirm package and image digests, signatures, SBOMs, and support window.", "");
  const destination = resolve("release-artifacts/RELEASE_NOTES.md");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${lines.join("\n")}\n`);
  console.log(destination);
}
