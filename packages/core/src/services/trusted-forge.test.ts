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
