import assert from "node:assert";
import { test } from "node:test";
import { searchItemsResponse, typedSearchItems } from "./search.js";

test("searchItemsResponse wraps REST search results in a canonical items envelope", () => {
  assert.deepEqual(searchItemsResponse([{ id: "doc-1", title: "Design" }]), {
    items: [{ id: "doc-1", title: "Design" }],
  });
});

test("typedSearchItems preserves object fields and enforces route-level types", () => {
  assert.deepEqual(typedSearchItems("task", [{ id: "task-1", title: "Implement", type: "document" }, "loose"]), [
    { type: "task", id: "task-1", title: "Implement" },
    { type: "task", value: "loose" },
  ]);
});
