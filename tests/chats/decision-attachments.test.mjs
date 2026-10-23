import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AgentStore, WorkspaceStore } from '@ponderosa/agents';
import { AssetStore } from '../../apps/server/dist/assets.js';
import { withFixture, fixtureTestOptions, until, runtimeAttachmentPaths } from '../shared/fixture.mjs';
import { validateDecisionResponse } from '../../apps/web/src/decisions.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const document = Buffer.from('Full decision document content 😀\nFinal sentence retained.');
async function ask(f, engine = 'codex', prompt = {}) {
  const chat = await f.createChat('Decision attachment ownership');
  const agent = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agents`, {
    title: 'Question owner', engine, conversationId: chat.id, idempotencyKey: randomUUID(),
  }));
  let decision;
  f.plans.set(agent.id, [{ output: false, run: async session => {
    decision = f.ok(await f.tool(session, 'ponderosa_decision', { ...(prompt.questions ? {} : { mode: 'text', question: 'Attach the controlled evidence' }), blocking: true, idempotencyKey: randomUUID(), ...prompt }));
  } }]);
  await f.send(agent.id, 'Ask the controlled attachment question.'); await f.settled(agent.id);
  return { chat, agent, decision, scope: 'agent:'+agent.id };
}
async function upload(f, x, body = png, name = 'evidence.png', type = 'image/png', owner = x.decision.id) {
  return f.ok(await f.api('POST', `/api/conversations/${encodeURIComponent(x.scope)}/draft-attachments`, body,
    { 'content-type': 'application/x-ponderosa-attachment', 'x-ponderosa-filename': encodeURIComponent(name),
      'x-ponderosa-media-type': type, 'x-ponderosa-draft-owner': owner }));
}
async function download(f, url, expected) {
  const result = await f.api('GET', url); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.rawBody, expected); assert.equal(result.headers['x-content-type-options'], 'nosniff');
}
for (const engine of ['codex', 'claude']) for (const text of ['', 'Attached evidence']) test(`${engine}: Decision ${text ? 'text plus file' : 'image-only'} answer survives delivery, cleanup, reopen and Agent deletion`, fixtureTestOptions, t => {
  let store;
  return withFixture(t, async f => {
    const x = await ask(f, engine), body = text ? document : png, name = text ? 'résumé 100%.txt' : 'evidence.png';
    const staged = await upload(f, x, body, name, text ? 'text/plain' : 'image/png');
    const marker = 'FILES_READ_'+randomUUID();
    f.plans.set(x.agent.id, [{ run: async (session, input) => {
      const paths = runtimeAttachmentPaths(input); assert.ok(paths.length, 'actual provider input contains materialized files');
      const bytes = await Promise.all(paths.map(file => readFile(file)));
      assert.ok(bytes.some(value => value.equals(body)), 'provider-visible original bytes match the upload');
      f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: marker }));
    } }]);
    const result = f.ok(await f.api('POST', `/api/decisions/${x.decision.id}/respond`, { ...(text ? { text } : {}), attachmentIds: [staged.id] }));
    const file = result.response.attachments[0]; assert.equal(result.response.attachments.length, 1);
    assert.equal(file.name, name); assert.equal(file.agentId, x.agent.id);
    assert.equal(file.sha256, createHash('sha256').update(body).digest('hex'));
    await until(async () => (await f.detail(x.agent.id)).messages.some(m => m.text === marker), 'exact attachment continuation reply');
    await f.settled(x.agent.id);
    await download(f, file.downloadUrl, body);
    const all = f.ok(await f.api('GET', '/api/all-chat?limit=100'));
    assert.deepEqual(all.decisions.find(event => event.decision.id === x.decision.id && event.kind === "decision_response")?.decision.response.attachments, result.response.attachments);
    const bindings = store.sqlite.prepare('SELECT * FROM runtime_attachment_associations WHERE communication_id=?').all(`decision:${x.decision.id}:response`);
    assert.equal(bindings.length, 1); assert.equal(bindings[0].asset_id, file.id);
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM agent_activations WHERE dedupe_key=?').get(`message:decision:${x.decision.id}:response`).n, 1);
    const assets = new AssetStore(f.dataDir);
    try { await assets.reconcile(x.chat.projectId, x.agent.id, new Set(), Date.now()+60*60_000); }
    finally { assets.close(); }
    await download(f, file.downloadUrl, body);
    assert.deepEqual(f.ok(await f.api('POST', `/api/decisions/${x.decision.id}/respond`, { text: 'Repeated request must not overwrite accepted files' })), result);
    const turns = f.turns.length;
    await f.reopen();
    assert.deepEqual(f.ok(await f.api('GET', `/api/decisions?agentId=${x.agent.id}`)).find(d => d.id === x.decision.id), result);
    await download(f, file.downloadUrl, body); assert.equal(f.turns.length, turns, 'reopen does not wake accepted work again');
    const preview = f.ok(await f.api('POST', `/api/projects/${x.chat.projectId}/agent-deletions/preview`, { rootAgentIds: [x.agent.id] }));
    f.ok(await f.api('POST', `/api/projects/${x.chat.projectId}/agent-deletions/commit`, { rootAgentIds: [x.agent.id], previewHash: preview.previewHash }));
    assert.equal((await f.api('GET', `/api/agents/${x.agent.id}`)).status, 404);
    await download(f, file.downloadUrl, body);
    await f.reopen(); await download(f, file.downloadUrl, body);
    const retained = f.ok(await f.api('GET', '/api/all-chat?limit=100'));
    assert.deepEqual(retained.decisions.find(event => event.decision.id === x.decision.id && event.kind === 'decision_response')?.decision.response.attachments, result.response.attachments);
    assert.equal(f.ok(await f.api('GET', '/api/branches/engine/all-chat?limit=100')).decisions.some(event=>event.decision.id===x.decision.id),false);
    assert.equal((await f.api('GET',file.downloadUrl.replace('/api/','/api/branches/engine/'))).status,404);
  }, { diagnosticProvider: true, storeFactory: dataDir => (store = new AgentStore(dataDir)) });
});

test('Decision files reject foreign owners, invalid IDs, Skip/option/form mixing and retired uploads without resolving the question', fixtureTestOptions, t => withFixture(t, async f => {
  const x = await ask(f), other = await ask(f), foreign = await upload(f, other), own = await upload(f, x);
  const ordinary = await upload(f, x, document, 'ordinary.txt', 'text/plain', randomUUID());
  for (const response of [{ attachmentIds: [foreign.id] }, { attachmentIds: [ordinary.id] }, { attachmentIds: [randomUUID()] },
    { attachmentIds: [own.id, own.id] }, { attachmentIds: [null] }, { attachmentIds: null, text: 'invalid null' }, { attachmentIds: 'bad' }, { attachmentIds: Array.from({length: 101},randomUUID) }, { attachmentIds: [own.id], text: 'invalid form', content: {} },
    { attachmentIds: [own.id], skip: true }, { attachmentIds: [own.id], optionId: 'approve' }, { attachments: [{ localPath: '/private' }], text: 'forged' }]) {
    const result = await f.api('POST', `/api/decisions/${x.decision.id}/respond`, response); assert.ok([400,404].includes(result.status), JSON.stringify(result.body));
    assert.equal(f.ok(await f.api('GET', `/api/decisions?agentId=${x.agent.id}`))[0].status, 'pending');
  }
  f.ok(await f.api('POST', `/api/decisions/${x.decision.id}/respond`, { skip: true }));
  const late = await f.api('POST', `/api/conversations/${encodeURIComponent(x.scope)}/draft-attachments`, png,
    { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': 'late.png', 'x-ponderosa-media-type': 'image/png', 'x-ponderosa-draft-owner': x.decision.id });
  assert.equal(late.status,409);
  assert.equal((await f.api('PUT', `/api/conversations/${encodeURIComponent(x.scope)}/draft`, { text:'late',attachmentIds:[],ownerId:x.decision.id,expectedRevision:0,clientId:'stale-tab' })).status,409);
}));

test('a lost response after canonical save preserves file bytes and wakes exactly one continuation', fixtureTestOptions, t => withFixture(t, async f => {
  const x = await ask(f), staged = await upload(f,x); let failed = false;
  const original = WorkspaceStore.prototype.resolveDecision;
  t.mock.method(WorkspaceStore.prototype,'resolveDecision',function(id,response){const value=original.call(this,id,response);if(id===x.decision.id&&!failed){failed=true;throw Error('Controlled response loss after fsynced save');}return value;});
  assert.equal((await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{attachmentIds:[staged.id]})).status,500);
  const saved = f.ok(await f.api('GET',`/api/decisions?agentId=${x.agent.id}`))[0];assert.equal(saved.status,'resolved');assert.equal(saved.response.attachments.length,1);
  await download(f,saved.response.attachments[0].downloadUrl,png);
  const turns=f.turns.length;await f.reopen();
  await until(()=>f.turns.length===turns+1,'one repaired Decision continuation');await f.settled(x.agent.id);
  const count=f.turns.length;
  assert.deepEqual(f.ok(await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{attachmentIds:[staged.id]})),saved);
  assert.equal(f.turns.length,count);await download(f,saved.response.attachments[0].downloadUrl,png);
}));

test('Decision client validation retains attachment-only and text-plus-file answers', () => {
  const decision = { id: randomUUID(), mode: 'text', options: [], allowOther: true, status: 'pending' }, id = randomUUID();
  assert.deepEqual(validateDecisionResponse(decision, { attachmentIds: [id] }), { attachmentIds: [id] });
  assert.deepEqual(validateDecisionResponse(decision, { text: '  Full answer  ', attachmentIds: [id] }), { text: 'Full answer', attachmentIds: [id] });
});

for (const engine of ['codex','claude']) test(`${engine}: an active Decision file answer steers the same Run with usable bytes once`, fixtureTestOptions, t => withFixture(t,async f=>{
  const chat=await f.createChat('Active file answer');
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Active file reader',engine,conversationId:chat.id,idempotencyKey:randomUUID()}));
  const session=await f.hold(agent.id), run=(await f.detail(agent.id)).runs.find(r=>r.status==='running');
  const decision=f.ok(await f.tool(session,'ponderosa_decision',{mode:'text',question:'Attach evidence while this Run remains active',blocking:true,idempotencyKey:randomUUID()}));
  const x={chat,agent,decision,scope:'agent:'+agent.id},file=await upload(f,x,document,'active.txt','text/plain');
  f.ok(await f.api('POST',`/api/decisions/${decision.id}/respond`,{attachmentIds:[file.id]}));
  const steer=await until(()=>f.steers.find(s=>s.agentId===agent.id&&s.input.prompt.includes(decision.id)),'file answer steering');
  const paths=runtimeAttachmentPaths(steer.input);assert.ok(paths.length, JSON.stringify(steer.input));assert.ok((await Promise.all(paths.map(p=>readFile(p)))).some(body=>body.equals(document)), JSON.stringify(paths));
  f.ok(await f.api('POST',`/api/decisions/${decision.id}/respond`,{attachmentIds:[file.id]}));
  assert.equal(f.steers.filter(s=>s.input.prompt.includes(decision.id)).length,1);
  assert.equal((await f.detail(agent.id)).runs.find(r=>r.id===run.id).status,'running');assert.equal(session.isAlive(),true);
  f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Read active file exactly once',steeringInjectionId:steer.input.clientMessageId}));
  session.finish();await until(async()=>(await f.detail(agent.id)).runs.find(r=>r.id===run.id).status==='completed','same Run finishes');
},{diagnosticProvider:true}));

test('failed-save provisional files stay protected until replay, then only unselected bindings expire', fixtureTestOptions,t=>{
  let store;
  return withFixture(t,async f=>{
    const x=await ask(f),file=await upload(f,x),original=WorkspaceStore.prototype.resolveDecision;let failed=false;
    t.mock.method(WorkspaceStore.prototype,'resolveDecision',function(id,response){if(id===x.decision.id&&!failed){failed=true;throw Error('Controlled failure before canonical save');}return original.call(this,id,response);});
    const route=`/api/decisions/${x.decision.id}/respond`,source=`decision:${x.decision.id}:response`;
    assert.equal((await f.api('POST',route,{attachmentIds:[file.id]})).status,500);
    const provisional=store.sqlite.prepare('SELECT asset_id FROM runtime_attachment_associations WHERE communication_id=?').get(source).asset_id;
    let assets=new AssetStore(f.dataDir);
    try{await assets.reconcile(x.chat.projectId,x.agent.id,new Set(),Date.now()+60*60_000);assert.ok(await assets.content(x.chat.projectId,x.agent.id,provisional,false));}finally{assets.close();}
    const saved=f.ok(await f.api('POST',route,{attachmentIds:[file.id]}));
    assert.notEqual(saved.response.attachments[0].id,provisional);await f.settled(x.agent.id);
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM runtime_attachment_associations WHERE communication_id=?').get(source).n,2);
    await f.reopen();
    const remaining=store.sqlite.prepare('SELECT asset_id FROM runtime_attachment_associations WHERE communication_id=?').all(source);
    assert.deepEqual(remaining.map(row=>row.asset_id),[saved.response.attachments[0].id]);
    assets=new AssetStore(f.dataDir);
    try{await assets.reconcile(x.chat.projectId,x.agent.id,new Set(),Date.now()+60*60_000);assert.equal(await assets.content(x.chat.projectId,x.agent.id,provisional,false),undefined);}finally{assets.close();}
    await download(f,saved.response.attachments[0].downloadUrl,png);
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});


test('resolved Decision retirement releases conflict files without clearing the ordinary Agent draft',fixtureTestOptions,t=>withFixture(t,async f=>{
  const x=await ask(f),one=await upload(f,x),two=await upload(f,x,document,'displaced.txt','text/plain'),url=`/api/conversations/${encodeURIComponent(x.scope)}`;
  const draft=(ownerId,text,attachmentIds,clientId='a',expectedRevision=0)=>({ownerId,text,attachmentIds,clientId,expectedRevision});
  f.ok(await f.api('PUT',url+'/draft',draft('ordinary-owner','Ordinary unsent message',[])));
  f.ok(await f.api('PUT',url+'/draft',draft(x.decision.id,'Current answer',[one.id])));
  assert.equal((await f.api('PUT',url+'/draft',draft(x.decision.id,'Stale alternative',[two.id],'b'))).status,409);
  const conflicts=f.ok(await f.api('GET',url+'/draft-conflicts?ownerId='+x.decision.id));assert.equal(conflicts.conflicts.length,1);
  f.ok(await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{attachmentIds:[one.id]}));await f.settled(x.agent.id);
  assert.equal(f.ok(await f.api('GET',url+'/draft-conflicts?ownerId='+x.decision.id)).conflicts.length,0);
  const retired=f.ok(await f.api('GET',url+'/draft?ownerId='+x.decision.id));assert.equal(retired.text,'');assert.deepEqual(retired.attachmentIds,[]);
  assert.equal(f.ok(await f.api('GET',url+'/draft?ownerId=ordinary-owner')).text,'Ordinary unsent message');
  const restore=await f.api('POST',url+'/draft-conflicts/'+conflicts.conflicts[0].id+'/restore',{ownerId:x.decision.id,clientId:'late',expectedRevision:retired.revision});assert.ok([404,409].includes(restore.status),JSON.stringify(restore));
  await f.reopen();assert.equal(f.ok(await f.api('GET',url+'/draft?ownerId=ordinary-owner')).text,'Ordinary unsent message');
}));

for(const engine of ['codex','claude']) test(`${engine}: a fresh provider session receives both Decision image and document contents`,fixtureTestOptions,t=>{
  let store;
  return withFixture(t,async f=>{
    const x=await ask(f,engine),previous=f.turns.at(-1).sessionId;
    assert.equal(store.clearResumeSession(x.agent.id,'provider_root_exit'),true);await f.reopen();
    const first=await upload(f,x),second=await upload(f,x,document,'complete.txt','text/plain');
    let inspected=false;
    f.plans.set(x.agent.id,[{run:async(session,input)=>{
      assert.notEqual(session.engineAgentId,previous);
      const bodies=await Promise.all(runtimeAttachmentPaths(input).map(file=>readFile(file)));
      assert.ok(bodies.some(body=>body.equals(png)));assert.ok(bodies.some(body=>body.equals(document)));inspected=true;
    }}]);
    f.ok(await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{attachmentIds:[first.id,second.id]}));
    await until(()=>inspected,'fresh session inspects both files');await f.settled(x.agent.id);
  },{diagnosticProvider:true,storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('files never approve a real approval option or provider form',fixtureTestOptions,t=>withFixture(t,async f=>{
  const x=await ask(f,'codex',{mode:'approval',options:[{id:'approve',label:'Approve'},{id:'deny',label:'Deny'}],allowOther:true}),file=await upload(f,x);
  for(const response of [{optionId:'approve',attachmentIds:[file.id]},{text:'Evidence',content:{approved:true},attachmentIds:[file.id]}]) {
    assert.equal((await f.api('POST',`/api/decisions/${x.decision.id}/respond`,response)).status,400);
    assert.equal(f.ok(await f.api('GET',`/api/decisions?agentId=${x.agent.id}`))[0].status,'pending');
  }
  const answer=f.ok(await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{text:'This is evidence, not permission',attachmentIds:[file.id]}));
  assert.equal(answer.response.optionId,undefined);assert.equal(answer.response.attachments.length,1);await f.settled(x.agent.id);
}));

for(const engine of ['codex','claude']) test(`UI019 ${engine}: one grouped answer set preserves full questions, per-question files and one continuation`,fixtureTestOptions,t=>withFixture(t,async f=>{
 const tail='FINAL_QUESTION_SENTENCE_'+randomUUID(),questions=[
 {id:'evidence',mode:'text',question:'x'.repeat(10000-tail.length)+tail,context:'Complete context retained'},
 {id:'direction',mode:'choice',question:'Which direction?',options:[{id:'north',label:'North'},{id:'south',label:'South'}]},
 {id:'optional',mode:'text',question:'Optional information'}];
 const x=await ask(f,engine,{questions});assert.equal(x.decision.questions[0].question,questions[0].question);
 const one=await upload(f,x),two=await upload(f,x,document,'complete.txt','text/plain');
 const answers=[{questionId:'evidence',status:'answered',attachmentIds:[one.id,two.id]},{questionId:'direction',status:'answered',optionId:'north'},{questionId:'optional',status:'skipped'}];
 const draftRoute=`/api/conversations/${encodeURIComponent(x.scope)}/draft`;
 const staged=f.ok(await f.api('PUT',draftRoute,{ownerId:x.decision.id,text:'',attachmentIds:[one.id,two.id],decisionAnswers:answers,expectedRevision:0,clientId:'group-tab'}));
 assert.deepEqual(staged.decisionAnswers,answers);
 const turns=f.turns.length;await f.reopen();assert.equal(f.turns.length,turns,'Draft navigation/save/reopen never completes the Decision');
 assert.deepEqual(f.ok(await f.api('GET',draftRoute+'?ownerId='+x.decision.id)).decisionAnswers,answers);
 let inspected=false;
 f.plans.set(x.agent.id,[{run:async(session,input)=>{
   assert.ok(input.prompt.includes(tail),'Provider input contains the final full-question sentence');assert.ok(input.prompt.includes('Complete context retained'));
   assert.ok(input.prompt.includes('optional'));assert.ok(input.prompt.includes('skipped'));
   const bodies=await Promise.all(runtimeAttachmentPaths(input).map(file=>readFile(file)));assert.ok(bodies.some(body=>body.equals(png)));assert.ok(bodies.some(body=>body.equals(document)));inspected=true;
 }}]);
 const saved=f.ok(await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{answers}));
 assert.equal(saved.response.answers.length,3);assert.equal(saved.response.answers[1].optionId,'north');assert.equal(saved.response.answers[2].status,'skipped');assert.equal(saved.response.optionId,undefined);
 assert.deepEqual(saved.response.answers[0].attachmentIds,saved.response.attachments.map(file=>file.id));
 await until(()=>inspected,'full grouped input/file inspection');await f.settled(x.agent.id);
 const delivered=f.turns.length;assert.deepEqual(f.ok(await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{answers})),saved);assert.equal(f.turns.length,delivered);
 for(let i=0;i<2;i++)await download(f,saved.response.attachments[i].downloadUrl,i?document:png);
 const retired=f.ok(await f.api('GET',draftRoute+'?ownerId='+x.decision.id));assert.equal(retired.decisionAnswers,undefined);assert.deepEqual(retired.attachmentIds,[]);
 assert.deepEqual(f.ok(await f.api('GET','/api/decisions?id='+x.decision.id))[0],saved);
 assert.deepEqual(f.ok(await f.api('GET','/api/branches/engine/decisions?id='+x.decision.id)),[],'Exact reads retain product isolation');
 await f.reopen();assert.deepEqual(f.ok(await f.api('GET','/api/decisions?id='+x.decision.id))[0],saved);assert.equal(f.turns.length,delivered);
},{diagnosticProvider:true}));

test('UI019 invalid answer/draft sets cannot complete work or borrow another Decision files',fixtureTestOptions,t=>withFixture(t,async f=>{
 const questions=[{id:'one',question:'One'},{id:'two',question:'Two'}],x=await ask(f,'codex',{questions}),other=await ask(f),foreign=await upload(f,other),own=await upload(f,x);
 const good=[{questionId:'one',status:'answered',text:'One'},{questionId:'two',status:'skipped'}],route=`/api/decisions/${x.decision.id}/respond`;
 for(const body of [{text:'Incomplete scalar'},{skip:true},{answers:[]},{answers:[good[0],good[0]]},{answers:[{...good[0],questionId:'foreign'},good[1]]},{answers:[good[0],{...good[1],optionId:'approve'}]},{answers:good,text:'Mixed'},{answers:[{questionId:'one',status:'answered',attachmentIds:[own.id]},{questionId:'two',status:'answered',attachmentIds:[own.id]}]}]){
  const result=await f.api('POST',route,body);assert.equal(result.status,400,JSON.stringify(result.body));assert.equal(f.ok(await f.api('GET','/api/decisions?id='+x.decision.id))[0].status,'pending');
 }
 assert.equal((await f.api('POST',route,{answers:[{questionId:'one',status:'answered',attachmentIds:[foreign.id]},good[1]]})).status,404);
 const draft={ownerId:x.decision.id,text:'',decisionAnswers:[{questionId:'foreign',status:'answered',text:'Wrong identity'}],attachmentIds:[],expectedRevision:0,clientId:'bad'};
 assert.equal((await f.api('PUT',`/api/conversations/${encodeURIComponent(x.scope)}/draft`,draft)).status,400);
 assert.equal((await f.api('PUT',`/api/conversations/${encodeURIComponent(x.scope)}/draft`,{...draft,ownerId:'ordinary-owner',decisionAnswers:good})).status,400);
 const skipped=f.ok(await f.api('POST',route,{answers:questions.map(q=>({questionId:q.id,status:'skipped'}))}));assert.equal(skipped.status,'resolved');assert.ok(skipped.response.answers.every(a=>a.status==='skipped'));assert.equal(skipped.response.optionId,undefined);await f.settled(x.agent.id);
}));
test('UI019 lost grouped response repairs one continuation and preserves canonical question/file bindings',fixtureTestOptions,t=>withFixture(t,async f=>{
 const x=await ask(f,'codex',{questions:[{id:'one',question:'First'},{id:'two',question:'Second'}]}),file=await upload(f,x);const answers=[{questionId:'one',status:'answered',attachmentIds:[file.id]},{questionId:'two',status:'answered',text:'Full second answer'}];
 const original=WorkspaceStore.prototype.resolveDecision;let failed=false;t.mock.method(WorkspaceStore.prototype,'resolveDecision',function(id,response){const saved=original.call(this,id,response);if(id===x.decision.id&&!failed){failed=true;throw Error('Controlled grouped response loss after save');}return saved;});
 assert.equal((await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{answers})).status,500);const saved=f.ok(await f.api('GET','/api/decisions?id='+x.decision.id))[0];assert.equal(saved.response.answers[0].attachmentIds[0],saved.response.attachments[0].id);
 const turns=f.turns.length;await f.reopen();await until(()=>f.turns.length===turns+1,'one grouped repair continuation');await f.settled(x.agent.id);const delivered=f.turns.length;
 assert.deepEqual(f.ok(await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{answers})),saved);assert.equal(f.turns.length,delivered);await download(f,saved.response.attachments[0].downloadUrl,png);
},{diagnosticProvider:true}));

test('UI019 oversized aggregate answers are rejected before resolution or provider wake-up',fixtureTestOptions,t=>withFixture(t,async f=>{
 const questions=[1,2,3].map(i=>({id:'q'+i,question:'😀'.repeat(9999)+i})),x=await ask(f,'codex',{questions}),turns=f.turns.length;
 const answers=questions.map(q=>({questionId:q.id,status:'answered',text:'😀'.repeat(10000)}));const result=await f.api('POST',`/api/decisions/${x.decision.id}/respond`,{answers});assert.equal(result.status,413,JSON.stringify(result.body));
 assert.equal(f.ok(await f.api('GET','/api/decisions?id='+x.decision.id))[0].status,'pending');assert.equal(f.turns.length,turns);
}));
