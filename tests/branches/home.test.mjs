import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {AgentStore,BranchStore,CoordinationV3Store,WorkspaceStore} from '@ponderosa/agents';
import {registerBranchRoutes} from '../../apps/server/dist/routes/branches.js';
import {workspaceNotificationPage} from '../../apps/server/dist/routes/notifications.js';

const gate={id:'work',kind:'human_gate',prompt:'Approve this owned fixture',editable:true};
async function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'branch-home-')),probes=[],providers=new Map();let store,workspace,coordination,branches,app,passed=false;
 const open=async()=>{
 store=new AgentStore(root);workspace=new WorkspaceStore(root);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination);app=Fastify();
 registerBranchRoutes(app,{store,workspace,branches,installations:{setPublisher(){}},sources:{},createChat:()=>{throw Error('Home must not create Chats')},notify:()=>{throw Error('Home must not notify work')},providerStatus:async id=>{probes.push(id);return providers.get(id)??{authentication:'authenticated',intakeReady:true}}});
 await app.ready();
 };
 await open();
 t.after(async()=>{await app.close();workspace.close();store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained Home fixture: ${root}`)});
 const home=async(query='')=>{const response=await app.inject({url:'/api/branches/home'+query});assert.equal(response.statusCode,200,response.body);return response.json()};
 const deploy=(name,step=gate,bindings={agents:{},directories:{}},chatId='',failure={action:'stop'})=>branches.deploy({chatId,idempotencyKey:randomUUID(),definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:step.id,steps:[step],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure}},bindings});
 return {root,get store(){return store},get workspace(){return workspace},get coordination(){return coordination},get branches(){return branches},get app(){return app},probes,providers,home,deploy,
  async reopen(){await app.close();workspace.close();store.close();await open()},pass(){passed=true}};
}

test('Branches Home distinguishes no workflows from an empty draft without creating work',async t=>{
 const f=await fixture(t),empty=await f.home();assert.equal(empty.workflowCount,0);assert.equal(empty.activeExecutionCount,0);assert.equal(empty.openActionCount,0);
 for(const key of ['activeExecutions','recentOutcomes','attention'])assert.deepEqual(empty[key],{items:[]});
 f.branches.create('Empty draft','draft');const draft=await f.home();assert.equal(draft.workflowCount,1);assert.equal(draft.activeExecutionCount,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);assert.deepEqual(f.probes,[]);f.pass();
});

test('focused Run action HTTP reads preserve complete gate fields, exact ownership and unchanged runtime authority',async t=>{
 const f=await fixture(t),prompt='Review the full proposal '+ '🌲'.repeat(500),proposal='Authored result '+ '漢'.repeat(500);
 const branch=f.deploy('Full approval',{...gate,prompt}),execution=f.branches.accept(branch.id,'approval',proposal);f.branches.advance();
 const url=`/api/branch-executions/${execution.id}/actions`,before=f.store.sqlite.prepare('SELECT total_changes() n').get().n;
 const response=await f.app.inject({url});assert.equal(response.statusCode,200,response.body);const page=response.json();
 assert.equal(page.executionId,execution.id);assert.equal(page.revision,f.branches.execution(execution.id).revision);assert.equal(page.items.length,1);
 const item=page.items[0];assert.equal(item.kind,'gate');assert.equal(item.gate.prompt,prompt);assert.equal(item.gate.proposal,proposal);assert.equal(item.gate.editable,true);assert.equal(item.gate.revision,0);assert.ok(item.gate.openedAt);
 assert.equal(page.largeEvidenceOmitted,true,'The Step preview is bounded while decision text stays complete');assert.equal(Array.from(item.step.input).length,129);
 const exact=await f.app.inject({url:`/api/branch-executions/${execution.id}/steps/${item.step.id}/evidence`});assert.equal(exact.statusCode,200,exact.body);assert.equal(exact.json().input,proposal);
 const other=f.branches.accept(branch.id,'other','Unrelated');
 assert.equal((await f.app.inject({url:`/api/branch-executions/${other.id}/steps/${item.step.id}/evidence`})).statusCode,404);
 const inspected=f.store.sqlite.prepare('SELECT total_changes() n').get().n;
 assert.equal((await f.app.inject({url:'/api/branch-executions/missing/actions'})).statusCode,404);
 assert.equal((await f.app.inject({url:url+'?cursor=broken'})).statusCode,400);
 assert.equal(f.store.sqlite.prepare('SELECT total_changes() n').get().n,inspected,'Missing or malformed reads do not mutate authority');
 assert.ok(inspected>before,'Only the explicitly accepted second Run changed authority');
 f.branches.resolveGate(item.gate.id,{commandKey:'resolve-owned-approval',expectedRevision:0,decision:'approve'});
 assert.equal((await f.app.inject({url})).json().items.length,0);
 assert.equal(f.branches.detail(execution.id).gates[0].openedAt,item.gate.openedAt,'Resolved audit reuses the same exact gate-open checkpoint');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('Branch Trigger Events retain replaced sources and unlinked events after changing to Manual with exact-owner pagination',async t=>{
 const f=await fixture(t);let branch=f.deploy('Retained events');
 const definition=f.branches.version(branch.id,branch.versionId).definition;
 const publish=kind=>{
  const sourceConfig=kind==='schedule'?{scheduleKind:'interval',everyMs:60000}:{replayWindowSeconds:300};
  branch=f.branches.deploy({chatId:'',branchId:branch.id,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),definition:{...definition,trigger:kind==='manual'?{kind}:{kind,configRef:'source'}},bindings:{agents:{},directories:{},...(kind==='manual'?{}:{triggers:{source:{enabled:true,sourceConfig}}})}},new Date().toISOString(),kind==='manual'?undefined:{sourceConfig});
  return branch;
 };
 publish('schedule');const schedule=f.branches.triggers.recordTriggerOccurrence({triggerId:branch.triggerId,occurrenceKey:'schedule',payload:{source:'schedule'},provenance:{source:'schedule'}});
 const unlinked=randomUUID();
 f.store.sqlite.prepare(`INSERT INTO trigger_occurrences
  (id,trigger_id,occurrence_key,project_id,agent_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,input_hash,activation_config_json,state,attempts,available_at,occurred_at,created_at,updated_at)
  SELECT ?,trigger_id,'unlinked',project_id,agent_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,input_hash,activation_config_json,'dead_lettered',0,available_at,occurred_at,created_at,updated_at FROM trigger_occurrences WHERE id=?`).run(unlinked,schedule.occurrenceId);
 publish('webhook');const webhook=f.branches.triggers.recordTriggerOccurrence({triggerId:branch.triggerId,occurrenceKey:'webhook',payload:{source:'webhook'},provenance:{source:'webhook'}});
 publish('manual');assert.equal(branch.triggerId,undefined);
 const seen=[];let before;
 do{const response=await f.app.inject({url:`/api/branches/${branch.id}/trigger/occurrences?limit=1${before?'&before='+before:''}`});assert.equal(response.statusCode,200,response.body);const rows=response.json();seen.push(...rows);before=rows.at(-1)?.id;}while(before);
 assert.deepEqual(seen.map(row=>row.id).sort(),[schedule.occurrenceId,webhook.occurrenceId,unlinked].sort());
 assert.equal(seen.find(row=>row.id===unlinked).branchExecutionId,undefined);assert.deepEqual([...new Set(seen.map(row=>row.triggerSnapshot.sourceKind))].sort(),['schedule','webhook']);
 const empty=f.deploy('No automatic events');assert.deepEqual((await f.app.inject({url:`/api/branches/${empty.id}/trigger/occurrences`})).json(),[]);
 assert.equal((await f.app.inject({url:`/api/branches/${empty.id}/trigger/occurrences?before=${schedule.occurrenceId}`})).statusCode,400);
 assert.equal((await f.app.inject({url:'/api/branches/missing/trigger/occurrences'})).statusCode,404);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('merge target reads page all permitted outcomes independently of visible history and reject another Branch source',async t=>{
 const f=await fixture(t),branch=f.deploy('Merge targets'),ids=[];
 f.store.sqlite.transaction(()=>{for(let i=0;i<125;i++){const execution=f.branches.accept(branch.id,`target_${i}`,'');ids.push(execution.id);f.store.sqlite.prepare("UPDATE branch_executions SET state='completed' WHERE id=?").run(execution.id)}})();
 const source=f.branches.accept(branch.id,'merge-source',''),base=`/api/branches/${branch.id}/executions?mergeFor=${source.id}`;
 const seen=[];let before;
 do{const response=await f.app.inject({url:base+(before?'&before='+before:'')});assert.equal(response.statusCode,200,response.body);const page=response.json();assert.ok(page.length<=100);assert.ok(page.every(item=>item.id!==source.id&&item.branchId===branch.id&&['queued','running','waiting','completed'].includes(item.state)));seen.push(...page.map(item=>item.id));before=page.length===100?page.at(-1).id:undefined;}while(before);
 assert.deepEqual(seen.sort(),ids.sort());assert.equal(new Set(seen).size,125);
 assert.equal((await f.app.inject({url:`/api/branches/${branch.id}/executions?state=running`})).json().length,0,'The selected history filter has no bearing on merge candidates');
 const foreign=f.deploy('Foreign merge target'),other=f.branches.accept(foreign.id,'source','');
 assert.equal((await f.app.inject({url:`/api/branches/${branch.id}/executions?mergeFor=${other.id}`})).statusCode,400);
 assert.equal((await f.app.inject({url:base+`&before=${other.id}`})).statusCode,400);
 assert.equal((await f.app.inject({url:base+'&state=failed'})).statusCode,400);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands').get().n,0,'Reading candidates must not merge or retry any Run');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('global Home pages count distinct nested executions beyond sidebar limits and omit full evidence',async t=>{
 const f=await fixture(t),ids=[],terminal=['completed','failed','canceled','skipped','merged'];
 f.store.sqlite.transaction(()=>{
  for(let i=0;i<150;i++){
   const branch=f.deploy('Workflow '+i),execution=f.branches.accept(branch.id,'one','Private input '+i);ids.push(execution.id);
   // Deterministic canonical fixture membership, including tied timestamps and all actual outcomes.
   f.store.sqlite.prepare("UPDATE branch_executions SET state=?,created_at=?,updated_at=?,parent_execution_id=? WHERE id=?").run(i<120?['queued','running','waiting'][i%3]:terminal[i%5],'2026-10-23T00:00:00.000Z','2026-10-23T01:00:00.000Z',i===1?ids[0]:null,execution.id);
  }
  f.store.sqlite.prepare('UPDATE branch_executions SET input_text=?,output_text=? WHERE id=?').run('x'.repeat(1024*1024),'y'.repeat(1024*1024),ids[0]);
 })();
 assert.equal(f.branches.listBranches().length,100,'The ordinary sidebar remains paged');
 const first=await f.home('?search=does-not-exist&section=organized');
 assert.equal(first.workflowCount,150);assert.equal(first.activeExecutionCount,120);assert.equal(first.activeExecutions.items.length,8);assert.equal(first.recentOutcomes.items.length,6);
 assert.ok(JSON.stringify(first).length<20000);assert.ok(first.activeExecutions.nextCursor);assert.ok(first.recentOutcomes.nextCursor);
 await f.reopen();assert.deepEqual((await f.home()).activeExecutions,first.activeExecutions,'Keyset ordering survives process/database reopen');
 const active=[],outcomes=[];let page=first;
 do{active.push(...page.activeExecutions.items);const cursor=page.activeExecutions.nextCursor;if(!cursor)break;page=await f.home('?activeCursor='+encodeURIComponent(cursor))}while(true);
 page=first;do{outcomes.push(...page.recentOutcomes.items);const cursor=page.recentOutcomes.nextCursor;if(!cursor)break;page=await f.home('?outcomeCursor='+encodeURIComponent(cursor))}while(true);
 assert.equal(active.length,120);assert.equal(new Set(active.map(item=>item.id)).size,120);assert.ok(active.some(item=>item.id===ids[1]&&item.parentExecutionId===ids[0]));
 assert.equal(outcomes.length,30);assert.equal(new Set(outcomes.map(item=>item.id)).size,30);assert.deepEqual([...new Set(outcomes.map(item=>item.state))].sort(),terminal.sort());
 assert.ok(active.every(item=>!('input'in item)&&!('output'in item)&&!('configuration'in item)&&!('agentWaits'in item.operational)));
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);
 for(const query of ['?activeCursor=bad','?activeCursor='+encodeURIComponent(first.recentOutcomes.nextCursor),'?outcomeCursor='+encodeURIComponent(first.activeExecutions.nextCursor),'?attentionCursor='+encodeURIComponent(first.activeExecutions.nextCursor)])assert.equal((await f.app.inject({url:'/api/branches/home'+query})).statusCode,400);
 f.pass();
});

test('Home finds six older actions beyond newer updates and preserves exact scoped unresolved counts',async t=>{
 const f=await fixture(t),branch=f.deploy('Approval workflow'),notices=[];
 for(let i=0;i<55;i++)notices.push(f.workspace.createNotification({branchId:branch.id,kind:'operational',category:'decision',severity:'attention',title:'Approval '+i,body:'A human approval is required'}));
 for(let i=0;i<80;i++)f.workspace.createNotification({branchId:branch.id,kind:'information',title:'Routine update '+i,body:'No action required'});
 for(let i=0;i<12;i++)f.workspace.createNotification({kind:'operational',title:'Main Ponderosa action '+i,body:'Other product'});
 f.workspace.acknowledgeNotifications([notices[0].id]);f.workspace.setNotificationStatus(notices[1].id,'dismissed');f.workspace.setNotificationStatus(notices[2].id,'resolved');
 const first=await f.home();assert.equal(first.openActionCount,53);assert.equal(first.attention.items.length,6);assert.ok(first.attention.items.every(item=>item.branchId===branch.id&&item.kind==='operational'));
 assert.deepEqual(first.branchNames,{[branch.id]:'Approval workflow'});assert.ok(first.attention.nextCursor);
 const seen=[];let page=first;
 do{seen.push(...page.attention.items.map(item=>item.id));if(!page.attention.nextCursor)break;page=await f.home('?attentionCursor='+encodeURIComponent(page.attention.nextCursor));assert.equal(page.openActionCount,53)}while(true);
 assert.equal(seen.length,53);assert.equal(new Set(seen).size,53);assert.ok(seen.includes(notices[0].id),'Acknowledging an action does not resolve it');assert.ok(!seen.includes(notices[1].id));assert.ok(!seen.includes(notices[2].id));
 assert.equal(workspaceNotificationPage(f,'branches',{limit:6}).items.every(item=>item.kind==='information'),true,'The ordinary first feed page contains only newer routine updates');
 await f.reopen();const retained=await f.home();assert.equal(retained.openActionCount,53);assert.deepEqual(retained.attention,first.attention,'Resolved/dismissed notices remain excluded after reopening');f.pass();
});

test('Home reuses canonical waiting, provider and reconciliation labels with one observation per provider',async t=>{
 const f=await fixture(t),project=f.store.createProject({label:'Home providers',hostPath:f.root,defaultEngine:'codex'}),chat=f.store.createConversation(project.id,{title:'Owned workflow context'});
 const agents=['codex','claude'].map(engine=>f.store.createAgent(project.id,{title:'Same display name',engine,conversationId:chat.id}));
 const executions=[];
 for(let i=0;i<7;i++){
  const agent=agents[i%2],branch=f.deploy('Provider '+i,{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Return the explicit result'},{agents:{worker:agent.id},directories:{}},chat.id);
  executions.push(f.branches.accept(branch.id,'one','Request'));
 }
 const approval=f.branches.accept(f.deploy('Approval').id,'one','Approve');
 for(let i=0;i<10;i++)f.branches.advance();
 const request=f.branches.detail(executions[0].id).attempts[0].requestId;
 f.coordination.updateRequest({requestId:request,updateId:'dependency',kind:'waiting_dependency',actor:{kind:'agent',id:agents[0].id},payload:{text:'Wait for exact dependent work'}});
 f.providers.set('claude',{authentication:'unauthenticated',intakeReady:false});
 let home=await f.home();assert.deepEqual(f.probes.sort(),['claude','codex']);
 assert.equal(home.activeExecutionCount,8);assert.equal(home.openActionCount,0,'Operational waits are not synthesized into human actions');
 assert.equal(home.activeExecutions.items.find(item=>item.id===approval.id).operational.state,'waiting_human');
 assert.deepEqual(home.activeExecutions.items.find(item=>item.id===executions[0].id).operational,{state:'blocked',label:'Waiting for dependent work'});
 assert.equal(home.activeExecutions.items.find(item=>item.id===executions[1].id).operational.state,'provider_attention');
 assert.equal(home.activeExecutions.items.find(item=>item.id===executions[2].id).operational.state,'waiting_agent');
 f.probes.length=0;f.providers.set('claude',{authentication:'authenticated',intakeReady:false,resourceAdmission:{state:'held'}});
 const attempt=f.branches.detail(executions[2].id).attempts[0];f.store.sqlite.prepare("UPDATE branch_attempts SET state='outcome_unknown' WHERE id=?").run(attempt.id);
 home=await f.home();assert.deepEqual(f.probes.sort(),['claude','codex']);assert.equal(home.activeExecutions.items.find(item=>item.id===executions[1].id).operational.state,'provider_unavailable');assert.equal(home.activeExecutions.items.find(item=>item.id===executions[2].id).operational.state,'needs_reconciliation');
 f.store.sqlite.transaction(()=>{for(let i=0;i<1000;i++)f.coordination.coordinate({projectId:project.id,conversationId:chat.id,actorScope:'user:local-operator',idempotencyKey:'unrelated-'+i,requests:[{recipientAgentId:agents[i%2].id,lifetime:{kind:'indefinite'},payload:{text:'Unrelated retained request'}}]})})();
 f.probes.length=0;const started=performance.now();const scaled=await f.home();assert.equal(scaled.activeExecutionCount,8);assert.deepEqual(f.probes.sort(),['claude','codex']);
 t.diagnostic(`Eight canonical workflow statuses with 1000 unrelated Requests: ${(performance.now()-started).toFixed(2)}ms, ${Buffer.byteLength(JSON.stringify(scaled))} bytes`);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('Home explains automatic budget waits and scheduled retries without inventing attention',async t=>{
 const f=await fixture(t),budgetBranch=f.deploy('Budget hold');
 f.branches.updateExecutionBudget(budgetBranch.id,{commandKey:'one-automatic',expectedRevision:0,expectedPeriodId:null,policy:{limit:1,period:'lifetime'},acknowledgeNewPeriod:true});
 for(let i=0;i<2;i++){const caller=f.deploy('Caller '+i,{id:'call',kind:'branch_call',branchRef:'child'},{agents:{},directories:{},branches:{child:budgetBranch.id}});f.branches.accept(caller.id,'call','')}
 const branch=f.deploy('Scheduled retry',{id:'script',kind:'script',runtime:'node',source:'process.exit(1)',cwdRef:'owned',timeoutMs:1000},{agents:{},directories:{owned:f.root}},'',{action:'retry',maxAttempts:2,delayMs:300000});
 const retry=f.branches.accept(branch.id,'retry','');for(let i=0;i<4;i++)f.branches.advance();const budget=f.branches.listExecutions(budgetBranch.id).find(item=>item.budgetWait);assert.ok(budget);
 const lease=f.branches.claimScript('owned-fixture');assert.ok(lease);assert.equal(lease.executionId,retry.id);f.branches.settleScript(lease,{failed:true,output:'Expected controlled failure'});
 const home=await f.home(),rows=new Map(home.activeExecutions.items.map(item=>[item.id,item]));
 const held=(await f.home()).activeExecutions.items.find(item=>item.id===budget.id);
 assert.deepEqual(held.operational,{state:'queued',label:'Waiting for automatic execution budget'});
 assert.deepEqual(rows.get(retry.id).operational,{state:'retrying',label:'Retry scheduled'});assert.equal(home.openActionCount,0);f.pass();
});

test('Home global read plans and bounded materialization remain stable at 25, 150 and 1000 workflows',async t=>{
 const f=await fixture(t),measurements=[];let existing=0;
 for(const count of [25,150,1000]){
  f.store.sqlite.transaction(()=>{for(;existing<count;existing++){const branch=f.deploy('Scale '+existing),execution=f.branches.accept(branch.id,'one','');if(existing%2)f.store.sqlite.prepare("UPDATE branch_executions SET state='completed' WHERE id=?").run(execution.id)}})();
  const started=performance.now(),home=await f.home();measurements.push({workflows:count,elapsedMs:Math.round((performance.now()-started)*100)/100,bytes:Buffer.byteLength(JSON.stringify(home))});
  assert.equal(home.workflowCount,count);assert.equal(home.activeExecutionCount,Math.ceil(count/2));assert.equal(home.activeExecutions.items.length,8);assert.equal(home.recentOutcomes.items.length,6);
 }
 const plans={};
 for(const [kind,column,states]of [['active','created_at',"'queued','running','waiting'"],['outcomes','updated_at',"'completed','failed','canceled','skipped','merged'"]]){
  plans[kind]=f.store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT e.id,e.branch_id,b.name FROM branch_executions e JOIN branches b ON b.id=e.branch_id WHERE e.state IN (${states}) ORDER BY e.${column} DESC,e.id DESC LIMIT 9`).all().map(row=>row.detail);
  assert.ok(plans[kind].some(detail=>/SEARCH e USING INDEX branch_execution_queue/u.test(detail)),JSON.stringify(plans[kind]));
 }
 t.diagnostic(JSON.stringify({measurements,plans}));f.pass();
});
