// Run in a separate process so seed and refresh load genuinely different builds.
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { root, directory, binary, phase, scenario = 'missing', seedKind } = JSON.parse(process.env.PONDEROSA_UPGRADE_FIXTURE);
const load = path => import(pathToFileURL(join(root, path)).href);
const { AgentStore, CoordinationV3Store, WorkspaceStore } = await load('packages/agents/dist/index.js');
const { ClaudeStreamSession } = await load('packages/engines/dist/index.js');
const { createServer } = await load('apps/server/dist/app.js');
const store = new AgentStore(directory), coordination = new CoordinationV3Store(store.sqlite);
new WorkspaceStore(directory).updatePreferences({ contextRolloverEnabled: false,
  ...(phase === 'refresh' && scenario === 'changed-policy' ? { globalInstructions: 'Changed immutable operator policy' } : {}) });
let project, chat, agent;
if (phase === 'seed') {
  project = store.createProject({ label: 'Upgrade fixture', hostPath: directory, defaultEngine: 'claude' });
  chat = store.createConversation(project.id, { title: 'Upgrade fixture' });
  agent = store.createAgent(project.id, { title: 'Upgrade fixture', engine: 'claude', conversationId: chat.id });
} else {
  const row = store.sqlite.prepare('SELECT id FROM agents LIMIT 1').get();
  agent = store.getAgent(row.id); project = store.getProject(agent.projectId);
  chat = { id: agent.conversationId };
}
const original = store.resumeSessionState(agent.id);
const originalSnapshots = store.readEvents(agent.id).filter(({ event }) => event.type === 'session_snapshot');
let allowTeardown = false, closeAttempts = 0;
const opened = [], observations = [];
const adapter = { id: 'claude', displayName: 'Disposable', trustedSystemPromptChannel: 'system',
  listModels: () => [], listEfforts: () => [],
  async openSession(options) {
    const replacement = phase === 'refresh' && !options.resumeSessionId;
    observations.push({ resumeSessionId: options.resumeSessionId ?? null,
      acceptedSnapshot: store.resumeSessionState(agent.id), systemPrompt: options.systemPrompt });
    if (replacement && opened.length) assert.equal(opened.at(-1).isAlive(), false, 'old process exit precedes replacement');
    const session = new ClaudeStreamSession({ ...options, bin: binary, permissionMode: 'default', killGraceMs: 100,
      environment: { ...options.environment, PONDEROSA_CLAUDE_FIXTURE_TOKENS: replacement ? '8000' : '10000',
        PONDEROSA_CLAUDE_FIXTURE_REPLY: phase === 'seed' && seedKind === 'direct' ? '1' : '0',
        PONDEROSA_CLAUDE_FIXTURE_OBSERVATION: replacement ? scenario : 'valid',
        PONDEROSA_CLAUDE_FIXTURE_DELAY: replacement && scenario === 'cancelled' ? '500' : '' } });
    if (phase === 'refresh' && scenario === 'teardown' && !opened.length) {
      const close = session.close.bind(session);
      session.close = async () => { closeAttempts++; if (!allowTeardown) throw Error('Disposable teardown failure'); return close(); };
    }
    opened.push(session); return session;
  } };
const reservation = createNetServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const app = createServer({ dataDir: directory, store, agentBaseUrl: `http://127.0.0.1:${port}`,
  engines: [{ adapter, authStatus: async () => ({ authenticated: true }) }], logger: false, communicationV3: { pollMs: 10 } });
async function waitFor(check) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(JSON.stringify({ observations, rollover: coordination.activeContextRollover(agent.id), events: store.readEvents(agent.id).slice(-6) }));
}
let result;
try {
  await app.listen({ host: '127.0.0.1', port });
  if (phase === 'seed') {
    if (seedKind === 'direct') {
      const response = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`,
        payload: { text: 'Disposable seed for manual refresh', idempotencyKey: 'base-direct' } });
      assert.ok([200, 202].includes(response.statusCode), response.body);
    } else {
      store.appendCommunicationEvent({ schemaVersion: 2, eventId: 'base-broadcast', projectId: project.id,
        conversationId: chat.id, sender: { kind: 'user', userId: 'local-operator' }, intent: 'broadcast',
        audience: { kind: 'organization', organizationId: project.id }, text: 'Disposable canonical context', createdAt: new Date().toISOString() });
      store.appendConversationMessage(chat.id, { text: 'Disposable canonical context', role: 'user' },
        undefined, 'main', undefined, undefined, 'base-broadcast');
      coordination.coordinate({ projectId: project.id, conversationId: chat.id, actorScope: 'user:local-operator',
        idempotencyKey: 'base-coordinate', requests: [{ requestId: 'base-coordinate', recipientAgentId: agent.id,
          communicationEventId: 'base-broadcast', lifetime: { kind: 'indefinite' }, payload: { text: 'Disposable coordination seed' } }] });
    }
    await waitFor(() => store.resumeSessionState(agent.id) && coordination.activeRunCount() === 0);
    const snapshot = store.resumeSessionState(agent.id);
    const snapshotEvent = store.readEvents(agent.id).find(({ event }) => event.type === 'session_snapshot').event;
    result = { snapshot, providerInput: store.getProviderInput(snapshotEvent.executionId, true) };
    assert.ok(result.providerInput.sourceManifest.communicationEventIds.length > 0, 'seed must include an exact canonical context boundary');
  } else {
    if (scenario === 'unknown') store.appendEvent(agent.id, { type: 'session_snapshot', sessionId: original.sessionId,
      executionId: originalSnapshots.at(-1).event.executionId, toolContractHash: 'a'.repeat(64), artifactIds: original.artifactIds });
    const before = store.resumeSessionState(agent.id);
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/compact` });
    assert.equal(response.statusCode, 200, response.body);
    const rolloverId = response.json().rolloverId;
    if (scenario === 'cancelled') {
      const candidate = await waitFor(() => { const row = coordination.contextRollover(rolloverId); return row.replacementSessionId && row; });
      const stop = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/cancel`,
        payload: { targetRunId: candidate.replacementRunId, idempotencyKey: 'cancel-candidate' } });
      assert.equal(stop.statusCode, 200, stop.body);
    }
    if (scenario === 'teardown') await waitFor(() => closeAttempts > 0);
    else if (scenario === 'unknown' || scenario === 'changed-policy') await waitFor(() => store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_runs WHERE status='failed'").get().n > 0);
    else await waitFor(() => ['completed', 'failed', 'outcome_unknown'].includes(coordination.contextRollover(rolloverId).state));
    result = { original: before, accepted: store.resumeSessionState(agent.id), observations,
      rollover: coordination.contextRollover(rolloverId), closeAttempts,
      resetCount: store.readEvents(agent.id).filter(({ event }) => event.type === 'session_reset').length,
      originalInput: store.getProviderInput(originalSnapshots.at(-1).event.executionId, true) };
  }
} finally {
  allowTeardown = true; app.prepareForShutdown(); await app.close(); store.close();
}
process.send(result);
