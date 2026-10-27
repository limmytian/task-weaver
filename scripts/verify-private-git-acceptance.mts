import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../apps/cli/src/async-command';

// The caller must have explicit owner authorization for this disposable remote.
assert.deepEqual(process.argv.slice(2), ['--confirm-disposable-private-remote']);
const remote = new URL(process.env.TW_ACCEPTANCE_GIT_URL ?? '');
assert.equal(remote.protocol, 'https:');
assert.equal(remote.username + remote.password + remote.search + remote.hash, '');
const expectedMain = process.env.TW_ACCEPTANCE_GIT_MAIN;
assert.match(expectedMain ?? '', /^[a-f0-9]{40,64}$/);
const root = await mkdtemp(join(tmpdir(), 'tw-private-git-acceptance-'));
const a = join(root, 'target'), b = join(root, 'worker');
const prefix = `acceptance/${randomUUID()}`;
const target = `${prefix}/target`, worker = `${prefix}/worker`;
const branches = [target, worker];
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Task Weaver Acceptance', GIT_AUTHOR_EMAIL: 'acceptance@example.test',
  GIT_COMMITTER_NAME: 'Task Weaver Acceptance', GIT_COMMITTER_EMAIL: 'acceptance@example.test' };
const receipt = { schemaVersion: 1, authenticatedRead: false, authenticatedPush: false,
  targetAdvanceObserved: false, mergeConflictObserved: false, conflictAbortPreservedCommit: false,
  uncertaintyInjection: 'withhold_result_after_real_push', uncertainWriteReconciled: false,
  uncertainWriteReplayed: false, mainUnchanged: false, remoteBranchesRemoved: false,
  localClonesRemoved: false, realAgent: false, independentPhysicalNodes: false, completed: false };
const git = async (args: string[], cwd = root, allowFailure = false) => {
  const result = await runCommand('git', args, { cwd, env, timeoutMs: 30_000, maxOutputBytes: 16384 });
  if (!allowFailure) assert.ok(result.ok && !result.outputTruncated, 'Git acceptance operation failed; inspect the current remote before retrying');
  return result;
};
const ref = async (branch: string) => {
  const result = await git(['ls-remote', remote.href, `refs/heads/${branch}`]);
  return result.stdout.trim().split(/\s/)[0] ?? '';
};
const commit = async (cwd: string, content: string) => {
  await writeFile(join(cwd, 'acceptance.txt'), content);
  await git(['add', 'acceptance.txt'], cwd);
  await git(['-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'Update synthetic acceptance fixture'], cwd);
  return (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
};
try {
  assert.equal(await ref('main'), expectedMain, 'Fixture main changed before acceptance');
  await git(['clone', '--no-tags', remote.href, a]);
  receipt.authenticatedRead = true;
  await git(['checkout', '-b', target, 'origin/main'], a);
  const base = await commit(a, 'base\n');
  await git(['push', 'origin', `HEAD:refs/heads/${target}`], a);
  await git(['clone', '--no-tags', remote.href, b]);
  await git(['checkout', '-b', worker, `origin/${target}`], b);
  assert.equal((await git(['rev-parse', 'HEAD'], b)).stdout.trim(), base);
  const advanced = await commit(a, 'target advance\n');
  await git(['push', 'origin', `HEAD:refs/heads/${target}`], a);
  const workerTip = await commit(b, 'worker conflict\n');
  // The trusted harness confirms the write happened, then withholds its result
  // from the simulated controller. This is not a real network outage claim.
  await git(['push', 'origin', `HEAD:refs/heads/${worker}`], b);
  receipt.authenticatedPush = true;
  assert.equal(await ref(worker), workerTip);
  receipt.uncertainWriteReconciled = true;
  await git(['fetch', 'origin', target], b);
  assert.equal((await git(['rev-parse', 'FETCH_HEAD'], b)).stdout.trim(), advanced);
  receipt.targetAdvanceObserved = true;
  const merge = await git(['-c', 'commit.gpgsign=false', 'merge', '--no-commit', '--no-ff', 'FETCH_HEAD'], b, true);
  assert.equal(merge.status, 1);
  assert.match((await git(['ls-files', '--unmerged'], b)).stdout, /acceptance\.txt/);
  receipt.mergeConflictObserved = true;
  await git(['merge', '--abort'], b);
  assert.equal((await git(['rev-parse', 'HEAD'], b)).stdout.trim(), workerTip);
  assert.equal((await git(['status', '--porcelain'], b)).stdout.trim(), '');
  receipt.conflictAbortPreservedCommit = true;
  assert.equal(await ref('main'), expectedMain);
  receipt.mainUnchanged = true;
  receipt.completed = true;
} catch {
  process.exitCode = 1;
} finally {
  try {
    for (const branch of branches) {
      if (await ref(branch)) await git(['push', remote.href, '--delete', branch], a);
      assert.equal(await ref(branch), '');
    }
    receipt.remoteBranchesRemoved = true;
    assert.equal(await ref('main'), expectedMain);
    receipt.mainUnchanged = true;
  } catch { receipt.completed = false; process.exitCode = 1; }
  await rm(root, { recursive: true, force: true });
  receipt.localClonesRemoved = true;
  console.log(JSON.stringify(receipt, null, 2));
}
