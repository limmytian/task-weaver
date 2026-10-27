import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPreviewType, evidenceAttachmentMetadata } from './attachments';

test('attachment previews allow only passive formats', () => {
  assert.equal(attachmentPreviewType('video/mp4'), 'video/mp4');
  assert.equal(attachmentPreviewType('audio/mpeg'), 'audio/mpeg');
  assert.equal(attachmentPreviewType('image/svg+xml'), null);
  assert.equal(attachmentPreviewType('text/html'), null);
  assert.equal(attachmentPreviewType('application/javascript'), null);
});

test('promoted evidence exposes only a safe filename and allowlisted format', () => {
  assert.deepEqual(evidenceAttachmentMetadata('private/path/report.csv'), { originalFilename: 'report.csv', mimeType: 'text/csv' });
  assert.equal(evidenceAttachmentMetadata('private\\active.svg').mimeType, 'application/octet-stream');
  assert.equal(evidenceAttachmentMetadata('secret/page.html').mimeType, 'application/octet-stream');
  assert.equal(evidenceAttachmentMetadata('private/unsafe\n.txt').originalFilename, 'unsafe.txt');
  assert.doesNotThrow(() => encodeURIComponent(evidenceAttachmentMetadata(`${'x'.repeat(254)}😀`).originalFilename));
  assert.deepEqual(evidenceAttachmentMetadata(null), { originalFilename: 'evidence.bin', mimeType: 'application/octet-stream' });
});
