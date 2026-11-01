import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';
import {captureBranchHostCut,verifyBranchHostCut} from '../../packages/agents/dist/branch-host-cut.js';
import {selectBranchUnit} from '../../packages/agents/dist/branch-unit-selection.js';
function fixture(t,{secret=false,mode,maxConcurrent=8,requireCommunication=false,transform,input='input'}={}){
 const dir=mkdtempSync(join(tmpdir(),'host-cut-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Host cut',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Host cut'}),agent=store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id}),peer=store.createAgent(project.id,{title:'Peer',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Host cut',trigger:{kind:'manual'},...(secret?{parameters:{token:{type:'secret'}}}:{}),entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Do the retained task',...(requireCommunication?{requireUserCommunication:true}:{})}],controls:[],edges:[],policy:{maxConcurrentExecutions:maxConcurrent,failure:{action:'stop'}}};
 const extra=transform?.(definition,{agent,peer})??{};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{worker:agent.id},directories:{},...extra}});
 if(mode)branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode},0);
 const source=branches.accept(branch.id,'source',input);
 const capture=()=>store.sqlite.transaction(()=>captureBranchHostCut(store.sqlite,source.id,selectBranchUnit(store.sqlite,source.id))).deferred();
 return {store,coordination,branches,project,chat,agent,peer,branch,source,capture};
}
test('host Request/question/answer/Join history freezes original scope and order without leases or reply authority',async t=>{
 const f=fixture(t);for(let n=0;n<20&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const root=f.branches.detail(f.source.id).attempts[0].requestId;assert.ok(root);
 f.coordination.updateRequest({requestId:root,updateId:'question',kind:'question',actor:{kind:'agent',id:f.agent.id},payload:{text:'Which source?'}});
 const delegated=f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,requesterAgentId:f.agent.id,actorScope:'controlled-host-fixture',idempotencyKey:'join',requests:[{recipientAgentId:f.peer.id,lifetime:{kind:'indefinite'},payload:{text:'Original child task'}}],join:{mode:'all',wakePolicy:'each_result'}});
 const now=new Date().toISOString();f.store.sqlite.prepare("INSERT INTO coordination_question_suspensions(question_update_id,request_id,owner_agent_id,dependency_kind,dependency_id,state,created_at,updated_at) VALUES(?,?,?,'join',?,'open',?,?)").run('question',root,f.agent.id,delegated.joinId,now,now);
 f.coordination.updateRequest({requestId:root,updateId:'answer',kind:'answer',inReplyToUpdateId:'question',actor:{kind:'user'},payload:{text:'The original private source'}});
 const cut=f.capture(),before=JSON.stringify(cut);assert.ok(verifyBranchHostCut(cut,f.source.id));assert.equal(cut.nativeState,'not_captured');assert.equal(cut.restoreAuthority,'fresh_admission_required');
 assert.ok(cut.updates.some(({row})=>row.id==='answer'&&row.in_reply_to_update_id==='question'));assert.equal(cut.joins[0].row.wake_policy,'each_result');assert.equal(cut.members[0].row.request_id,delegated.requestIds[0]);assert.equal(cut.requests.find(({row})=>row.id===root).row.conversation_id,f.chat.id);
 for(const key of ['lease_owner','lease_until','fencing_token','reply_authority_json','admission_json','process_identity_json'])assert.equal(before.includes(`"${key}"`),false);
 f.coordination.updateRequest({requestId:delegated.requestIds[0],updateId:'child-done',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'New result'}});
 assert.equal(JSON.stringify(cut),before,'later host progress cannot mutate captured bytes');const later=f.capture();assert.notDeepEqual(later,cut);assert.ok(verifyBranchHostCut(cut,f.source.id));
 const changed=structuredClone(cut);changed.updates[0].row.payload_json='{}';assert.equal(verifyBranchHostCut(changed,f.source.id),false);
 const selected=selectBranchUnit(f.store.sqlite,f.source.id);assert.throws(()=>captureBranchHostCut(f.store.sqlite,f.source.id,selected),/owner transaction/);
});

test('checkpoint saver admits the reviewed persistent issued-Request subset without launching work',async t=>{
 const f=fixture(t);for(let n=0;n<20&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const row=f.store.sqlite.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_type(snapshot_json,'$.hostDependencies')='object' ORDER BY id DESC LIMIT 1").get(f.source.id);assert.ok(row);
 const snapshot=JSON.parse(row.snapshot_json);assert.equal(snapshot.restore_supported,true);assert.ok(verifyBranchHostCut(snapshot.hostDependencies,f.source.id));
 const owners=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n;for(const cp of f.branches.historicalCheckpoints(f.branch.id,f.source.id)){const saved=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);if(saved.selected.attempts.some(a=>a.request_id))assert.equal(cp.restoreSupported,true);}assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,owners);
});

// Deferred: manager/roster visibility never grants private dependency capture.
test('host cut refuses a dependency owned outside root participants',async t=>{
 const f=fixture(t);for(let n=0;n<20&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const root=f.branches.detail(f.source.id).attempts[0].requestId;
 f.coordination.updateRequest({requestId:root,updateId:'private-question',kind:'question',actor:{kind:'agent',id:f.agent.id},payload:{text:'Dependency?'}});
 const foreign=f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,requesterAgentId:f.peer.id,actorScope:'controlled-host-fixture',idempotencyKey:'foreign',requests:[{recipientAgentId:f.agent.id,lifetime:{kind:'indefinite'},payload:{text:'Private dependency'}}],join:{mode:'all'}});
 const now=new Date().toISOString();f.store.sqlite.prepare("INSERT INTO coordination_question_suspensions(question_update_id,request_id,owner_agent_id,dependency_kind,dependency_id,state,created_at,updated_at) VALUES(?,?,?,'join',?,'open',?,?)").run('private-question',root,f.agent.id,foreign.joinId,now,now);
 assert.throws(()=>f.capture(),/root participant scope/);
});

async function adoptionFixture(t,options){
 const f=fixture(t,options);
 for(let n=0;n<30&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const requestId=f.branches.detail(f.source.id).attempts[0].requestId;
 f.coordination.updateRequest({requestId,updateId:'source-completed',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Original effects settled'}});
 for(let n=0;n<30&&f.branches.execution(f.source.id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(f.source.id).state,'completed');
 const saved=f.store.sqlite.prepare("SELECT id,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND json_type(snapshot_json,'$.hostDependencies')='object' ORDER BY id DESC LIMIT 1").get(f.source.id);assert.ok(saved);
 const selection={checkpointId:saved.id,expectedHash:saved.content_hash,requestId},grant=()=>true;
 return {...f,selection,grant,review:()=>f.branches.reviewHostRequest(f.branch.id,f.source.id,selection,grant)};
}
test('operator adoption creates one fresh Request and atomically reconciles a lost response',async t=>{
 const f=await adoptionFixture(t),review=f.review(),command={...f.selection,reviewHash:review.reviewHash,commandKey:'adopt',instruction:'Reconcile original effects, then report what independent work remains.',mode:'reconcile'};
 const receipt=f.branches.adoptHostRequest(f.branch.id,f.source.id,command,f.grant);
 assert.notEqual(receipt.requestId,f.selection.requestId);const fresh=f.coordination.getRequest(receipt.requestId);
 assert.equal(fresh.recipientAgentId,f.agent.id);assert.equal(fresh.conversationId,f.chat.id);assert.equal(fresh.requesterAgentId,undefined);
 assert.equal(fresh.payload.text,command.instruction);assert.equal(fresh.payload.historicalEvidence.source.expectedHash,f.selection.expectedHash);
 const row=f.store.sqlite.prepare('SELECT reply_authority_json FROM coordination_requests WHERE id=?').get(receipt.requestId);assert.equal(row.reply_authority_json,null);
 assert.equal(f.coordination.getRequest(f.selection.requestId).state,'completed');
 const before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n;
 const reopened=new BranchStore(f.store.sqlite,f.coordination),replay=reopened.adoptHostRequest(f.branch.id,f.source.id,command,f.grant);assert.equal(replay.requestId,receipt.requestId);assert.equal(replay.replayed,true);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,before);
 assert.throws(()=>reopened.adoptHostRequest(f.branch.id,f.source.id,{...command,instruction:'Different work'},f.grant),/idempotency conflict/);
 f.store.sqlite.prepare('UPDATE agents SET conversation_id=NULL WHERE id=?').run(f.agent.id);
 assert.throws(()=>reopened.adoptHostRequest(f.branch.id,f.source.id,command,f.grant),/current grant/);
});
test('stale authority requires a fresh review and explicit changed/secret acknowledgement',async t=>{
 const f=await adoptionFixture(t,{secret:true}),old=f.review();
 f.branches.configure(f.branch.id,{...f.branches.configuration(f.branch.id),secretBindings:{token:'fixture-handle-not-a-secret-value'}},0);
 const input={...f.selection,reviewHash:old.reviewHash,commandKey:'reviewed',instruction:'Reconcile under current authority.',mode:'reconcile'};
 const count=()=>f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,before=count();
 assert.throws(()=>f.branches.adoptHostRequest(f.branch.id,f.source.id,input,f.grant),/review changed/);assert.equal(count(),before);
 const current=f.review();assert.ok(current.current.configurationChanged);assert.deepEqual(current.current.requiredSecretRefs,['token']);assert.equal(JSON.stringify(current).includes('fixture-handle'),false);
 input.reviewHash=current.reviewHash;assert.throws(()=>f.branches.adoptHostRequest(f.branch.id,f.source.id,input,f.grant),/Changed current bindings/);
 input.acknowledgeChangedBindings=true;assert.throws(()=>f.branches.adoptHostRequest(f.branch.id,f.source.id,input,f.grant),/secret-dependent/);
 input.acknowledgeSecretBindings=true;assert.ok(f.branches.adoptHostRequest(f.branch.id,f.source.id,input,f.grant).requestId);
});
test('a Branch-owned Chat is scoped by its actual original identity without a legacy Branch Chat',async t=>{
 const f=await adoptionFixture(t);
 f.store.sqlite.prepare("UPDATE branches SET chat_id='' WHERE id=?").run(f.branch.id);f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(f.branch.id,f.chat.id);
 const cut=f.capture();assert.ok(cut);assert.equal(cut.requests[0].row.conversation_id,f.chat.id);assert.ok(f.review());
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=NULL WHERE id=?').run(f.chat.id);assert.throws(()=>f.review(),/Chat ownership/);assert.throws(()=>f.capture(),/owned Chat scope/);
});
test('receipt failure rolls back Request intake and its runnable activation',async t=>{
 const f=await adoptionFixture(t),review=f.review(),input={...f.selection,reviewHash:review.reviewHash,commandKey:'crash',instruction:'Inspect original effects.',mode:'reconcile'};
 const counts=()=>['coordination_requests','agent_activations','coordination_idempotency'].map(table=>f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.store.sqlite.exec("CREATE TEMP TRIGGER refuse_host_receipt BEFORE INSERT ON branch_commands WHEN NEW.command_key LIKE 'host-adoption:%' BEGIN SELECT RAISE(ABORT,'controlled receipt failure'); END");
 assert.throws(()=>f.branches.adoptHostRequest(f.branch.id,f.source.id,input,f.grant),/controlled receipt failure/);assert.deepEqual(counts(),before);
 f.store.sqlite.exec('DROP TRIGGER refuse_host_receipt');assert.ok(f.branches.adoptHostRequest(f.branch.id,f.source.id,input,f.grant).requestId);
});
test('artifact owner/hash and current grants are rechecked before historical read or adoption',async t=>{
 const f=await adoptionFixture(t),db=f.store.sqlite;
 db.prepare("INSERT INTO runtime_artifacts(id,owner_kind,owner_id,project_id,role,title,media_type,blob_path,blob_hash,byte_length,created_at) VALUES(?,'request_update',?,?,'document','Retained evidence','text/markdown',?,?,?,?)").run('retained-artifact','source-completed',f.project.id,'/never-exposed-or-read', 'a'.repeat(64),42,new Date().toISOString());
 const candidate=f.branches.unitSaver.freeze({written:new Set([f.source.id])})[0];assert.ok(candidate.content);
 const result=db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,candidate.content,candidate.hash),selection={...f.selection,checkpointId:Number(result.lastInsertRowid),expectedHash:candidate.hash};
 assert.throws(()=>f.branches.reviewHostRequest(f.branch.id,f.source.id,selection,()=>false),/artifact current grant/);
 const review=f.branches.reviewHostRequest(f.branch.id,f.source.id,selection,()=>true);assert.equal(JSON.stringify(review).includes('/never-exposed'),false);
 const input={...selection,reviewHash:review.reviewHash,commandKey:'artifact',instruction:'Inspect retained artifact evidence.',mode:'reconcile'};
 assert.throws(()=>f.branches.adoptHostRequest(f.branch.id,f.source.id,input,()=>false),/artifact current grant/);
 db.prepare('UPDATE runtime_artifacts SET blob_hash=? WHERE id=?').run('b'.repeat(64),'retained-artifact');assert.throws(()=>f.branches.reviewHostRequest(f.branch.id,f.source.id,selection,()=>true),/artifact current grant/);
});

// Deferred: execute only after the source-only restriction is lifted.
for(const mode of ['async','sync'])test(`before-Request ${mode} Agent graph cut admits a fresh obligation and consumes its result`,async t=>{
 const f=fixture(t,{mode});
 let cut,oldRequest;
 for(let n=0;n<30&&!oldRequest;n++){
  f.branches.advance();await f.branches.unitSaver.drain();
  cut??=f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(cp=>{
   if(!cp.restoreSupported)return false;
   const s=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);
   return s.selected.steps.length===1&&s.selected.attempts.every(a=>a.state==='prepared'&&!a.request_id);
  });
  oldRequest=f.branches.detail(f.source.id).attempts[0]?.requestId;
 }
 assert.ok(cut);assert.ok(oldRequest);
 f.coordination.updateRequest({requestId:oldRequest,updateId:`original-${mode}`,kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'original'}});
 for(let n=0;n<20&&f.branches.execution(f.source.id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'agent-graph');
 assert.equal(f.branches.detail(next.id).attempts[0].requestId,undefined);
 let fresh;for(let n=0;n<30&&!fresh;n++){f.branches.advance();await f.branches.unitSaver.drain();fresh=f.branches.detail(next.id).attempts[0]?.requestId;}
 assert.ok(fresh);assert.notEqual(fresh,oldRequest);assert.equal(f.coordination.getRequest(oldRequest).state,'completed');
 f.coordination.updateRequest({requestId:fresh,updateId:`fresh-${mode}`,kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'fresh result'}});
 for(let n=0;n<20&&f.branches.execution(next.id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(next.id).state,'completed');assert.equal(f.branches.execution(next.id).output,'fresh result');
 assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'agent-graph').id,next.id);
});

// Deferred source regression: no provider/runner execution is needed by these fixtures.
test('canonical historical graph restoration preserves facts, fresh identities and atomic receipt replay',async t=>{
 const f=await adoptionFixture(t);
 // Fixture source updates were authored without leasing the queued delivery.
 f.store.sqlite.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const selection={checkpointId:f.selection.checkpointId,expectedHash:f.selection.expectedHash};
 const review=f.branches.reviewHostGraph(f.branch.id,f.source.id,selection,f.grant),input={...selection,reviewHash:review.reviewHash,commandKey:'restore-graph',reconcileEffects:true};
 const before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_activations').get().n;
 const result=f.branches.restoreHostGraph(f.branch.id,f.source.id,input,f.grant),fresh=result.requestMap[f.selection.requestId];
 assert.notEqual(fresh,f.selection.requestId);assert.equal(f.coordination.getRequest(fresh).state,'completed');
 const row=f.store.sqlite.prepare('SELECT reply_authority_json,origin_run_id,communication_event_id FROM coordination_requests WHERE id=?').get(fresh);
 assert.deepEqual(row,{reply_authority_json:null,origin_run_id:null,communication_event_id:null});
 const history=f.coordination.requestLifecycleDetails({projectId:f.project.id,conversationId:f.chat.id,recordId:fresh});
 assert.equal(history.updates[0].actorKind,'system');assert.equal(history.updates[0].historicalOrigin.sourceRequestId,f.selection.requestId);assert.match(history.updates[0].text,/Imported historical/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_activations').get().n,before,'terminal facts do not relaunch their effects');
 const replay=new BranchStore(f.store.sqlite,f.coordination).restoreHostGraph(f.branch.id,f.source.id,input,f.grant);assert.equal(replay.replayed,true);assert.deepEqual(replay.requestMap,result.requestMap);
 f.store.sqlite.prepare('UPDATE agents SET conversation_id=NULL WHERE id=?').run(f.agent.id);assert.throws(()=>f.branches.restoreHostGraph(f.branch.id,f.source.id,input,f.grant),/grant/);
});
test('historical graph receipt and provenance insertion failure roll back every fresh identity',async t=>{
 const f=await adoptionFixture(t);f.store.sqlite.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const selection={checkpointId:f.selection.checkpointId,expectedHash:f.selection.expectedHash},review=f.branches.reviewHostGraph(f.branch.id,f.source.id,selection,f.grant),input={...selection,reviewHash:review.reviewHash,commandKey:'graph-crash',reconcileEffects:true};
 const counts=()=>['coordination_requests','coordination_request_updates','coordination_cut_restorations','coordination_restored_update_origins','agent_activations','activation_outbox'].map(table=>f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.store.sqlite.exec("CREATE TEMP TRIGGER refuse_restored_origin BEFORE INSERT ON coordination_restored_update_origins BEGIN SELECT RAISE(ABORT,'controlled origin failure'); END");
 assert.throws(()=>f.branches.restoreHostGraph(f.branch.id,f.source.id,input,f.grant),/controlled origin failure/);assert.deepEqual(counts(),before);
 f.store.sqlite.exec('DROP TRIGGER refuse_restored_origin');assert.ok(f.branches.restoreHostGraph(f.branch.id,f.source.id,input,f.grant).restorationId);
});

test('Branch result reader consumes retained output and refuses altered import provenance',async t=>{
 const {restoredRequestUpdatePayload}=await import('../../packages/agents/dist/coordination-v3-cut-restoration-authority.js');
 const {payloadHash,stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const f=await adoptionFixture(t),db=f.store.sqlite;
 db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const selection={checkpointId:f.selection.checkpointId,expectedHash:f.selection.expectedHash},review=f.branches.reviewHostGraph(f.branch.id,f.source.id,selection,f.grant);
 const receipt=f.branches.restoreHostGraph(f.branch.id,f.source.id,{...selection,reviewHash:review.reviewHash,commandKey:'result-origin',reconcileEffects:true},f.grant);
 const row=db.prepare('SELECT * FROM coordination_request_updates WHERE id=?').get(receipt.updateMap['source-completed']);
 assert.match(JSON.parse(row.payload_json).text,/Imported historical/);
 assert.deepEqual(restoredRequestUpdatePayload(db,row),{text:'Original effects settled'});
 assert.throws(()=>restoredRequestUpdatePayload(db,{...row,request_id:f.selection.requestId}),/provenance differs/);
 assert.throws(()=>restoredRequestUpdatePayload(db,{...row,resulting_version:row.resulting_version+1}),/provenance differs/);
 const changed={...JSON.parse(row.payload_json),historicalPayload:{text:'Unverified replacement'}};
 assert.throws(()=>restoredRequestUpdatePayload(db,{...row,payload_json:stableJson(changed),payload_hash:payloadHash(changed)}),/provenance differs/);
 const live=db.prepare('SELECT * FROM coordination_request_updates WHERE id=?').get('source-completed');
 assert.deepEqual(restoredRequestUpdatePayload(db,{...live,payload_json:stableJson(changed)}),changed,'ordinary authored payloads do not acquire import authority');
 db.prepare('DELETE FROM coordination_restored_update_origins WHERE update_id=?').run(row.id);
 assert.throws(()=>restoredRequestUpdatePayload(db,row),/provenance unavailable/);
});

test('Branch terminal reduction waits when the selected Request version has no matching update',async t=>{
 const f=fixture(t);
 for(let n=0;n<30&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const requestId=f.branches.detail(f.source.id).attempts[0].requestId;assert.ok(requestId);
 f.coordination.updateRequest({requestId,updateId:'terminal-before-projection-drift',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Selected result'}});
 f.store.sqlite.prepare('UPDATE coordination_requests SET version=version+1 WHERE id=?').run(requestId);
 f.branches.advance();await f.branches.unitSaver.drain();
 const attempt=f.branches.detail(f.source.id).attempts[0];assert.equal(attempt.state,'waiting');assert.equal(attempt.result,undefined);assert.match(attempt.error,/explicit reconciliation/);
 assert.notEqual(f.branches.execution(f.source.id).state,'completed');
});

test('mapped historical question accepts a live answer and completes its fresh Join continuation',async t=>{
 const {stableJson,payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const f=fixture(t);for(let n=0;n<30&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const root=f.branches.detail(f.source.id).attempts[0].requestId;
 const child=f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,requesterAgentId:f.agent.id,actorScope:'controlled-host-fixture',idempotencyKey:'historical-question-join',requests:[{recipientAgentId:f.peer.id,lifetime:{kind:'indefinite'},payload:{text:'Inspect without repeating effects'}}],join:{mode:'all',continuationRequestIds:[root]}});
 f.coordination.updateRequest({requestId:child.requestIds[0],updateId:'historical-question-source',kind:'question',actor:{kind:'agent',id:f.peer.id},payload:{text:'Which retained source should be inspected?'}});
 const cut=f.capture(),snapshot={schema:'branch-unit-selected.v2',hostDependencies:cut},bytes=stableJson(snapshot),expectedHash=payloadHash(snapshot);
 const checkpointId=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,expectedHash).lastInsertRowid);
 f.coordination.updateRequest({requestId:child.requestIds[0],updateId:'settled-child',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Original task settled'}});
 f.coordination.updateRequest({requestId:root,updateId:'settled-root',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Original root settled'}});
 for(let n=0;n<30&&f.branches.execution(f.source.id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(f.source.id).state,'completed');
 // No provider was launched by the fixture; retire its synthetic queued deliveries.
 f.store.sqlite.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const selection={checkpointId,expectedHash},grant=()=>true,review=f.branches.reviewHostGraph(f.branch.id,f.source.id,selection,grant),command={...selection,reviewHash:review.reviewHash,commandKey:'restore-question-join',reconcileEffects:true};
 const restored=f.branches.restoreHostGraph(f.branch.id,f.source.id,command,grant),childId=restored.requestMap[child.requestIds[0]],questionId=restored.updateMap['historical-question-source'],rootId=restored.requestMap[root],joinId=restored.joinMap[child.joinId];
 const pending=f.store.sqlite.prepare("SELECT agent_id,kind,payload_json FROM agent_activations WHERE state='pending'").all();
 assert.equal(pending.length,1);assert.equal(pending[0].agent_id,f.agent.id);assert.equal(pending[0].kind,'coordination_question');assert.equal(JSON.parse(pending[0].payload_json).inReplyToUpdateId,questionId);
 const imported=f.store.sqlite.prepare('SELECT kind,actor_kind,actor_id FROM coordination_request_updates WHERE id=?').get(questionId);assert.deepEqual(imported,{kind:'historical_question',actor_kind:'system',actor_id:'host-cut-restoration'});
 assert.throws(()=>f.coordination.updateRequest({requestId:childId,updateId:'forged-history',kind:'historical_question',actor:{kind:'system'},payload:{text:'Forged'}}),/Unsupported live/);
 assert.throws(()=>f.coordination.updateRequest({requestId:childId,updateId:'wrong-answer',kind:'answer',actor:{kind:'user'},inReplyToUpdateId:'historical-question-source',payload:{text:'Wrong identity'}}),/outstanding question/);
 f.coordination.updateRequest({requestId:childId,updateId:'fresh-answer',kind:'answer',actor:{kind:'user'},inReplyToUpdateId:questionId,payload:{text:'Inspect only the retained source.'}});
 assert.equal(f.coordination.getRequest(childId).state,'in_progress');
 f.coordination.updateRequest({requestId:childId,updateId:'fresh-completion',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Reconciled; no effect replayed'}});
 const wake=f.store.sqlite.prepare("SELECT payload_json FROM agent_activations WHERE kind='coordination_join_satisfied' AND id IN(SELECT activation_id FROM activation_sources WHERE source_kind='join' AND source_id=?)").get(joinId);
 assert.ok(wake);const payload=JSON.parse(wake.payload_json);assert.equal(payload.outcomes[0].requestId,childId);assert.equal(payload.continuations[0].requestId,rootId);assert.equal(payload.outcomes[0].update.id,'fresh-completion');
 assert.equal(f.coordination.getRequest(root).state,'completed');assert.equal(f.coordination.getRequest(rootId).state,'waiting_dependency');
});

// Deferred: source-only issued-Request Branch rewind integration.
async function issuedRewindFixture(t,{terminal=false,questionJoin=false,progress=false,maxConcurrent=8,requireCommunication=false}={}){
 const f=fixture(t,{maxConcurrent,requireCommunication}),db=f.store.sqlite;
 for(let n=0;n<30&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const oldAttempt=f.branches.detail(f.source.id).attempts[0],root=oldAttempt.requestId;assert.ok(root);
 let child;
 if(progress)f.coordination.updateRequest({requestId:root,updateId:'rewind-root-progress',kind:'progress',actor:{kind:'agent',id:f.agent.id},payload:{text:'Observed progress only'}});
 if(questionJoin){
  child=f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,requesterAgentId:f.agent.id,actorScope:'issued-rewind-fixture',idempotencyKey:'child',requests:[{recipientAgentId:f.peer.id,lifetime:{kind:'indefinite'},payload:{text:'Reconcile retained child'}}],join:{mode:'all',continuationRequestIds:[root]}});
  f.coordination.updateRequest({requestId:child.requestIds[0],updateId:'rewind-child-question',kind:'question',actor:{kind:'agent',id:f.peer.id},payload:{text:'Which retained source?'}});
 }
 if(terminal)f.coordination.updateRequest({requestId:root,updateId:'rewind-retained-terminal',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Retained terminal output'}});
 const candidate=f.branches.unitSaver.freeze({written:new Set([f.source.id])})[0];assert.ok(candidate.content);assert.equal(JSON.parse(candidate.content).restore_supported,true);
 const checkpointId=Number(db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,candidate.content,candidate.hash).lastInsertRowid),selection={checkpointId,expectedHash:candidate.hash};
 if(child)f.coordination.updateRequest({requestId:child.requestIds[0],updateId:'settle-original-child',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Original child settled'}});
 if(!terminal)f.coordination.updateRequest({requestId:root,updateId:'settle-original-root',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Original root settled'}});
 for(let n=0;n<30&&!['completed','failed'].includes(f.branches.execution(f.source.id).state);n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(f.source.id).state,requireCommunication?'failed':'completed');
 db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const grant=()=>true,review=f.branches.reviewHostGraph(f.branch.id,f.source.id,selection,grant),graph={reviewHash:review.reviewHash,reconcileEffects:true,grant};
 const rewind=(key='issued-prefix',reviewed=graph)=>f.branches.rewindHistorical(f.branch.id,f.source.id,checkpointId,candidate.hash,key,undefined,reviewed);
 return {...f,db,root,child,oldAttempt,selection,graph,rewind};
}
for(const terminal of [false,true])test(`issued Request Branch rewind maps its ${terminal?'retained terminal':'live'} result into a fresh suffix`,async t=>{
 const f=await issuedRewindFixture(t,{terminal});
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,f.selection.checkpointId,f.selection.expectedHash,'unreviewed'),/Reviewed historical graph authority/);
 const before=f.db.prepare('SELECT COUNT(*) n FROM agent_activations').get().n,next=f.rewind(),attempt=f.branches.detail(next.id).attempts[0];
 assert.notEqual(attempt.id,f.oldAttempt.id);assert.notEqual(attempt.stepExecutionId,f.oldAttempt.stepExecutionId);assert.notEqual(attempt.requestId,f.root);assert.equal(attempt.fence,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM agent_activations').get().n,before+(terminal?0:1));
 assert.equal(f.rewind().id,next.id,'lost-response retry reuses both Branch and canonical maps');
 if(!terminal)f.coordination.updateRequest({requestId:attempt.requestId,updateId:'mapped-root-completion',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Fresh suffix output'}});
 for(let n=0;n<30&&f.branches.execution(next.id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(next.id).state,'completed');assert.equal(f.branches.execution(next.id).output,terminal?'Retained terminal output':'Fresh suffix output');
 assert.equal(f.coordination.getRequest(f.root).state,'completed');assert.equal(f.rewind().id,next.id);
});
test('issued Request rewind atomically restores question, answer and Join continuation into its Branch suffix',async t=>{
 const f=await issuedRewindFixture(t,{questionJoin:true}),next=f.rewind(),attempt=f.branches.detail(next.id).attempts[0];
 const line=JSON.parse(f.db.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get(next.id).snapshot_json),map=line.coordination;
 assert.equal(attempt.requestId,map.requestMap[f.root]);
 const child=map.requestMap[f.child.requestIds[0]],question=map.updateMap['rewind-child-question'];
 f.coordination.updateRequest({requestId:child,updateId:'mapped-live-answer',kind:'answer',actor:{kind:'user'},inReplyToUpdateId:question,payload:{text:'Use the retained source'}});
 f.coordination.updateRequest({requestId:child,updateId:'mapped-child-complete',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Child reconciled'}});
 assert.ok(f.db.prepare("SELECT 1 FROM activation_sources WHERE source_kind='join' AND source_id=?").get(map.joinMap[f.child.joinId]));
 f.coordination.updateRequest({requestId:attempt.requestId,updateId:'mapped-join-root-complete',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Join reconciled into Branch'}});
 for(let n=0;n<30&&f.branches.execution(next.id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(next.id).output,'Join reconciled into Branch');
});
test('issued Request rewind rolls back canonical deliveries and Branch ownership on frontier insertion failure',async t=>{
 const f=await issuedRewindFixture(t),tables=['branch_executions','branch_commands','branch_attempts','coordination_requests','coordination_request_updates','coordination_cut_restorations','agent_activations','activation_outbox'],counts=()=>tables.map(table=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.db.exec("CREATE TEMP TRIGGER reject_mapped_attempt BEFORE INSERT ON branch_attempts WHEN NEW.request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'controlled mapped attempt failure'); END");
 assert.throws(()=>f.rewind(),/controlled mapped attempt failure/);assert.deepEqual(counts(),before);
 f.db.exec('DROP TRIGGER reject_mapped_attempt');assert.ok(f.rewind().id);
});
test('issued Request review cannot reuse an independently restored graph as a Branch suffix',async t=>{
 const f=await issuedRewindFixture(t),{payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 f.branches.restoreHostGraph(f.branch.id,f.source.id,{...f.selection,commandKey:`branch-rewind:${payloadHash('issued-prefix')}`,reviewHash:f.graph.reviewHash,reconcileEffects:true},f.graph.grant);
 assert.throws(()=>f.rewind(),/separate restoration/);
});

for(const tamper of ['request-link','request-bound-audit','terminal-version'])test(`issued Request rewind refuses ${tamper} mismatch before admission`,async t=>{
 const f=await issuedRewindFixture(t,{terminal:true}),{stableJson,payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const saved=JSON.parse(f.db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(f.selection.checkpointId).snapshot_json);
 if(tamper==='request-link')saved.selected.attempts[0].request_id='unowned-request';
 if(tamper==='request-bound-audit')saved.continuation.audit=saved.continuation.audit.filter(event=>event.kind!=='request_bound');
 if(tamper==='terminal-version'){
  const update=saved.hostDependencies.updates.find(({row})=>row.id==='rewind-retained-terminal');update.row.resulting_version++;update.sha256=payloadHash(update.row);
 }
 const hash=payloadHash(saved),id=Number(f.db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,stableJson(saved),hash).lastInsertRowid),before=f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n;
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash,'mismatched-cut',undefined,f.graph),/integrity|unsupported/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,before);
});
test('restored update-sourced Request delivery retains ordinary Branch concurrency accounting',async t=>{
 const f=await issuedRewindFixture(t,{progress:true,maxConcurrent:1}),next=f.rewind(),attempt=f.branches.detail(next.id).attempts[0];
 const source=f.db.prepare("SELECT source.source_kind FROM activation_sources source JOIN agent_activations a ON a.id=source.activation_id WHERE a.state='pending' AND source.source_kind='request_update'").get();assert.ok(source);
 const other=f.branches.accept(f.branch.id,'capacity-after-restore','other');
 for(let n=0;n<10;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.detail(other.id).attempts.some(a=>a.requestId),false);
 f.coordination.updateRequest({requestId:attempt.requestId,updateId:'release-restored-capacity',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Reconciled'}});
 for(let n=0;n<30&&!f.branches.detail(other.id).attempts.some(a=>a.requestId);n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.ok(f.branches.detail(other.id).attempts.some(a=>a.requestId));
});

test('mapped suffix still refuses completion without fresh required user Communication proof',async t=>{
 const f=await issuedRewindFixture(t,{requireCommunication:true}),next=f.rewind(),attempt=f.branches.detail(next.id).attempts[0];
 f.coordination.updateRequest({requestId:attempt.requestId,updateId:'unproven-mapped-publication',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Claimed publication',communicationEventId:'historical-or-missing-publication'}});
 for(let n=0;n<30&&!['completed','failed'].includes(f.branches.execution(next.id).state);n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(next.id).state,'failed');assert.match(f.branches.detail(next.id).attempts[0].error,/Required user Communication/);
 assert.equal(f.branches.execution(next.id).output,undefined);
});

// Deferred source: the shared canonical restoration path for Fork/Map and mixed gates.
async function parallelIssuedFixture(t,{shape='map',mode='async'}={}){
 const f=fixture(t,{mode,input:'["one","two"]',transform:(d,{agent,peer})=>{
  const edge=(id,from,to,on='success')=>({id,from,to,on});
  d.steps.push({id:'finish',kind:'human_gate',prompt:'Finish the restored graph',editable:true});
  if(shape==='map'){
   d.entry='map';d.controls=[{id:'map',kind:'map',joinId:'join',workerId:'agent',source:'list',maxItems:4,maxConcurrentItems:1},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}];
   d.edges=[edge('item','map','agent','selected'),edge('arrive','agent','join'),edge('finish-edge','join','finish')];
  }else{
   d.entry='fork';d.steps.push(shape==='mixed'?{id:'sibling',kind:'human_gate',prompt:'Review alongside Agent',editable:true}:{id:'sibling',kind:'agent',target:{kind:'persistent_agent',ref:'peer'},instructions:'Reconcile sibling'});
   d.controls=[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['right','left']}];
   d.edges=[edge('left','fork','agent','selected'),edge('right','fork','sibling','selected'),edge('arrive','agent','join'),edge('sibling-arrive','sibling','join',shape==='mixed'?'approved':'success'),edge('finish-edge','join','finish')];
  }
  return {agents:{worker:agent.id,peer:peer.id}};
 }}),db=f.store.sqlite;
 const source=f.source;
 const tick=async()=>{f.branches.advance();await f.branches.unitSaver.drain();};
 const requests=id=>db.prepare('SELECT a.id,a.request_id,r.recipient_agent_id,r.state FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id JOIN coordination_requests r ON r.id=a.request_id WHERE s.execution_id=?').all(id);
 const complete=id=>{for(const r of requests(id))if(!['completed','failed','cancelled'].includes(r.state))f.coordination.updateRequest({requestId:r.request_id,updateId:`complete-${r.request_id}`,kind:'completed',actor:{kind:'agent',id:r.recipient_agent_id},payload:{text:'Reconciled item'}});};
 const gates=id=>db.prepare("SELECT g.id,g.revision,s.step_id FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? AND g.state='waiting'").all(id);
 const approve=(id,exceptFinish=false)=>{for(const g of gates(id))if(!exceptFinish||g.step_id!=='finish')f.branches.resolveGate(g.id,{expectedRevision:g.revision,decision:'approve',commandKey:`approve-${g.id}`});};
 for(let n=0;n<80;n++){
  await tick();
  if(mode==='exit'){complete(source.id);approve(source.id,true);await f.branches.unitSaver.drain();if(gates(source.id).some(g=>g.step_id==='finish')&&f.branches.execution(source.id).checkpointInvocation.state==='interrupted')break;}
  else if(requests(source.id).length===(shape==='fork'?2:1)&&(shape!=='mixed'||gates(source.id).some(g=>g.step_id==='sibling')))break;
 }
 assert.ok(requests(source.id).length);
 if(mode==='exit')await f.branches.unitSaver.completeExits();
 const candidate=f.branches.unitSaver.freeze({written:new Set([source.id])})[0];assert.ok(candidate.content);
 const saved=JSON.parse(candidate.content);assert.equal(saved.restore_supported,true);
 const checkpointId=Number(db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(source.id,candidate.content,candidate.hash).lastInsertRowid),selection={checkpointId,expectedHash:candidate.hash};
 const finish=async id=>{for(let n=0;n<100&&f.branches.execution(id).state!=='completed';n++){complete(id);approve(id);await tick();}assert.equal(f.branches.execution(id).state,'completed');};
 await finish(source.id);
 db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const grant=()=>true,review=f.branches.reviewHostGraph(f.branch.id,source.id,selection,grant),graph={reviewHash:review.reviewHash,reconcileEffects:true,grant};
 const rewind=(key='parallel-issued')=>f.branches.rewindHistorical(f.branch.id,source.id,checkpointId,candidate.hash,key,undefined,graph);
 return {...f,source,db,saved,selection,graph,rewind,finish,gates,requests};
}
for(const shape of ['map','fork','mixed'])for(const mode of ['async','sync','exit'])test(`issued ${shape} ${mode} rewind preserves canonical maps and completes its fresh suffix`,async t=>{
 const f=await parallelIssuedFixture(t,{shape,mode}),next=f.rewind(),old=f.saved.selected;
 const line=JSON.parse(f.db.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get(next.id).snapshot_json);
 for(const attempt of old.attempts.filter(a=>a.request_id)){
  const fresh=f.db.prepare('SELECT * FROM branch_attempts WHERE id=?').get(line.idMap[attempt.id]);
  assert.equal(fresh.request_id,line.coordination.requestMap[attempt.request_id]);assert.notEqual(fresh.request_id,attempt.request_id);assert.equal(fresh.fence,0);
 }
 if(mode==='exit'){
  assert.notEqual(f.branches.execution(next.id).checkpointInvocation.id,line.sourceCheckpointInvocation.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id JOIN coordination_request_updates u ON s.source_kind='request_update' AND s.source_id=u.id WHERE u.request_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(line.coordination.requestMap)).n,0,'settled terminal roots have no new provider delivery');
 }
 if(shape==='mixed'&&mode!=='exit')assert.ok(f.gates(next.id).some(g=>g.id!==old.gates[0].id));
 if(shape==='map'&&mode!=='exit')assert.ok(old.items.some(item=>item.dispatched===0));
 assert.equal(f.rewind().id,next.id);
 await f.finish(next.id);assert.equal(f.rewind().id,next.id);
});
for(const tamper of ['request-bound','terminal-version','gate-response'])test(`mixed issued prefix rejects ${tamper} tampering without canonical delivery`,async t=>{
 const f=await parallelIssuedFixture(t,{shape:'mixed',mode:'exit'}),{stableJson,payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js'),saved=structuredClone(f.saved);
 if(tamper==='request-bound')saved.continuation.audit=saved.continuation.audit.filter(a=>a.kind!=='request_bound');
 if(tamper==='terminal-version'){const update=saved.hostDependencies.updates.find(({row})=>row.resulting_state==='completed');update.row.resulting_version++;update.sha256=payloadHash(update.row);}
 if(tamper==='gate-response')saved.selected.gates.find(g=>g.state==='resolved').response_json=stableJson({decision:'approve',expectedRevision:0,commandKey:'forged',output:'forged'});
 const hash=payloadHash(saved),id=Number(f.db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,stableJson(saved),hash).lastInsertRowid),before=f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n;
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash,'tampered-parallel',undefined,f.graph),/integrity|unsupported/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,before);
});
test('Mixed issued rewind rolls back both graphs and pending gate notifications on insertion failure',async t=>{
 const f=await parallelIssuedFixture(t,{shape:'mixed'}),tables=['branch_executions','branch_attempts','branch_gate_notifications','coordination_requests','coordination_cut_restorations','activation_outbox'],counts=()=>tables.map(table=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.db.exec("CREATE TEMP TRIGGER reject_parallel_gate BEFORE INSERT ON branch_gate_notifications BEGIN SELECT RAISE(ABORT,'controlled gate insertion failure'); END");
 assert.throws(()=>f.rewind(),/controlled gate insertion failure/);assert.deepEqual(counts(),before);
 f.db.exec('DROP TRIGGER reject_parallel_gate');assert.ok(f.rewind().id);
});
