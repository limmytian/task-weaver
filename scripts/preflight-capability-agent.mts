import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../apps/cli/src/async-command';
import { buildAiEnvironment } from '../apps/cli/src/repository-credentials';

const args = new Set(process.argv.slice(2));
if ([...args].some(arg => arg !== '--run-real-model')) throw new Error('Only --run-real-model is supported');
const root = await mkdtemp(join(tmpdir(), 'tw-capability-agent-preflight-'));
const summary = (result: Awaited<ReturnType<typeof runCommand>>) => ({
  exitCode: result.status, timedOut: result.timedOut, durationMs: result.durationMs,
  outputTruncated: result.outputTruncated,
});

try {
  const nativeEnvironment = buildAiEnvironment(process.env, { HOME: homedir() });
  const workerEnvironment = buildAiEnvironment(process.env, {
    HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
  });
  const version = await runCommand('agy', ['--version'], { cwd: root, env: nativeEnvironment, timeoutMs: 15_000, maxOutputBytes: 4096 });
  const native = await runCommand('agy', ['models'], { cwd: root, env: nativeEnvironment, timeoutMs: 15_000, maxOutputBytes: 16384 });
  const isolated = await runCommand('agy', ['models'], { cwd: root, env: workerEnvironment, timeoutMs: 15_000, maxOutputBytes: 16384 });
  const validVersion = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version.stdout.trim()) ? version.stdout.trim() : null;
  const modelsVisible = (result: typeof native) => result.ok && !result.outputTruncated && /^\S+\t\S+/m.test(result.stdout);
  const receipt: Record<string, unknown> = {
    schemaVersion: 1, executable: 'agy', version: validVersion,
    nativeProfile: { ...summary(native), modelsVisible: modelsVisible(native) },
    isolatedWorker: { ...summary(isolated), modelsVisible: modelsVisible(isolated), localSkillsInitiallyEmpty: true },
    modelInvocation: null, modelCost: null, taskQuality: 'not_tested',
    capabilityAdoption: 'not_tested', daemonExecution: 'not_tested',
    authenticationCopied: false, installedDependencies: false,
  };
  if (args.has('--run-real-model')) {
    const result = await runCommand('agy', ['--print-timeout', '60s', '--output-format', 'json',
      '--print=This is a bounded connectivity check. Do not use tools, read files, or modify anything. Reply exactly TW_ACCEPTANCE_READY.'],
    { cwd: root, env: nativeEnvironment, timeoutMs: 65_000, maxOutputBytes: 65536 });
    let response: { status?: unknown; response?: unknown; usage?: Record<string, unknown> } | undefined;
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (value && typeof value === 'object' && !Array.isArray(value)) response = value;
    } catch { /* An invalid or truncated response is not successful connectivity. */ }
    const usage: Record<string, number | null> = {};
    for (const key of ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens']) {
      const value = response?.usage?.[key];
      usage[key] = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    receipt.modelInvocation = { ...summary(result),
      correctResponse: result.ok && !result.outputTruncated && response?.status === 'SUCCESS' && typeof response.response === 'string' && response.response.trim() === 'TW_ACCEPTANCE_READY',
      reportedUsage: usage, resolvedModel: null, profile: 'native',
    };
  }
  // Never print upstream diagnostics, conversations, tokens or model-supplied content.
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
