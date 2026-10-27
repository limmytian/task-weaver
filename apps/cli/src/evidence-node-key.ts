import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { evidenceRegistrationPayload } from '@task-weaver/contracts';
import { configFilePath } from './config.js';

/** Private key stays in the user's protected local CLI configuration directory. */
function localNodePrivateKey() {
  const directory = dirname(configFilePath());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe node key directory');
  chmodSync(directory, 0o700);
  const path = join(directory, 'evidence-node-key.pem');
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe node key permissions');
      const key = createPrivateKey(readFileSync(fd));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid node key type');
      return key;
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pair = generateKeyPairSync('ed25519');
  try {
    writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    return pair.privateKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return localNodePrivateKey();
    throw error;
  }
}

export function signEvidenceRegistration(input: { requirementId: string; nodeId: string; relativePath: string; sizeBytes: number; sha256: string }) {
  const key = localNodePrivateKey();
  return {
    nodePublicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
    nodeRegistrationProof: sign(null, Buffer.from(evidenceRegistrationPayload(input), 'utf8'), key).toString('base64'),
  };
}
