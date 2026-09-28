import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverGitManagedSkillPackages,
  parseFrontmatter,
} from "./skill-presets.js";

test("frontmatter parser reads scalar and JSON array metadata", () => {
  const parsed = parseFrontmatter([
    "---",
    "name: example-skill",
    "description: A test skill",
    'keywords: ["alpha", "beta"]',
    'tags: ["integration"]',
    "---",
    "# Example",
  ].join("\n"));

  assert.equal(parsed.meta.name, "example-skill");
  assert.equal(parsed.meta.description, "A test skill");
  assert.deepEqual(parsed.meta.keywords, ["alpha", "beta"]);
  assert.equal(parsed.content, "# Example");
});

test("preset discovery is deterministic and content-addressed", async () => {
  const root = await mkdtemp(join(tmpdir(), "tw-skill-presets-"));
  try {
    await mkdir(join(root, "z-last"));
    await mkdir(join(root, "a-first", "references"), { recursive: true });
    await writeFile(join(root, "z-last", "SKILL.md"), "---\nname: z-skill\ntags: [\"z\"]\n---\n# Z\n");
    await writeFile(join(root, "a-first", "SKILL.md"), "---\nname: a-skill\n---\n# A\n");
    await writeFile(join(root, "a-first", "references", "guide.md"), "reference");
    await writeFile(join(root, ".ignored", "SKILL.md"), "ignored").catch(() => undefined);

    const first = await discoverGitManagedSkillPackages(root);
    const second = await discoverGitManagedSkillPackages(root);

    assert.deepEqual(first.map((pkg) => pkg.name), ["a-skill", "z-skill"]);
    assert.equal(first[0]!.files.length, 2);
    assert.match(first[0]!.version, /^git-[a-f0-9]{24}$/);
    assert.equal(first[0]!.version, second[0]!.version);
    assert.equal(first[0]!.contentHash, second[0]!.contentHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
