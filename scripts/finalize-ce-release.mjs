import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const output = resolve(process.cwd(), "release-artifacts", "bundle");
const manifestPath = join(output, "ce-release.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.artifacts = readdirSync(output)
  .filter((file) => file !== "ce-release.json" && !file.endsWith(".sigstore.json"))
  .sort()
  .map((file) => {
    const bytes = readFileSync(join(output, file));
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifestPath);
