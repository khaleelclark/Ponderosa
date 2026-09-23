import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startBrowserService, BrowserServiceClient } from '../dist/browser-service.js';
import { playwrightBrowserDriverFactory, findBrowserExecutable } from '../dist/chrome-cdp-driver.js';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';

test('shared Project browser uses reliable actions through the independent broker', { skip: !findBrowserExecutable() }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-service-actions-'));
  const socket = join(root, 'browser.sock');
  const page = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<title>Broker fixture</title><main>${Array.from({ length: 90 }, (_, i) => `<button data-testid="item-${i}">Item ${i}</button>`).join('')}<section id="workflow"><label for="child">Child workflow</label><select id="child"><option>Choose</option></select><button aria-label="Search" onclick="document.title='first clicked'">Search</button><button aria-label="Search" onclick="document.title='second clicked'">Search</button></section></main>`);
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  let service;
  let manager;
  try {
    service = await startBrowserService(socket, root, playwrightBrowserDriverFactory(root));
    const client = new BrowserServiceClient(socket);
    await client.claim();
    manager = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => client.driver(id, event, launch), () => {}, undefined, undefined, () => true, true);
    const scope = { projectId: 'project', agentId: 'project-browser:project', runId: 'project:project' };
    const opened = await manager.open(scope, `http://127.0.0.1:${page.address().port}`);
    await manager.act(scope, { action: 'scroll', page_id: opened.activePageId, delta_y: 500 });
    const scoped = JSON.parse(await manager.inspect(scope, '#workflow'));
    assert.ok(scoped.controls.some(control => control.selector === '#child' && control.name === 'Child workflow'));
    await assert.rejects(manager.act(scope, { action: 'click', selector: 'button[aria-label="Search"]' }), error => error.statusCode === 409 && error.code === 'selector_ambiguous');
    assert.equal(manager.get(scope.agentId).title, 'Broker fixture');
    await manager.close(scope);
  } finally {
    await manager?.closeAll('test');
    await service?.close();
    await new Promise(resolve => page.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
