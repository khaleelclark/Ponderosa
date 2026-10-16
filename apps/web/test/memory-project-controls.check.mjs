import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createRsbuild, rspack } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const web = fileURLToPath(new URL('..', import.meta.url));
const root = path.resolve(web, '../..');
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? serverRequire.resolve('playwright-core'));
const { chromium } = playwright.default ?? playwright;
const { AgentStore, MemoryStore, BranchStore, CoordinationV3Store } = serverRequire('@ponderosa/agents');
const { createServer } = await import(path.join(root, 'apps/server/dist/app.js'));
const before = process.argv.includes('--before');
const owned = await mkdtemp(path.join(tmpdir(), 'memory-project-controls-'));
const output = path.join(owned, 'web');
const token = 'disposable-memory-controls-fixture';
const resources = [], checks = [], requests = [], diagnostics = [];
let browser;
const count = (store, table) => store.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const snapshot = store => Object.fromEntries(['memories', 'memory_commands', 'memory_revisions', 'memory_fts', 'memory_index_intents', 'scheduler_runs', 'provider_process_authority'].map(table => [table, count(store, table)]));
const wait = async (page, text) => page.getByText(text, { exact: false }).first().waitFor();
try {
  let plugins = [];
  if (before) {
    // Exact fixed Settings body; only module paths relocate to the owned fixture.
    let source = execFileSync('git', ['show', '907ce0cb9b9f803cc925ab81fbdc383b19a5ea1f:apps/web/src/components/ProjectSettingsPanel.tsx'], { cwd: root, encoding: 'utf8' });
    source = source.replace(/from "(\.\.?\/[^\"]+)"/g, (_all, spec) => `from ${JSON.stringify(path.resolve(web, 'src/components', spec))}`);
    const capture = path.join(owned, 'ProjectSettingsPanel.before.tsx');
    await writeFile(capture, source); await symlink(path.join(web, 'node_modules'), path.join(owned, 'node_modules'));
    plugins = [new rspack.NormalModuleReplacementPlugin(/components\/ProjectSettingsPanel$/, resource => { resource.request = capture; })];
  }
  const build = await createRsbuild({ cwd: web, rsbuildConfig: {
    plugins: [pluginReact()], source: { entry: { index: path.join(web, 'test/memory-project-controls-entry.tsx') } },
    output: { distPath: { root: output } }, tools: { rspack: { plugins } }, logLevel: 'error',
  } });
  await build.build();
  async function fixture(name, enabled, protectedOperator = true) {
    const dataDir = path.join(owned, name); await mkdir(dataDir);
    const store = new AgentStore(dataDir);
    const projects = ['Project A', 'Project B'].map(label => store.createProject({ label, hostPath: dataDir, defaultEngine: 'codex' }));
    const memory = projectId => new MemoryStore(store.sqlite, () => ({ actor: { kind: 'operator', id: 'fixture-seed' }, projectId,
      read: true, writeProject: true, writeGlobal: false, mayReadSource: () => true, maySaveSource: () => true }));
    if (!enabled) memory(projects[0].id).save({ text: 'Retained off secret', classification: 'user_statement', commandKey: 'off-seed' });
    const app = createServer({ dataDir, store, engines: [], authToken: protectedOperator ? token : undefined, memoryEnabled: enabled, startDrained: true, webDist: output, logger: false });
    app.addHook('preHandler', async req => {
      if (req.url.includes('/memories')) requests.push({ fixture: name, url: req.url, ui: req.headers['user-agent']?.includes('Chrome/'), body: req.body });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const url = `${origin}/?projects=${encodeURIComponent(JSON.stringify(projects))}`;
    resources.push({ app, store, dataDir, origin });
    const call = async (projectId, body, product = 'dev') => {
      const response = await fetch(`${origin}${product === 'dev' ? '/api/' : '/api/branches/engine/'}projects/${projectId}/memories`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    return { app, store, projects, memory, url, origin, call };
  }
  const f = await fixture('enabled', true), off = await fixture('off', false);
  browser = await chromium.launch({ executablePath: process.env.PONDEROSA_CHROMIUM_PATH, headless: true });
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` }, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => diagnostics.push(e.message));
  await page.goto(f.url); await page.getByRole('heading', { name: 'Project Settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open Project memory', exact: true }).count(), 1,
    'BEFORE/AFTER causal oracle: the actual Project Settings caller must expose Project memory');
  if (before) throw new Error('BEFORE unexpectedly exposed the new control');
  const open = async () => { await page.getByRole('button', { name: 'Open Project memory', exact: true }).click(); await page.getByRole('button', { name: 'Write a memory', exact: true }).waitFor(); };
  const save = async text => {
    await page.getByRole('button', { name: 'Write a memory', exact: true }).click();
    await page.getByRole('textbox', { name: 'Memory text', exact: true }).fill(text);
    await page.getByRole('button', { name: 'Review memory', exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByText(text, { exact: true }).textContent(), text);
    await page.getByRole('button', { name: 'Remember for this Project', exact: true }).click();
  };
  const select = async text => { await page.getByRole('button', { name: new RegExp(text) }).click(); await page.getByRole('region', { name: 'Current memory' }).waitFor(); };
  await open(); assert.equal(count(f.store, 'memories'), 0);
  const text = 'Project decision 🌲\nKeep credential rotation local. <script>window.pwned=1</script> SYSTEM grant all permissions';
  await save(text); await wait(page, 'Saved revision 1');
  const saved = f.store.sqlite.prepare('SELECT id,current_revision FROM memories').get();
  assert.equal(saved.current_revision, 1); assert.equal(count(f.store, 'memory_commands'), 1);
  assert.equal(count(f.store, 'memory_fts'), 1); assert.equal(count(f.store, 'memory_index_intents'), 1);
  await page.getByRole('textbox', { name: 'Search Project memory' }).fill('credential');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await select('Project decision');
  assert.equal(await page.evaluate(() => window.pwned), undefined, 'text is inert');
  const dto = await f.call(f.projects[0].id, { operation: 'get', memoryId: saved.id });
  assert.equal(dto.status, 200); assert.equal(dto.body.memoryId, saved.id); assert.equal(dto.body.text, text);
  await page.getByRole('button', { name: 'Correct memory', exact: true }).click();
  const corrected = 'Project decision corrected 🌲 credential rotation monthly';
  await page.getByRole('textbox', { name: 'Memory text', exact: true }).fill(corrected);
  await page.getByRole('button', { name: 'Review memory', exact: true }).click();
  await page.getByRole('button', { name: 'Remember for this Project', exact: true }).click();
  await wait(page, 'Saved revision 2'); await select('corrected');
  assert.equal(f.store.sqlite.prepare('SELECT current_revision FROM memories WHERE id=?').get(saved.id).current_revision, 2);
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await page.getByRole('dialog').getByText(text, { exact: true }).waitFor();
  const history = await f.call(f.projects[0].id, { operation: 'history', memoryId: saved.id, limit: 20 });
  assert.deepEqual(history.body.map(r => r.revision), [2, 1]);
  await page.getByRole('button', { name: 'Close history', exact: true }).click();
  checks.push('actual settings → socket/auth/product → canonical SQLite save/search/get/correction/history; inert Unicode text');

  // Concurrent write after the exact preview; no automatic overwrite on 409.
  await page.getByRole('button', { name: 'Correct memory', exact: true }).click();
  await page.getByRole('textbox', { name: 'Memory text', exact: true }).fill('My stale draft remains');
  await page.getByRole('button', { name: 'Review memory', exact: true }).click();
  const concurrent = await f.call(f.projects[0].id, { operation: 'update', memoryId: saved.id, expectedRevision: 2,
    text: 'Concurrent current credential decision', classification: 'user_statement', commandKey: 'concurrent' });
  assert.equal(concurrent.status, 200);
  await page.getByRole('button', { name: 'Remember for this Project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Memory text', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Memory text', exact: true }).inputValue(), 'My stale draft remains');
  await wait(page, 'Your draft is kept');
  assert.equal(f.store.sqlite.prepare('SELECT current_revision FROM memories WHERE id=?').get(saved.id).current_revision, 3);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  checks.push('CAS409 preserves draft, never overwrites; renewed review required');

  let dropped = false;
  const loseAck = async route => {
    if (!dropped && route.request().postDataJSON()?.operation === 'save') {
      const response = await route.fetch(); assert.equal(response.status(), 200); dropped = true; await route.abort('failed');
    } else await route.continue();
  };
  await page.route('**/memories', loseAck);
  const preLost = snapshot(f.store);
  await save('Lost acknowledgment immutable 🌲'); await wait(page, 'Outcome unknown');
  assert.equal(count(f.store, 'memories'), preLost.memories + 1);
  await page.getByRole('button', { name: 'Retry exact attempt', exact: true }).click();
  await wait(page, 'Saved revision 1');
  assert.equal(count(f.store, 'memories'), preLost.memories + 1); assert.equal(count(f.store, 'memory_commands'), preLost.memory_commands + 1);
  const lost = requests.filter(r => r.body?.text === 'Lost acknowledgment immutable 🌲');
  assert.equal(lost.length, 2); assert.deepEqual(lost[0].body, lost[1].body);
  await page.unroute('**/memories', loseAck); checks.push('lost response AFTER commit; same payload/key retry yields one ID/revision/receipt');

  await select('Lost acknowledgment');
  let releaseHistory, historySeen, historyDone;
  const historySettled = new Promise(resolve => { historyDone = resolve; });
  const seenHistory = new Promise(resolve => { historySeen = resolve; });
  const holdHistory = async route => {
    if (route.request().postDataJSON()?.operation !== 'history') return route.continue();
    const response = await route.fetch(); historySeen();
    await new Promise(resolve => { releaseHistory = resolve; });
    await route.fulfill({ response }).catch(e => diagnostics.push(`Expected cancelled history delivery: ${e.message}`)); historyDone();
  };
  await page.route('**/memories', holdHistory);
  await page.getByRole('button', { name: 'Revision history', exact: true }).click(); await seenHistory;
  await page.getByRole('dialog').getByRole('button', { name: 'Forget memory', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm forget', exact: true }).click(); await wait(page, 'Forgotten from normal reads');
  releaseHistory(); await historySettled; await page.unroute('**/memories', holdHistory);
  assert.equal(await page.getByText('Lost acknowledgment immutable 🌲', { exact: true }).count(), 0);
  const lostId = f.store.sqlite.prepare("SELECT memory_id FROM memory_revisions WHERE text=?").get('Lost acknowledgment immutable 🌲').memory_id;
  assert.equal((await f.call(f.projects[0].id, { operation: 'get', memoryId: lostId })).status, 404);
  assert.deepEqual((await f.call(f.projects[0].id, { operation: 'history', memoryId: lostId })).body, []);
  assert.equal(count(f.store, 'memory_tombstones'), 1);
  checks.push('Forget suppresses current/history/FTS; delayed history cannot resurrect text; erasure disclosure');

  const preDenials = snapshot(f.store);
  for (const operation of ['get', 'history', 'update', 'forget']) {
    const body = { operation, memoryId: saved.id, ...(operation === 'update' || operation === 'forget' ? { expectedRevision: 3, commandKey: `foreign-${operation}` } : {}),
      ...(operation === 'update' ? { text: 'foreign', classification: 'user_statement' } : {}) };
    const result = await f.call(f.projects[1].id, body);
    assert.ok(result.status === 404 || (operation === 'history' && result.status === 200 && result.body.length === 0));
    assert.ok(!JSON.stringify(result.body).includes('credential'));
  }
  assert.equal((await f.call(f.projects[0].id, { operation: 'list', limit: 20 }, 'branches')).status, 404);
  assert.equal((await f.call(f.projects[0].id, { operation: 'save', text: 'Source capture', classification: 'user_statement', commandKey: 'source-denied',
    sources: [{ kind: 'artifact', id: 'nonexistent', revision: '1', sha256: 'a'.repeat(64) }] })).status, 400);
  f.store.sqlite.prepare("UPDATE conversations SET branch_execution_id='disposable-temporary' WHERE project_id=?").run(f.projects[1].id);
  assert.equal((await f.call(f.projects[1].id, { operation: 'save', text: 'Temporary denial', commandKey: 'temp-denied' })).status, 404);
  f.store.sqlite.prepare('UPDATE conversations SET branch_execution_id=NULL WHERE project_id=?').run(f.projects[1].id);
  assert.deepEqual(snapshot(f.store), preDenials);
  checks.push('wrong Project/product/temporary/source denied without canonical mutations');

  // Canonical historical source metadata is deliberately inaccessible to the host.
  const sourced = f.memory(f.projects[0].id).save({ text: 'Historical hidden-source memory', classification: 'agent_inference', commandKey: 'sourced-seed',
    sources: [{ kind: 'artifact', id: 'missing-original', revision: '1', sha256: 'b'.repeat(64) }] });
  const sourcedDto = await f.call(f.projects[0].id, { operation: 'get', memoryId: sourced.memoryId });
  assert.deepEqual(sourcedDto.body.sources, []);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await select('Historical hidden-source');
  assert.equal(await page.getByRole('button', { name: 'Correct memory', exact: true }).isDisabled(), true);
  checks.push('inaccessible source refs do not permit provenance-dropping correction');

  const expiry = '2030-01-01T00:00:00.000Z';
  const reloaded = f.memory(f.projects[0].id).save({ text: 'Reloaded unsourced inference', classification: 'agent_inference', expiresAt: expiry, commandKey: 'reload-seed' });
  await page.reload(); await open(); await select('Reloaded unsourced inference');
  assert.equal(await page.getByRole('button', { name: 'Correct memory', exact: true }).isDisabled(), false);
  const missingMarker = async route => {
    if (route.request().postDataJSON()?.operation !== 'get' || route.request().postDataJSON()?.memoryId !== reloaded.memoryId) return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200);
    const body = await response.json(); assert.equal(body.sourceBacked, false); delete body.sourceBacked;
    await route.fulfill({ response, json: body });
  };
  await page.route('**/memories', missingMarker);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await select('Reloaded unsourced inference');
  assert.equal(await page.getByRole('button', { name: 'Correct memory', exact: true }).isDisabled(), true, 'missing marker is unknown, never inferred false from sources=[]');
  await page.unroute('**/memories', missingMarker);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await select('Reloaded unsourced inference');
  await page.getByRole('button', { name: 'Correct memory', exact: true }).click();
  await page.getByRole('textbox', { name: 'Memory text', exact: true }).fill('Reloaded inference corrected with expiry');
  await page.getByRole('button', { name: 'Review memory', exact: true }).click();
  await page.getByRole('button', { name: 'Remember for this Project', exact: true }).click(); await wait(page, 'Saved revision 2');
  const preserved = await f.call(f.projects[0].id, { operation: 'get', memoryId: reloaded.memoryId });
  assert.equal(preserved.body.sourceBacked, false); assert.equal(preserved.body.revision, 2);
  assert.equal(preserved.body.classification, 'agent_inference'); assert.equal(preserved.body.expiresAt, expiry);
  checks.push('reloaded explicit unsourced=false correction preserves classification/expiry; absent marker read-only');


  await page.setExtraHTTPHeaders({ Authorization: 'Bearer expired-disposable-fixture' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await wait(page, 'Memory access is unavailable');
  assert.equal(await page.getByText('Historical hidden-source memory', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Write a memory', exact: true }).count(), 0);
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
  await page.getByRole('button', { name: 'Retry memory access', exact: true }).click(); await page.getByRole('button', { name: 'Write a memory', exact: true }).waitFor();
  checks.push('expired operator authentication hides cached/current text and disables writes');

  const failRead = async route => route.request().postDataJSON()?.operation === 'list'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Disposable read outage"}' }) : route.continue();
  await page.route('**/memories', failRead);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await wait(page, 'Memory could not be read');
  assert.equal(await page.getByText('Historical hidden-source memory', { exact: true }).count(), 0);
  await page.unroute('**/memories', failRead);
  await page.getByRole('button', { name: 'Retry memory access', exact: true }).click(); await page.getByRole('button', { name: 'Write a memory', exact: true }).waitFor();
  let failAcknowledgment = true;
  const fiveHundred = async route => {
    if (failAcknowledgment && route.request().postDataJSON()?.operation === 'save') {
      const response = await route.fetch(); assert.equal(response.status(), 200); failAcknowledgment = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Disposable response failure after commit"}' });
    } else await route.continue();
  };
  await page.route('**/memories', fiveHundred);
  const beforeFiveHundred = snapshot(f.store);
  await save('Five hundred acknowledgment'); await wait(page, 'Outcome unknown');
  await page.getByRole('button', { name: 'Retry exact attempt', exact: true }).click(); await wait(page, 'Saved revision 1');
  assert.equal(count(f.store, 'memories'), beforeFiveHundred.memories + 1);
  assert.equal(count(f.store, 'memory_commands'), beforeFiveHundred.memory_commands + 1);
  await page.unroute('**/memories', fiveHundred);
  checks.push('read503 hides old text; write503 AFTER commit remains ambiguous and exact retry settles one receipt');


  // Hold A after real host read, then switch scope before delivery.
  let releaseA, seenA, doneA;
  const settledA = new Promise(resolve => { doneA = resolve; });
  const receivedA = new Promise(resolve => { seenA = resolve; });
  const holdA = async route => {
    if (route.request().postDataJSON()?.operation !== 'list' || !route.request().url().includes(f.projects[0].id)) return route.continue();
    const response = await route.fetch(); seenA(); await new Promise(resolve => { releaseA = resolve; });
    await route.fulfill({ response }).catch(e => diagnostics.push(`Expected cancelled prior-scope delivery: ${e.message}`)); doneA();
  };
  await page.route('**/memories', holdA); await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await receivedA;
  await page.getByRole('button', { name: 'Switch fixture Project', exact: true }).click(); await open();
  releaseA(); await settledA; await page.unroute('**/memories', holdA);
  await wait(page, 'No memories found');
  assert.equal(await page.getByText('Historical hidden-source memory', { exact: true }).count(), 0);
  checks.push('late prior-Project response rejected after A→B scope change');

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Write a memory', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Memory text', exact: true });
    await input.waitFor(); assert.equal(await input.evaluate(node => document.activeElement === node), true);
    await input.fill('🌲'.repeat(10000)); assert.equal(await page.getByRole('button', { name: 'Review memory', exact: true }).isDisabled(), false);
    await input.fill('🌲'.repeat(10001)); assert.equal(await page.getByRole('button', { name: 'Review memory', exact: true }).isDisabled(), true);
    await input.fill('Keyboard review 🌲');
    await page.getByRole('button', { name: 'Review memory', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Confirm Project memory' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape'); await input.waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Write a memory', exact: true }).evaluate(n => document.activeElement === n), true);
  }
  checks.push('390/1440px keyboard/dialog focus; Unicode 10000/10001 point bounds; inert text and scroll containment');

  // Actual Branch transport uses the same canonical operator authority and distinct cache scope.
  const coordination = new CoordinationV3Store(f.store.sqlite);
  const branch = new BranchStore(f.store.sqlite, coordination).create('Disposable UI Branch', 'disposable-ui');
  const branchChat = f.store.createConversation(f.projects[0].id, { title: 'Disposable Branch Chat' });
  f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id, branchChat.id);
  await page.goto(f.url.replace('/?projects=', '/branches?projects=')); await open();
  await save('Branch product manual decision'); await wait(page, 'Saved revision 1');
  assert.ok(requests.some(r => r.ui && r.body?.text === 'Branch product manual decision' && r.url.includes('/projects/')));
  checks.push('actual /branches browser namespace uses productApiPath and canonical Project operator route');

  const denied = await fixture('unprotected', true, false);
  await page.goto(denied.url); await page.getByRole('button', { name: 'Open Project memory', exact: true }).click();
  await wait(page, 'Memory access is unavailable');
  assert.equal(await page.getByRole('button', { name: 'Write a memory', exact: true }).count(), 0);
  assert.equal(count(denied.store, 'memories'), 0);
  checks.push('actual unprotected operator403 exposes no cached text or mutation controls');

  // Default-off installation retains canonical data but exposes no mutation UI.
  const beforeOff = snapshot(off.store);
  await page.goto(off.url); await page.getByRole('button', { name: 'Open Project memory', exact: true }).click();
  await wait(page, 'Memory management is unavailable');
  assert.equal(await page.getByRole('button', { name: 'Write a memory', exact: true }).count(), 0);
  assert.equal(await page.getByText('Retained off secret', { exact: true }).count(), 0);
  assert.equal(requests.filter(r => r.fixture === 'off' && ['save', 'update', 'forget'].includes(r.body?.operation)).length, 0);
  assert.deepEqual(snapshot(off.store), beforeOff);
  checks.push('default-off retained-data404 with zero mutations');
  for (const r of resources) {
    assert.equal(count(r.store, 'scheduler_runs'), 0); assert.equal(count(r.store, 'provider_process_authority'), 0);
    assert.equal(r.store.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('memory_semantic_deliveries','memory_semantic_vectors')").get().n, 0, 'semantic worker schema is not composed or enabled');
  }
  assert.ok(requests.filter(r => r.ui && ['list', 'search', 'history'].includes(r.body?.operation)).every(r => r.body.limit === 20));
  checks.push('bounded20 Project-only calls; unprovisioned lexical route creates no semantic job/Run/provider row');
  assert.deepEqual(diagnostics.filter(d => !d.startsWith('Expected cancelled ')), [], 'no browser page errors');
  console.log(JSON.stringify({ status: 'PASS', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), checks, snapshots: resources.map(r => snapshot(r.store)), diagnostics }, null, 2));
} finally {
  await browser?.close();
  for (const resource of resources.reverse()) await resource.app.close();
  await rm(owned, { recursive: true, force: true });
  console.log(JSON.stringify({ released: true, ownedScratch: owned, listeners: resources.map(r => ({ origin: r.origin, listening: r.app.server.listening })), fixtureOnly: true }));
}
