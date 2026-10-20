import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { skillRuntimeProfileSchema, ValidationError, type CapabilityAvailability } from "@task-weaver/contracts";
import type { z } from "zod";
import { capabilityDigest } from "./capability-digest";

export type SkillRuntimeProfile = z.infer<typeof skillRuntimeProfileSchema>;
const exec = promisify(execFile);

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
  const items = await Promise.all(profiles.map(async profile => {
    let availability: CapabilityAvailability;
    try {
      await exec("docker", ["image", "inspect", profile.image, "--format", "{{.Id}}"], { timeout: 1500, maxBuffer: 4096 });
      availability = { state: "available", executionMode: "isolated" };
    } catch { availability = { state: "unavailable", reason: "not_configured", remediation: "Provision this exact image and a dedicated Docker runtime host before invoking the skill." }; }
    return { ...profile, profileHash: capabilityDigest(profile), availability };
  }));
  return { items, status: items.length ? "configured" : "not_configured", network: "none", inheritedCredentials: false, maxOutputBytes: 65536, inputFormat: "json_stdin", outputFormat: "text", persistentArtifacts: false };
}

/** The image and interpreter are operator-controlled; package code only runs inside Docker. */
export async function executeIsolatedSkill(profile: SkillRuntimeProfile, directory: string, scriptPath: string, input: unknown, signal: AbortSignal) {
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded, "utf8") > 16384) throw new ValidationError("Skill input exceeds the 16384-byte limit");
  signal.throwIfAborted();
  const name = `tw-skill-${randomUUID()}`;
  const interpreter = profile.interpreter === "shell" ? "/bin/sh" : profile.interpreter === "python" ? "python3" : "node";
  const args = ["run", "--rm", "--pull=never", "--name", name, "--label", "task-weaver.skill-runtime=true", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1", "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", "--workdir=/work/root", "--mount", `type=bind,src=${directory},dst=/work,readonly`, "--env=TW_SKILL_MANIFEST=/work/manifest.json", "--entrypoint", interpreter, "-i", profile.image, `/work/root/${scriptPath}`];
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
    void exec("docker", ["rm", "--force", name], { timeout: 5000, maxBuffer: 4096 }).catch(() => undefined);
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
    await exec("docker", ["rm", "--force", name], { timeout: 5000, maxBuffer: 4096 }).catch(() => undefined);
  }
}
