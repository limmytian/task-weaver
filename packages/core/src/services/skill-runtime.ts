import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { skillRuntimeProfileSchema, ValidationError, type CapabilityAvailability } from "@task-weaver/contracts";
import type { z } from "zod";
import { capabilityDigest } from "./capability-digest";

export type SkillRuntimeProfile = z.infer<typeof skillRuntimeProfileSchema>;
const exec = promisify(execFile);

export async function readonlyImageVolumes(image: string, workspace: boolean): Promise<string[]> {
  const info = await exec("docker", ["info", "--format", "{{json .}}"], { timeout: 1500, maxBuffer: 65536 });
  const limits = JSON.parse(info.stdout) as { OSType: string; MemoryLimit: boolean; CpuCfsQuota: boolean; PidsLimit: boolean };
  if (limits.OSType !== "linux" || !limits.MemoryLimit || !limits.CpuCfsQuota || !limits.PidsLimit) throw new ValidationError("Skill execution requires a Linux engine with enforced memory, CPU and process limits");
  const result = await exec("docker", ["image", "inspect", image, "--format", "{{json .Config.Volumes}}"], { timeout: 1500, maxBuffer: 16384 });
  const value = JSON.parse(result.stdout) as Record<string, unknown> | null;
  const paths = Object.keys(value ?? {});
  if (paths.length > 16 || paths.some(path => path.length > 512 || !/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes(".."))) throw new ValidationError("Runtime image declares unsupported volume paths");
  // Image-declared anonymous volumes must not silently introduce writable disk mounts.
  return paths.filter(path => path !== "/tmp" && !(workspace && path === "/work")).map(path => `--tmpfs=${path}:ro,noexec,nosuid,size=1m`);
}

type RuntimeSnapshot = { availability: CapabilityAvailability; checkedAt: string; recheckAt: string };
const readiness = new Map<string, { expires: number; result: Promise<RuntimeSnapshot> }>();

async function inspectRuntime(profile: SkillRuntimeProfile): Promise<RuntimeSnapshot> {
  const key = capabilityDigest(profile);
  const cached = readiness.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const entry = { expires: Infinity, result: undefined as unknown as Promise<RuntimeSnapshot> };
  entry.result = (async () => {
    let availability: CapabilityAvailability;
    let name: string | undefined;
    try {
      const volumes = await readonlyImageVolumes(profile.image, false);
      name = `tw-skill-probe-${randomUUID()}`;
      const interpreter = profile.interpreter === "shell" ? "/bin/sh" : profile.interpreter === "python" ? "python3" : "node";
      await exec("docker", ["run", "--rm", "--pull=never", "--name", name, "--label=task-weaver.skill-runtime=true", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534", "--memory=64m", "--cpus=0.25", "--pids-limit=16", "--tmpfs=/tmp:rw,noexec,nosuid,size=1m", ...volumes, "--entrypoint", interpreter, profile.image, ...(profile.interpreter === "shell" ? ["-c", "exit 0"] : ["--version"])], { timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4096 });
      availability = { state: "available", executionMode: "isolated" };
    } catch {
      availability = { state: "unavailable", reason: "dependency_missing", remediation: "Provision this exact image and its declared interpreter on the dedicated runtime host." };
    } finally {
      if (name) await exec("docker", ["rm", "--force", "--volumes", name], { timeout: 2500, maxBuffer: 4096 }).catch(() => undefined);
    }
    const checkedAt = new Date().toISOString();
    entry.expires = Date.now() + 30000;
    return { availability, checkedAt, recheckAt: new Date(entry.expires).toISOString() };
  })();
  readiness.set(key, entry);
  if (readiness.size > 32) readiness.delete(readiness.keys().next().value!);
  return entry.result;
}

export function configuredSkillRuntimes(config?: string): SkillRuntimeProfile[] {
  if (!config) return [];
  let value: unknown;
  try { value = JSON.parse(config); } catch { throw new ValidationError("Skill runtime configuration is invalid"); }
  const parsed = skillRuntimeProfileSchema.array().max(16).safeParse(value);
  if (!parsed.success || new Set(parsed.data.map(profile => profile.id)).size !== parsed.data.length) throw new ValidationError("Skill runtime profiles require unique IDs and digest-pinned images");
  return parsed.data;
}

export async function listSkillRuntimes(config?: string) {
  let profiles: SkillRuntimeProfile[];
  try { profiles = configuredSkillRuntimes(config); }
  catch { return { items: [], status: "invalid_configuration", remediation: "Ask an administrator to validate the trusted runtime profile configuration.", network: "none", inheritedCredentials: false, maxOutputBytes: 65536 }; }
  const items = new Array<SkillRuntimeProfile & RuntimeSnapshot & { profileHash: string }>(profiles.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(2, profiles.length) }, async () => {
    while (index < profiles.length) {
      const current = index++, profile = profiles[current]!;
      items[current] = { ...profile, profileHash: capabilityDigest(profile), ...await inspectRuntime(profile) };
    }
  }));
  return { items, status: items.length ? "configured" : "not_configured", network: "none", inheritedCredentials: false, maxOutputBytes: 65536, inputFormat: "json_stdin", outputFormat: "text", persistentArtifacts: false };
}

/** The image and interpreter are operator-controlled; package code only runs inside Docker. */
export async function executeIsolatedSkill(profile: SkillRuntimeProfile, directory: string, scriptPath: string, input: unknown, signal: AbortSignal, inputLimit: 16384 | 131072 = 16384) {
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded, "utf8") > inputLimit) throw new ValidationError("Runtime input exceeds its host byte limit");
  signal.throwIfAborted();
  const name = `tw-skill-${randomUUID()}`;
  const interpreter = profile.interpreter === "shell" ? "/bin/sh" : profile.interpreter === "python" ? "python3" : "node";
  const volumes = await readonlyImageVolumes(profile.image, true).catch(() => { throw new ValidationError("The configured runtime image is unavailable or has unsupported volumes"); });
  const args = ["run", "--rm", "--pull=never", "--name", name, "--label", "task-weaver.skill-runtime=true", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1", "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", ...volumes, "--workdir=/work/root", "--mount", `type=bind,src=${directory},dst=/work,readonly`, "--env=TW_SKILL_MANIFEST=/work/manifest.json", "--entrypoint", interpreter, "-i", profile.image, `/work/root/${scriptPath}`];
  let stdout = "", stderr = "", bytes = 0, timedOut = false, outputTruncated = false;
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const started = Date.now();
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  // Killing the Docker client alone would leave a container running.
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref();
    void exec("docker", ["rm", "--force", "--volumes", name], { timeout: 5000, maxBuffer: 4096 }).catch(() => undefined);
  };
  const onAbort = () => stop();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(() => { timedOut = true; stop(); }, profile.timeoutMs);
  timer.unref();
  const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
    const available = Math.max(0, 65536 - bytes);
    const kept = decoders[target].write(chunk.subarray(0, available));
    if (target === "stdout") stdout += kept; else stderr += kept;
    bytes += chunk.length;
    if (bytes > 65536) { outputTruncated = true; stop(); }
  };
  child.stdout.on("data", chunk => collect("stdout", chunk));
  child.stderr.on("data", chunk => collect("stderr", chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(encoded);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", () => reject(new ValidationError("The configured container runtime is unavailable"))); child.once("close", resolve); });
    signal.throwIfAborted();
    stdout += decoders.stdout.end(); stderr += decoders.stderr.end();
    const bound = (text: string, budget: number) => new StringDecoder("utf8").write(Buffer.from(text).subarray(0, Math.max(0, budget)));
    if (Buffer.byteLength(stdout + stderr) > 65536) outputTruncated = true;
    stdout = bound(stdout, 65536);
    stderr = bound(stderr, 65536 - Buffer.byteLength(stdout));
    if (exitCode !== null && [125, 126, 127].includes(exitCode)) {
      stdout = "";
      stderr = "The configured container runtime or interpreter could not start this skill. Inspect runtime readiness and declared dependencies.";
    }
    return { status: exitCode === 0 && !timedOut && !outputTruncated ? "succeeded" : "failed", exitCode, timedOut, outputTruncated, stdout, stderr, durationMs: Date.now() - started, runtimeImage: profile.image };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal.removeEventListener("abort", onAbort);
    await exec("docker", ["rm", "--force", "--volumes", name], { timeout: 5000, maxBuffer: 4096 }).catch(() => undefined);
  }
}
