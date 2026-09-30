import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownPreviewText, notificationPreviewText } from '../dist/index.js';

test('notification previews format complete Markdown before truncating long destinations', () => {
  const original = `## **Ready**\n[Audit preview link](https://example.test/${'a'.repeat(500)}) and *next steps*.`;
  assert.equal(notificationPreviewText(original), 'Ready Audit preview link and next steps.');
  assert.ok(original.includes('https://example.test/'), 'display formatting does not mutate the canonical message');
  assert.equal(markdownPreviewText('[Audit preview link](https://example.test/' + 'a'.repeat(200)), 'Audit preview link');
  assert.equal(notificationPreviewText('x'.repeat(239) + '🌲'), 'x'.repeat(239));
  assert.equal(notificationPreviewText('x'.repeat(300)).length, 240);
});
