import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';
import {captureBranchHostCut,verifyBranchHostCut} from '../../packages/agents/dist/branch-host-cut.js';
import {selectBranchUnit} from '../../packages/agents/dist/branch-unit-selection.js';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'host-cut-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Host cut',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Host cut'}),agent=store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id}),peer=store.createAgent(project.id,{title:'Peer',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Host cut',trigger:{kind:'manual'},entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Do the retained task'}],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}};
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
