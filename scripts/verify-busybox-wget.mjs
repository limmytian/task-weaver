#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function probe() {
  const requests = [];
  const server = net.createServer((socket) => socket.on("data", (data) => {
    const request = data.toString("latin1");
    requests.push(request);
    const redirect = request.startsWith("GET /redirect ");
    socket.end(redirect
      ? "HTTP/1.1 302 Found\r\nLocation: /encoded%20space\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      : "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  }));
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (url) => new Promise((resolveRun, reject) => {
    const child = spawn("/bin/busybox", ["wget", "-q", "-O", "/dev/null", url], { stdio: "ignore" });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("wget timed out")); }, 5000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolveRun(code); });
  });
  try {
    assert.equal(await run(`${base}/encoded%20space`), 0, "Normal encoded URL failed");
    assert.equal(await run(`${base}/redirect`), 0, "Normal redirect failed");
    const accepted = [];
    for (let byte = 1; byte <= 32; byte++) {
      const before = requests.length;
      const status = await run(`${base}/unsafe${String.fromCharCode(byte)}injected`);
      if (status === null) throw new Error(`wget terminated by signal for byte ${byte}`);
      if (status === 0 || requests.length !== before) accepted.push(byte);
    }
    console.log(JSON.stringify({ accepted, requests: requests.length, normalAndRedirectPassed: true }));
    assert.deepEqual(accepted, [], "Raw control characters or spaces were accepted");
  } finally {
    server.close();
  }
}

if (process.argv[2] === "--inside") {
  await probe();
} else {
  const [image, platform = "linux/arm64"] = process.argv.slice(2);
  if (!image) throw new Error("Usage: node scripts/verify-busybox-wget.mjs <local-image> [linux/arm64|linux/amd64]");
  const { inspectLocalImage } = await import("./image-inspection-lib.mjs");
  const details = inspectLocalImage(image, platform);
  const result = spawnSync("docker", ["run", "--rm", "--platform", platform, "--network", "none",
    "--read-only", "--entrypoint", "node", "--mount",
    `type=bind,src=${fileURLToPath(import.meta.url)},dst=/tmp/wget-probe.mjs,readonly`,
    image, "/tmp/wget-probe.mjs", "--inside"], { encoding: "utf8", timeout: 180000 });
  assert.equal(inspectLocalImage(image, platform).Id, details.Id, "Image changed during verification");
  const report = { schemaVersion: 1, image, imageId: details.Id, platform,
    passed: result.status === 0, output: result.stdout.trim(),
    error: result.status === 0 ? undefined : (result.error?.message ?? result.stderr.trim()),
    scope: "Loopback wget request targets and redirect; not a distribution approval" };
  const directory = resolve("release-artifacts/busybox-wget", details.Id.slice(7));
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result.status, 0, "BusyBox wget verification failed");
}
