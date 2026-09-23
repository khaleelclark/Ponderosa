import assert from 'node:assert/strict';
import test from 'node:test';
import { boundBrowserSnapshot } from '../dist/browser-security.js';

test('bounded browser snapshots keep executable selectors complete', () => {
  const controls = Array.from({ length: 80 }, (_, i) => ({
    selector: `[data-control="00000000-0000-4000-8000-${String(i).padStart(12, '0')}"]`,
    controlId: `control-${i}`,
    text: 'Long context '.repeat(200),
  }));
  const output = boundBrowserSnapshot(JSON.stringify({ controls }), 4000);
  assert.ok(output.length <= 4000);
  const parsed = JSON.parse(output);
  assert.ok(parsed.controls.length > 0 && parsed.controls.length < 80);
  for (const control of parsed.controls) {
    assert.equal(control.selector, controls.find(candidate => candidate.controlId === control.controlId)?.selector);
  }
});

test('an oversized selector cannot exceed the snapshot budget', () => {
  const output = boundBrowserSnapshot(JSON.stringify({ controls: [{ selector: 'x'.repeat(20000), controlId: 'oversized' }] }), 1000);
  assert.ok(output.length <= 1000);
  assert.doesNotThrow(() => JSON.parse(output));
});
