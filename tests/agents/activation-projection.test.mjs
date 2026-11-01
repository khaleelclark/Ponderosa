import assert from 'node:assert/strict';
import test from 'node:test';
import { providerActivation } from '../../packages/agents/dist/coordination-v3-provider-failure-projection.js';

const sqlite = { prepare(sql) {
  assert.match(sql, /SELECT request_update/);
  return { all: () => [] };
} };
const activation = {
  id: 'activation', kind: 'message', priority: 70,
  dispatch_policy: 'steer_or_run', prompt_class: 'human',
  payload_json: JSON.stringify({ text: 'retained canonical input' }),
  delivery_failures: 2, last_delivery_error: null, provider_failure_category: null,
};

test('fresh Runs and steering preserve the complete provider activation contract', () => {
  assert.deepEqual(providerActivation(sqlite, activation), {
    id: 'activation', kind: 'message', priority: 70,
    dispatchPolicy: 'steer_or_run', promptClass: 'human',
    payload: { text: 'retained canonical input' }, deliveryFailures: 2,
  });
  assert.deepEqual(providerActivation(sqlite, { ...activation, last_delivery_error: 'Exact delivery cause' }), {
    ...providerActivation(sqlite, activation), lastDeliveryError: 'Exact delivery cause',
  });
});

test('shared activation projection retains provider failure sanitization and malformed-payload disclosure', () => {
  const projected = providerActivation(sqlite, {
    ...activation, last_delivery_error: 'private raw provider failure', provider_failure_category: 'rate_limit',
  });
  assert.ok(projected.lastDeliveryError);
  assert.notEqual(projected.lastDeliveryError, 'private raw provider failure');
  assert.deepEqual(providerActivation(sqlite, { ...activation, payload_json: '{' }).payload, {
    activationId: 'activation', detail: 'Activation payload is unavailable.',
  });
});
