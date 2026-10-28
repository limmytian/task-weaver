import assert from "node:assert/strict";
import test from "node:test";
import { getText } from "./binary-source-lib.mjs";

const url = "https://raw.githubusercontent.com/example/project/immutable-ref/metadata";
const response = (status, body = "", redirect = "") => ({ status: 0, stdout: `${body}\n${status}\n${redirect}` });
function fixture(results, duration = 0) {
  let time = 0;
  const calls = [];
  const delays = [];
  return {
    calls, delays,
    options: {
      now: () => time,
      sleep: (ms) => { delays.push(ms); time += ms; },
      execute: (command, args, options) => {
        calls.push({ command, args, options });
        time += duration;
        assert.ok(results.length, "unexpected extra request");
        return results.shift();
      },
    },
  };
}

test("safe metadata GET retries transient transport/status failures and preserves bytes", () => {
  const f = fixture([{ status: 28, stderr: "sensitive upstream diagnostic" }, response(503), response(200, "\nmetadata\n200\n\n")]);
  assert.equal(getText(url, f.options), "\nmetadata\n200\n\n");
  assert.deepEqual(f.delays, [250, 500]);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) {
    assert.equal(call.command, "curl");
    assert.equal(call.args[0], "--disable");
    assert.ok(!call.args.includes("--location"));
    assert.ok(!call.args.includes("--insecure"));
    assert.equal(call.args.at(-1), url, "immutable request identity must not change on retry");
    assert.equal(call.args[call.args.indexOf("--write-out") + 1], "\\n%{http_code}\\n%{redirect_url}");
    assert.ok(call.options.timeout <= 90_000);
  }
});

test("GitHub API metadata uses the scoped token without forwarding it across redirects", () => {
  const api = "https://api.github.com/repos/example/project/contents/path?ref=immutable";
  const f = fixture([response(302, "", "https://raw.githubusercontent.com/example/project/immutable-ref/file"), response(200, "metadata")]);
  assert.equal(getText(api, { ...f.options, githubToken: "test-token" }), "metadata");
  assert.ok(f.calls[0].args.includes("@-"));
  assert.equal(f.calls[0].options.input, "Authorization: Bearer test-token\nAccept: application/vnd.github+json\n");
  assert.ok(!f.calls[1].args.some((argument) => argument.includes("test-token")));
  assert.equal(f.calls[1].options.input, undefined);

  const publicMetadata = fixture([response(200, "metadata")]);
  assert.equal(getText(url, { ...publicMetadata.options, githubToken: "test-token" }), "metadata");
  assert.ok(!publicMetadata.calls[0].args.some((argument) => argument.includes("test-token")));
});

test("authentication, TLS and local process failures are never retried or disclosed", () => {
  for (const result of [response(401), response(403), response(404), { status: 35 }, { status: 60 },
    { status: 0, stdout: "malformed" }, { error: new Error("secret-path"), status: null }, { status: null, signal: "SIGTERM" }]) {
    const f = fixture([result]);
    assert.throws(() => getText(`${url}?token=secret`, f.options), error => {
      assert.match(error.message, /Upstream metadata unavailable/);
      assert.doesNotMatch(error.message, /secret|sensitive|immutable-ref/);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.delays, []);
  }
});

test("retry and overall deadline budgets stay finite", () => {
  const f = fixture([response(429), response(502), response(504)]);
  assert.throws(() => getText(url, f.options), /HTTP 504; requests=3/);
  assert.deepEqual(f.delays, [250, 500]);
  const slow = fixture([{ status: 28 }, { status: 28 }], 45_000);
  assert.throws(() => getText(url, slow.options), /deadline exhausted/);
  assert.equal(slow.calls.length, 2);
  assert.equal(slow.calls[1].options.timeout, 44_750);
});

test("every redirect is allowlisted before contact and loops have a shared budget", () => {
  const target = "https://codeload.github.com/example/project/immutable-ref";
  const f = fixture([response(302, "", target), response(200, "pinned contents")]);
  assert.equal(getText(url, f.options), "pinned contents");
  assert.equal(f.calls[1].args.at(-1), target);
  for (const target of ["http://github.com/a", "https://127.0.0.1/private", "https://unapproved.example/secret", "https://user:secret@github.com/a"]) {
    const denied = fixture([response(302, "", target)]);
    assert.throws(() => getText(url, denied.options), /redirect target rejected/);
    assert.equal(denied.calls.length, 1);
  }
  const loop = fixture(Array.from({ length: 6 }, () => response(302, "", url)));
  assert.throws(() => getText(url, loop.options), /redirect budget exhausted; requests=6/);
  const invalid = fixture([]);
  assert.throws(() => getText("https://localhost/secret", invalid.options));
  assert.equal(invalid.calls.length, 0);
});
