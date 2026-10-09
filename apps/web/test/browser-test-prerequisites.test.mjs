import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The built unit recipe keeps apps/web as cwd when copying tests to scratch.
const web = existsSync(new URL('./browser-stream-routing.check.mjs', import.meta.url))
  ? fileURLToPath(new URL('../', import.meta.url)) : process.cwd();
const root = resolve(web, '../..');
test('registered browser transport checks build their canonical server first and propagate failure', () => {
  const { scripts } = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'));
  const steps = scripts['test:browser-stream'].split(' && ');
  assert.deepEqual(steps, ['pnpm --filter @ponderosa/server build', 'node test/browser-stream-routing.check.mjs',
    'node --experimental-test-module-mocks test/browser-agent-routing.check.mjs']);
  assert.ok(scripts['test:built'].endsWith(' && pnpm test:browser-stream'));
});
for (const name of ['verify.yml', 'native-beta.yml', 'native-production.yml']) {
  test(`${name} provisions frozen Chromium before pnpm verify`, () => {
    const workflow = readFileSync(join(root, '.github/workflows', name), 'utf8');
    const steps = workflow.split(/^      - /m);
    const install = steps.findIndex(step => step.includes('pnpm --filter @ponderosa/server exec playwright-core install --with-deps chromium'));
    const verify = steps.findIndex(step => /\bpnpm verify\b/.test(step));
    assert.ok(install > 0 && verify > install, 'pinned browser installation must precede the verification step');
    assert.match(workflow, /node-version: 24\.16\.0/);
    assert.match(workflow, /version: 11\.10\.0/);
  });
}
