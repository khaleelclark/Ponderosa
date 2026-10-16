import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultEngineRegistrations } from '@ponderosa/engines';
import { createServer } from '../../apps/server/dist/app.js';
import { until } from './fixture.mjs';


// Explicit opt-in: consumes an existing subscription; never logs in or installs tools.
const enabled = process.env.PONDEROSA_REGRESSION_REAL_CODEX === '1';
export const options = {
  timeout: 300000,
  skip: !enabled ? 'Set PONDEROSA_REGRESSION_REAL_CODEX=1 with existing permitted Codex access' : false,
};

export async function withRealCodex(t, run, { beforeTurn } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-real-regression-'));
  const handles = [], registrations = defaultEngineRegistrations(process.env).filter(x => x.adapter.id === 'codex');
  assert.equal(registrations.length, 1);
  const original = registrations[0].adapter;
  const adapter = Object.create(original);
  const submitted = [], seeds = [], toolCalls = [];
  adapter.openSession = async options => {
    const session = await original.openSession({ ...options,
      handleDynamicToolCall: async request => {
        const result = await options.handleDynamicToolCall(request);
        toolCalls.push({ agentId: options.agentId, name: request.name, arguments: request.arguments, result });
        return result;
      },
      onRuntimeSpawned: handle => { handles.push(handle); options.onRuntimeSpawned(handle); } });
    seeds.push({ agentId: options.agentId, history: options.history, sessionId: session.engineAgentId, resumedFrom: options.resumeSessionId });
    const start = session.startTurn.bind(session), steer = session.steer.bind(session);
    session.startTurn = async input => {
      if (beforeTurn) await beforeTurn({ agentId: options.agentId, sessionId: session.engineAgentId, input });
      const result = await start(input);
      submitted.push({ agentId: options.agentId, sessionId: session.engineAgentId, kind: 'turn', prompt: input.prompt }); return result;
    };
    session.steer = async input => {
      const result = await steer(input);
      if (result.status === 'accepted') submitted.push({ agentId: options.agentId, sessionId: session.engineAgentId, kind: 'steer', prompt: input.prompt });
      return result;
    };
    return session;
  };
  const app = createServer({ dataDir: path.join(root, 'data'), logger: false, allowedBrowseRoots: [root],
    engines: [{ ...registrations[0], adapter }], communicationV3: { pollMs: 100, maxConcurrentRuns: 3 } });
  let success = false;
  t.after(async () => {
    app.prepareForShutdown(); await app.close();
    for (const handle of handles) {
      assert.equal(handle.isAlive(), false, 'Provider root remains alive after shutdown');
      const pgid = handle.processIdentity?.pgid;
      if (pgid) assert.throws(() => process.kill(-pgid, 0), error => error.code === 'ESRCH', 'Provider group remains alive');
    }
    if (success) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed real-provider fixture retained: ${root}`);
    t.diagnostic(`Observed shutdown of ${handles.length} owned Codex runtime(s)`);
  });
  await app.ready();
  const api = async (method, url, payload, headers = {}) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `HTTP ${response.statusCode}`); return response.json();
  };
  const wait = (id, previous = []) => until(async () => {
    const detail = await api('GET', `/api/agents/${id}`), runs = detail.runs.filter(x => !previous.includes(x.id));
    if (!runs.length || runs.some(x => ['running','preparing'].includes(x.status))) return false;
    assert.ok(runs.every(x => x.status === 'completed'), 'Real provider task failed'); return detail;
  }, 'real Codex result', 150000);
  const createChat = label => api('POST', '/api/chats', { label, defaultEngine: 'codex' }, { 'idempotency-key': randomUUID() });
  const createAgent = (chat, title, managerAgentId) => api('POST', `/api/projects/${chat.projectId}/agents`, { title, engine: 'codex', conversationId: chat.id,
    idempotencyKey: randomUUID(), ...(managerAgentId ? { managerAgentId } : {}) });
  const send = (id, text) => api('POST', `/api/agents/${id}/messages`, { text, idempotencyKey: randomUUID() });
  const events = async chat => (await readFile(path.join(root, 'data', 'projects', chat.projectId, 'communication-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const agentEvents = async (chat, id) => (await readFile(path.join(root, 'data', 'projects', chat.projectId, 'agents', id, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).event);
  const input = runId => api('GET', `/api/runs/${runId}/provider-input?exact=1`);
  await run({ api, wait, createChat, createAgent, send, events, agentEvents, input, submitted, seeds, toolCalls, inject: app.inject.bind(app), root });
  success = true;
}
