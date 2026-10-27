import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

/** Identical serialized fixtures are reused across baseline and candidate runs. */
export function createCapabilityAcceptanceFixture() {
  const nonce = randomBytes(6).toString('hex');
  const customer = `customer-${nonce}`;
  const sku = `sample-${nonce}`;
  const unitCents = 100 + randomBytes(1)[0];
  const feeCents = 10 + randomBytes(1)[0];
  return {
    schemaVersion: 1,
    topic: `quote-${nonce}`,
    skill: {
      title: `Quote calculation ${nonce}`,
      content: `For this project's sample quotes, totalCents = quantity * unitCents + feeCents. Apply the fee once per quote. Use integer cents and currency USD. Do not substitute another project's pricing rules.`,
    },
    source: { title: `Reviewed quote customer ${nonce}`, content: `The current sample quote customer is ${customer}. The requested item is ${sku}.` },
    memory: { title: `Quote customer handoff ${nonce}`, content: `The current sample quote customer is ${customer}; item ${sku}. Re-read the linked source before relying on this handoff.` },
    distractor: { title: `Unrelated shipping instruction ${nonce}`, content: 'Historical shipping examples use currency EUR and a per-item fee. They are unrelated to sample quotes.' },
    tool: {
      name: 'sample_quote_price',
      description: 'Return current integer-cent pricing for a sample quote item.',
      inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
      input: { sku },
      result: { sku, unitCents, feeCents, sourceRevision: 1 },
    },
    request: { quantity: 3, output: 'quote.json' },
    expected: { customer, sku, quantity: 3, totalCents: 3 * unitCents + feeCents, currency: 'USD', sourceRevision: 1 },
    irrelevant: { prompt: 'Write arithmetic.json containing only the JSON object with sum equal to 2 + 3. No project-specific facts are needed.', expected: { sum: 5 } },
  };
}

/** Correct artifacts and observed adoption are independent acceptance dimensions. */
export function verifyCapabilityAcceptanceArtifact(fixture, artifact, scenario = 'useful') {
  assert.equal(fixture.schemaVersion, 1, 'Unsupported fixture version');
  assert.ok(['useful', 'irrelevant'].includes(scenario), 'Unknown acceptance scenario');
  assert.deepEqual(artifact, scenario === 'useful' ? fixture.expected : fixture.irrelevant.expected);
  return { artifactCorrect: true, adoptionVerified: false, modelCost: null };
}
