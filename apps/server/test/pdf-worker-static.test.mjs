import assert from 'node:assert/strict';
import test from 'node:test';
import { contentTypeForStatic, cacheControlForStatic } from '../dist/static-content.js';
test('lazy PDF module workers are served as JavaScript without weakening CSP or caching', () => {
  const file = '/web/static/assets/pdf.worker.min.hash.mjs';
  assert.equal(contentTypeForStatic(file), 'text/javascript; charset=utf-8');
  assert.equal(cacheControlForStatic(file), 'public, max-age=31536000, immutable');
  assert.equal(contentTypeForStatic('/web/static/assets/unknown.bin'), 'application/octet-stream');
});
