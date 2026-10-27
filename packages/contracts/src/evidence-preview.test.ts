import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceTextPreview, evidenceTablePreview } from './evidence-preview';

test('bounded text preview rejects invalid encoding and never misreports a split UTF-8 sample', () => {
  const input = Buffer.from('a'.repeat(262143) + '中');
  const preview = evidenceTextPreview(input, input.length);
  assert.equal(preview.encoding, 'utf-8'); assert.equal(preview.sampledBytes, 262143); assert.equal(preview.truncated, true);
  assert.equal(evidenceTextPreview(Buffer.from([0xff]), 1).encoding, 'unsupported');
});
test('table parser handles quotes, newlines and inert formulas with bounds', () => {
  const result = evidenceTablePreview('name,value\r\n"a,b","x\ny"\nformula,=2+2', ',');
  assert.deepEqual(result.rows, [['name', 'value'], ['a,b', 'x\ny'], ['formula', '=2+2']]);
  assert.equal(result.malformed, false);
  assert.equal(evidenceTablePreview('"unfinished', ',').malformed, true);
  const large = evidenceTablePreview(Array.from({ length: 120 }, () => 'x'.repeat(5000)).join('\n'), ',');
  assert.equal(large.rows.length, 100); assert.equal(large.rows[0]![0]!.length, 4096); assert.equal(large.truncated, true);
});
