import { spawn } from 'node:child_process';
import { evidenceLimits } from '@task-weaver/contracts';

export type EvidenceGitFile = { status: string; path: string; previousPath?: string };
export type EvidenceGitComparison = { baseCommit: string; headCommit: string; comparisonCommit: string; mode: 'merge-base' | 'direct' };
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** The workspace path must come from the authorized repository manifest, never a browser request. */
async function git(workspace: string, args: string[], limit: number, signal?: AbortSignal): Promise<{ bytes: Buffer; truncated: boolean }> {
  const deadline = AbortSignal.timeout(evidenceLimits.requestDurationMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'ignore'], signal: combined,
    });
    const parts: Buffer[] = []; let bytes = 0; let truncated = false; let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      const room = limit - bytes;
      if (room > 0) { const piece = chunk.subarray(0, room); parts.push(piece); bytes += piece.length; }
      if (chunk.length > room) { truncated = true; child.kill(); }
    });
    child.on('error', error => { if (!settled) { settled = true; reject(error); } });
    child.on('close', code => {
      if (settled) return; settled = true;
      if (combined.aborted) return reject(combined.reason);
      if (code !== 0 && !truncated) return reject(new Error('Git evidence is unavailable'));
      resolve({ bytes: Buffer.concat(parts), truncated });
    });
  });
}

/** Resolve once; all later file and diff reads use these immutable object IDs. */
export async function pinEvidenceComparison(workspace: string, baseCommit: string, headCommit: string, mode: 'merge-base' | 'direct' = 'merge-base', signal?: AbortSignal): Promise<EvidenceGitComparison> {
  if (!oid.test(baseCommit) || !oid.test(headCommit)) throw new Error('Git evidence requires full commit object IDs');
  for (const commit of [baseCommit, headCommit]) await git(workspace, ['cat-file', '-e', `${commit}^{commit}`], 1024, signal);
  const comparisonCommit = mode === 'merge-base' ? (await git(workspace, ['merge-base', baseCommit, headCommit], 1024, signal)).bytes.toString('utf8').trim() : baseCommit;
  if (!oid.test(comparisonCommit)) throw new Error('Git comparison has no valid merge base');
  return { baseCommit, headCommit, comparisonCommit, mode };
}

export async function listEvidenceGitFiles(workspace: string, comparison: EvidenceGitComparison, signal?: AbortSignal) {
  validateComparison(comparison);
  const result = await git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', comparison.comparisonCommit, comparison.headCommit, '--'], evidenceLimits.diffBytes, signal);
  const tokens = result.bytes.toString('utf8').split('\0');
  if (tokens.at(-1) !== '') tokens.pop();
  const files: EvidenceGitFile[] = [];
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++]!; const first = tokens[i++];
    if (!first) break;
    if (/^[RC]/.test(status)) {
      const second = tokens[i++]; if (!second) break;
      files.push({ status, previousPath: first, path: second });
    } else files.push({ status, path: first });
    if (files.length > evidenceLimits.diffFiles) break;
  }
  return { files: files.slice(0, evidenceLimits.diffFiles), truncated: result.truncated || files.length > evidenceLimits.diffFiles };
}

export async function readEvidenceGitDiff(workspace: string, comparison: EvidenceGitComparison, path: string, signal?: AbortSignal) {
  validateComparison(comparison);
  const listing = await listEvidenceGitFiles(workspace, comparison, signal);
  const file = listing.files.find(item => item.path === path);
  if (!file) throw new Error('File is not in the bounded comparison');
  const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
  const result = await git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', comparison.comparisonCommit, comparison.headCommit, '--', ...paths], evidenceLimits.diffBytes, signal);
  return { file, diff: result.bytes.toString('utf8'), truncated: result.truncated };
}

function validateComparison(comparison: EvidenceGitComparison) {
  if (![comparison.baseCommit, comparison.headCommit, comparison.comparisonCommit].every(value => oid.test(value)) || !['merge-base', 'direct'].includes(comparison.mode)) throw new Error('Invalid pinned comparison');
}
