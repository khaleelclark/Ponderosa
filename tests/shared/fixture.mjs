import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../../apps/server/dist/app.js';
import { processBirthMarker } from '@ponderosa/engines';
import { WindowsProcessJob } from '@ponderosa/native-host';

// Hosted Windows includes slow fixture setup and cleanup; native qualification keeps 30 seconds.
export const fixtureTestOptions = {
  timeout: process.platform === 'win32' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' ? 60_000 : 30_000,
};

class Events {
  items = []; waiters = []; ended = false;
  push(value) { const resolve = this.waiters.shift(); resolve ? resolve({ value, done: false }) : this.items.push(value); }
  end() { this.ended = true; for (const resolve of this.waiters.splice(0)) resolve({ done: true }); }
  [Symbol.asyncIterator]() { return this; }
  next() { return this.items.length ? Promise.resolve({ value: this.items.shift(), done: false }) : this.ended ? Promise.resolve({ done: true }) : new Promise(resolve => this.waiters.push(resolve)); }
}

export async function until(read, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await delay(10); }
  throw new Error(`Timed out waiting for ${label}`);
}

// Read only paths actually supplied to the controlled provider. Decode JSON
// containers before inspecting strings so Windows backslashes stay literal.
export function runtimeAttachmentPaths(value) {
  const paths = new Set();
  const visit = item => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (item && typeof item === 'object') { Object.values(item).forEach(visit); return; }
    if (typeof item !== 'string') return;
    try { const decoded = JSON.parse(item); if (decoded !== item) { visit(decoded); return; } } catch {}
    for (const line of item.split('\n')) {
      const match = line.match(/(?:^|:\s)((?:[A-Za-z]:[\\/]|\/)[^\r\n"<>]+[\\/]runtime-attachments[\\/][^\r\n"<>]+)/);
      if (match) paths.add(match[1]);
    }
  };
  visit(value); return [...paths];
}

// The child is real but inert: no shell, network, provider account or user data.
// Inert Windows roots cannot spawn descendants and are assigned to an exact
// kill-on-close Job before publication; POSIX roots keep their detached group.
export async function fixture({ diagnosticProvider = false, beforeRuntimeClose, providerInstalled, modelCatalog, modelValidator, capabilityCatalog, socketIdleTimeoutMs, storeFactory, authToken, resourceAdmissionObservation } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-regression-'));
  const dataDir = path.join(root, 'data');
  const plans = new Map(), sessions = new Map(), turns = [], children = [], failures = [], openingSessions = new Set(), commands = [], steers = [];
  let closingFixture = false;
  const capabilities = { steering: true, persistentSessions: true, commands: [], mcpServers: [], composerCapabilities: [] };
  const providerProbes = [], capabilityDiscoveries = [];
  const adapter = {
    id: 'codex', displayName: 'Controlled regression adapter', trustedSystemPromptChannel: 'developer',
    ...(modelValidator ? { validateModel: modelValidator } : {}),
    ...(modelCatalog ? { discoverModelCatalog: modelCatalog, modelSpecificEfforts: true } : {}),
    listModels: () => [{ id: modelCatalog ? '' : 'fixture', label: 'Fixture' }], listEfforts: () => [{ id: 'medium', label: 'Medium' }],
    defaultModel: () => 'fixture', defaultEffort: () => 'medium', capabilities: async cwd => { capabilityDiscoveries.push({cwd}); return capabilityCatalog ? capabilityCatalog(cwd) : capabilities; },
    async *seed() { throw Error('Persistent fixture unexpectedly used one-shot seed'); },
    async *continue() { throw Error('Persistent fixture unexpectedly used one-shot continuation'); },
    async openSession(options) {
      const events = new Events();
      const job = process.platform === 'win32' ? new WindowsProcessJob() : undefined;
      let child;
      try {
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: !job, stdio: 'ignore', cwd: root, windowsHide: true });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      } catch (error) { job?.close(); throw error; }
      const record = { pid: child.pid, exited: false }; children.push(record);
      const birthMarker = processBirthMarker(child.pid);
      const exited = new Promise(resolve => child.once('exit', () => {
        record.exited = true; events.end(); options.onRuntimeRootExit?.({ exitCode: child.exitCode }); resolve();
      }));
      try { job?.assign(child.pid); }
      catch (error) {
        // This unpublished inert child is still ours if Job assignment fails.
        child.kill(); await exited; job.close(); record.close = async () => {}; throw error;
      }
      let closing;
      const session = {
        engineAgentId: options.resumeSessionId ?? randomUUID(), events,
        processIdentity: job ? undefined : { pid: child.pid, pgid: child.pid, birthMarker },
        isAlive: () => !record.exited || (job?.activeProcesses() ?? 0) > 0,
        close: async () => {
          if (beforeRuntimeClose) await beforeRuntimeClose({ agentId: options.agentId, sessionId: session.engineAgentId, processIdentity: session.processIdentity });
          return closing ??= (async () => {
          if (!record.exited) {
            const observed = processBirthMarker(child.pid);
            assert.ok(observed === undefined || observed === birthMarker, 'Owned process identity changed; refusing termination');
            if (job) job.terminate();
            else try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
          await exited;
          if (job) {
            await until(() => job.activeProcesses() === 0, 'owned Windows Job exit');
            assert.equal(job.activeProcesses(), 0, 'Owned Windows Job remains alive');
            job.close();
          }
          })();
        },
        capabilities: async () => ({ ...capabilities, sessionId: session.engineAgentId, model: 'fixture' }),
        invokeCommand: async (name, argumentsText) => {
          commands.push({ agentId: options.agentId, sessionId: session.engineAgentId, name, argumentsText });
          return { message: 'Controlled command completed' };
        },
        contextUsage: () => ({ usedTokens: 1000, windowTokens: 200000 }),
        steer: async input => { steers.push({ agentId: options.agentId, input }); return { status: 'accepted' }; },
        interrupt: async () => { events.push({ type: 'error', terminalStatus: 'interrupted', message: 'Controlled interruption' }); session.finish(); },
        tool: (name, args, id = randomUUID()) => options.handleDynamicToolCall({ id, name, arguments: args }),
        finish: () => events.push({ type: 'turn_done', usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } }),
        async startTurn(input) {
          const turnId = randomUUID(), plan = (plans.get(options.agentId) ?? []).shift() ?? {};
          const turn = { agentId: options.agentId, sessionId: session.engineAgentId, turnId, input, history: options.history };
          turns.push(turn);
          setImmediate(async () => {
            if (closing || record.exited) return;
            try {
              events.push({ type: 'session', sessionId: session.engineAgentId });
              if (plan.output !== false) events.push({ type: 'text', delta: 'Ordinary fixture execution output' });
              if (plan.hold) return;
              if (plan.run) await plan.run(session, input, turn);
              else {
                let result = await session.tool('ponderosa_update_request', { text: 'Controlled worker result' });
                if (!result.success) result = await session.tool('ponderosa_message', { text: 'Explicit fixture reply' });
                assert.equal(result.success, true, result.text);
              }
              session.finish();
            } catch (error) {
              failures.push(error); events.push({ type: 'error', terminalStatus: 'failed', message: error.message }); session.finish();
            }
          });
          return { turnId };
        },
      };
      record.close = session.close;
      sessions.set(options.agentId, session); options.onRuntimeSpawned(session); return session;
    },
  };
  const openSession = adapter.openSession.bind(adapter);
  adapter.openSession = options => {
    assert.equal(closingFixture, false, 'Fixture refused a provider root after shutdown began');
    const opening = openSession(options);
    openingSessions.add(opening);
    opening.then(() => openingSessions.delete(opening), () => openingSessions.delete(opening));
    return opening;
  };
  const options = { dataDir, logger: false, allowedBrowseRoots: [root], ...(authToken ? { authToken } : {}),
    // Controlled inert providers use a fixed sample, independent of CI host pressure.
    resourceAdmissionObservation: resourceAdmissionObservation ?? { sample: async () => ({ availableBytes: 8 * 1024 ** 3, memoryFullPercent: 0, ioFullPercent: 0, source: 'linux_host' }) },
    engines: [{ adapter, isInstalled: () => providerInstalled?.(adapter.id) !== false, authStatus: async () => ({ authenticated: true, source: 'subscription_presence', detail: 'Controlled fixture; no provider account' }), availabilityProbe: async () => { providerProbes.push({ engineId: adapter.id }); return { available: true }; } },
      ...(diagnosticProvider ? [{ adapter: { ...adapter, id: 'claude', displayName: 'Controlled diagnostic provider' },
        isInstalled: () => providerInstalled?.('claude') !== false,
        authStatus: async () => ({ authenticated: true, source: 'subscription_presence', detail: 'Controlled diagnostic; no provider account' }),
        availabilityProbe: async () => { providerProbes.push({ engineId: 'claude' }); return { available: true }; },
      }] : [])],
    communicationV3: { pollMs: 10, maxConcurrentRuns: 4 } };
  let app;
  const open = async () => { closingFixture = false; app = createServer({ ...options, ...(storeFactory ? { store: storeFactory(dataDir) } : {}) }); if (socketIdleTimeoutMs !== undefined) app.server.setTimeout(socketIdleTimeoutMs); await app.ready(); };
  const close = async () => { if (app) {
    const current = app; app = undefined; closingFixture = true; current.prepareForShutdown();
    // Include roots still opening when a failed assertion initiated shutdown.
    // Observe their exits while the server can still record root-exit callbacks.
    await Promise.allSettled([...openingSessions]);
    await Promise.all(children.map(child => child.close()));
    await current.close();
  } };
  await open();
  const api = async (method, url, payload, headers = {}) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers:{...(authToken?{authorization:`Bearer ${authToken}`} :{}),...headers} });
    let body; try { body = response.json(); } catch { body = response.body; }
    return { status: response.statusCode, body, headers: response.headers, rawBody: response.rawPayload };
  };
  const ok = response => { assert.ok(response.status >= 200 && response.status < 300, `HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 600)}`); return response.body; };
  const detail = async id => ok(await api('GET', `/api/agents/${id}`));
  const settled = async (id, previous = []) => until(async () => {
    const d = await detail(id), fresh = d.runs.filter(r => !previous.includes(r.id));
    if (!fresh.length || fresh.some(r => ['running', 'preparing'].includes(r.status))) return false;
    if (failures.length) throw failures[0];
    assert.equal(fresh.some(r => r.status === 'failed'), false, JSON.stringify(fresh));
    return d;
  }, `new Run for ${id}`);
  const createChat = async title => ok(await api('POST', '/api/chats', { label: title, defaultEngine: 'codex' }, { 'idempotency-key': randomUUID() }));
  const createAgent = async (chat, title, managerAgentId) => {
    const agent = ok(await api('POST', `/api/projects/${chat.projectId}/agents`, { title, engine: 'codex', conversationId: chat.id,
      initialMessage: 'Controlled initial task', idempotencyKey: randomUUID(), awaitResult: true, ...(managerAgentId ? { managerAgentId } : {}) }));
    await settled(agent.id); return agent;
  };
  const createIdleAgent = async (chat, title, managerAgentId) => ok(await api('POST', `/api/projects/${chat.projectId}/agents`, {
    title, engine: 'codex', conversationId: chat.id, idempotencyKey: randomUUID(), ...(managerAgentId ? { managerAgentId } : {}),
  }));
  const send = async (id, text, extra = {}) => ok(await api('POST', `/api/agents/${id}/messages`, { text, idempotencyKey: randomUUID(), ...extra }));
  const tool = async (session, name, args) => {
    const result = await session.tool(name, args); let body; try { body = JSON.parse(result.text); } catch { body = result.text; }
    return { status: result.success ? 200 : body.statusCode, body };
  };
  const hold = async id => {
    const count = turns.filter(t => t.agentId === id).length;
    plans.set(id, [{ hold: true }]); await send(id, 'Controlled held task');
    await until(() => turns.filter(t => t.agentId === id).length > count, 'held provider input'); return sessions.get(id);
  };
  return { root, dataDir, api, ok, detail, settled, createChat, createAgent, createIdleAgent, send, tool, hold, plans, sessions, turns, capabilities, commands, steers, providerProbes, capabilityDiscoveries,
    listen: () => app.listen({ host: '127.0.0.1', port: 0 }),
    async reopen() { await close(); await open(); },
    async dispose(remove = true) {
      await close();
      assert.equal(children.every(c => c.exited), true, 'Owned child exit was not observed');
      if (remove) await rm(root, { recursive: true, force: true });
    } };
}

export async function withFixture(t, run, options) {
  const f = await fixture(options); let success = false;
  try { await run(f); success = true; }
  catch (error) { t.diagnostic(`Assertion before cleanup: ${error.stack ?? error}`); throw error; }
  finally { if (!success) t.diagnostic(`Failed disposable fixture retained: ${f.root}`); await f.dispose(success); }
}
