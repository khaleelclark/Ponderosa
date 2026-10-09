import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'apps/server/package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const load = path => import(pathToFileURL(join(root, 'apps/server/dist', path)));
const { AgentStore, CoordinationV3Store, BranchStore } = require('@ponderosa/agents');
const { createRsbuild } = await import(pathToFileURL(webRequire.resolve('@rsbuild/core')));
const module = await import(pathToFileURL(require.resolve('playwright-core')));
const { chromium } = module.default ?? module;
const drivers = [], sockets = new Set(), responses = [], entered = new Set();
const invocations = [], replies = [];
const pageId = 'page /?&+#%';
const driverModule = pathToFileURL(join(root, 'apps/server/dist/chrome-cdp-driver.js'));
const actualDriverModule = await import(driverModule);
// Substitute only the normalized driver factory. Scheduler, authority, route
// registration, product ownership and Run fences are the actual createServer.
mock.module(driverModule, { namedExports: { ...actualDriverModule,
  playwrightBrowserDriverFactory: () => async () => {
    const driver = { alive: true, marker: drivers.length + 1 };
    drivers.push(driver);
    const validate = id => assert.equal(id, pageId);
    return { isAlive: () => driver.alive, close: async () => { driver.alive = false; },
      pages: async () => ({ activePageId: pageId, pages: [{ pageId, url: 'about:blank', title: 'Inert page', active: true }] }),
      capture: async id => { validate(id); return Buffer.from([137, 80, 78, 71, driver.marker]); },
      preview: async id => { validate(id); return { data: Buffer.from([255, 216, 255, driver.marker]).toString('base64'), sequence: 1 }; },
      cancelPendingFileChooser: async () => {} };
  },
} });
const { createServer } = await load('app.js');
const { resourceInProduct } = await load('product-scope.js');
let temp, store, app, browser, release;
const held = new Promise(resolve => { release = resolve; });
async function until(read) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Canonical inert scheduler did not reach the expected state');
}
try {
  temp = mkdtempSync(join(tmpdir(), 'ponderosa-agent-routing-'));
  store = new AgentStore(join(temp, 'data'));
  const coordination = new CoordinationV3Store(store.sqlite), branches = new BranchStore(store.sqlite, coordination);
  const branch = branches.create('Agent browser routing', 'agent-browser-routing');
  const projects = [store.createProject({ label: 'Branch', hostPath: temp, defaultEngine: 'codex', chatOwned: true, branchId: branch.id }),
    store.createProject({ label: 'Dev', hostPath: temp, defaultEngine: 'codex' })];
  const agents = projects.map(project => store.createAgent(project.id, { title: 'Canonical inert route owner', engine: 'codex', conversationId: project.lastConversationId }));
  // A mixed Project cannot supply the Agent's product identity.
  const mixedChat = store.createConversation(projects[1].id, { title: 'Branch ownership inside the Dev Project' });
  store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id, mixedChat.id);
  assert.equal(resourceInProduct(store, 'project', projects[1].id, 'dev'), true);
  assert.equal(resourceInProduct(store, 'project', projects[1].id, 'branches'), true);
  const output = join(temp, 'web');
  await (await createRsbuild({ cwd: join(root, 'apps/web'), rsbuildConfig: {
    source: { entry: { index: join(root, 'apps/web/test/browser-stream-routing-entry.ts') } },
    output: { distPath: { root: output } }, logLevel: 'error' } })).build();
  const run = async function* (options) {
    const identity = store.sqlite.prepare("SELECT id,agent_id,status,fencing_token FROM scheduler_runs WHERE agent_id=? AND status='running'").get(options.agentId);
    assert.ok(identity); invocations.push(identity); entered.add(options.agentId);
    await held;
    // Complete the human source's canonical reply before terminal accounting.
    // Ordinary Adapter output alone leaves a required reply pending and recovers another Run.
    assert.deepEqual(coordination.requiredReplyAuthoritiesForRun(identity.id), [{ intent: 'direct_to_user' }]);
    assert.equal(coordination.latestAcknowledgedSteeringInjection(identity.id), undefined);
    const reply = await app.inject({ method: 'POST', url: '/api/agent-messages',
      headers: { authorization: `Bearer ${options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
      payload: { intent: 'direct_to_user', text: 'Disposable canonical browser route reply' } });
    assert.equal(reply.statusCode, 200, reply.body);
    const obligations = coordination.requiredReplyObligationsForRun(identity.id);
    assert.equal(obligations.length, 1); assert.equal(obligations[0].state, 'satisfied');
    assert.ok(obligations[0].satisfiedCommunicationId);
    assert.equal(reply.json().eventId, obligations[0].satisfiedCommunicationId);
    replies.push({ runId: identity.id, agentId: options.agentId, status: reply.statusCode,
      communicationId: obligations[0].satisfiedCommunicationId });
    yield { type: 'turn_done' };
  };
  app = createServer({ dataDir: join(temp, 'data'), store, webDist: output, logger: false, communicationV3: { pollMs: 10 },
    engines: [{ adapter: { id: 'codex', displayName: 'Inert subscription fixture', trustedSystemPromptChannel: 'developer', seed: run, continue: run,
      listModels: () => [], listEfforts: () => [] }, authStatus: async () => ({ authenticated: true }) }] });
  app.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.includes('/browser')) responses.push({ url: request.url, route: request.routeOptions.url, params: request.params, status: reply.statusCode });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.PONDEROSA_CHROMIUM_PATH, headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.listeningOrigin + '/branches');
  await page.waitForFunction(() => Boolean(window.streamProbe));
  const rows = [], runs = [];
  const json = async (url, method = 'GET', body) => {
    const response = await fetch(app.listeningOrigin + url, { method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  for (let index = 0; index < agents.length; index++) {
    const agent = agents[index], product = index ? 'dev' : 'branches', prefix = index ? '/api/' : '/api/branches/engine/';
    const intake = await json(prefix + 'agents/' + agent.id + '/messages', 'POST', { text: 'Disposable canonical browser route hold', idempotencyKey: 'browser-route-hold-' + product });
    assert.equal(intake.status, 202, JSON.stringify(intake));
    await until(() => entered.has(agent.id));
    const run = store.sqlite.prepare("SELECT id,agent_id,status,fencing_token FROM scheduler_runs WHERE agent_id=? AND status='running'").get(agent.id);
    assert.ok(run); runs.push(run);
    assert.equal(resourceInProduct(store, 'agent', agent.id, product), true);
    assert.equal(resourceInProduct(store, 'project', agent.id, product), false);
    const base = prefix + 'projects/' + agent.projectId + '/agents/' + agent.id;
    const locationBefore = await json(base + '/browser-location');
    assert.deepEqual(locationBefore, { status: 200, body: { kind: 'none' } });
    const url = base + '/runs/' + run.id + '/browser';
    const open = await json(url, 'POST');
    console.log('CANONICAL OPEN ' + JSON.stringify({ product, run, locationBefore, open }));
    assert.equal(open.status, 200, JSON.stringify(open));
    assert.equal(open.body.status, 'ready'); assert.equal(open.body.runId, run.id); assert.equal(open.body.agentId, agent.id);
    const session = await json(url), location = await json(base + '/browser-location');
    assert.equal(session.status, 200); assert.equal(session.body.id, open.body.id);
    assert.equal(location.status, 200); assert.equal(location.body.kind, 'run'); assert.equal(location.body.runId, run.id);
    const observed = await page.evaluate(async ({ product, projectId, agentId, runId, pageId }) => {
      history.replaceState({}, '', product === 'branches' ? '/branches' : '/');
      const { agentBrowserAdapter, createBrowserBinaryFrameParser, parseBrowserFrameEvent } = window.streamProbe;
      const adapter = agentBrowserAdapter(projectId, agentId, runId), frames = [];
      for (const binary of [true, false]) {
        const url = adapter.frameStreamUrl(pageId), controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        let reader;
        try {
          const response = await fetch(url + (binary ? '&format=binary' : ''), { signal: controller.signal, cache: 'no-store' });
          const result = { url, binary, status: response.status, type: response.headers.get('content-type') };
          if (!response.ok) { frames.push(result); continue; }
          reader = response.body.getReader();
          const parser = binary ? createBrowserBinaryFrameParser() : undefined;
          let text = '', frame;
          while (!frame) {
            const next = await reader.read(); if (next.done) throw new Error('Stream ended before frame');
            if (binary) frame = parser.push(next.value)[0];
            else { text += new TextDecoder().decode(next.value); const event = text.match(/event: frame\ndata: (.+)\n\n/); if (event) frame = parseBrowserFrameEvent(event[1]); }
          }
          frames.push({ ...result, metadata: frame.metadata, bytes: Array.from(new Uint8Array(await frame.blob.arrayBuffer())) });
        } finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      }
      const polling = await adapter.getFrame(pageId);
      const event = await new Promise((resolve, reject) => {
        const source = new EventSource(adapter.frameStreamUrl(pageId));
        const timer = setTimeout(() => { source.close(); reject(new Error('EventSource timeout')); }, 5_000);
        source.addEventListener('frame', async event => {
          clearTimeout(timer); source.close();
          try { const frame = parseBrowserFrameEvent(event.data); resolve({ metadata: frame.metadata, bytes: Array.from(new Uint8Array(await frame.blob.arrayBuffer())) }); }
          catch (error) { reject(error); }
        }, { once: true });
        source.onerror = () => { clearTimeout(timer); source.close(); reject(new Error('EventSource failed')); };
      });
      return { frames, event, polling: { revision: polling.revision, metadata: polling.metadata, bytes: Array.from(new Uint8Array(await polling.blob.arrayBuffer())) } };
    }, { product, projectId: agent.projectId, agentId: agent.id, runId: run.id, pageId });
    const marker = index + 1;
    for (const frame of observed.frames) {
      assert.equal(frame.status, 200); assert.match(frame.type, frame.binary ? /^application\/vnd\.ponderosa\.browser-frames/ : /^text\/event-stream/);
      assert.deepEqual(frame.bytes, [255, 216, 255, marker]); assert.equal(frame.metadata.pageId, pageId);
    }
    assert.deepEqual(observed.event.bytes, [255, 216, 255, marker]); assert.equal(observed.event.metadata.pageId, pageId);
    assert.deepEqual(observed.polling.bytes, [137, 80, 78, 71, marker]); assert.ok(observed.polling.revision > 0);
    rows.push({ product, projectId: agent.projectId, agentId: agent.id, run, session, location, observed });
  }
  const denials = [];
  const deny = async (label, prefix, projectId, agentId, runId, expectedError) => {
    for (const suffix of ['', '/frame?pageId=' + encodeURIComponent(pageId), '/frame-stream?pageId=' + encodeURIComponent(pageId), '/frame-stream?format=binary&pageId=' + encodeURIComponent(pageId)]) {
      const result = await json(prefix + 'projects/' + projectId + '/agents/' + agentId + '/runs/' + runId + '/browser' + suffix);
      assert.equal(result.status, 404, JSON.stringify({ label, result }));
      if (expectedError) assert.equal(result.body.error, expectedError);
      denials.push({ label, suffix, ...result });
    }
  };
  for (let index = 0; index < agents.length; index++) {
    const agent = agents[index], prefix = index ? '/api/' : '/api/branches/engine/', foreignPrefix = index ? '/api/branches/engine/' : '/api/';
    await deny('foreign-product', foreignPrefix, agent.projectId, agent.id, runs[index].id, 'Resource is unavailable in this product');
    await deny('wrong-project', prefix, projects[1 - index].id, agent.id, runs[index].id);
    await deny('wrong-agent', prefix, agent.projectId, agents[1 - index].id, runs[index].id);
    await deny('missing-agent', prefix, agent.projectId, 'missing-agent', runs[index].id, 'Resource is unavailable in this product');
    await deny('stale-run', prefix, agent.projectId, agent.id, 'stale-run', 'browser access requires the exact active run');
  }
  for (const state of ['staging', 'retiring']) {
    store.sqlite.prepare("INSERT OR REPLACE INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,'agent',?,?)")
      .run(branch.id, 'agent-routing-negative', 'chat', agents[0].id, state);
    await deny(state, '/api/branches/engine/', projects[0].id, agents[0].id, runs[0].id, 'Resource is unavailable in this product');
  }
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE package_id='agent-routing-negative'").run();
  const restored = await json('/api/branches/engine/projects/' + projects[0].id + '/agents/' + agents[0].id + '/runs/' + runs[0].id + '/browser');
  assert.equal(restored.status, 200);
  const activeRuns = store.sqlite.prepare('SELECT id,agent_id,status FROM scheduler_runs ORDER BY rowid').all();
  assert.equal(activeRuns.length, 2); assert.ok(activeRuns.every(run => run.status === 'running'));
  assert.deepEqual(activeRuns.map(run => run.id).sort(), runs.map(run => run.id).sort());
  console.log('CANONICAL HELD ' + JSON.stringify({ activeRuns, invocations }));
  release();
  await until(() => store.sqlite.prepare("SELECT count(*) AS n FROM scheduler_runs WHERE status='running'").get().n === 0);
  const completedRuns = store.sqlite.prepare('SELECT id,agent_id,status,terminal_at FROM scheduler_runs ORDER BY rowid').all();
  const activations = store.sqlite.prepare('SELECT id,agent_id,kind,state,consumed_at FROM agent_activations ORDER BY rowid').all();
  const attachments = store.sqlite.prepare('SELECT run_id,activation_id,consumed_at FROM scheduler_run_activations ORDER BY rowid').all();
  const injections = store.sqlite.prepare('SELECT id,run_id,kind,state,acknowledged_at FROM scheduler_prompt_injections ORDER BY rowid').all();
  const obligations = runs.flatMap(run => coordination.requiredReplyObligationsForRun(run.id));
  console.log('CANONICAL SETTLED ' + JSON.stringify({ invocations, replies, completedRuns, activations, attachments, injections, obligations }));
  assert.equal(invocations.length, 2); assert.equal(new Set(invocations.map(run => run.id)).size, 2);
  assert.deepEqual(invocations.map(run => run.id).sort(), runs.map(run => run.id).sort());
  assert.equal(completedRuns.length, 2); assert.ok(completedRuns.every(run => run.status === 'completed' && run.terminal_at));
  assert.deepEqual(completedRuns.map(run => run.id).sort(), runs.map(run => run.id).sort());
  assert.equal(activations.length, 2); assert.ok(activations.every(activation => activation.kind === 'human_message' && activation.state === 'consumed' && activation.consumed_at));
  assert.equal(attachments.length, 2); assert.ok(attachments.every(attachment => attachment.consumed_at));
  assert.deepEqual(attachments.map(attachment => attachment.activation_id).sort(), activations.map(activation => activation.id).sort());
  assert.deepEqual(attachments.map(attachment => attachment.run_id).sort(), runs.map(run => run.id).sort());
  assert.equal(injections.length, 2); assert.ok(injections.every(injection => injection.kind === 'turn' && injection.state === 'acknowledged' && injection.acknowledged_at));
  assert.deepEqual(injections.map(injection => injection.run_id).sort(), runs.map(run => run.id).sort());
  assert.equal(replies.length, 2); assert.equal(new Set(replies.map(reply => reply.communicationId)).size, 2);
  assert.equal(obligations.length, 2);
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM required_reply_obligations WHERE state<>'satisfied'").get().n, 0);
  for (const obligation of obligations) {
    assert.equal(obligation.state, 'satisfied'); assert.equal(obligation.attemptCount, 0); assert.ok(!obligation.recoveryActivationId);
    assert.deepEqual(obligation.replyAuthority, { intent: 'direct_to_user' });
    assert.ok(attachments.some(attachment => attachment.run_id === obligation.runId && attachment.activation_id === obligation.sourceActivationId));
    assert.ok(replies.some(reply => reply.runId === obligation.runId && reply.agentId === obligation.agentId && reply.communicationId === obligation.satisfiedCommunicationId));
    const communication = coordination.runtimeCommunication(obligation.satisfiedCommunicationId)?.payload.communication;
    assert.ok(communication); assert.equal(communication.eventId, obligation.satisfiedCommunicationId);
    assert.equal(communication.intent, 'user_dm');
    assert.equal(communication.sender.kind, 'agent'); assert.equal(communication.sender.agentId, obligation.agentId);
    assert.equal(communication.sender.executionId, obligation.runId); assert.equal(communication.audience.kind, 'user_agent');
    assert.equal(communication.audience.agentId, obligation.agentId);
  }
  for (let index = 0; index < agents.length; index++) {
    const prefix = index ? '/api/' : '/api/branches/engine/';
    await deny('settled-run', prefix, projects[index].id, agents[index].id, runs[index].id, 'browser access requires the exact active run');
  }
  assert.equal(store.deleteAgent(agents[1].id), true, 'canonical deletion must finish before the deleted-Agent denial');
  await deny('deleted-agent', '/api/', projects[1].id, agents[1].id, runs[1].id, 'Resource is unavailable in this product');
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM scheduler_runs').get().n, 2);
  assert.equal(invocations.length, 2);
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM agent_activations WHERE kind='required_reply_recovery' OR state IN ('pending','attached','retry_pending')").get().n, 0);
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM required_reply_obligations WHERE state<>'satisfied'").get().n, 0);
  assert.equal(entered.size, 2); assert.equal(drivers.length, 2); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ rows, denials, restored, responses, errors, canonicalInertSchedulerStarts: invocations.length,
    canonicalRunCount: completedRuns.length, canonicalReplyCount: replies.length }, null, 2));
} finally {
  release();
  await browser?.close();
  if (app) { app.prepareForShutdown(); await app.close(); await until(() => sockets.size === 0); }
  store?.close();
  mock.restoreAll();
  if (temp) rmSync(temp, { recursive: true, force: true });
  assert.equal(sockets.size, 0); assert.ok(drivers.every(driver => !driver.alive));
  assert.ok(!browser?.isConnected()); assert.ok(!app?.server.listening); assert.ok(!temp || !existsSync(temp));
  console.log('CLEANUP ' + JSON.stringify({ sockets: sockets.size, driversAlive: drivers.filter(driver => driver.alive).length,
    browserDisconnected: !browser?.isConnected(), serverClosed: !app?.server.listening, inertAdaptersReleased: true, temp, removed: !temp || !existsSync(temp) }));
}

console.log('PASS full createServer canonical scheduler/active-Run Agent sessions, binary/legacy/EventSource/polling in both products; mixed-Project foreign/wrong/missing/inactive/stale/settled/deleted denial and observed cleanup. Inert drivers only; no native/provider or mounted viewport qualification.');
