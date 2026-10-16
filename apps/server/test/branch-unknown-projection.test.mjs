import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
import {BranchScriptService} from '../dist/branch-script-service.js';
import {branchOperationalSummary} from '../dist/branch-operations.js';

test('linked unknown Request is reconciliation without changing held work or sealed research',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinecone-unknown-'));
 const store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 const owner=branches.create('Projection fixture','owner');
 const project=store.createProject({label:'Projection',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:owner.id});
 const chat=store.getConversation(project.lastConversationId),agent=store.createAgent(project.id,{title:'Reader',engine:'codex',conversationId:chat.id});
 const step=id=>({id,kind:'agent',target:{kind:'persistent_organization',ref:'root'},instructions:'Return one result'});
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'projection',definition:{schema:'ponderosa.branch.v1',name:'Projection',trigger:{kind:'manual'},entry:'research',steps:[step('research'),step('review')],controls:[],edges:[{id:'next',from:'research',to:'review',on:'success'}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{root:agent.id},directories:{}}});
 const execution=branches.accept(branch.id,'fixture','source'),worker=new BranchScriptService(branches,store,'projection-fixture');
 await worker.tick(true);const first=branches.detail(execution.id).attempts[0].requestId;
 coordination.updateRequest({requestId:first,updateId:'sealed',kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'Preserved research'}});
 await worker.tick(true);await worker.tick(true);
 const detail=branches.detail(execution.id),attempt=detail.attempts.find(a=>a.requestId!==first);
 assert.ok(attempt?.requestId);assert.equal(detail.sealedResults.length,1);
 const sealed=JSON.stringify(detail.sealedResults);
 const db=store.sqlite,snapshot=()=>({requests:db.prepare('SELECT * FROM coordination_requests ORDER BY id').all(),runs:db.prepare('SELECT * FROM scheduler_runs ORDER BY id').all(),attempts:db.prepare('SELECT * FROM branch_attempts ORDER BY id').all(),sealed:db.prepare('SELECT * FROM branch_sealed_results ORDER BY id').all()});
 const healthy=async()=>({authentication:'authenticated',intakeReady:true});
 for(const state of ['in_progress','awaiting_answer','outcome_unknown']){
  // Synthetic authority state only in this disposable on-disk fixture.
  db.prepare('UPDATE coordination_requests SET state=? WHERE id=?').run(state,attempt.requestId);
  const before=snapshot(),view=branches.detail(execution.id),summary=await branchOperationalSummary(db,branches.execution(execution.id),healthy);
  assert.deepEqual(snapshot(),before,'projections cannot create Request/Run/replay or mutate held work');assert.equal(JSON.stringify(view.sealedResults),sealed);
  assert.equal(view.waits.some(w=>w.kind==='reconciliation'),state==='outcome_unknown');
  assert.equal(summary.counts.needsReconciliation,state==='outcome_unknown'?1:0);
  if(state==='outcome_unknown'){assert.equal(summary.state,'needs_reconciliation');assert.equal(summary.agentWaits.length,0);assert.equal(view.attempts.find(a=>a.id===attempt.id).requestOutcomeUnknown,true)}
  else assert.equal(summary.agentWaits[0].state,state==='in_progress'?'agent_running':'waiting_human');
 }
 db.prepare("UPDATE branch_attempts SET state='outcome_unknown' WHERE id=?").run(attempt.id);
 const before=snapshot(),summary=await branchOperationalSummary(db,branches.execution(execution.id),healthy);
 assert.equal(summary.counts.needsReconciliation,1,'same attempt and Request unknown count once');assert.equal(branches.detail(execution.id).waits[0].kind,'reconciliation');assert.deepEqual(snapshot(),before);
 db.prepare("UPDATE coordination_requests SET state='in_progress' WHERE id=?").run(attempt.requestId);
 assert.equal((await branchOperationalSummary(db,branches.execution(execution.id),healthy)).counts.needsReconciliation,1,'attempt unknown still counts without Request unknown');
});
