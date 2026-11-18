import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
import { formatMessageTimestamp } from '../../apps/web/src/messageTimestamp.ts';

test('history timestamps retain native absolute labels with two formatter constructions for the page', () => {
  const Native = Intl.DateTimeFormat;
  const values = Array.from({ length: 100 }, (_, i) => new Date(Date.UTC(2026, 9, 31, 23, 59, i)).toISOString());
  const label = new Native(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const title = new Native(undefined, { dateStyle: 'full', timeStyle: 'long' });
  let constructions = 0;
  Intl.DateTimeFormat = class extends Native { constructor(...args) { super(...args); constructions++; } };
  try {
    assert.equal(formatMessageTimestamp('invalid'), undefined);
    assert.equal(constructions, 0);
    for (const value of values) {
      const date = new Date(value);
      assert.deepEqual(formatMessageTimestamp(value), { dateTime: value, label: label.format(date), title: title.format(date) });
    }
    assert.equal(constructions, 2, 'One shared label/title pair, rather than two per message');
  } finally { Intl.DateTimeFormat = Native; }
});
