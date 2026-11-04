import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gitDiffLines } from './git-diff-lines';

test('maps added, removed and context lines across hunks', () => {
  const rows = gitDiffLines('@@ -5,2 +5,3 @@\n context\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -20 +21 @@\n-last\n+next');
  assert.deepEqual(rows.filter(row => row.line !== undefined).map(({ side, line }) => [side, line]), [['new', 5], ['old', 6], ['new', 6], ['new', 7], ['old', 20], ['new', 21]]);
});
