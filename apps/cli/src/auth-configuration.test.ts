import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Command } from 'commander'
import { configFilePath, loadConfig, saveConfig } from './config.js'
import { request } from './client.js'
import { loginWithApiKey, logoutLocal, registerAuth, validateApiUrl } from './commands/auth.js'

const token = `tw_${'a'.repeat(64)}`

test('CLI credentials preserve metadata, verify stable identity and never trust actor headers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-auth-config-'))
  const previous = { dir: process.env.TW_CONFIG_DIR, key: process.env.TW_API_KEY, url: process.env.TW_API_URL }
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const output: string[] = []
  try {
    process.env.TW_CONFIG_DIR = directory
    delete process.env.TW_API_KEY
    delete process.env.TW_API_URL
    const metadata = { apiUrl: 'https://tw.example', clientId: 'client-1', nodeId: 'node-1', actorId: 'forged-actor', daemonInstanceIds: { executor: 'instance-1' }, repositoryCredentialProfiles: {} }
    saveConfig(metadata)
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(configFilePath()).mode & 0o777, 0o600)
    let actorType: 'human' | 'agent' = 'human'
    let responseStatus = 200
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-actor-id'), null)
      assert.equal(headers.get('x-actor-type'), null)
      assert.equal(init?.redirect, 'error')
      if (String(input).endsWith('/health')) return Response.json({ status: 'ok' })
      assert.equal(headers.get('authorization'), `Bearer ${token}`)
      return Response.json(responseStatus === 200 ? { actor: { id: 'stable-principal', type: actorType }, account: null, session: null } : { error: 'invalid_credential' }, { status: responseStatus })
    }
    assert.equal((await loginWithApiKey('https://tw.example', token)).actor.type, 'human')
    assert.deepEqual(loadConfig(), { ...metadata, apiKey: token })
    actorType = 'agent'
    assert.equal((await loginWithApiKey('https://tw.example', token)).actor.type, 'agent')
    responseStatus = 401
    const before = readFileSync(configFilePath(), 'utf8')
    await assert.rejects(loginWithApiKey('https://other.example', token))
    assert.equal(readFileSync(configFilePath(), 'utf8'), before)
    console.log = (...args: unknown[]) => { output.push(args.join(' ')) }
    const program = new Command()
    registerAuth(program)
    await program.parseAsync(['auth', 'status', '--json'], { from: 'user' })
    const status = JSON.parse(output.at(-1)!)
    assert.equal(status.reachability, 'reachable')
    assert.equal(status.authentication, 'invalid or missing credential')
    assert.ok(!output.join('').includes(token))
    logoutLocal()
    assert.deepEqual(loadConfig(), { ...metadata, apiKey: undefined })
    process.env.TW_API_KEY = token
    assert.equal(loadConfig().apiKey, token)
    await request('GET', '/api/v1/auth/me').catch(() => {})
    writeFileSync(configFilePath(), '{invalid')
    assert.throws(loadConfig, /Unable to read/)
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    for (const [name, value] of [['TW_CONFIG_DIR', previous.dir], ['TW_API_KEY', previous.key], ['TW_API_URL', previous.url]]) {
      if (value === undefined) delete process.env[name!]
      else process.env[name!] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI login rejects credentials in URLs, cleartext remote origins and malformed keys', async () => {
  for (const url of ['http://tw.example', 'https://user:password@tw.example', 'https://tw.example/path', 'https://tw.example?key=secret']) {
    assert.throws(() => validateApiUrl(url))
  }
  assert.equal(validateApiUrl('http://127.0.0.1:3001'), 'http://127.0.0.1:3001')
  await assert.rejects(loginWithApiKey('https://tw.example', 'legacy-key'), /subject-bound/)
})


test('Agent inspection commands use bounded shared contracts and explicit retired filters', async () => {
  const previousUrl = process.env.TW_API_URL;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const urls: URL[] = [];
  try {
    process.env.TW_API_URL = 'https://tw.example';
    globalThis.fetch = async (input) => {
      urls.push(new URL(String(input)));
      return Response.json([]);
    };
    console.log = () => {};
    const run = async (args: string[]) => {
      const program = new Command();
      registerAuth(program);
      await program.parseAsync(['auth', 'agents', ...args], { from: 'user' });
    };
    await run(['list', '--json']);
    assert.equal(urls.at(-1)?.searchParams.get('status'), 'active');
    assert.equal(urls.at(-1)?.searchParams.get('pageSize'), '20');
    await run(['list', '--status', 'disabled', '--query', 'Duplicate & fixture', '--page', '2', '--json']);
    assert.equal(urls.at(-1)?.searchParams.get('query'), 'Duplicate & fixture');
    assert.equal(urls.at(-1)?.searchParams.get('status'), 'disabled');
    assert.equal(urls.at(-1)?.searchParams.get('page'), '2');
    const count = urls.length;
    await assert.rejects(run(['list', '--page-size', '51']));
    assert.equal(urls.length, count);
    const actorId = '11111111-1111-4111-8111-111111111111';
    await run(['projects', actorId, '--view', 'available', '--page-size', '10', '--json']);
    assert.equal(urls.at(-1)?.pathname, `/api/v1/auth/agents/${actorId}/projects`);
    assert.equal(urls.at(-1)?.searchParams.get('pageSize'), '10');
    await assert.rejects(run(['get', 'invalid-id']));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (previousUrl === undefined) delete process.env.TW_API_URL;
    else process.env.TW_API_URL = previousUrl;
  }
});
