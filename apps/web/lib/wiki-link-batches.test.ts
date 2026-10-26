import assert from "node:assert/strict";
import test from "node:test";
import { resolveWikiLinkBatches } from "./wiki-link-batches";

test("all distinct wiki titles remain reachable with one bounded request at a time", async () => {
  const titles = Array.from({ length: 121 }, (_, index) => `Title ${index}`);
  let active = 0, peak = 0;
  const sizes: number[] = [];
  const result = await resolveWikiLinkBatches([...titles, titles[0]!], async batch => {
    active++; peak = Math.max(peak, active); sizes.push(batch.length);
    await Promise.resolve(); active--;
    return batch.map(title => ({ id: title, title }));
  }, new AbortController().signal);
  assert.deepEqual(result.map(row => row.title), titles);
  assert.deepEqual(sizes, [50, 50, 21]); assert.equal(peak, 1);
});

test("obsolete or failed batches never return partial private resolution results", async () => {
  const controller = new AbortController(); let reads = 0;
  await assert.rejects(resolveWikiLinkBatches(Array(51).fill("a").map((_, i) => String(i)), async titles => {
    reads++; controller.abort(); return titles.map(title => ({ id: title, title }));
  }, controller.signal));
  assert.equal(reads, 1);
  await assert.rejects(resolveWikiLinkBatches(["a"], async () => { throw Error("unavailable"); }, new AbortController().signal));
});
