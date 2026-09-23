import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { playwrightBrowserDriverFactory, findBrowserExecutable } from '../dist/chrome-cdp-driver.js';

test('scoped inspection exposes an offscreen workflow control and ambiguous clicks cannot act', { skip: !findBrowserExecutable() }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-action-reliability-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<title>Controls fixture</title><main>${Array.from({ length: 90 }, (_, i) => `<button data-testid="control-${i}">Control ${i}</button>`).join('')}<section id="workflow"><label for="child">Child workflow</label><select id="child"><option>Choose workflow</option></select><button aria-label="Search" onclick="document.title='first clicked'">Search</button><button aria-label="Search" onclick="document.title='second clicked'">Search</button></section></main>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver;
  try {
    driver = await playwrightBrowserDriverFactory(root)('fixture', () => {}, undefined, undefined, { disableSandbox: process.env.CI === 'true' });
    await driver.navigate(`http://127.0.0.1:${server.address().port}`);
    assert.ok(!JSON.parse(await driver.inspect()).controls.some(control => control.selector === '#child'), 'global snapshot is bounded');
    const scoped = JSON.parse(await driver.inspect('#workflow'));
    assert.equal(scoped._ponderosa.scope, 'requested_region');
    assert.ok(scoped.controls.some(control => control.selector === '#child' && control.name === 'Child workflow'));
    await assert.rejects(driver.click('button[aria-label="Search"]'), { reason: 'selector_ambiguous' });
    assert.equal((await driver.pageInfo()).title, 'Controls fixture', 'ambiguous click activated neither target');
  } finally {
    await driver?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
