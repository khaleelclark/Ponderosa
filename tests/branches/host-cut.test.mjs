import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';
import {captureBranchHostCut,verifyBranchHostCut} from '../../packages/agents/dist/branch-host-cut.js';
import {selectBranchUnit} from '../../packages/agents/dist/branch-unit-selection.js';
function fixture(t,{secret=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'host-cut-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Host cut',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Host cut'}),agent=store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id}),peer=store.createAgent(project.id,{title:'Peer',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Host cut',trigger:{kind:'manual'},...(secret?{parameters:{token:{type:'secret'}}}:{}),entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Do the retained task'}],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{worker:agent.id},directories:{}}}),source=branches.accept(branch.id,'source','input');
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

test('checkpoint saver captures host dependencies but never marks an Agent frontier executable',async t=>{
 const f=fixture(t);for(let n=0;n<20&&!f.branches.detail(f.source.id).attempts[0]?.requestId;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const row=f.store.sqlite.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_type(snapshot_json,'$.hostDependencies')='object' ORDER BY id DESC LIMIT 1").get(f.source.id);assert.ok(row);
 const snapshot=JSON.parse(row.snapshot_json);assert.equal(snapshot.restore_supported,false);assert.ok(verifyBranchHostCut(snapshot.hostDependencies,f.source.id));
 const owners=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n;assert.ok(f.branches.historicalCheckpoints(f.branch.id,f.source.id).every(cp=>!cp.restoreSupported));assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,owners);
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
