import assert from 'node:assert/strict';
import test from 'node:test';
import { controlStates, mapItemStatus, shouldPollOperations } from '../src/components/branches/executionPresentation.js';

test('operational status converges after execution completion', () => {
  assert.equal(shouldPollOperations('running', { state: 'running' }), true);
  assert.equal(shouldPollOperations('completed', { state: 'running' }), true);
  assert.equal(shouldPollOperations('failed', { state: 'needs_reconciliation' }), true);
  assert.equal(shouldPollOperations('completed', { state: 'completed' }), false);
});

test('joined Map paths show the worker result rather than the arrival state', () => {
  const item = { state: 'arrived', result: { failed: true, output: '' } };
  assert.equal(mapItemStatus(item), 'failed');
  assert.equal(mapItemStatus({ state: 'arrived', result: { failed: false, output: 'ok' } }), 'completed');
  assert.equal(mapItemStatus({ state: 'arrived' }), 'joined · result unavailable');
  assert.equal(mapItemStatus({ state: 'arrived' }, [
    { number: 1, state: 'failed' }, { number: 2, state: 'completed', result: { failed: false } },
  ]), 'completed');
});

test('control cards use canonical decisions and Map state', () => {
  const detail = {
    decisions: [
      { id: '1', at: '2026-09-24T12:00:00Z', nodeId: 'route', kind: 'route_invalid' },
      { id: '2', at: '2026-09-24T12:00:01Z', nodeId: 'join', kind: 'join_resolved', failed: true },
    ],
    maps: [{ mapId: 'map', itemCount: 3, state: 'completed' }],
    waits: [{ kind: 'join', stepId: 'other-join' }],
  };
  assert.deepEqual(controlStates(detail), {
    route: 'otherwise', join: 'failed', map: '3 items settled', 'other-join': 'waiting',
  });
  assert.equal(controlStates({ ...detail, maps: [...detail.maps, { mapId: 'map', itemCount: 2, state: 'open' }] }).map, '5 items running');
});
