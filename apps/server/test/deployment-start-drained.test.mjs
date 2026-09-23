import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../dist/app.js';

test('qualification instance starts drained and leases no Runs until explicitly resumed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ponderosa-start-drained-'));
  const app = createServer({ dataDir, engines: [], logger: false, startDrained: true });
  t.after(async () => {
    app.prepareForShutdown();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await app.ready();

  const initial = (await app.inject({ method: 'GET', url: '/api/ready' })).json();
  assert.equal(initial.leasingRuns, false);
  assert.equal(initial.deploymentDrain.state, 'draining');

  const resumedResponse = await app.inject({ method: 'POST', url: '/api/deployment/resume' });
  assert.equal(resumedResponse.statusCode, 200, resumedResponse.body);
  const resumed = resumedResponse.json();
  assert.equal(resumed.leasingRuns, true);
  assert.equal(resumed.state, 'accepting');
});
