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
 const extra=transform?.(definition,{agent,peer,branches,store,project,chat,dir})??{};
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
 assert.throws(()=>restoredRequestUpdatePayload(db,{...row,in_reply_to_update_id:'unmapped-question'}),/provenance differs/);
 for(const field of ['restorationId','sourceRequestId','sourceUpdateId','sourceKind','sourcePayloadHash','sourceVersion','historical']){
  const payload=JSON.parse(row.payload_json);payload.historicalOrigin[field]='altered';
  assert.throws(()=>restoredRequestUpdatePayload(db,{...row,payload_json:stableJson(payload),payload_hash:payloadHash(payload)}),/provenance differs/,field);
 }
 const withoutOrigin=JSON.parse(row.payload_json);delete withoutOrigin.historicalOrigin;
 assert.throws(()=>restoredRequestUpdatePayload(db,{...row,payload_json:stableJson(withoutOrigin),payload_hash:payloadHash(withoutOrigin)}),/provenance differs/);
 assert.throws(()=>restoredRequestUpdatePayload(db,{...row,payload_json:JSON.stringify(JSON.parse(row.payload_json),null,2)}),/provenance differs/);
 const changed={...JSON.parse(row.payload_json),historicalPayload:{text:'Unverified replacement'}};
 assert.throws(()=>restoredRequestUpdatePayload(db,{...row,payload_json:stableJson(changed),payload_hash:payloadHash(changed)}),/provenance differs/);
 const live=db.prepare('SELECT * FROM coordination_request_updates WHERE id=?').get('source-completed');
 assert.deepEqual(restoredRequestUpdatePayload(db,{...live,payload_json:stableJson(changed)}),changed,'ordinary authored payloads do not acquire import authority');
 for(const kind of ['historical_question','historical_answer'])assert.throws(()=>restoredRequestUpdatePayload(db,{...live,kind}),/provenance unavailable/);
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
 const cut=f.capture(),snapshot={schema:'branch-unit-selected.v2',selected:selectBranchUnit(f.store.sqlite,f.source.id),hostDependencies:cut},bytes=stableJson(snapshot),expectedHash=payloadHash(snapshot);
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


// Deferred source only: canonical graph admission is shared across every captured tree owner.
async function treeIssuedFixture(t,{parallel=false,shared=false,terminal=false}={}){
 let leaf;
 const f=fixture(t,{transform:(d,{branches,chat,agent,peer})=>{
  const edge=(id,from,to,on='success')=>({id,from,to,on});
  const leafDefinition={schema:'ponderosa.branch.v1',name:'Issued leaf',trigger:{kind:'manual'},entry:parallel?'fork':'work',steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Reconcile owned leaf'},...(parallel?[{id:'peer',kind:'agent',target:{kind:'persistent_agent',ref:'peer'},instructions:'Reconcile peer leaf'}]:[])],controls:parallel?[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['b','a']}]:[],edges:parallel?[edge('a','fork','work','selected'),edge('b','fork','peer','selected'),edge('a-join','work','join'),edge('b-join','peer','join')]:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}};
  leaf=branches.deploy({chatId:chat.id,idempotencyKey:'tree-leaf',definition:leafDefinition,bindings:{agents:{worker:agent.id,peer:peer.id},directories:{}}});
  d.entry=parallel?'fork':'call';d.steps=[{id:'call',kind:'branch_call',branchRef:'leaf'},...(parallel?[{id:'other',kind:'branch_call',branchRef:'leaf'}]:[])];
  d.controls=parallel?[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['right','left']}]:[];
  d.edges=parallel?[edge('left','fork','call','selected'),edge('right','fork','other','selected'),edge('call-join','call','join'),edge('other-join','other','join')]:[];
  return {branches:{leaf:leaf.id}};
 }}),db=f.store.sqlite;
 const owners=id=>db.prepare('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN tree p ON e.parent_execution_id=p.id) SELECT e.* FROM branch_executions e JOIN tree t ON t.id=e.id ORDER BY e.id').all(id);
 const requests=id=>db.prepare('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN tree p ON e.parent_execution_id=p.id) SELECT a.id,a.request_id,r.recipient_agent_id,r.state FROM tree t JOIN branch_step_executions s ON s.execution_id=t.id JOIN branch_attempts a ON a.step_execution_id=s.id JOIN coordination_requests r ON r.id=a.request_id').all(id);
 const tick=async()=>{f.branches.advance();await f.branches.unitSaver.drain();};
 for(let n=0;n<100&&requests(f.source.id).length<(parallel?4:1);n++)await tick();
 assert.equal(requests(f.source.id).length,parallel?4:1);
 let dependency;
 if(shared){
  const roots=requests(f.source.id).filter(r=>r.recipient_agent_id===f.agent.id).map(r=>r.request_id);
  dependency=f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,requesterAgentId:f.agent.id,actorScope:'tree-shared-join',idempotencyKey:'shared',requests:[{recipientAgentId:f.peer.id,lifetime:{kind:'indefinite'},payload:{text:'Reconcile one shared dependency'}}],join:{mode:'all',continuationRequestIds:roots}});
  f.coordination.updateRequest({requestId:dependency.requestIds[0],updateId:'tree-shared-question',kind:'question',actor:{kind:'agent',id:f.peer.id},payload:{text:'Which retained source?'}});
 }
 const complete=id=>{for(const r of requests(id))if(!['completed','failed','cancelled'].includes(r.state))f.coordination.updateRequest({requestId:r.request_id,updateId:`tree-done:${r.request_id}`,kind:'completed',actor:{kind:'agent',id:r.recipient_agent_id},payload:{text:'Reconciled leaf'}});};
 if(terminal)complete(f.source.id);
 const candidate=f.branches.unitSaver.freeze({written:new Set([f.source.id])})[0];assert.ok(candidate.content);
 const saved=JSON.parse(candidate.content);assert.equal(saved.continuation?.schema,'ponderosa.branch.script-tree-continuation.v1');assert.equal(saved.restore_supported,true);
 const checkpointId=Number(db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,candidate.content,candidate.hash).lastInsertRowid),selection={checkpointId,expectedHash:candidate.hash};
 if(dependency)f.coordination.updateRequest({requestId:dependency.requestIds[0],updateId:'tree-original-dependency-done',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Original dependency settled'}});
 const finish=async id=>{for(let n=0;n<120&&f.branches.execution(id).state!=='completed';n++){complete(id);await tick();}assert.equal(f.branches.execution(id).state,'completed');};
 await finish(f.source.id);assert.ok(owners(f.source.id).every(o=>o.state==='completed'));
 db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const grant=()=>true,review=f.branches.reviewHostGraph(f.branch.id,f.source.id,selection,grant),graph={reviewHash:review.reviewHash,reconcileEffects:true,grant};
 const rewind=(key='tree-issued')=>f.branches.rewindHistorical(f.branch.id,f.source.id,checkpointId,candidate.hash,key,undefined,graph);
 return {...f,db,leaf,saved,selection,graph,dependency,owners,requests,rewind,finish};
}
for(const parallel of [false,true])for(const terminal of [false,true])test(`issued ${parallel?'parallel':'serial'} child-owner tree restores ${terminal?'terminal':'live'} facts with one canonical receipt`,async t=>{
 const f=await treeIssuedFixture(t,{parallel,terminal}),before=f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,next=f.rewind();
 const line=JSON.parse(f.db.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.tree-rewind-lineage.v1'").get(next.id).snapshot_json);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,before+1);
 if(terminal)assert.equal(f.db.prepare("SELECT COUNT(*) n FROM agent_activations WHERE json_extract(payload_json,'$.requestId') IN (SELECT value FROM json_each(?))").get(JSON.stringify(line.coordination.requestMap)).n,0,'retained terminal tree facts create no recipient Request delivery');
 const {treeCoordinationLineageSupported}=await import('../../packages/agents/dist/branch-tree-continuation.js');assert.equal(treeCoordinationLineageSupported(f.db,line,f.saved),true);
 for(const o of f.saved.continuation.owners)for(const a of o.selected.attempts.filter(a=>a.request_id)){
  const row=f.db.prepare('SELECT a.*,s.execution_id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE a.id=?').get(line.idMap[a.id]);
  assert.equal(row.execution_id,line.idMap[o.executionId]);assert.equal(row.request_id,line.coordination.requestMap[a.request_id]);assert.notEqual(row.request_id,a.request_id);assert.equal(row.fence,0);
 }
 assert.equal(f.rewind().id,next.id);await f.finish(next.id);assert.equal(f.rewind().id,next.id);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,before+1);
 assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
});
test('shared child-owner Join/question history is deduplicated into one graph with fresh continuation identities',async t=>{
 const f=await treeIssuedFixture(t,{parallel:true,shared:true}),{retainedBranchHostGraph}=await import('../../packages/agents/dist/branch-tree-host-cut.js'),merged=retainedBranchHostGraph(f.saved,f.source.id),occurrences=merged.owners.flatMap(o=>o.cut.requests).filter(({row})=>row.id===f.dependency.requestIds[0]);
 assert.equal(occurrences.length,2);assert.equal(merged.cut.requests.filter(({row})=>row.id===f.dependency.requestIds[0]).length,1);
 const next=f.rewind(),line=JSON.parse(f.db.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.tree-rewind-lineage.v1'").get(next.id).snapshot_json),map=line.coordination;
 const requestId=map.requestMap[f.dependency.requestIds[0]],questionId=map.updateMap['tree-shared-question'];
 f.coordination.updateRequest({requestId,updateId:'tree-fresh-answer',kind:'answer',actor:{kind:'user'},inReplyToUpdateId:questionId,payload:{text:'Inspect the retained source'}});
 f.coordination.updateRequest({requestId,updateId:'tree-fresh-dependency-complete',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Shared dependency reconciled'}});
 assert.ok(f.db.prepare("SELECT 1 FROM activation_sources WHERE source_kind='join' AND source_id=?").get(map.joinMap[f.dependency.joinId]));
 await f.finish(next.id);
});
for(const kind of ['cut-hash','request-bound','owner-pin','shared-fact'])test(`tree issued restore rejects ${kind} changes before creating canonical ownership`,async t=>{
 const f=await treeIssuedFixture(t,{parallel:true,shared:kind==='shared-fact'}),{payloadHash,stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js'),saved=structuredClone(f.saved),o=saved.continuation.owners.find(o=>o.hostDependencies);
 if(kind==='cut-hash')o.hostDependenciesHash='0'.repeat(64);
 if(kind==='request-bound')o.audit=o.audit.filter(a=>a.kind!=='request_bound');
 if(kind==='owner-pin')o.hostDependencies.bindingPin.revisionId='another-owner';
 if(kind==='shared-fact'){const record=o.hostDependencies.requests.find(({row})=>row.id===f.dependency.requestIds[0]);record.row.updated_at='2099-01-01T00:00:00.000Z';record.sha256=payloadHash(record.row);o.hostDependenciesHash=payloadHash(o.hostDependencies);}
 const hash=payloadHash(saved),id=Number(f.db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,stableJson(saved),hash).lastInsertRowid);
 const tables=['coordination_cut_restorations','coordination_requests','coordination_request_updates','coordination_restored_update_origins','branch_executions','branch_step_executions','branch_attempts','branch_commands','agent_activations','activation_outbox'],state=()=>tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),before=state();
 const expected={'cut-hash':'Tree per-owner host cut differs','request-bound':'Historical tree continuation integrity unsupported','owner-pin':'Tree per-owner host cut differs','shared-fact':'Shared tree requests fact differs'};
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash,'tampered-tree',undefined,f.graph),{name:'Error',message:expected[kind]});
 assert.deepEqual(state(),before,'tampered tree creates or changes no canonical ownership, delivery or receipt');
});
test('child frontier failure rolls back the single tree receipt, deliveries and every fresh owner',async t=>{
 const f=await treeIssuedFixture(t,{parallel:true}),tables=['branch_executions','branch_attempts','branch_commands','coordination_requests','coordination_request_updates','coordination_cut_restorations','agent_activations','activation_outbox'],counts=()=>tables.map(table=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.db.exec("CREATE TEMP TRIGGER fail_tree_child BEFORE INSERT ON branch_attempts WHEN NEW.request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'controlled tree child insertion failure'); END");
 assert.throws(()=>f.rewind(),/controlled tree child insertion failure/);assert.deepEqual(counts(),before);
 f.db.exec('DROP TRIGGER fail_tree_child');assert.ok(f.rewind().id);
});
test('lost-response tree replay still checks child participant grants and current child binding pins',async t=>{
 const f=await treeIssuedFixture(t),next=f.rewind(),tables=['coordination_cut_restorations','coordination_requests','coordination_request_updates','coordination_restored_update_origins','branch_executions','branch_attempts','branch_commands','agent_activations','activation_outbox'],counts=()=>tables.map(table=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.db.prepare('UPDATE agents SET conversation_id=NULL WHERE id=?').run(f.agent.id);assert.throws(()=>f.rewind(),/unavailable|current grant/);
 assert.deepEqual(counts(),before);
 f.db.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run(f.chat.id,f.agent.id);assert.equal(f.rewind().id,next.id);assert.deepEqual(counts(),before);
 f.db.prepare("UPDATE branches SET enabled=0 WHERE id=?").run(f.leaf.id);assert.throws(()=>f.rewind(),/unavailable/);
 assert.deepEqual(counts(),before);
 f.db.prepare("UPDATE branches SET enabled=1 WHERE id=?").run(f.leaf.id);
 const config=f.branches.configuration(f.leaf.id);f.branches.configure(f.leaf.id,{...config,limits:{...config.limits,maxTraversals:config.limits.maxTraversals+1}},0);const configured=counts();assert.throws(()=>f.rewind(),/pins changed|configuration/);
 assert.deepEqual(counts(),configured);assert.ok(next.id);
});

// Deferred source only: repeated capture/selection/rewind of restored coordination.
function retainRecaptured(f,id){
 const candidate=f.branches.unitSaver.freeze({written:new Set([id])})[0];assert.ok(candidate.content);
 const saved=JSON.parse(candidate.content);assert.equal(saved.restore_supported,true);
 const checkpointId=Number(f.db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(id,candidate.content,candidate.hash).lastInsertRowid);
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,id).find(c=>c.id===checkpointId).restoreSupported,true);
 return {saved,selection:{checkpointId,expectedHash:candidate.hash}};
}
function rewindRecaptured(f,id,selection,key){
 const grant=()=>true,review=f.branches.reviewHostGraph(f.branch.id,id,selection,grant),graph={reviewHash:review.reviewHash,reconcileEffects:true,grant};
 return ()=>f.branches.rewindHistorical(f.branch.id,id,selection.checkpointId,selection.expectedHash,key,undefined,graph);
}
async function settleRecaptured(f,id,text='Recaptured fresh output'){
 for(const r of f.db.prepare('SELECT r.* FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id JOIN coordination_requests r ON r.id=a.request_id WHERE s.execution_id=?').all(id))if(r.state!=='completed')f.coordination.updateRequest({requestId:r.id,updateId:`recapture-complete:${r.id}`,kind:'completed',actor:{kind:'agent',id:r.recipient_agent_id},payload:{text}});
 for(let n=0;n<40&&f.branches.execution(id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(id).state,'completed');
 f.db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
}
for(const terminal of [false,true])test(`restored ${terminal?'retained terminal':'live'} history can be captured, selected and rewound repeatedly`,async t=>{
 const f=await issuedRewindFixture(t,{terminal,progress:!terminal}),{hostUpdateFact}=await import('../../packages/agents/dist/branch-host-provenance.js');
 let current=f.rewind(),priorIds=new Set([f.root]);
 for(let generation=0;generation<3;generation++){
  const attempt=f.branches.detail(current.id).attempts[0];assert.ok(!priorIds.has(attempt.requestId));priorIds.add(attempt.requestId);
  const {saved,selection}=retainRecaptured(f,current.id);assert.ok(saved.hostDependencies.provenance.restorations.length);
  if(terminal){const u=saved.hostDependencies.updates.find(e=>e.row.resulting_state==='completed').row;assert.deepEqual(hostUpdateFact(saved.hostDependencies,u).payload,{text:'Retained terminal output'});assert.equal(hostUpdateFact(saved.hostDependencies,u).actor.id,f.agent.id);}
  await settleRecaptured(f,current.id);
  const rewind=rewindRecaptured(f,current.id,selection,`recapture-${generation}`),before=f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,next=rewind();
  assert.equal(rewind().id,next.id);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,before+1);
  if(generation===2){await settleRecaptured(f,next.id);assert.equal(f.branches.execution(next.id).output,terminal?'Retained terminal output':'Recaptured fresh output');assert.equal(rewind().id,next.id);}
  current=next;
 }
});
test('historical question and fresh answer survive another import and recapture with original actors',async t=>{
 const f=await issuedRewindFixture(t,{questionJoin:true}),first=f.rewind();
 const lineage=id=>JSON.parse(f.db.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get(id).snapshot_json);
 const map=lineage(first.id).coordination,child=map.requestMap[f.child.requestIds[0]],question=map.updateMap['rewind-child-question'];
 f.coordination.updateRequest({requestId:child,updateId:'recaptured-live-answer',kind:'answer',actor:{kind:'user'},inReplyToUpdateId:question,payload:{text:'Use the original retained source'}});
 const firstCapture=retainRecaptured(f,first.id);
 f.coordination.updateRequest({requestId:child,updateId:'recaptured-child-completed',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Child reconciled'}});
 await settleRecaptured(f,first.id);
 const replay=rewindRecaptured(f,first.id,firstCapture.selection,'recapture-question-answer'),second=replay(),secondCapture=retainRecaptured(f,second.id);
 const {hostUpdateFact}=await import('../../packages/agents/dist/branch-host-provenance.js'),cut=secondCapture.saved.hostDependencies;
 const q=cut.updates.find(e=>e.row.kind==='historical_question').row,a=cut.updates.find(e=>e.row.kind==='historical_answer').row;
 assert.equal(a.in_reply_to_update_id,q.id);assert.equal(hostUpdateFact(cut,q).actor.id,f.peer.id);assert.equal(hostUpdateFact(cut,a).actor.kind,'user');
 assert.deepEqual(hostUpdateFact(cut,a).payload,{text:'Use the original retained source'});
 assert.equal(replay().id,second.id);
});
for(const parallel of [false,true])test(`restored issued ${parallel?'parallel':'serial'} owner tree recaptures one shared canonical graph`,async t=>{
 const f=await treeIssuedFixture(t,{parallel,shared:parallel}),first=f.rewind();
 await f.branches.unitSaver.drain(); // Every descendant must have a committed checkpoint before tree recapture.
 const capture=retainRecaptured(f,first.id);
 const {retainedBranchHostGraph}=await import('../../packages/agents/dist/branch-tree-host-cut.js'),graph=retainedBranchHostGraph(capture.saved,first.id);
 assert.equal(graph.cut.provenance.restorations.length,1);
 if(f.dependency){const line=JSON.parse(f.db.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.tree-rewind-lineage.v1'").get(first.id).snapshot_json);f.coordination.updateRequest({requestId:line.coordination.requestMap[f.dependency.requestIds[0]],updateId:'recapture-tree-dependency',kind:'completed',actor:{kind:'agent',id:f.peer.id},payload:{text:'Dependency reconciled'}});}
 await f.finish(first.id);f.db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const rewind=rewindRecaptured(f,first.id,capture.selection,'recaptured-tree'),second=rewind();assert.equal(rewind().id,second.id);
 await f.branches.unitSaver.drain();
 retainRecaptured(f,second.id);
});
for(const tamper of ['origin','receipt','source-cut','missing-proof','kind','payload'])test(`recapture refuses ${tamper} provenance before another restoration`,async t=>{
 const f=await issuedRewindFixture(t,{terminal:true}),next=f.rewind(),{saved}=retainRecaptured(f,next.id),{payloadHash,stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const cut=saved.hostDependencies;
 if(tamper==='origin'){const e=cut.provenance.origins[0];e.row.source_actor_json=stableJson({kind:'agent',id:'forged-actor'});e.sha256=payloadHash(e.row);}
 if(tamper==='receipt'){const e=cut.provenance.restorations[0];e.row.receipt.cut_hash='0'.repeat(64);e.sha256=payloadHash(e.row);}
 if(tamper==='source-cut'){const e=cut.provenance.restorations[0];e.row.snapshot.hostDependencies.updates[0].row.payload_json=stableJson({text:'Substituted original'});e.sha256=payloadHash(e.row);}
 if(tamper==='missing-proof')delete cut.provenance;
 if(tamper==='kind'){const e=cut.updates[0];e.row.kind='historical_answer';e.sha256=payloadHash(e.row);}
 if(tamper==='payload'){const e=cut.updates[0],payload=JSON.parse(e.row.payload_json);payload.historicalPayload={text:'Imported explanation substituted'};e.row.payload_json=stableJson(payload);e.row.payload_hash=payloadHash(payload);e.sha256=payloadHash(e.row);}
 const hash=payloadHash(saved),id=Number(f.db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(next.id,stableJson(saved),hash).lastInsertRowid);
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,next.id).find(c=>c.id===id).restoreSupported,false);
 const before=f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n;
 assert.throws(()=>f.branches.reviewHostGraph(f.branch.id,next.id,{checkpointId:id,expectedHash:hash},()=>true),/provenance|integrity|receipt|historical/i);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM coordination_cut_restorations').get().n,before);
});
test('recaptured rewind rollback and replay preserve original current participant grants',async t=>{
 const f=await issuedRewindFixture(t,{terminal:true}),first=f.rewind(),{selection}=retainRecaptured(f,first.id);await settleRecaptured(f,first.id);
 const rewind=rewindRecaptured(f,first.id,selection,'recapture-rollback'),tables=['coordination_requests','coordination_request_updates','coordination_restored_update_origins','coordination_cut_restorations','branch_executions','branch_attempts','branch_commands','agent_activations','activation_outbox'],counts=()=>tables.map(table=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.db.exec("CREATE TEMP TRIGGER fail_recaptured_suffix BEFORE INSERT ON branch_attempts WHEN NEW.request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'recaptured suffix failure'); END");assert.throws(rewind,/recaptured suffix failure/);assert.deepEqual(counts(),before);
 f.db.exec('DROP TRIGGER fail_recaptured_suffix');const second=rewind();assert.equal(rewind().id,second.id);
 const committed=counts();f.db.prepare('UPDATE agents SET conversation_id=NULL WHERE id=?').run(f.agent.id);assert.throws(rewind,/grant|unavailable/);assert.deepEqual(counts(),committed);
 f.db.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run(f.chat.id,f.agent.id);assert.equal(rewind().id,second.id);assert.deepEqual(counts(),committed);
});
for(const shape of ['map','fork','mixed'])for(const mode of ['async','sync','exit'])test(`restored ${shape} ${mode} frontier can save and rewind another checkpoint`,async t=>{
 const f=await parallelIssuedFixture(t,{shape,mode}),first=f.rewind(),capture=retainRecaptured(f,first.id);
 await f.finish(first.id);f.db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const rewind=rewindRecaptured(f,first.id,capture.selection,`recaptured-${shape}-${mode}`),second=rewind();assert.equal(rewind().id,second.id);
 await f.finish(second.id);assert.equal(rewind().id,second.id);
});
test('recaptured tree union refuses conflicting immutable origin evidence across owners',async t=>{
 const f=await treeIssuedFixture(t,{parallel:true,shared:true}),first=f.rewind();
 await f.branches.unitSaver.drain();
 const capture=retainRecaptured(f,first.id),{payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js'),{retainedBranchHostGraph}=await import('../../packages/agents/dist/branch-tree-host-cut.js');
 const owners=capture.saved.continuation.owners.filter(o=>o.hostDependencies?.provenance?.origins.length);
 assert.ok(owners.length>=2);const shared=owners[0].hostDependencies.provenance.origins.find(e=>owners[1].hostDependencies.provenance.origins.some(other=>other.row.update_id===e.row.update_id));assert.ok(shared);
 const changed=owners[1].hostDependencies.provenance.origins.find(e=>e.row.update_id===shared.row.update_id);changed.row.source_payload_hash='0'.repeat(64);changed.sha256=payloadHash(changed.row);owners[1].hostDependenciesHash=payloadHash(owners[1].hostDependencies);
 assert.throws(()=>retainedBranchHostGraph(capture.saved,first.id),/Shared tree historical provenance differs/);
});


test('ordinary retained updates verify the exact canonical command envelope, never a payload-only replacement',async t=>{
 const {hostUpdateHashMatches}=await import('../../packages/agents/dist/branch-host-provenance.js');
 const {payloadHash,stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const f=fixture(t);for(let n=0;n<30&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const requestId=f.branches.detail(f.source.id).attempts[0].requestId;
 f.coordination.updateRequest({requestId,updateId:'envelope-progress',kind:'progress',actor:{kind:'agent',id:f.agent.id},payload:{text:'Observed retained progress'}});
 const cut=f.capture(),row=cut.updates.find(e=>e.row.id==='envelope-progress').row;
 assert.equal(hostUpdateHashMatches(cut,row),true);
 assert.notEqual(row.payload_hash,payloadHash(JSON.parse(row.payload_json)));
 for(const change of [{payload_hash:payloadHash(JSON.parse(row.payload_json))},{actor_id:'foreign'},{request_id:'foreign'},{in_reply_to_update_id:'foreign'},{provider_failure_category:'unknown'},{payload_json:stableJson({text:'changed'})}])assert.equal(hostUpdateHashMatches(cut,{...row,...change}),false);
 assert.equal(hostUpdateHashMatches({...cut,artifactRefs:[{row:{owner_kind:'request_update',owner_id:row.id}}]},row),false,'reference-only cuts cannot supply omitted original artifact command metadata');
});
