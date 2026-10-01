import assert from "node:assert/strict";
import test from "node:test";
import versionRoutes from "./version.js";

test("version endpoints expose build metadata without database access and honor disabled checks", async () => {
  const previous = process.env.TW_VERSION_CHECK_ENABLED;
  process.env.TW_VERSION_CHECK_ENABLED = "false";
  try {
    for (const [path, method] of [["/", "GET"], ["/check", "POST"]]) {
      const response = await versionRoutes.request(path!, { method });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, "disabled");
      assert.equal(result.installed.version, "0.3.0");
      assert.equal(result.latest, null);
    }
  } finally {
    if (previous === undefined) delete process.env.TW_VERSION_CHECK_ENABLED;
    else process.env.TW_VERSION_CHECK_ENABLED = previous;
  }
});
