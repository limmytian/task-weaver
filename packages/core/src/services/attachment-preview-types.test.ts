import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPreviewType } from './attachments';

test('attachment previews allow only passive formats', () => {
  assert.equal(attachmentPreviewType('video/mp4'), 'video/mp4');
  assert.equal(attachmentPreviewType('audio/mpeg'), 'audio/mpeg');
  assert.equal(attachmentPreviewType('image/svg+xml'), null);
  assert.equal(attachmentPreviewType('text/html'), null);
  assert.equal(attachmentPreviewType('application/javascript'), null);
});
