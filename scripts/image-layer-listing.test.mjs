import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSavedImageLayer } from "./image-layer-listing.mjs";

test("saved layer inspection lists all paths and fails closed on malformed layers", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-layer-listing-"));
  try {
    const layer = `${"a".repeat(64)}/layer.tar`;
    mkdirSync(join(root, "a".repeat(64)));
    mkdirSync(join(root, "payload"));
    writeFileSync(join(root, "payload/large-file"), "");
    // Exceed the former 512 MiB payload buffer without allocating it in Node.
    truncateSync(join(root, "payload/large-file"), 513 * 1024 * 1024);
    execFileSync("tar", ["-cf", join(root, layer), "-C", join(root, "payload"), "."]);
    const archive = join(root, "image.tar");
    execFileSync("tar", ["-cf", archive, "-C", root, layer]);
    const temporary = join(root, "temporary-layer.tar");
    assert.ok(listSavedImageLayer(archive, layer, temporary).includes("./large-file"));
    assert.equal(existsSync(temporary), false);
    assert.throws(() => listSavedImageLayer(archive, "../escape", temporary));
    writeFileSync(join(root, layer), "invalid tar data");
    execFileSync("tar", ["-cf", archive, "-C", root, layer]);
    assert.throws(() => listSavedImageLayer(archive, layer, temporary));
    assert.equal(existsSync(temporary), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
