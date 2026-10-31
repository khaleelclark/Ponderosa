import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { findChromiumExecutable, seedLegacyPwaProfile, qualifyPersistentPwaUpgrade } from '../../packaging/qualification/persistent-pwa-upgrade.mjs';

import { processIsAlive, validProcessId } from '../../packaging/qualification/process-state.mjs';

const enabled = process.env.PONDEROSA_REGRESSION_INSTALLED_PWA === '1';
test('check 109: an installed PWA replaces legacy cached assets and retains its authenticated current build after browser restart', {
  timeout: 180000,
  skip: !enabled ? 'Set PONDEROSA_REGRESSION_INSTALLED_PWA=1 and PONDEROSA_REGRESSION_BUNDLE to a disposable native bundle' : false,
}, async t => {
  assert.ok(process.env.PONDEROSA_REGRESSION_BUNDLE, 'An explicitly selected qualification bundle is required');
  const installRoot = path.resolve(process.env.PONDEROSA_REGRESSION_BUNDLE);
  const manifest = JSON.parse(await readFile(path.join(installRoot, 'build-manifest.json'), 'utf8'));
  assert.equal(manifest.target.platform, process.platform);
  assert.equal(manifest.target.arch, process.arch);
  const browserExecutable = findChromiumExecutable();
  assert.ok(browserExecutable, 'This opt-in lane requires an existing host Chromium browser');
  const browserFactory = process.platform === 'win32'
    ? (await import('../shared/windows-pwa-browser.mjs')).openWindowsPwaBrowser : undefined;
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-installed-pwa-'));
  const dataDir = path.join(root, 'instance'), profileDir = path.join(root, 'browser-profile');
  const node = path.join(installRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const cli = path.join(installRoot, 'app/launcher/dist/cli.js');
  let started = false, success = false, cleanupPassed = false, observedPid;
  t.after(async () => {
    if (success && cleanupPassed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed installed PWA fixture retained: ${root}`);
  });
  const command = (name, args = []) => spawnSync(node, [cli, name, '--install-root', installRoot, '--data-dir', dataDir, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  try {
    const port = await new Promise((resolve, reject) => {
      const server = createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
    });
    await seedLegacyPwaProfile(port, profileDir, browserExecutable, browserFactory);
    const result = command('start', ['--port', String(port), '--no-browser']);
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); started = true;
    const state = JSON.parse(await readFile(path.join(dataDir, 'launcher-state/instance.json'), 'utf8'));
    observedPid = state.pid;
    assert.equal(validProcessId(observedPid), true); assert.equal(processIsAlive(observedPid), true);
    const base = `http://127.0.0.1:${port}`;
    // Browser-only qualification: no real provider probes, account changes or
    // normal user settings. Disable both providers in this fresh instance before
    // the actual application is opened by the maintained PWA helper.
    const settings = await fetch(`${base}/api/workspace/preferences`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerAvailability: { codex: false, claude: false } }) });
    assert.equal(settings.ok, true);
    const enginesResponse = await fetch(`${base}/api/engines`, {});
    assert.equal(enginesResponse.ok, true);
    assert.ok((await enginesResponse.json()).every(engine => engine.enabled === false), 'This browser-only fixture must not probe subscriptions');
    const proof = await qualifyPersistentPwaUpgrade({ port, profileDir, webDist: path.join(installRoot, 'app/web/dist'), bootstrapUrl: `${base}/__ponderosa_bootstrap`, browserExecutable, browserFactory });
    assert.ok(proof.publicAssetCount > 0);
    assert.ok(proof.expectedAssets.length > 0);
    t.diagnostic(`Native ${process.platform}/${process.arch} bundle ${manifest.commit}: legacy worker/cache retired; installed assets survived actual Chromium restart without browser credentials`);
    success = true;
  } finally {
    if (started) {
      const stopped = command('stop');
      assert.ifError(stopped.error); assert.equal(stopped.status, 0, stopped.stderr);
      const status = command('status', ['--json']);
      assert.ifError(status.error); assert.equal(status.status, 1, 'A stopped instance has no healthy status');
      assert.equal(JSON.parse(status.stdout).healthy, false);
      assert.equal(processIsAlive(observedPid), false, 'Stop returned before the exact owned daemon exited');
      cleanupPassed = true;
    }

  }
});
