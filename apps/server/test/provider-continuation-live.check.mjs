// Explicitly opt-in. Fresh private data and two disposable managed Runs only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import { defaultEngineRegistrations } from '@ponderosa/engines';
import { createServer } from '../dist/app.js';

assert.equal(process.env.PONDEROSA_LIVE_PROVIDER_CHECK, '1', 'set PONDEROSA_LIVE_PROVIDER_CHECK=1 to authorize the disposable provider check');
const dataDir = await mkdtemp(join(tmpdir(), 'ponderosa-provider-continuation-'));
const store = new AgentStore(dataDir);
const token = randomUUID();
const portReservation = createNetServer();
await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve));
const port = portReservation.address().port;
await new Promise(resolve => portReservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
await mkdir(join(dataDir, 'project'));
const project = store.createProject({ label: 'Disposable continuation check', hostPath: join(dataDir, 'project'), defaultEngine: 'codex' });
const chat = store.createConversation(project.id, { title: 'Reply and completion check' });
const agent = store.createAgent(project.id, { title: 'Continuation probe', engine: 'codex', conversationId: chat.id });
const app = createServer({ dataDir, store, engines: defaultEngineRegistrations().filter(item => item.adapter.id === 'codex'),
  authToken: token, agentBaseUrl: baseUrl, logger: false, buildRevision: 'qualification-ui-followups' });
const results = [];
try {
  await app.listen({ host: '127.0.0.1', port });
  for (let index = 0; index < 2; index++) {
    const marker = `CONTINUATION_CHECK_${randomUUID()}`;
    const started = Date.now();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`, headers: { authorization: `Bearer ${token}` },
      payload: { text: `First emit a brief public commentary update saying you received this instruction. Then reply to this message with exactly ${marker}, using ponderosa_message. Do not use shell commands, browse, create files, ask questions, or delegate. Finish after publishing your reply.`, idempotencyKey: marker } });
    assert.ok([200, 202].includes(response.statusCode), `send rejected (${response.statusCode}): ${response.body}`);
    console.log(JSON.stringify({ checkpoint: 'send accepted', attempt: index + 1, statusCode: response.statusCode }));
    let run, reply;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      run = store.sqlite.prepare('SELECT id,status,started_at,terminal_at FROM scheduler_runs WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(agent.id);
      reply = store.sqlite.prepare("SELECT created_at FROM messages WHERE agent_id=? AND role='assistant' AND text LIKE ? ORDER BY seq DESC LIMIT 1").get(agent.id, `%${marker}%`);
      if (run && !['running', 'leased'].includes(run.status) && reply) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const details = run ? new CoordinationV3Store(store.sqlite).agentWorkItemDetails({ projectId: project.id, conversationId: chat.id, kind: 'run', recordId: run.id }) : undefined;
    results.push({ runId: run?.id, status: run?.status, replyObserved: Boolean(reply), replyDelayMs: reply ? Date.parse(reply.created_at) - started : null,
      terminalDelayAfterReplyMs: reply && run?.terminal_at ? Date.parse(run.terminal_at) - Date.parse(reply.created_at) : null, details });
    assert.ok(reply, 'the managed Agent must publish the requested reply');
    assert.equal(run?.status, 'completed', JSON.stringify(results));
    const publicProgress = store.readEvents(agent.id).filter(item => item.event.executionId === run.id && item.event.type === 'text' && item.event.presentation === 'progress');
    assert.ok(publicProgress.length > 0, 'the actual managed Run must accept public commentary through the provider boundary');
    const detail = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(detail.statusCode, 200, detail.body);
    const receipt = detail.json().messages.find(message => message.role === 'user' && message.text.includes(marker))?.deliveryReceipts?.[0];
    assert.equal(receipt?.state, 'processed', 'commentary must not leave the accepted message unconfirmed');
    assert.equal(receipt?.executionId, run.id, 'the original accepted Run must complete, not a later follow-up');
    assert.equal(receipt?.providerAcknowledged, true);
    const evidence = new Map(details.map(item => [item.label, item.value]));
    assert.doesNotMatch(evidence.get('Last recorded provider progress'), /Not found/);
    assert.ok(JSON.parse(evidence.get('Recent Run event metadata')).some(event => event.type === 'tool_result'), 'ordinary provider tool results remain attributable to this exact Run');
    assert.match(evidence.get('Recorded terminal event'), /completed/);
  }
  const first = new Map(results[0].details.map(item => [item.label, item.value]));
  const second = new Map(results[1].details.map(item => [item.label, item.value]));
  assert.ok(first.get('Provider session ID'));
  assert.equal(first.get('Provider session ID'), second.get('Provider session ID'), 'second Run continues the same provider session');
  assert.equal(first.get('Provider context'), 'fresh_task');
  assert.equal(second.get('Provider context'), 'continued_session');
  console.log(JSON.stringify({ status: 'pass', results }, null, 2));
} finally {
  // Shutdown acts only on the disposable authority created above. It is test
  // cleanup, not a product timeout or an inferred provider completion.
  app.prepareForShutdown(); await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
