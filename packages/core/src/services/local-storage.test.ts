import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalStorageAdapter } from "./local-storage";

test("streamed objects enforce limits, clean failures and survive adapter recreation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tw-storage-"));
  try {
    const storage = new LocalStorageAdapter(dir, { maxObjectBytes: 4 });
    await assert.rejects(storage.putObject({ key: "attachments/oversize", body: Readable.from([Buffer.alloc(3), Buffer.alloc(3)]) }), /max size/);
    assert.deepEqual(await readdir(join(dir, "attachments")), []);
    const interrupted = Readable.from((async function* () { yield Buffer.from("ab"); throw new Error("Interrupted fixture"); })());
    await assert.rejects(storage.putObject({ key: "attachments/interrupted", body: interrupted }), /Interrupted/);
    assert.deepEqual(await readdir(join(dir, "attachments")), []);
    await storage.putObject({ key: "attachments/good", body: Readable.from([Buffer.from("ab"), Buffer.from("cd")]) });
    assert.equal((await new LocalStorageAdapter(dir).statObject("attachments/good")).sizeBytes, 4);
    await assert.rejects(storage.putObject({ key: "attachments/bad-hash", body: "abcd", sha256: "invalid" }), /sha256/);
    assert.deepEqual(await readdir(join(dir, "attachments")), ["good"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("shared storage rejects traversal and symlink escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tw-storage-")), outside = await mkdtemp(join(tmpdir(), "tw-outside-"));
  try {
    const storage = new LocalStorageAdapter(dir);
    for (const key of ["../outside", "/absolute", "..\\outside", "a/../b", "a\0b"])
      await assert.rejects(storage.putObject({ key, body: "fixture" }));
    await symlink(outside, join(dir, "linked"));
    await assert.rejects(storage.putObject({ key: "linked/escape", body: "fixture" }), /symbolic links/);
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
