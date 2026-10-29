import assert from "node:assert/strict";

/** Validate run identity obtained from the GitHub Actions API, not event payload text. */
export function promotionIdentity(run, { repository, runId, attempt, kind, commit, version }) {
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(runId ?? "", /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0);
  assert.match(commit ?? "", /^[a-f0-9]{40}$/);
  assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(["main", "release"].includes(kind));
  assert.equal(String(run.id), runId, "Actions run ID mismatch");
  assert.equal(run.run_attempt, attempt, "Actions attempt mismatch");
  assert.equal(run.repository?.full_name?.toLowerCase(), repository.toLowerCase(), "Actions repository mismatch");
  assert.equal(run.status, "in_progress", "Only the running publisher may promote");
  if (kind === "main") {
    assert.equal(run.path, ".github/workflows/release-gates.yml", "Unexpected workflow");
    assert.equal(run.event, "push"); assert.equal(run.head_branch, "main"); assert.equal(run.head_sha, commit);
  } else {
    assert.equal(run.path, ".github/workflows/ce-release.yml", "Unexpected workflow");
    assert.equal(run.event, "workflow_dispatch");
  }
  const imageVersion = kind === "main" ? `${version}-main.${runId}.${attempt}` : version;
  assert.ok(imageVersion.length <= 128, "Version tag exceeds OCI limits");
  return { version: imageVersion, commit };
}
