import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
const script=id=>({id,kind:'script',runtime:'node',source:'console.log("ok")',cwdRef:'root',timeoutMs:5000});
const edge=(id,from,to,on='success')=>({id,from,to,on});
function fixture(t,graph,{accept=true,maxTraversals}={}) {
 const dir=mkdtempSync(join(tmpdir(),'branch-graph-'));let store,coordination,branches;
 const open=()=>{store=new AgentStore(dir);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination,(projectId,eventId)=>store.getCommunicationEvent(projectId,eventId))};open();
 const project=store.createProject({label:'Graph',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Workflows'});
 const agent=store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Graph',trigger:{kind:'manual'},entry:'a',steps:[script('a')],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}},...graph};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{worker:agent.id},directories:{root:dir}}});
 if(maxTraversals!==undefined)branches.configure(branch.id,{...branches.configuration(branch.id),limits:{...branches.configuration(branch.id).limits,maxTraversals}},0);
 const execution=accept?branches.accept(branch.id,'event','input'):undefined;
 t.after(()=>{store.close();});
 return {get store(){return store},get branches(){return branches},get coordination(){return coordination},branch,execution,agent,chat,dir,definition,reopen(){store.close();open()}};
}
function forkGraph(mode='all',remainder='finish') {
 return {entry:'fork',steps:[script('a'),script('b')],controls:[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode,remainder,inputOrder:['a-arm','b-arm']}],edges:[edge('a-arm','fork','a','selected'),edge('b-arm','fork','b','selected'),edge('a-in','a','join'),edge('b-in','b','join')]};
}
function runTwo(f) {f.branches.advance();return [f.branches.claimScript('worker'),f.branches.claimScript('worker')]}

function wideForkGraph(count,{condition=false}={}) {
 const steps=Array.from({length:count},(_,i)=>script(`s${i}`));
 const armIds=steps.map((_,i)=>`arm${i}`);
 const controls=[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:armIds}];
 const edges=steps.flatMap((step,i)=>[edge(armIds[i],'fork',condition&&i===0?'choose':step.id,'selected'),edge(`arrival${i}`,step.id,'join')]);
 if(condition){controls.push({id:'choose',kind:'condition',predicate:{source:'input',equals:'input'},otherwise:'join'});edges.push(edge('chosen','choose','s0','selected'),edge('skipped','choose','join','failure'));}
 return {entry:'fork',steps,controls,edges};
}

test('binding revisions remain addressable as exact Branch-owned deployment snapshots',t=>{
 const f=fixture(t,{}, {accept:false}),first=f.branch;
 const definition=f.branches.version(first.id,first.versionId).definition;
 const second=f.branches.deploy({branchId:first.id,expectedVersionId:first.versionId,chatId:first.chatId,idempotencyKey:'second-bindings',definition,bindings:{agents:{worker:f.agent.id},directories:{root:f.dir+'/second'}}});
 assert.equal(f.branches.localConfiguration(first.id).directories.root,f.dir+'/second');
 assert.equal(f.branches.bindingRevision(first.id,first.bindingRevisionId).directories.root,f.dir);
 assert.equal(f.branches.bindingRevision(first.id,second.bindingRevisionId).directories.root,f.dir+'/second');
 assert.equal(f.branches.bindingRevision('another-branch',first.bindingRevisionId),undefined);
 f.reopen();
 assert.equal(f.branches.bindingRevision(first.id,first.bindingRevisionId).directories.root,f.dir);
});

for(const count of [50,100]) {
 test(`${count}-way fixed fork is rejected before work when its configured traversal budget cannot complete`,t=>{
  const f=fixture(t,wideForkGraph(count),{accept:false});
  const preview=f.branches.preview({chatId:f.chat.id,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:`preview-${count}`,definition:f.definition,bindings:{agents:{worker:f.agent.id},directories:{root:f.dir}}});
  assert.match(preview.notes.join(' '),new RegExp(`at least ${1+count*2} visits`));
  assert.throws(()=>f.branches.accept(f.branch.id,'event','input'),/Traversal preflight.*maxTraversals 100/);
  assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,0);
 });
 test(`${count}-way fork preserves the exact limit through a failed join`,t=>{
  // The conditional arm makes static cost uncertain; all arms run for this input.
  const f=fixture(t,wideForkGraph(count,{condition:true}));
  for(let i=0;i<count+5;i++){
   f.branches.advance();
   const lease=f.branches.claimScript('wide-worker');
   if(lease)f.branches.settleScript(lease,{failed:false,output:lease.input});
   if(f.branches.execution(f.execution.id).state==='failed')break;
  }
  const detail=f.branches.detail(f.execution.id);
  assert.equal(detail.execution.state,'failed');
  assert.match(detail.execution.output,/limit_exhausted: maxTraversals \(limit 100, attempted 101\)/);
  assert.match(detail.execution.output,/external effects may have occurred/);
  assert.ok(detail.decisions.some(d=>d.kind==='limit_exhausted'&&d.message.includes('maxTraversals')));
  if(count===50)assert.ok(detail.decisions.some(d=>d.kind==='join_resolved'&&d.message.includes('limit_exhausted')));
  assert.ok(detail.attempts.some(a=>a.outcome?.kind==='limit_exhausted'));
 });
}

test('preflight warns on an explicit graph loop without claiming a fixed traversal count',t=>{
 const f=fixture(t,{edges:[{...edge('again','a','a'),loop:true}]},{accept:false});
 const preview=f.branches.preview({chatId:f.chat.id,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'loop-preview',definition:f.definition,bindings:{agents:{worker:f.agent.id},directories:{root:f.dir}}});
 assert.match(preview.notes.join(' '),/Conditions or loops make the full count uncertain/);
 assert.ok(f.branches.accept(f.branch.id,'event','input'));
});

test('preflight permits a shorter failure route under the configured budget',t=>{
 const graph={steps:[script('a'),script('b'),script('c'),script('rescue')],edges:[edge('a-next','a','b'),edge('b-next','b','c'),edge('a-rescue','a','rescue','failure')]};
 const f=fixture(t,graph,{maxTraversals:2});
 f.branches.advance();f.branches.settleScript(f.branches.claimScript('worker'),{failed:true,output:'use rescue'});
 f.branches.settleScript(f.branches.claimScript('worker'),{failed:false,output:'recovered'});
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.equal(f.branches.execution(f.execution.id).output,'recovered');
});

test('preflight permits a rejected gate to exclude an all-join arm',t=>{
 const graph={entry:'fork',steps:[{id:'gate',kind:'human_gate',prompt:'Approve work?',editable:false},script('work'),script('side')],controls:[
  {id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['gated','side-arm']}],edges:[
   edge('gated','fork','gate','selected'),edge('side-arm','fork','side','selected'),edge('approved','gate','work','approved'),edge('work-in','work','join'),edge('side-in','side','join')]};
 const f=fixture(t,graph,{maxTraversals:4});
 f.branches.advance();
 const lease=f.branches.claimScript('worker');assert.ok(lease);f.branches.settleScript(lease,{failed:false,output:'side done'});
 const gate=f.branches.detail(f.execution.id).gates.find(g=>g.state==='waiting');assert.ok(gate);
 f.branches.resolveGate(gate.id,{commandKey:'reject-gate',expectedRevision:gate.revision,decision:'reject'});
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.equal(f.branches.execution(f.execution.id).budgetExhausted,false);
});

test('Script text resembling a limit is not a canonical budget-exhaustion outcome',t=>{
 const f=fixture(t,{});f.branches.advance();
 f.branches.settleScript(f.branches.claimScript('worker'),{failed:true,output:'limit_exhausted: upstream provider quota'});
 assert.equal(f.branches.execution(f.execution.id).state,'failed');
 assert.equal(f.branches.execution(f.execution.id).budgetExhausted,false);
 assert.equal(f.branches.detail(f.execution.id).decisions.some(d=>d.kind==='limit_exhausted'),false);
});

test('nested limit cause survives both the inner and outer all-joins',t=>{
 const graph={entry:'outer',steps:[script('a'),script('b'),script('side')],controls:[
  {id:'outer',kind:'fork',joinId:'outer-join'},{id:'outer-join',kind:'join',forkId:'outer',mode:'all',remainder:'finish',inputOrder:['inner-arm','side-arm']},
  {id:'inner',kind:'fork',joinId:'inner-join'},{id:'inner-join',kind:'join',forkId:'inner',mode:'all',remainder:'finish',inputOrder:['a-arm','b-arm']},
  {id:'choose',kind:'condition',predicate:{source:'input',equals:'input'},otherwise:'inner-join'}],edges:[
   edge('inner-arm','outer','inner','selected'),edge('side-arm','outer','side','selected'),
   edge('a-arm','inner','choose','selected'),edge('b-arm','inner','b','selected'),
   edge('yes','choose','a','selected'),edge('no','choose','inner-join','failure'),
   edge('a-in','a','inner-join'),edge('b-in','b','inner-join'),
   edge('inner-out','inner-join','outer-join'),edge('side-out','side','outer-join')]};
 const f=fixture(t,graph,{maxTraversals:7});
 for(let i=0;i<10;i++){f.branches.advance();const lease=f.branches.claimScript('worker');if(lease)f.branches.settleScript(lease,{failed:false,output:'done'});if(f.branches.execution(f.execution.id).state==='failed')break;}
 const detail=f.branches.detail(f.execution.id);
 assert.equal(detail.execution.state,'failed');
 assert.match(detail.execution.output,/limit_exhausted: maxTraversals/);
 assert.ok(detail.decisions.some(d=>d.kind==='join_resolved'&&d.nodeId==='outer-join'&&d.message.includes('limit_exhausted')));
});

test('parallel all-join uses definition order, survives restart, and settles once',t=>{
 const f=fixture(t,forkGraph()),[a,b]=runTwo(f);
 f.branches.settleScript(b,{failed:false,output:'B'});f.reopen();
 assert.equal(f.branches.execution(f.execution.id).state,'running');
 f.branches.settleScript(a,{failed:false,output:'A'});f.reopen();f.branches.advance();
 assert.equal(f.branches.execution(f.execution.id).output,'[a]\nA\n\n[b]\nB');
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_join_arrivals').get().n,2);
 assert.throws(()=>f.branches.settleScript(a,{failed:false,output:'duplicate'}),/fenced/);
});

test('parallel join labels combined text with frozen path names',t=>{
 const graph=forkGraph();graph.steps[0].label='Frontend review';graph.steps[1].label='Backend review';
 const f=fixture(t,graph),[a,b]=runTwo(f);
 f.branches.settleScript(b,{failed:false,output:'B'});f.branches.settleScript(a,{failed:false,output:'A'});
 assert.equal(f.branches.execution(f.execution.id).output,'[Frontend review]\nA\n\n[Backend review]\nB');
});

test('any-join with finish remainder waits for losing work but never changes selected output',t=>{
 const f=fixture(t,forkGraph('any')),[a,b]=runTwo(f);
 f.branches.settleScript(b,{failed:false,output:'winner'});
 assert.equal(f.branches.execution(f.execution.id).state,'running');
 f.branches.settleScript(a,{failed:false,output:'later'});
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.equal(f.branches.execution(f.execution.id).output,'[b]\nwinner');
});

test('any-join cancels exact losing Script and waits for its observed cleanup',t=>{
 const f=fixture(t,forkGraph('any','cancel')),[a,b]=runTwo(f);
 f.branches.authorizeScript(a,{pid:123,pgid:123,birthMarker:'test:fake'});
 f.branches.settleScript(b,{failed:false,output:'winner'});
 assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 assert.throws(()=>f.branches.settleScript(a,{failed:false,output:'stale'}),/fenced/);
 f.branches.recoverScript(a.attemptId);
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.equal(f.branches.execution(f.execution.id).output,'[b]\nwinner');
});

test('unselected conditional arm does not block an all-join',t=>{
 const graph=forkGraph();graph.controls.push({id:'choose',kind:'condition',predicate:{source:'input',equals:'take'},otherwise:'join'});
 graph.edges[0]=edge('a-arm','fork','choose','selected');graph.edges.push(edge('yes','choose','a','selected'),edge('no','choose','join','failure'));
 const f=fixture(t,graph);f.branches.advance();const lease=f.branches.claimScript('worker');
 assert.equal(f.branches.detail(f.execution.id).steps.length,1);
 f.branches.settleScript(lease,{failed:false,output:'selected'});
 assert.equal(f.branches.execution(f.execution.id).output,'[b]\nselected');
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
});

test('durable gate edits input, replays exact resolution, and rejects conflicts',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'human_gate',prompt:'Review',editable:true},script('b')],edges:[edge('approved','a','b','approved')]});
 f.branches.advance();f.reopen();const gate=f.branches.detail(f.execution.id).gates[0];
 assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 const input={commandKey:'approve',expectedRevision:gate.revision,decision:'approve',output:'edited'};
 const result=f.branches.resolveGate(gate.id,input);f.reopen();assert.deepEqual(f.branches.resolveGate(gate.id,input),result);
 assert.throws(()=>f.branches.resolveGate(gate.id,{...input,output:'different'}),/idempotency/);
 assert.throws(()=>f.branches.resolveGate(gate.id,{...input,commandKey:'conflict'}),/conflict/);
 const lease=f.branches.claimScript('worker');assert.equal(lease.input,'edited');
 f.branches.settleScript(lease,{failed:false,output:lease.input});assert.equal(f.branches.execution(f.execution.id).output,'edited');
});

test('gate rejection with no rejection route is skipped and canceled gates cannot resolve',t=>{
 const f=fixture(t,{steps:[{id:'a',label:'',kind:'human_gate',prompt:'Review',editable:false}]});f.branches.advance();
 const gate=f.branches.detail(f.execution.id).gates[0];f.branches.resolveGate(gate.id,{commandKey:'reject',expectedRevision:0,decision:'reject'});
 assert.equal(f.branches.execution(f.execution.id).state,'skipped');
 assert.equal(f.branches.execution(f.execution.id).output,'Approval rejected at a.');
 const next=f.branches.accept(f.branch.id,'second','input');f.branches.advance();const second=f.branches.detail(next.id).gates[0];
 f.branches.cancel(next.id);assert.throws(()=>f.branches.resolveGate(second.id,{commandKey:'approve',expectedRevision:0,decision:'approve'}),/conflict/);
});

test('routed gate rejection preserves proposed text for its rejection path',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'human_gate',prompt:'Review',editable:false},script('b')],edges:[edge('rejected','a','b','rejected')]});
 f.branches.advance();const gate=f.branches.detail(f.execution.id).gates[0];
 f.branches.resolveGate(gate.id,{commandKey:'reject-route',expectedRevision:gate.revision,decision:'reject'});
 const lease=f.branches.claimScript('worker');assert.equal(lease.input,'input');
 f.branches.settleScript(lease,{failed:false,output:'Handled rejection'});
 assert.equal(f.branches.execution(f.execution.id).output,'Handled rejection');
});

test('bounded retry preserves failed attempts and does not run before its durable due time',t=>{
 const f=fixture(t,{policy:{maxConcurrentExecutions:2,failure:{action:'retry',maxAttempts:2,delayMs:1000}}});
 f.branches.advance();const first=f.branches.claimScript('worker');f.branches.settleScript(first,{failed:true,output:'try again'});
 assert.equal(f.branches.execution(f.execution.id).state,'waiting');assert.equal(f.branches.claimScript('worker'),undefined);
 f.reopen();const second=f.branches.claimScript('worker',new Date(Date.now()+2000).toISOString());assert.ok(second);
 assert.notEqual(second.attemptId,first.attemptId);f.branches.settleScript(second,{failed:true,output:'last'});
 assert.equal(f.branches.execution(f.execution.id).state,'failed');assert.equal(f.branches.detail(f.execution.id).attempts.length,2);
});

test('failed Script remains manually retryable after its observed process exit',t=>{
 const f=fixture(t,{});f.branches.advance();const lease=f.branches.claimScript('worker');
 f.branches.authorizeScript(lease,{pid:123,pgid:123,birthMarker:'test:failed-script'});
 f.branches.settleScript(lease,{failed:true,output:'A known failure'});
 assert.equal(f.branches.detail(f.execution.id).attempts[0].retryBlockedReason,undefined);
});

test('outcome-unknown Script requires explicit reconciliation before manual retry',t=>{
 const f=fixture(t,{});f.branches.advance();const lease=f.branches.claimScript('worker');f.branches.authorizeScript(lease,{pid:123,pgid:123,birthMarker:'test:fake'});f.branches.recoverScript(lease.attemptId);
 const command={commandKey:'resolve',expectedRevision:f.branches.execution(f.execution.id).revision,action:'resolve_script',attemptId:lease.attemptId,result:{failed:false,output:'observed effect'},reason:'Verified external receipt'};
 assert.throws(()=>f.branches.intervene(f.execution.id,command),/Reconcile/);
 f.branches.intervene(f.execution.id,{...command,externalEffectsReconciled:true});
 assert.equal(f.branches.intervene(f.execution.id,{...command,externalEffectsReconciled:true}).execution.state,"completed");
 assert.throws(()=>f.branches.intervene(f.execution.id,{...command,commandKey:"stale-reconcile",externalEffectsReconciled:true}),/revision|stale|completed|terminal/i);
 assert.equal(f.branches.execution(f.execution.id).output,'observed effect');assert.equal(f.branches.execution(f.execution.id).state,'completed');
});

test('failed Agent Request reason is visible in execution evidence, not workflow output',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Work'}]});
 f.branches.advance();const first=f.branches.detail(f.execution.id).attempts[0];
 f.coordination.updateRequest({requestId:first.requestId,updateId:'failed-reason',kind:'failed',actor:{kind:'agent',id:f.agent.id},payload:{reason:'Provider working folder changed'}});
 f.branches.advance();const detail=f.branches.detail(f.execution.id);
 assert.equal(detail.execution.state,'failed');assert.equal(detail.attempts[0].error,'Provider working folder changed');
 assert.equal(detail.attempts[0].result.output,undefined);
});

for(const variant of ['valid','missing','invented','wrong-agent','wrong-chat','collaboration','wrong-run'])test(`required spokesperson publication checks canonical Communication and exact Request Run: ${variant}`,t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Send a DM',requireUserCommunication:true},script('receipt')],edges:[edge('delivered','a','receipt')]});
 f.branches.advance();const attempt=f.branches.detail(f.execution.id).attempts[0];
 const lease=f.coordination.leaseNextRun({workerId:'publication-test'});assert.ok(lease);f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 f.coordination.recordProviderInput({executionId:'publication-run',schedulerRunId:lease.runId,fencingToken:lease.fencingToken,agentId:f.agent.id,projectId:f.agent.projectId,prompt:'Send a DM',sourceManifest:{schemaVersion:1,historyMessageCount:0,activationIds:lease.activationIds,communicationEventIds:[],artifactIds:[],conversationId:f.chat.id,providerSessionDisposition:'fresh_task',sources:[]}});
 const otherChat=variant==='wrong-chat'?f.store.createConversation(f.agent.projectId,{title:'Other Chat'}):f.chat;
 const other=f.store.createAgent(f.agent.projectId,{title:'Other Agent',engine:'codex',conversationId:otherChat.id});
 const author=['wrong-agent','wrong-chat'].includes(variant)?other:f.agent;
 if(!['missing','invented'].includes(variant))f.store.appendCommunicationEvent({eventId:'published',schemaVersion:2,projectId:f.agent.projectId,conversationId:otherChat.id,sender:{kind:'agent',agentId:author.id,executionId:variant==='wrong-run'?'other-run':'publication-run'},intent:variant==='collaboration'?'collaboration':'user_dm',audience:variant==='collaboration'?{kind:'agents',agentIds:[other.id]}:{kind:'user_agent',userId:'local-operator',agentId:author.id},text:'Actual authored finding',createdAt:new Date().toISOString()});
 f.coordination.updateRequest({requestId:attempt.requestId,updateId:'complete',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Claims delivered',...(variant!=='missing'?{communicationEventId:'published'}:{})}});
 f.branches.advance();const receipt=f.branches.claimScript('receipt-test');
 if(variant==='valid'){assert.ok(receipt);f.branches.settleScript(receipt,{failed:false,output:'receipt stored'});assert.equal(f.branches.execution(f.execution.id).state,'completed');assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE transition_key=?").get(`communication:${attempt.id}`).n,1);}
 else{assert.equal(receipt,undefined);assert.equal(f.branches.execution(f.execution.id).state,'failed');assert.match(f.branches.detail(f.execution.id).attempts[0].error,/Required user Communication/);}
});

test('a canceled Agent Request does not advertise an impossible manual retry',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Work'}]});
 f.branches.advance();const attempt=f.branches.detail(f.execution.id).attempts[0];
 f.coordination.updateRequest({requestId:attempt.requestId,updateId:'cancel-request',kind:'cancelled',actor:{kind:'user',id:'local-operator'}});
 f.branches.advance();
 assert.match(f.branches.detail(f.execution.id).attempts[0].retryBlockedReason,/cannot be retried/);
});

test('recovery policy creates an ordinary canonical Request and waits for its terminal result',t=>{
 const f=fixture(t,{policy:{maxConcurrentExecutions:2,failure:{action:'recover',agentRef:'worker',maxAttempts:1}}});
 f.branches.advance();f.branches.settleScript(f.branches.claimScript('worker'),{failed:true,output:'repair needed'});f.branches.advance();
 const detail=f.branches.detail(f.execution.id);assert.equal(detail.attempts[1].purpose,'recovery');assert.ok(detail.attempts[1].requestId);
 f.coordination.updateRequest({requestId:detail.attempts[1].requestId,updateId:'recovered',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'recovered'}});
 f.branches.advance();assert.equal(f.branches.execution(f.execution.id).output,'recovered');
});

test('nested fork instances join independently and compose deterministic output',t=>{
 const graph=forkGraph();graph.steps.push(script('c'),script('d'));graph.controls.push({id:'inner',kind:'fork',joinId:'inner-join'},{id:'inner-join',kind:'join',forkId:'inner',mode:'all',remainder:'finish',inputOrder:['c-arm','d-arm']});
 graph.edges=graph.edges.filter(e=>e.id!=='a-in');graph.edges.push(edge('a-inner','a','inner'),edge('c-arm','inner','c','selected'),edge('d-arm','inner','d','selected'),edge('c-in','c','inner-join'),edge('d-in','d','inner-join'),edge('inner-out','inner-join','join'));
 const f=fixture(t,graph),[a,b]=runTwo(f);f.branches.settleScript(a,{failed:false,output:'A'});
 const c=f.branches.claimScript('worker'),d=f.branches.claimScript('worker');
 f.branches.settleScript(d,{failed:false,output:'D'});f.branches.settleScript(b,{failed:false,output:'B'});f.reopen();f.branches.settleScript(c,{failed:false,output:'C'});
 assert.equal(f.branches.execution(f.execution.id).output,'[a]\n[c]\nC\n\n[d]\nD\n\n[b]\nB');
 assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM branch_forks WHERE state='closed'").get().n,2);
});

test('impossible quorum fails once and cancels unfinished paths',t=>{
 const graph=forkGraph('quorum','cancel');graph.controls[1].quorum=2;graph.controls[1].inputOrder.push('c-arm');graph.steps.push(script('c'));graph.edges.push(edge('c-arm','fork','c','selected'),edge('c-in','c','join'));
 const f=fixture(t,graph),[a,b]=runTwo(f);const c=f.branches.claimScript('worker');
 f.branches.settleScript(a,{failed:true,output:'A failed'});assert.equal(f.branches.execution(f.execution.id).state,'running');
 f.branches.settleScript(b,{failed:true,output:'B failed'});assert.equal(f.branches.execution(f.execution.id).state,'failed');
 assert.throws(()=>f.branches.settleScript(c,{failed:false}),/fenced/);
});

test('manual retry uses runnable capacity while another execution waits at a human gate',t=>{
 const f=fixture(t,{steps:[script('a'),{id:'review',kind:'human_gate',prompt:'Review',editable:false}],edges:[edge('review','a','review')],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}});
 f.branches.advance();const failedLease=f.branches.claimScript('worker');f.branches.settleScript(failedLease,{failed:true,output:'fix me'});
 assert.equal(f.branches.execution(f.execution.id).state,'failed');
 const waiting=f.branches.accept(f.branch.id,'waiting','review me');f.branches.advance();
 const waitingLease=f.branches.claimScript('worker');f.branches.settleScript(waitingLease,{failed:false,output:'ready for review'});f.branches.advance();
 assert.equal(f.branches.execution(waiting.id).state,'waiting');assert.equal(f.branches.detail(waiting.id).gates[0].state,'waiting');
 const failed=f.branches.execution(f.execution.id);
 f.branches.intervene(f.execution.id,{commandKey:'retry-with-waiter',expectedRevision:failed.revision,action:'retry',attemptId:failedLease.attemptId,reason:'Corrected the failure'});
 const retry=f.branches.claimScript('worker');assert.ok(retry);assert.equal(retry.executionId,f.execution.id);
});

test('failed Step asks a human before retry and preserves the earlier failure evidence',t=>{
 const f=fixture(t,{policy:{maxConcurrentExecutions:1,failure:{action:'ask_human'}}});f.branches.advance();f.branches.settleScript(f.branches.claimScript('worker'),{failed:true,output:'inspect this'});
 f.reopen();const gate=f.branches.detail(f.execution.id).gates[0];assert.equal(gate.purpose,'recovery');assert.equal(gate.proposal,'inspect this');
 f.branches.resolveGate(gate.id,{commandKey:'retry',expectedRevision:gate.revision,decision:'retry'});
 const lease=f.branches.claimScript('worker');f.branches.settleScript(lease,{failed:false,output:'fixed'});
 assert.equal(f.branches.execution(f.execution.id).state,'completed');assert.equal(f.branches.detail(f.execution.id).attempts[0].result.output,'inspect this');
});

test('rejecting a recovery gate seals the failed invocation before a later operator retry',t=>{
 const f=fixture(t,{policy:{maxConcurrentExecutions:1,failure:{action:'ask_human'}}});f.branches.advance();
 const first=f.branches.claimScript('worker');f.branches.settleScript(first,{failed:true,output:'original failure'});
 const gate=f.branches.detail(f.execution.id).gates[0];
 f.branches.resolveGate(gate.id,{commandKey:'reject-recovery',expectedRevision:gate.revision,decision:'reject'});
 const rejected=f.branches.detail(f.execution.id),oldStep=rejected.steps[0],oldResult=rejected.sealedResults[0];
 assert.equal(rejected.execution.state,'failed');assert.equal(rejected.sealedResults.length,1);
 assert.equal(oldResult.stepExecutionId,oldStep.id);assert.deepEqual(oldResult.result,{failed:true,output:'original failure'});
 f.branches.intervene(f.execution.id,{commandKey:'retry-after-rejection',expectedRevision:rejected.execution.revision,action:'retry',attemptId:first.attemptId,reason:'Reconciled the failed attempt'});
 const retry=f.branches.claimScript('worker');assert.ok(retry);f.branches.settleScript(retry,{failed:false,output:'fixed'});
 const final=f.branches.detail(f.execution.id);
 assert.equal(final.execution.state,'completed');assert.equal(final.steps.length,2);assert.equal(final.sealedResults.length,2);
 assert.deepEqual(final.sealedResults.find(result=>result.id===oldResult.id),oldResult);
 assert.notEqual(final.sealedResults.find(result=>result.stepExecutionId!==oldStep.id)?.terminalAttemptId,first.attemptId);
});

test('explicit retry of unknown Agent Request binds canonical recovery lineage',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Work'}]});f.branches.advance();
 const first=f.branches.detail(f.execution.id).attempts[0];f.coordination.updateRequest({requestId:first.requestId,updateId:'unknown',kind:'outcome_unknown',actor:{kind:'supervisor'}});f.branches.advance();
 const uncertain=f.branches.detail(f.execution.id).attempts[0];assert.equal(uncertain.state,'waiting');assert.equal(uncertain.requestOutcomeUnknown,true);assert.equal(uncertain.retryBlockedReason,undefined);
 f.branches.intervene(f.execution.id,{commandKey:'retry',expectedRevision:f.branches.execution(f.execution.id).revision,action:'retry',attemptId:first.id,externalEffectsReconciled:true,reason:'Verified no external effect'});
 f.branches.advance();const next=f.branches.detail(f.execution.id).attempts[1];
 assert.equal(f.store.sqlite.prepare('SELECT superseded_by_request_id successor FROM coordination_requests WHERE id=?').get(first.requestId).successor,next.requestId);
});

test('merge cancels source authority without changing the surviving execution version',t=>{
 const f=fixture(t,{}),target=f.branches.accept(f.branch.id,'target','other');f.branches.advance();
 const source=f.branches.execution(f.execution.id),command={commandKey:'merge',expectedRevision:source.revision,action:'merge',mergedInto:target.id,reason:'Duplicate request'};
 f.branches.intervene(source.id,command);
 assert.equal(f.branches.execution(source.id).state,'merged');assert.equal(f.branches.execution(source.id).mergedInto,target.id);
 assert.equal(f.branches.execution(target.id).versionId,target.versionId);
 assert.equal(f.branches.intervene(source.id,command).execution.state,'merged');
});

test('path-instance budget fails durably instead of partially spawning a fork',t=>{
 const graph=forkGraph();graph.policy={maxConcurrentExecutions:1,maxPathInstances:2,failure:{action:'stop'}};
 const f=fixture(t,graph);f.branches.advance();
 assert.equal(f.branches.execution(f.execution.id).state,'failed');assert.match(f.branches.execution(f.execution.id).output,/budget/);
 assert.equal(f.branches.detail(f.execution.id).paths.length,1);
});

test('a join cancel cannot resurrect a losing path from a stale reducer batch',t=>{
 const graph=forkGraph('any','cancel');graph.steps=graph.steps.filter(s=>s.id==='b');graph.edges=graph.edges.filter(e=>e.id!=='a-in');graph.edges[0]=edge('a-arm','fork','join','selected');
 const f=fixture(t,graph);f.branches.advance();
 assert.equal(f.branches.execution(f.execution.id).state,'completed');assert.equal(f.branches.detail(f.execution.id).steps.length,0);
 assert.equal(f.branches.claimScript('worker'),undefined);
});


test('an arrived failed path cannot be retried while an any join is still open',t=>{
 const f=fixture(t,forkGraph('any')),[a,b]=runTwo(f);
 f.branches.settleScript(a,{failed:true,output:'failed arm'});
 assert.throws(()=>f.branches.intervene(f.execution.id,{commandKey:'retry-arrived',expectedRevision:f.branches.execution(f.execution.id).revision,action:'retry',attemptId:a.attemptId,reason:'Retry failed arm'}),/already arrived/);
 f.branches.settleScript(b,{failed:false,output:'winner'});
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.equal(f.branches.execution(f.execution.id).output,'[b]\nwinner');
});

test('Agent recovery gate does not consume its terminal Request again across restart',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Work',failure:{action:'ask_human'}}]});
 f.branches.advance();const first=f.branches.detail(f.execution.id).attempts[0];
 f.coordination.updateRequest({requestId:first.requestId,updateId:'failed',kind:'failed',actor:{kind:'agent',id:f.agent.id},payload:{text:'needs review'}});
 f.branches.advance();f.branches.advance();f.reopen();f.branches.advance();
 const gate=f.branches.detail(f.execution.id).gates[0];
 assert.equal(gate.state,'waiting');assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE transition_key=?").get(`settled:${first.id}`).n,1);
 f.branches.resolveGate(gate.id,{commandKey:'retry-agent',expectedRevision:gate.revision,decision:'retry'});
 f.branches.advance();const next=f.branches.detail(f.execution.id).attempts[1];
 assert.ok(next.requestId);assert.notEqual(next.requestId,first.requestId);
});


test('approval precedes a pinned notification Action and expired leases fence stale settlement',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'human_gate',prompt:'Review notification',editable:true},{id:'notify',kind:'action',action:'notify',configRefs:[]}],edges:[edge('approve','a','notify','approved')]});
 f.branches.advance();assert.equal(f.branches.claimAction('early'),undefined);
 const gate=f.branches.detail(f.execution.id).gates[0];f.branches.resolveGate(gate.id,{commandKey:'approve',expectedRevision:gate.revision,decision:'approve',output:'Approved text'});f.branches.advance();
 const first=f.branches.claimAction('first');assert.equal(first.input,'Approved text');assert.equal(first.title,'Graph');
 const definition=f.branches.version(f.branch.id,f.branch.versionId).definition;
 f.branches.deploy({branchId:f.branch.id,expectedVersionId:f.branch.versionId,chatId:f.branch.chatId,idempotencyKey:'rename',definition:{...definition,name:'New name'},bindings:f.branches.localConfiguration(f.branch.id)});
 f.reopen();assert.equal(f.branches.claimAction('too-early'),undefined);assert.throws(()=>f.branches.settleAction(first,'expired',new Date(Date.now()+31000).toISOString()),/fenced/);
 const now=new Date(Date.now()+31000).toISOString(),retry=f.branches.claimAction('retry',now);assert.equal(retry.attemptId,first.attemptId);assert.equal(retry.title,'Graph');
 assert.throws(()=>f.branches.settleAction(first,'stale'),/fenced/);f.branches.settleAction(retry,'notification',now);
 assert.equal(f.branches.execution(f.execution.id).state,'completed');assert.equal(f.branches.execution(f.execution.id).output,'Approved text');assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);
});

test('cancellation fences an already leased notification Action',t=>{
 const f=fixture(t,{steps:[{id:'a',kind:'action',action:'notify',configRefs:[]}]});f.branches.advance();const action=f.branches.claimAction('worker');f.branches.cancel(f.execution.id);
 assert.throws(()=>f.branches.settleAction(action,'late'),/fenced/);assert.equal(f.branches.claimAction('retry',new Date(Date.now()+60000).toISOString()),undefined);
});

test('execution audit pages bound attempts and use execution-scoped restart-safe cursors',t=>{
 const f=fixture(t,{policy:{maxConcurrentExecutions:8,failure:{action:'retry',maxAttempts:100,delayMs:0}}});
 for(let i=0;i<100;i++){f.branches.advance();const lease=f.branches.claimScript('test');assert.ok(lease);f.branches.settleScript(lease,{failed:true,output:'Known failure'})}
 const failed=f.branches.detail(f.execution.id),last=failed.attempts.at(-1);assert.equal(failed.attempts.length,100);
 f.branches.intervene(f.execution.id,{commandKey:'retry-page',expectedRevision:failed.execution.revision,action:'retry',attemptId:last.id,reason:'Retry after correction'});
 f.branches.advance();f.branches.settleScript(f.branches.claimScript('test'),{failed:false,output:'Done'});
 const first=f.branches.detail(f.execution.id);assert.equal(first.attempts.length,100);assert.ok(first.nextCursor);assert.equal(first.attempts.at(-1).number,1);
 assert.equal(first.steps.length,2);assert.notEqual(first.steps[0].sealedResultId,first.steps[1].sealedResultId);
 f.reopen();const older=f.branches.detail(f.execution.id,first.nextCursor);assert.equal(older.attempts.length,1);assert.equal(older.attempts[0].number,1);assert.equal(older.nextCursor,undefined);assert.equal(older.steps.length,0);
 const other=f.branches.accept(f.branch.id,'other','');assert.throws(()=>f.branches.detail(other.id,first.nextCursor),/cursor/);assert.throws(()=>f.branches.detail(f.execution.id,'invalid'),/JSON|Unexpected|cursor/);
});

test('parallel arms receive their own explicit graph-defined input',t=>{
 const graph=forkGraph();graph.edges[0].input={kind:'literal',text:'frontend instructions'};graph.edges[1].input={kind:'literal',text:'backend instructions'};
 const f=fixture(t,graph),leases=runTwo(f);assert.deepEqual(leases.map(l=>l.input),['frontend instructions','backend instructions']);
});

test('inspection projects condition choices, skipped arms, fork start and join eligibility from durable evidence',t=>{
 const graph=forkGraph();graph.controls.push({id:'choose',label:'Risk check',kind:'condition',predicate:{source:'input',equals:'take'},otherwise:'join'});
 graph.edges[0]=edge('a-arm','fork','choose','selected');graph.edges.push(edge('yes','choose','a','selected'),edge('no','choose','join','failure'));
 const f=fixture(t,graph);f.branches.advance();let detail=f.branches.detail(f.execution.id);
 assert.ok(detail.decisions.some(d=>d.kind==='condition_selected'&&/false.*did not select path to “a”/.test(d.message)));
 assert.ok(detail.decisions.some(d=>d.kind==='fork_started'));
 assert.ok(detail.waits.some(w=>w.kind==='join'&&/b/.test(w.message)));
 const lease=f.branches.claimScript('inspect');f.branches.settleScript(lease,{failed:false,output:'B'});f.reopen();detail=f.branches.detail(f.execution.id);
 assert.ok(detail.decisions.some(d=>d.kind==='join_resolved'&&/satisfied: 1 of 2/.test(d.message)));
});
