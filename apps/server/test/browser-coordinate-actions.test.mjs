import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';

test('agent coordinate actions require current page, bounded coordinates, and control', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-coordinate-'));
  const actions = [];
  const page = { pageId: 'one', url: 'https://example.test', title: 'Form', active: true };
  const driver = { isAlive: () => true, close: async () => {}, cancelPendingFileChooser: async () => {}, viewport: () => ({ width: 800, height: 600 }),
    pages: async () => ({ activePageId: 'one', pages: [page] }), pageInfo: async () => page,
    pointer: async (x,y) => { actions.push(['pointer',x,y]); return page; }, scroll: async (x,y) => { actions.push(['scroll',x,y]); return page; } };
  const manager = new BrowserSessionManager(root, async () => driver, () => {});
  const scope = { projectId: 'p', agentId: 'a', runId: 'r' };
  try {
    const session = await manager.open(scope);
    await assert.rejects(manager.act(scope, { action: 'pointer', page_id: 'other', x: 10, y: 10 }), /active page/);
    await assert.rejects(manager.act(scope, { action: 'pointer', page_id: 'one', x: 900, y: 10 }), /range/);
    await manager.act(scope, { action: 'pointer', page_id: 'one', x: 20, y: 30 });
    await manager.act(scope, { action: 'scroll', page_id: 'one', delta_x: 0, delta_y: 500 });
    await manager.setControl(scope, 'operator', session.controlEpoch);
    await assert.rejects(manager.act(scope, { action: 'pointer', page_id: 'one', x: 20, y: 30 }), /controlled/);
    assert.deepEqual(actions, [['pointer',20,30],['scroll',0,500]]);
  } finally { await manager.closeAll('test'); await rm(root, { recursive: true, force: true }); }
});
