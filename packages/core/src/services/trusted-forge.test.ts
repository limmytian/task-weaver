import assert from "node:assert/strict";
import test from "node:test";
import { parseTrustedPullRequestUrl, readTrustedPullRequest } from "./trusted-forge";
const repository = { id: "11111111-1111-4111-8111-111111111111", host: "github.com", namespace: "acme", name: "app", provider: "github" };
const payload = { number: 12, html_url: "https://github.com/acme/app/pull/12", state: "closed", merged: true, merged_at: "2026-10-15T10:00:00Z", merge_commit_sha: "c".repeat(40), head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "acme/app" } } };
test("trusted forge rejects foreign, credentialed and unsupported pull request references", () => {
  for (const url of ["http://github.com/acme/app/pull/12", "https://evil.test/acme/app/pull/12", "https://user:secret@github.com/acme/app/pull/12", "https://github.com/acme/other/pull/12", "https://github.com/acme/app/pull/12?token=secret", "https://github.com/acme/app/pull/12#fragment", "https://github.com/acme/app/pull/0"]) assert.throws(() => parseTrustedPullRequestUrl(repository, url));
});
test("trusted server fetch derives API paths, refuses redirects and validates merge evidence", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.github.com/repos/acme/app/pulls/12");
    assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), null);
    return Response.json(payload);
  };
  const snapshot = await readTrustedPullRequest(repository, payload.html_url, { fetch: fetcher });
  assert.equal(snapshot.state, "merged"); assert.equal(snapshot.mergeCommit, "c".repeat(40));
  for (const changes of [{ merged_at: null }, { merge_commit_sha: null }, { number: 13 }, { base: { ...payload.base, repo: { full_name: "evil/app" } } }]) await assert.rejects(readTrustedPullRequest(repository, payload.html_url, { fetch: async () => Response.json({ ...payload, ...changes }) }));
  await assert.rejects(readTrustedPullRequest(repository, payload.html_url, { fetch: async () => new Response(null, { status: 403 }) }), /HTTP 403/);
});
test("trusted forge response size is bounded while streaming", async () => {
  let cancelled = false; let pulled = 0;
  const response = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(1_000_001)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readTrustedPullRequest(repository, payload.html_url, { fetch: async () => response() }), /exceeds the supported size/);
  assert.equal(cancelled, true); assert.ok(pulled <= 3);
});
test("Git evidence resolves the base once and fetches pinned commits after branch movement", async () => {
  const { pinTrustedGitComparison, readTrustedGitComparison } = await import("./trusted-forge");
  const base = "a".repeat(40), head = "b".repeat(40), mergeBase = "c".repeat(40);
  let tip = base; const paths: string[] = [];
  const fetcher: typeof fetch = async url => {
    paths.push(String(url));
    if (String(url).endsWith("/branches/main")) return Response.json({ name: "main", commit: { sha: tip } });
    assert.ok(String(url).endsWith(`/compare/${base}...${head}`));
    return Response.json({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase }, files: [{ filename: "新.txt", previous_filename: "old.txt", status: "renamed", patch: "+content" }, { filename: "asset.bin", status: "modified" }] });
  };
  const pinned = await pinTrustedGitComparison(repository, "main", head, { fetch: fetcher });
  tip = "d".repeat(40);
  const result = await readTrustedGitComparison(repository, pinned, { fetch: fetcher });
  assert.equal(result.baseCommit, base); assert.equal(result.comparisonCommit, mergeBase);
  assert.equal(result.files[0]?.previousPath, "old.txt"); assert.equal(result.files[1]?.patchState, "unavailable");
  assert.equal(paths.filter(path => path.endsWith("/branches/main")).length, 1);
  await assert.rejects(readTrustedGitComparison(repository, { ...pinned, comparisonCommit: "e".repeat(40) }, { fetch: fetcher }), /identity changed/);
  await assert.rejects(pinTrustedGitComparison(repository, "main", "--upload-pack=evil", { fetch: fetcher }));
});
test("Gitea uses only its configured trusted API origin", async () => {
  const repo = { ...repository, host: "forge.example", provider: "gitea" };
  const url = "https://forge.example/acme/app/pulls/12";
  await assert.rejects(readTrustedPullRequest(repo, url), /trusted server forge connection/);
  const result = await readTrustedPullRequest(repo, url, { connection: { host: repo.host, provider: "gitea", apiBaseUrl: "https://api.forge.example/api/v1", repositoryIds: [repo.id], repositories: ["acme/app"] }, fetch: async (path, init) => {
    assert.equal(String(path), "https://api.forge.example/api/v1/repos/acme/app/pulls/12"); assert.equal(init?.redirect, "error");
    return Response.json({ ...payload, html_url: url });
  } });
  assert.equal(result.state, "merged");
});

test("server credentials are scoped to both catalog ID and canonical repository identity", async () => {
  for (const scope of [{ repositoryIds: ["22222222-2222-4222-8222-222222222222"], repositories: ["acme/app"] }, { repositoryIds: [repository.id], repositories: ["other/private"] }]) {
    await assert.rejects(readTrustedPullRequest(repository, payload.html_url, { connection: { host: "github.com", provider: "github", apiBaseUrl: "https://api.github.com", ...scope }, fetch: async () => { throw new Error("Must not fetch an unauthorized repository"); } }), /outside.*scope/);
  }
});

test("direct integration verifies the configured branch tip without requiring a pull request", async () => {
  const { readTrustedDirectMerge } = await import("./trusted-forge");
  const commit = "a".repeat(40);
  const result = await readTrustedDirectMerge(repository, "release/0.3.9", commit, { fetch: async (url, init) => {
    assert.equal(String(url), "https://api.github.com/repos/acme/app/branches/release%2F0.3.9");
    assert.equal(init?.redirect, "error");
    return Response.json({ name: "release/0.3.9", commit: { sha: commit } });
  } });
  assert.equal(result.headCommit, commit); assert.equal(result.targetCommit, commit);
});
test("direct integration accepts an ancestor and rejects unrelated or behind target branches", async () => {
  const { readTrustedDirectMerge } = await import("./trusted-forge");
  for (const status of ["ahead", "behind", "diverged"]) {
    const action = () => readTrustedDirectMerge(repository, "main", "a".repeat(40), { fetch: async url => {
      if (String(url).endsWith("/branches/main")) return Response.json({ name: "main", commit: { sha: "b".repeat(40) } });
      assert.ok(String(url).endsWith(`/compare/${"a".repeat(40)}...${"b".repeat(40)}`));
      return Response.json({ status, base_commit: { sha: "a".repeat(40) }, merge_base_commit: { sha: "a".repeat(40) } });
    } });
    if (status === "ahead") assert.equal((await action()).targetCommit, "b".repeat(40));
    else await assert.rejects(action(), /not contained/);
  }
  await assert.rejects(readTrustedDirectMerge(repository, "main", "a".repeat(40), { fetch: async () => Response.json({ name: "other", commit: { sha: "a".repeat(40) } }) }), /incomplete target branch/);
});
test("Gitea direct integration verifies parent objects and refuses unverifiable ancestry", async () => {
  const { readTrustedDirectMerge } = await import("./trusted-forge");
  const repo = { ...repository, host: "forge.example", provider: "gitea" };
  const connection = { host: repo.host, provider: "gitea" as const, apiBaseUrl: "https://api.forge.example/api/v1", repositoryIds: [repo.id], repositories: ["acme/app"] };
  for (const contained of [true, false]) {
    const action = () => readTrustedDirectMerge(repo, "main", "a".repeat(40), { connection, fetch: async url => {
      if (String(url).endsWith("/branches/main")) return Response.json({ name: "main", commit: { sha: "b".repeat(40) } });
      assert.ok(String(url).endsWith(`/git/commits/${"b".repeat(40)}`));
      return Response.json({ sha: "b".repeat(40), parents: contained ? [{ sha: "a".repeat(40) }] : [] });
    } });
    if (contained) assert.equal((await action()).headCommit, "a".repeat(40));
    else await assert.rejects(action(), /ancestry limit/);
  }
});
