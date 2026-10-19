import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CoordinationV3Store } from '../../packages/agents/dist/index.js';
import { openCurrentMemoryDatabase } from '../../packages/agents/dist/state-admission.js';

test('receipt injection batches preserve latest rows, recovery, missing IDs and project scope', t => {
  const db = openCurrentMemoryDatabase(); t.after(() => db.close());
  const project = randomUUID(), chat = randomUUID(), agent = randomUUID(), stamp = '2026-10-19T00:00:00.000Z';
  db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project, 'Owned', '/unused', stamp);
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(chat, project, 'Owned', stamp, stamp);
  db.prepare('INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?)').run(agent, project, chat, 'Owned', 'owned', 'codex', stamp, stamp, '{}');
  db.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,0)').run(agent, chat);
  const run = randomUUID(), scope = 'conversation:' + chat;
  db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'completed','owned',?,1,'injected',?,?,?,?)").run(run, project, agent, stamp, stamp, stamp, stamp, scope);
  const insert = db.prepare('INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  let sequence = 0;
  const inject = (ids, createdAt = stamp, updatedAt = stamp) => {
    const id = randomUUID(); insert.run(id, run, 'steer', sequence++, 'acknowledged', 'owned', JSON.stringify(ids), createdAt, updatedAt, stamp); return id;
  };
  db.transaction(() => { for (let i = 0; i < 1000; i++) inject(['noise-' + i]); })();
  db.prepare('INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('execution-a', run, agent, project, 'owned', 'owned', '[]', stamp, stamp);
  db.prepare('INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('execution-z', run, agent, project, 'owned', 'owned', '[]', stamp, stamp);
  const v3 = new CoordinationV3Store(db), messages = [], activations = [], latest = new Map();
  for (let i = 0; i < 66; i++) {
    const id = randomUUID(), sender = { kind: 'user', userId: 'operator' }, audience = { kind: 'organization', organizationId: project };
    const event = { schemaVersion: 2, eventId: id, projectId: project, conversationId: chat, sender, intent: 'broadcast', audience, text: 'Owned ' + i, createdAt: stamp };
    const created = v3.recordRuntimeCommunication({ id, projectId: project, scopeKey: scope, sender, intent: 'broadcast', audience, payload: { communication: event }, now: stamp,
      activation: { agentId: agent, kind: 'user_message', priority: 100, promptClass: 'human' } });
    messages.push(id); activations.push(created.activationId);
    db.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(created.activationId);
    if (i === 65) continue;
    inject([created.activationId], '2026-10-18T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    inject([created.activationId]); latest.set(created.activationId, inject([created.activationId, created.activationId]));
  }
  // A recovery-only activation has no source communication, so it must be
  // fetched by the second batch rather than confused with its source receipt.
  const original = db.prepare('SELECT * FROM agent_activations WHERE id=?').get(activations[0]);
  original.id = randomUUID(); original.dedupe_key = randomUUID(); original.state = 'attached';
  db.prepare(`INSERT INTO agent_activations(${Object.keys(original).join(',')}) VALUES(${Object.keys(original).map(() => '?').join(',')})`).run(...Object.values(original));
  db.prepare("UPDATE agent_activations SET state='outcome_unknown' WHERE id=?").run(activations[0]);
  db.prepare("INSERT INTO scheduler_steering_recoveries(injection_id,run_id,agent_id,state,recover_at,created_at,updated_at) VALUES(?,?,?,'recovery_queued',?,?,?)").run(latest.get(activations[0]), run, agent, stamp, stamp, stamp);
  db.prepare('INSERT INTO scheduler_steering_recovery_activations VALUES(?,?,?)').run(latest.get(activations[0]), activations[0], original.id);
  inject([original.id]);
  const prepare = db.prepare, selected = new Map(); let scans = 0;
  db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (!/FROM scheduler_prompt_injections injection,\s*json_each\(injection.activation_ids_json\) member/u.test(sql)) return statement;
    scans++; const all = statement.all.bind(statement);
    statement.all = (...args) => all(...args).map(row => { const { activation_id, ...value } = row; selected.set(activation_id, value); return row; });
    return statement;
  };
  let receipts;
  try { receipts = v3.deliveryReceiptsForCommunications(project, messages); } finally { db.prepare = prepare; }
  assert.equal(scans, 2, 'One source batch and one recovery batch, independent of 66 recipients');
  const oracle = db.prepare(`SELECT injection.id,injection.run_id,injection.kind,injection.state,injection.updated_at,injection.acknowledged_at,
    (SELECT operation.state FROM provider_operation_outbox operation WHERE operation.run_id=injection.run_id AND operation.operation='interrupt' AND operation.idempotency_key LIKE 'cancel:%' ORDER BY operation.id DESC LIMIT 1) AS run_stop_operation_state,
    (SELECT provider.execution_id FROM provider_inputs provider WHERE provider.scheduler_run_id=injection.run_id ORDER BY provider.created_at DESC,provider.execution_id DESC LIMIT 1) AS execution_id
    FROM scheduler_prompt_injections injection,json_each(injection.activation_ids_json) member WHERE member.value=? ORDER BY injection.created_at DESC,injection.sequence DESC LIMIT 1`);
  for (const id of [...activations, original.id]) assert.deepEqual(selected.get(id), oracle.get(id));
  assert.equal(receipts.size, 66); assert.equal(receipts.get(messages[0])[0].state, 'recovering');
  assert.equal(receipts.get(messages[0])[0].recoveryExecutionId, 'execution-z');
  assert.equal(receipts.get(messages[65])[0].injectionId, undefined);
  for (const id of messages.slice(1, 65)) assert.equal(receipts.get(id)[0].state, 'processed');
  assert.ok([...v3.deliveryReceiptsForCommunications(randomUUID(), messages).values()].every(value => value.length === 0));
});
