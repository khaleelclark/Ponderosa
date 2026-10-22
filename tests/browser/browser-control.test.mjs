import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBrowserService, BrowserServiceClient } from '../../apps/server/dist/browser-service.js';
import { BrowserSessionError } from '../../apps/server/dist/browser-security.js';
import { BrowserSessionManager } from '../../apps/server/dist/browser-session-manager.js';

test('check 4: native manual conflicts remain typed across the real broker/client and resume in the same session', { skip: process.platform === 'win32' ? 'Unix socket transport; native Windows transport needs qualification' : false }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pbr-'));
  const calls = []; let alive = true, manual = 'automation', revision = 0;
  const driver = {
    isAlive: () => alive, close: async () => { alive = false; },
    manualState: () => manual, controlRevision: () => revision,
    manualSocket: () => path.join(root, 'unused-display.sock'),
    viewport: () => ({ width: 1280, height: 720 }),
    pages: async () => ({ activePageId: 'page', pages: [{ pageId: 'page', url: 'about:blank', title: 'Fixture', active: true, isNew: false, closable: false }] }),
    capture: async () => { calls.push('capture'); return Buffer.from('fixture pixels'); },
    navigate: async () => { calls.push('navigate'); return { pageId: 'page', url: 'https://fixture.invalid', title: 'Fixture' }; },
    cancelPendingFileChooser: async () => {},
    pauseAutomation: async () => { manual = 'manual'; revision++; },
    resumeAutomation: async () => { manual = 'automation'; revision++; },
  };
  const socket = path.join(root, 'broker.sock'), broker = await startBrowserService(socket, root, async () => driver);
  let remote;
  t.after(async () => { if (remote?.isAlive()) await remote.close(); await broker.close(); assert.equal(alive, false); await rm(root, { recursive: true, force: true }); });
  const client = new BrowserServiceClient(socket); await client.claim();
  const sessionId = randomUUID();
  remote = await client.driver(sessionId, () => {}, { owner: { version: 1, kind: 'chat', conversationId: randomUUID() } });
  await remote.capture();
  await remote.pauseAutomation();
  const before = [...calls];
  for (const action of [() => remote.capture(), () => remote.navigate('https://fixture.invalid')]) {
    await assert.rejects(action, error => error instanceof BrowserSessionError && error.statusCode === 409 && error.code === 'browser_manual_control');
  }
  assert.deepEqual(calls, before, 'Paused calls reached the driver');
  await remote.resumeAutomation(); await remote.capture(); await remote.navigate('https://fixture.invalid');
  assert.equal(remote.isAlive(), true); assert.equal(alive, true);
  assert.deepEqual(calls, ['capture', 'capture', 'navigate']);
});

for (const failCleanup of [false, true]) test(`check ${failCleanup ? '39' : '98'}: ${failCleanup ? 'failed browser cleanup blocks replacement until its owned driver exits' : 'old Run cleanup cannot close its successor browser'}`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-browser-regression-'));
  const drivers = []; let refuseClose = failCleanup, passed = false;
  const manager = new BrowserSessionManager(root, async () => {
    const state = { alive: true }; drivers.push(state);
    return {
      isAlive: () => state.alive,
      close: async () => { if (refuseClose) throw new Error('Declared cleanup failure'); state.alive = false; },
      pages: async () => ({ activePageId: 'page', pages: [{ pageId: 'page', url: 'about:blank', title: 'Fixture', active: true, isNew: false, closable: false }] }),
      viewport: () => ({ width: 1280, height: 720 }),
      controlRevision: () => 0, manualState: () => 'automation',
      cancelPendingFileChooser: async () => {},
    };
  }, () => {});
  t.after(async () => {
    refuseClose = false; await manager.closeAll('fixture_shutdown');
    assert.ok(drivers.every(x => !x.alive), 'Owned driver remains alive');
    if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`Failed browser fixture retained: ${root}`);
  });
  const scope = { projectId: randomUUID(), agentId: randomUUID(), runId: randomUUID(), conversationId: randomUUID() };
  const first = await manager.open(scope);
  if (failCleanup) {
    await assert.rejects(manager.closeRun(scope, 'fixture_run_ended'), /cleanup/);
    await assert.rejects(manager.open({ ...scope, runId: randomUUID() }));
    assert.equal(drivers.length, 1); assert.equal(drivers[0].alive, true, 'Refused cleanup was mistaken for exit');
    refuseClose = false;
  }
  await manager.closeRun(scope, 'fixture_run_ended'); assert.equal(drivers[0].alive, false);
  const nextScope = { ...scope, runId: randomUUID() }, second = await manager.open(nextScope);
  assert.notEqual(second.id, first.id); assert.equal(drivers.length, 2);
  await manager.closeRun(scope, 'late_old_cleanup');
  assert.equal(manager.get(scope.agentId).id, second.id); assert.equal(drivers[1].alive, true);
  await manager.closeRun(nextScope, 'fixture_complete'); assert.equal(drivers[1].alive, false); passed = true;
});

test('a single-tab browser refuses new-tab requests before invoking its driver', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ponderosa-browser-single-tab-'));
  const previous={mode:process.env.NODE_ENV,multi:process.env.PONDEROSA_BROWSER_MULTI_PAGE};
  process.env.NODE_ENV='production';process.env.PONDEROSA_BROWSER_MULTI_PAGE='0';
  let alive=true,calls=0,passed=false;
  const manager=new BrowserSessionManager(root,async()=>({
    isAlive:()=>alive,close:async()=>{alive=false;},
    pages:async()=>({activePageId:'existing',pages:[{pageId:'existing',url:'about:blank',title:'Existing tab',active:true,isNew:false,closable:false}]}),
    newPage:async()=>{calls++;throw new Error('Disabled driver must not be called');},
  }),()=>{});
  try {
    const scope={projectId:randomUUID(),agentId:randomUUID(),runId:randomUUID(),conversationId:randomUUID()};
    const session=await manager.open(scope,undefined,'operator');assert.equal(session.capabilities.multiPage,false);
    await assert.rejects(manager.newPage(scope,session.controlEpoch),error=>error instanceof BrowserSessionError&&error.statusCode===409&&/New tabs are unavailable/.test(error.message));
    assert.equal(calls,0);assert.equal(manager.get(scope.agentId).id,session.id);assert.equal(alive,true);passed=true;
  }finally{
    await manager.closeAll('qualification_shutdown');assert.equal(alive,false);
    if(previous.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.mode;
    if(previous.multi===undefined)delete process.env.PONDEROSA_BROWSER_MULTI_PAGE;else process.env.PONDEROSA_BROWSER_MULTI_PAGE=previous.multi;
    if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Failed single-tab fixture retained: ${root}`);
  }
});
