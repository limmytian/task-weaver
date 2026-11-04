import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dependencyContext } from './dependency-context.js';

test('provides accessible dependency metadata and available delivery references', async () => {
  const read = async <T>(path: string): Promise<T> => {
    if (path.endsWith('/dependencies')) return { dependencies: [{ type: 'blocks', dependsOnRequirementId: 'source' }, { type: 'related', dependsOnRequirementId: 'hidden' }] } as T;
    if (path.endsWith('/hidden')) throw new Error('forbidden');
    return { id: 'source', title: 'Design', status: 'done', description: 'API contract', documentLinks: [{ document: { id: 'doc', title: 'Interface' } }], workflowOutputs: [{ id: 'output', type: 'attachment', summary: 'Schema', availability: 'available' }, { id: 'retired', type: 'local', availability: 'retired' }] } as T;
  };
  const context = await dependencyContext(read, 'target');
  assert.match(context, /Design/);
  assert.match(context, /Interface/);
  assert.match(context, /Schema/);
  assert.match(context, /"id":"hidden","unavailable":true/);
  assert.doesNotMatch(context, /retired/);
  assert.match(context, /not automatically transferred/);
});

test('limits dependency context and reports inaccessible lists', async () => {
  const missing = await dependencyContext(async () => { throw new Error('denied'); }, 'target');
  assert.match(missing, /could not be loaded/);
  let reads = 0;
  const context = await dependencyContext(async <T>(path: string): Promise<T> => {
    if (path.endsWith('/dependencies')) return { dependencies: Array.from({ length: 23 }, (_, i) => ({ dependsOnRequirementId: String(i), type: 'blocks' })) } as T;
    reads++; return { id: path.split('/').pop(), title: 'A', status: 'done' } as T;
  }, 'target');
  assert.equal(reads, 20);
  assert.match(context, /3 more dependencies omitted/);
});
