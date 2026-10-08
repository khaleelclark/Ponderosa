import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'apps/server/package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const { default: Fastify } = await import(pathToFileURL(require.resolve('fastify')));
const { AgentStore, WorkspaceStore, CoordinationV3Store, BranchStore } = await import(pathToFileURL(require.resolve('@ponderosa/agents')));
const load = path => import(pathToFileURL(join(root, 'apps/server/dist', path)));
const { createBrowserAuthority } = await load('browser-authority.js');
const { BrowserSessionError } = await load('browser-session-manager.js');
const { registerBrowserRoutes } = await load('routes/browsers.js');
const { registerProductScope, rewriteProductUrl } = await load('product-scope.js');
const { createRsbuild } = await import(pathToFileURL(webRequire.resolve('@rsbuild/core')));
const playwrightModule = await import(pathToFileURL(require.resolve('playwright-core')));
const { chromium } = playwrightModule.default ?? playwrightModule;

let temp, store, authority, app, browser;
const closures = new Set(), sockets = new Set(), drivers = [], requests = [];
const pageId = 'page /?&+#%';
try {
  temp = mkdtempSync(join(tmpdir(), 'fast020-stream-routing-'));
  store = new AgentStore(join(temp, 'data'));
  const workspace = new WorkspaceStore(join(temp, 'data'));
  const coordination = new CoordinationV3Store(store.sqlite), branches = new BranchStore(store.sqlite, coordination);
  const branch = branches.create('Stream routing', 'stream-routing');
  const project = store.createProject({ label: 'Branch browser', hostPath: temp, defaultEngine: 'codex', chatOwned: true, branchId: branch.id });
  const agent = store.createAgent(project.id, { title: 'Stream owner', engine: 'codex', conversationId: project.lastConversationId });
  const dev = store.createProject({ label: 'Dev browser', hostPath: temp, defaultEngine: 'codex' });
  authority = createBrowserAuthority({ dataDir: join(temp, 'data'), store, activeRuns: new Map(), publish: () => {},
    logWarn: console.warn, persistRuntimeEvent: async () => undefined,
    providerProcessAuthority: { register() { throw new Error('Inert driver must not spawn a process'); } },
    browserAdmissionAllowed: scope => Boolean(store.getProject(scope.projectId)),
    driverFactory: async () => {
      const driver = { alive: true, marker: drivers.length + 1 };
      drivers.push(driver);
      const validate = id => { if (id !== pageId) throw new BrowserSessionError('page not found', 404); };
      return { isAlive: () => driver.alive, close: async () => { driver.alive = false; },
        pages: async () => ({ activePageId: pageId, pages: [{ pageId, url: 'about:blank', title: 'Inert page', active: true }] }),
        capture: async id => { validate(id); return Buffer.from([137, 80, 78, 71, driver.marker]); },
        preview: async id => { validate(id); return { data: Buffer.from([255, 216, 255, driver.marker]).toString('base64'), sequence: 1 }; },
        cancelPendingFileChooser: async () => {} };
    } });
  app = Fastify({ rewriteUrl: rewriteProductUrl });
  app.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  registerProductScope(app, store, workspace, () => undefined, () => false);
  registerBrowserRoutes(app, { ...authority, liveSseClosures: closures,
    projectExists: id => Boolean(store.getProject(id)), agentExists: (p, a) => store.getAgent(a)?.projectId === p,
    projectDeletionInProgress: () => false, agentDeletionInProgress: () => false,
    // No scheduler Run is created or claimed here. Only Project sessions are admitted.
    operatorBrowserScope: () => { throw new BrowserSessionError('browser access requires the exact active run', 404); },
    getProjectBrowserGrant: id => authority.projectBrowserGrants.get(id),
    setProjectBrowserGrant: (id, grant) => authority.projectBrowserGrants.set(id, grant),
    deleteProjectBrowserGrant: id => authority.projectBrowserGrants.delete(id), activeProjectBrowserController: () => undefined });
  for (const id of [project.id, dev.id]) await authority.projectBrowserSessions.open(authority.projectBrowserScope(id), undefined, 'operator');
  const output = join(temp, 'web');
  await (await createRsbuild({ cwd: join(root, 'apps/web'), rsbuildConfig: {
    source: { entry: { index: join(root, 'apps/web/test/browser-stream-routing-entry.ts') } },
    output: { distPath: { root: output } }, logLevel: 'error' } })).build();
  const serve = (request, reply) => {
    const path = new URL(request.raw.url, 'http://local').pathname;
    const file = join(output, path === '/' || path === '/branches' ? 'index.html' : path);
    if (!existsSync(file)) return reply.code(404).send();
    return reply.type(file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html').send(readFileSync(file));
  };
  for (const path of ['/', '/branches', '/static/*']) app.get(path, serve);
  await app.listen({ port: 0, host: '127.0.0.1' });
  browser = await chromium.launch({ executablePath: process.env.PONDEROSA_CHROMIUM_PATH, headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/')) requests.push({ url: response.url(), status: response.status() }); });
  await page.goto(app.listeningOrigin + '/branches');
  await page.waitForFunction(() => Boolean(window.streamProbe));
  const identities = await page.evaluate(({ projectId, agentId, pageId }) => {
    const { projectBrowserAdapter: project, agentBrowserAdapter: agent, productApiPath } = window.streamProbe;
    const ids = { projectId: 'project /?%', agentId: 'agent /?%', runId: 'run /?%' };
    const branch = { project: project(projectId).frameStreamUrl(pageId), agent: agent(projectId, agentId, 'absent-run').frameStreamUrl(pageId),
      projectDefault: project(projectId).frameStreamUrl(), agentDefault: agent(projectId, agentId, 'absent-run').frameStreamUrl(),
      escapedProject: project(ids.projectId).frameStreamUrl(pageId), escapedAgent: agent(ids.projectId, ids.agentId, ids.runId).frameStreamUrl(pageId) };
    const native = ['/api/branches/engine/projects/p/browser/frame-stream?pageId=x%20y', '/api/branches/b', '/api/branch-executions/e', '/api/branch-gates/g'];
    const alreadyScoped = native.map(path => productApiPath(path));
    history.replaceState({}, '', '/');
    const dev = { project: project(projectId).frameStreamUrl(pageId), agent: agent(projectId, agentId, 'absent-run').frameStreamUrl(pageId) };
    history.replaceState({}, '', '/branches');
    return { branch, dev, native, alreadyScoped, ids };
  }, { projectId: project.id, agentId: agent.id, pageId });
  // Every stream request below goes from Chromium to the actual socket HTTP routes.
  const observe = (id, product, binary) => page.evaluate(async ({ id, product, binary, pageId }) => {
    history.replaceState({}, '', product === 'branches' ? '/branches' : '/');
    const { projectBrowserAdapter, createBrowserBinaryFrameParser, parseBrowserFrameEvent } = window.streamProbe;
    const url = projectBrowserAdapter(id).frameStreamUrl(pageId), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let reader;
    try {
      const response = await fetch(url + (binary ? '&format=binary' : ''), { signal: controller.signal, cache: 'no-store' });
      const result = { url, status: response.status, type: response.headers.get('content-type') };
      if (!response.ok) return result;
      reader = response.body.getReader();
      const parser = binary ? createBrowserBinaryFrameParser() : undefined;
      let text = '', frame;
      while (!frame) {
        const next = await reader.read();
        if (next.done) throw new Error('stream ended without frame');
        if (binary) frame = parser.push(next.value)[0];
        else {
          text += new TextDecoder().decode(next.value);
          const event = text.match(/event: frame\ndata: (.+)\n\n/);
          if (event) frame = parseBrowserFrameEvent(event[1]);
        }
      }
      return { ...result, metadata: frame.metadata, bytes: Array.from(new Uint8Array(await frame.blob.arrayBuffer())) };
    } finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  }, { id, product, binary, pageId });
  const observed = [];
  for (const [id, product, marker] of [[project.id, 'branches', 1], [dev.id, 'dev', 2]]) {
    for (const binary of [true, false]) observed.push({ marker, binary, ...await observe(id, product, binary) });
  }
  const foreign = [await observe(project.id, 'dev', true), await observe(dev.id, 'branches', false), await observe('missing-project', 'branches', true)];
  const polling = await page.evaluate(async ({ id, pageId }) => {
    history.replaceState({}, '', '/branches');
    const result = await window.streamProbe.projectBrowserAdapter(id).getFrame(pageId);
    return { bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())), revision: result.revision, metadata: result.metadata };
  }, { id: project.id, pageId });
  console.log('HTTP before EventSource ' + JSON.stringify({ identities, observed, foreign, polling }));
  const eventSourceFrame = await page.evaluate(({ id, pageId }) => new Promise((resolve, reject) => {
    const source = new EventSource(window.streamProbe.projectBrowserAdapter(id).frameStreamUrl(pageId));
    const timer = setTimeout(() => { source.close(); reject(new Error('EventSource frame timeout')); }, 5_000);
    source.addEventListener('frame', async event => {
      clearTimeout(timer); source.close();
      try {
        const frame = window.streamProbe.parseBrowserFrameEvent(event.data);
        resolve({ metadata: frame.metadata, bytes: Array.from(new Uint8Array(await frame.blob.arrayBuffer())) });
      } catch (error) { reject(error); }
    }, { once: true });
    source.onerror = () => { clearTimeout(timer); source.close(); reject(new Error('EventSource failed')); };
  }), { id: project.id, pageId });
  const inactive = [];
  for (const state of ['staging', 'retiring']) {
    store.sqlite.prepare("INSERT OR REPLACE INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,'',?,?)")
      .run(branch.id, 'stream-negative', 'chat', project.lastConversationId, state);
    inactive.push({ state, ...await observe(project.id, 'branches', true) });
  }
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE package_id='stream-negative'").run();
  const restored = await observe(project.id, 'branches', true);
  const agentDenied = await page.evaluate(async url => (await fetch(url)).status, identities.branch.agent);
  await authority.projectBrowserSessions.close(authority.projectBrowserScope(project.id), 'inactive-session-negative');
  const closed = await observe(project.id, 'branches', true);
  console.log(JSON.stringify({ identities, observed, foreign, polling, eventSourceFrame, inactive, restored, agentDenied, closed, requests, errors }, null, 2));
  for (const result of foreign.concat(inactive)) assert.equal(result.status, 404);
  assert.equal(agentDenied, 404); assert.equal(closed.status, 409, 'canonical manager denies a closed session');
  assert.deepEqual(eventSourceFrame.bytes, [255, 216, 255, 1]); assert.equal(eventSourceFrame.metadata.pageId, pageId);
  assert.deepEqual(polling.bytes, [137, 80, 78, 71, 1]); assert.ok(polling.revision > 0); assert.equal(polling.metadata.pageId, pageId);
  assert.deepEqual(identities.alreadyScoped, identities.native);
  assert.deepEqual(errors, []); assert.equal(drivers.length, 2);
  for (const result of observed.concat([{ ...restored, marker: 1, binary: true }])) {
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.match(result.type, result.binary ? /^application\/vnd\.ponderosa\.browser-frames/ : /^text\/event-stream/);
    assert.deepEqual(result.bytes, [255, 216, 255, result.marker]); assert.equal(result.metadata.pageId, pageId);
  }
  const suffix = `?pageId=${encodeURIComponent(pageId)}`;
  const projectPath = `/api/projects/${encodeURIComponent(project.id)}/browser/frame-stream${suffix}`;
  const agentPath = `/api/projects/${encodeURIComponent(project.id)}/agents/${encodeURIComponent(agent.id)}/runs/absent-run/browser/frame-stream${suffix}`;
  assert.equal(identities.dev.project, projectPath); assert.equal(identities.dev.agent, agentPath);
  assert.equal(identities.branch.project, '/api/branches/engine/' + projectPath.slice(5));
  assert.equal(identities.branch.agent, '/api/branches/engine/' + agentPath.slice(5));
  assert.equal(identities.branch.projectDefault, identities.branch.project.split('?')[0]);
  assert.equal(identities.branch.agentDefault, identities.branch.agent.split('?')[0]);
  const ids = identities.ids;
  assert.equal(identities.branch.escapedProject, `/api/branches/engine/projects/${encodeURIComponent(ids.projectId)}/browser/frame-stream${suffix}`);
  assert.equal(identities.branch.escapedAgent, `/api/branches/engine/projects/${encodeURIComponent(ids.projectId)}/agents/${encodeURIComponent(ids.agentId)}/runs/${encodeURIComponent(ids.runId)}/browser/frame-stream${suffix}`);
  console.log('PASS actual bundled Project binary/legacy streams, polling, Dev/Branches identity, foreign/missing/inactive/closed denial; Agent escaped URLs and no-Run denial. No live Agent positive or native driver claim.');
} finally {
  await browser?.close();
  for (const close of closures) close();
  await app?.close();
  await authority?.projectBrowserSessions.closeAll('test-cleanup');
  await authority?.browserSessions.closeAll('test-cleanup');
  authority?.browserProfiles.db.close();
  store?.close();
  if (temp) rmSync(temp, { recursive: true, force: true });
  assert.equal(closures.size, 0); assert.equal(sockets.size, 0); assert.ok(drivers.every(driver => !driver.alive));
  assert.ok(!browser?.isConnected()); assert.ok(!app?.server.listening); assert.ok(!temp || !existsSync(temp));
  console.log('CLEANUP observed: Chromium disconnected; HTTP sockets/stream closures0; inert drivers closed; stores closed; temp bundle removed.', JSON.stringify({ sockets: sockets.size, closures: closures.size, driversAlive: drivers.filter(driver => driver.alive).length, temp }));
}
