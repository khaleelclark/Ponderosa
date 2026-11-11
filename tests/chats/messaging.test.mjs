import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFixture, until, runtimeAttachmentPaths, fixtureTestOptions as options } from '../shared/fixture.mjs';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { inertCodex } from '../shared/inert-codex.mjs';

const rendered = turn => [JSON.stringify(turn.history), JSON.stringify(turn.input)].join('\n');

test('checks 1, 12, 16: shared request replay emits one explicit reply and keeps execution output separate', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Shared request');
  const agent = await f.createAgent(chat, 'Responsible Agent');
  const previous = (await f.detail(agent.id)).runs.map(r => r.id);
  const reply = `Shared response ${randomUUID()}`;
  f.plans.set(agent.id, [{ run: async session => assert.equal((await session.tool('ponderosa_message', { text: reply })).success, true) }]);
  const body = { text: `#${agent.handle} Reply to this exact shared request`, idempotencyKey: randomUUID(), recipientAgentMentions: [{ agentId: agent.id, projectId: chat.projectId, handle: agent.handle, currentHandle: agent.handle, currentTitle: agent.title }] };
  const first = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, body));
  const replay = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, body));
  assert.equal(replay.communicationEventId, first.communicationEventId);
  const d = await f.settled(agent.id, previous);
  assert.equal(f.turns.filter(x => x.agentId === agent.id).length, 2);
  assert.equal(d.messages.filter(x => x.text.includes(reply)).length, 1);
  assert.ok(JSON.stringify(d.runOutput).includes('Ordinary fixture execution output'));
  const conversation = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
  assert.ok(JSON.stringify(conversation).includes(reply));
  assert.ok(!JSON.stringify(conversation).includes('Ordinary fixture execution output'));
}));

test('checks 6, 7, 9, 56: reply after rename reaches the stable recipient; fresh unrelated context excludes private text', {timeout:90000}, async t => {
 let store,native;
 await withFixture(t, async f => {
  const chat = await f.createChat('Private reply');
  const target = await f.createIdleAgent(chat, 'Original name');
  const objective = 'Preserve the original identity context and answer the follow-up after rename.';
  await f.send(target.id, objective);
  await until(async () => (await native.requests()).some(x => x.method === 'turn/start'), 'initial native identity context');
  const finding='The original reader has retained its identity context.';await native.sendWorkResult(finding);
  await until(()=>store.readEvents(target.id).some(x=>x.event.type==='tool_result'&&x.event.output===finding),'retained native identity finding');
  await native.sendTool('ponderosa_message', {text:'Identity context retained; awaiting the follow-up.'});
  await f.settled(target.id);
  const renamed = f.ok(await f.api('PATCH', `/api/agents/${target.id}`, { title: 'Renamed reader' }));
  assert.equal(renamed.id, target.id);
  const marker = `private-${randomUUID()}`, previous = (await f.detail(target.id)).runs.map(r => r.id);
  await f.send(target.id, marker);
  const queued = await until(() => store.sqlite.prepare('SELECT id FROM agent_activations WHERE agent_id=? AND instr(payload_json,?)>0').get(target.id,marker), 'exact renamed follow-up');
  const handoff = await until(async () => { const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===2?rows:undefined; }, 'renamed-context handoff',20000);
  assert.equal(handoff[1].params.threadId,handoff[0].params.threadId);
  assert.ok(!JSON.stringify(handoff[1]).includes(marker),'The queued private task is not replayed into the old context');
  const summary = objective+' The original reader has retained its identity context; the follow-up is unfinished.';
  await native.sendAnswer(summary);
  const replacement = await until(async () => { const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===3?rows:undefined; }, 'verified renamed replacement',20000);
  assert.notEqual(replacement[2].params.threadId,handoff[0].params.threadId);
  assert.ok(JSON.stringify(replacement[2]).includes(summary),'The replacement preserves the original objective and retained finding');
  await native.sendAnswer('Identity continuity context received.');
  const turns = await until(async () => { const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===4?rows:undefined; }, 'same private follow-up after handoff',20000);
  assert.equal(turns[3].params.threadId,replacement[2].params.threadId);
  assert.ok(JSON.stringify(turns[3]).includes(marker));
  assert.equal(turns.filter(x=>JSON.stringify(x).includes(marker)).length,1);
  await native.sendTool('ponderosa_message',{text:'Explicit fixture reply'});
  const d = await f.settled(target.id, previous);
  const run = store.sqlite.prepare('SELECT r.id FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id WHERE a.activation_id=?').get(queued.id);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(queued.id).n,1);
  const input = f.ok(await f.api('GET', `/api/runs/${run.id}/provider-input?exact=1`));
  assert.ok(JSON.stringify(input).includes(marker));
  assert.ok(JSON.stringify(input).includes('Renamed reader'));
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(target.id).n,1);
  assert.equal(store.readEvents(target.id).filter(x=>x.event.type==='session_reset').length,0,'Rename cannot silently discard the accepted context');
  await f.reopen();
  const other = await f.createIdleAgent(chat, 'Unrelated reader');
  await f.send(other.id,'Read only your own unrelated task.');
  const unrelated = await until(async () => { const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===5?rows[4]:undefined; }, 'unrelated fresh context',20000);
  assert.ok(!JSON.stringify(unrelated).includes(marker));
  await native.sendTool('ponderosa_message',{text:'Unrelated task completed.'});await f.settled(other.id);
  assert.ok(d.messages.some(x => x.role === 'assistant' && x.text === 'Explicit fixture reply'));
 }, {storeFactory:root=>store=new AgentStore(root),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

for (const fresh of [false, true]) test(`checks 3, 17: explicitly attached text is read by the ${fresh ? 'fresh' : 'continued'} provider session`, fresh?{timeout:90000}:options, async t => {
 if(fresh){
  let store,native;
  await withFixture(t,async f=>{
   const chat=await f.createChat('Attachment reader'),otherChat=await f.createChat('Other owner'),agent=await f.createIdleAgent(chat,'Reader');
   const objective='Retain the attachment-reading objective while awaiting the supplied file.';
   await f.send(agent.id,objective);await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial native attachment context');
   const finding='The reader is ready to inspect only an explicitly supplied file.';await native.sendWorkResult(finding);
   await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output===finding),'retained native attachment finding');
   await native.sendTool('ponderosa_message',{text:'Ready for the explicitly supplied file.'});await f.settled(agent.id);
   const contents=`Only-in-file ${randomUUID()}`;
   const asset=f.ok(await f.api('POST',`/api/agents/${agent.id}/attachments`,Buffer.from(contents),{'content-type':'application/octet-stream','x-ponderosa-filename':'fixture.txt','x-ponderosa-media-type':'text/plain'}));
   const before=(await f.detail(agent.id)).runs.map(r=>r.id),oldSession=store.resumeSessionState(agent.id).sessionId;
   f.ok(await f.api('PATCH','/api/workspace/preferences',{globalInstructions:'Fresh fixture policy'}));
   const task='Read only the supplied fixture.txt and report its contents.';
   await f.send(agent.id,task,{attachmentIds:[asset.id]});
   const queued=await until(()=>store.sqlite.prepare('SELECT id FROM agent_activations WHERE agent_id=? AND instr(payload_json,?)>0').get(agent.id,task),'exact attachment task');
   const handoff=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===2?rows:undefined;},'attachment context handoff',20000);
   assert.equal(handoff[1].params.threadId,oldSession);assert.ok(!JSON.stringify(handoff[1]).includes(task),'The pending file task is not replayed into old context');
   const summary=objective+' The file-reading task is unfinished; inspect only its explicitly supplied file.';
   await native.sendAnswer(summary);
   const replacement=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===3?rows:undefined;},'verified attachment replacement',20000);
   assert.notEqual(replacement[2].params.threadId,oldSession);assert.ok(JSON.stringify(replacement[2]).includes(summary));
   await native.sendAnswer('Attachment continuity context received.');
   const turns=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===4?rows:undefined;},'same attachment task after handoff',20000),turn=turns[3];
   assert.equal(turn.params.threadId,replacement[2].params.threadId);assert.ok(JSON.stringify(turn).includes(task));
   assert.equal(turns.filter(x=>JSON.stringify(x).includes(task)).length,1);assert.ok(!JSON.stringify(turn).includes(contents),'Expected file contents leaked into prompt');
   const candidates=runtimeAttachmentPaths(turn);assert.ok(candidates.length,'No supplied runtime attachment path');
   const bytes=await readFile(candidates[0],'utf8');assert.equal(bytes,contents);
   await native.sendTool('ponderosa_message',{text:`Read: ${bytes}`});const d=await f.settled(agent.id,before);
   assert.ok(d.messages.some(x=>x.text===`Read: ${contents}`));assert.notEqual(store.resumeSessionState(agent.id).sessionId,oldSession);
   assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(queued.id).n,1);
   assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1);
   assert.equal(store.readEvents(agent.id).filter(x=>x.event.type==='session_reset').length,0,'Workspace guidance cannot silently discard the accepted context');
   assert.equal((await f.api('GET',`/api/conversations/${otherChat.id}/assets/${asset.id}/download`)).status,404);
  },{storeFactory:root=>store=new AgentStore(root),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
  return;
 }
 return withFixture(t, async f => {
  const chat = await f.createChat('Attachment reader'), otherChat = await f.createChat('Other owner');
  const agent = await f.createAgent(chat, 'Reader');
  const contents = `Only-in-file ${randomUUID()}`;
  const asset = f.ok(await f.api('POST', `/api/agents/${agent.id}/attachments`, Buffer.from(contents), { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': 'fixture.txt', 'x-ponderosa-media-type': 'text/plain' }));
  const before = (await f.detail(agent.id)).runs.map(r => r.id), oldSession = f.sessions.get(agent.id).engineAgentId;
  if (fresh) f.ok(await f.api('PATCH', '/api/workspace/preferences', { globalInstructions: 'Fresh fixture policy' }));
  let bytes;
  f.plans.set(agent.id, [{ run: async (session, input, turn) => {
    const text = rendered(turn);
    assert.ok(!text.includes(contents), 'Expected file contents leaked into prompt');
    const candidates = runtimeAttachmentPaths(turn);
    assert.ok(candidates.length, 'No supplied runtime attachment path');
    bytes = await readFile(candidates[0], 'utf8');
    assert.equal((await session.tool('ponderosa_message', { text: `Read: ${bytes}` })).success, true);
  } }]);
  await f.send(agent.id, 'Read only the supplied fixture.txt and report its contents.', { attachmentIds: [asset.id] });
  const d = await f.settled(agent.id, before);
  assert.equal(bytes, contents);
  assert.ok(d.messages.some(x => x.text === `Read: ${contents}`));
  assert.equal(f.sessions.get(agent.id).engineAgentId === oldSession, !fresh);
  assert.equal((await f.api('GET', `/api/conversations/${otherChat.id}/assets/${asset.id}/download`)).status, 404);
 });
});

test('checks 69, 70, 79: captured text artifact bytes and full-copy instructions survive reopening', options, t => withFixture(t, async f => {
  const source = await f.createChat('Artifact source'), target = await f.createChat('Import target');
  const instructions = `Saved guidance ${randomUUID()}`;
  f.ok(await f.api('PATCH', `/api/conversations/${source.id}`, { instructions }));
  const agent = await f.createAgent(source, 'Publisher');
  const bytes = `Text artifact ${randomUUID()}`;
  await writeFile(path.join(source.workingDirectory, 'artifact.txt'), bytes);
  const session = await f.hold(agent.id);
  const published = f.ok(await f.tool(session, 'ponderosa_import_file', { path: 'artifact.txt' }));
  const download = await f.api('GET', published.artifact.downloadUrl);
  assert.equal(download.body, bytes);
  const reader = await f.createAgent(source, 'Text artifact reader');
  f.plans.set(reader.id, [{ run: async (s, input, turn) => {
    const references = turn.input.prompt.split('\n').filter(line => line.startsWith('{') && line.includes(published.artifact.id)).map(line => JSON.parse(line));
    const reference = references.find(x => x.artifactId === published.artifact.id);
    assert.ok(reference?.localPath, 'Explicit artifact has no readable provider reference');
    assert.ok(!JSON.stringify(turn.input).includes(bytes), 'File-derived answer was already in the question');
    const actual = await readFile(reference.localPath, 'utf8');
    assert.equal(actual, bytes);
    assert.equal((await s.tool('ponderosa_message', { text: `Artifact read: ${actual}` })).success, true);
  } }]);
  const readerPrevious = (await f.detail(reader.id)).runs.map(r => r.id);
  f.ok(await f.tool(session, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [reader.id], text: `Read the text artifact ponderosa://artifact/${published.artifact.id}`, artifactIds: [published.artifact.id], urgency: 'urgent' }));
  const readerDetail = await f.settled(reader.id, readerPrevious);
  assert.ok(readerDetail.messages.some(x => x.text.includes(`Artifact read: ${bytes}`)));
  session.finish(); await until(async () => !(await f.detail(agent.id)).runs.some(r => ['running','preparing'].includes(r.status)), 'publisher finish');
  const pkg = f.ok(await f.api('GET', `/api/agents/${agent.id}/export?mode=full`));
  assert.equal(pkg.sourceProjectInstructions, instructions);
  const imported = f.ok(await f.api('POST', `/api/projects/${target.projectId}/import-agents`, { package: pkg, conversationId: target.id, engineMapping: { codex: 'codex' } }, { 'idempotency-key': randomUUID() }));
  await f.reopen();
  assert.equal(f.ok(await f.api('GET', `/api/conversations/${target.id}`)).conversation.instructions, instructions);
  assert.equal(f.ok(await f.api('GET', `/api/agents/${imported.rootAgentId}/export?mode=full`)).sourceProjectInstructions, instructions);
}));

test('checks 46, 47, 48, 50, 51: manager consumes blocked/failed children before final delivery', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Delegation');
  const manager = await f.createAgent(chat, 'Manager'), a = await f.createAgent(chat, 'Worker A'), b = await f.createAgent(chat, 'Worker B');
  f.plans.set(a.id, [{ hold: true }]); f.plans.set(b.id, [{ hold: true }]);
  const session = await f.hold(manager.id);
  const coordinated = f.ok(await f.tool(session, 'ponderosa_coordinate', { idempotencyKey: randomUUID(), requests: [a,b].map(w => ({ recipientAgentId: w.id, text: `Work for ${w.title}`, lifetime: { kind: 'indefinite' } })), join: { mode: 'all', satisfyingOutcomes: ['blocked','failed'], wakePolicy: 'final_only' } }));
  await until(() => [a,b].every(w => f.turns.filter(x => x.agentId === w.id).length === 2), 'worker inputs');
  assert.ok(rendered(f.turns.filter(x => x.agentId === a.id).at(-1)).includes('Work for Worker A'));
  assert.equal((await f.tool(session, 'ponderosa_message', { text: 'Premature report', taskDelivery: 'final' })).status, 409);
  f.ok(await f.tool(f.sessions.get(a.id), 'ponderosa_update_request', { kind: 'blocked', text: 'Missing prerequisite' })); f.sessions.get(a.id).finish();
  assert.equal((await f.tool(session, 'ponderosa_message', { text: 'Still premature', taskDelivery: 'final' })).status, 409);
  f.ok(await f.tool(f.sessions.get(b.id), 'ponderosa_update_request', { kind: 'failed', text: 'Validation failed' })); f.sessions.get(b.id).finish();
  let final;
  f.plans.set(manager.id, [{ run: async (s, input, turn) => {
    assert.ok(rendered(turn).includes('Missing prerequisite')); assert.ok(rendered(turn).includes('Validation failed'));
    final = await f.tool(s, 'ponderosa_message', { text: 'Worker A blocked; Worker B failed. Neither succeeded.', taskDelivery: 'final' });
    f.ok(final);
  } }]);
  session.finish(); await until(() => final, 'resumed manager');
  const d = await until(async () => { const detail = await f.detail(manager.id); return detail.messages.some(x => x.text === 'Worker A blocked; Worker B failed. Neither succeeded.') ? detail : false; }, 'canonical final');
  assert.equal(d.coordinationV3.joins.find(x => x.id === coordinated.joinId).state, 'satisfied');
  assert.deepEqual(d.coordinationV3.requests.filter(x => coordinated.requestIds.includes(x.id)).map(x => x.state).sort(), ['blocked','failed']);
}));

test('fresh delegated continuation restores the whole human objective and later steering instead of relying on peer summaries', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Whole objective reconstruction');
  const manager = await f.createAgent(chat, 'Objective owner'), worker = await f.createAgent(chat, 'Scoped worker');
  const objective = `Complete ALL implementation before combining and testing the whole product ${randomUUID()}`;
  const correction = `Preserve every requirement and report exact remaining blockers ${randomUUID()}`;
  f.plans.set(manager.id, [{ hold: true }]);
  const before = f.turns.filter(x => x.agentId === manager.id).length;
  await f.send(manager.id, objective);
  await until(() => f.turns.filter(x => x.agentId === manager.id).length > before, 'original human task accepted');
  const session = f.sessions.get(manager.id), oldSession = session.engineAgentId;
  f.plans.set(worker.id, [{ hold: true }]);
  f.ok(await f.tool(session, 'ponderosa_coordinate', { recipientAgentId: worker.id, text: 'Implement this scoped piece only.' }));
  await until(() => f.turns.filter(x => x.agentId === worker.id).length === 2, 'scoped worker accepted');
  await f.send(manager.id, correction);
  await until(() => f.steers.some(x => x.agentId === manager.id && x.input.prompt.includes(correction)), 'later human steering delivered');
  assert.equal((await f.tool(session, 'ponderosa_message', { text: 'More implementation remains.', taskDelivery: 'blocked' })).status, 409);
  // A changed system contract requires a fresh seed on the next legitimate
  // joined wake. Nothing starts an extra task or retries external effects.
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { globalInstructions: 'Keep the whole user objective intact.' }));
  let result;
  f.plans.set(manager.id, [{ run: async (resumed, input, turn) => {
    assert.notEqual(resumed.engineAgentId, oldSession);
    assert.ok(input.prompt.includes('[UNFINISHED HUMAN REQUESTS'));
    assert.ok(input.prompt.includes(objective)); assert.ok(input.prompt.includes(correction));
    result = await f.tool(resumed, 'ponderosa_message', { text: 'All requested work and verification complete.', taskDelivery: 'final' });
    f.ok(result);
  } }]);
  session.finish();
  f.ok(await f.tool(f.sessions.get(worker.id), 'ponderosa_update_request', { text: 'Scoped piece complete.' }));
  f.sessions.get(worker.id).finish();
  await until(() => result, 'whole objective reconstructed on fresh canonical wake');
}));
