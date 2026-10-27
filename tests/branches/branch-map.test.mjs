import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';

const script=(id,source='process.stdout.write(await new Promise(async resolve=>{let text="";for await(const chunk of process.stdin)text+=chunk;resolve(text)}))')=>({id,kind:'script',runtime:'node',source,cwdRef:'root',timeoutMs:5000});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
function fixture(t,{source='list',maxItems=100,maxConcurrentItems=Math.min(4,maxItems),mode='all',onUnmet,steps,controls,edges,entry='map',policy,bindings}={}){
 const dir=mkdtempSync(join(tmpdir(),'branch-map-'));let store,coordination,branches;
 const open=()=>{store=new AgentStore(dir);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination)};open();
 const project=store.createProject({label:'Map',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Map'});
 const definition={schema:'ponderosa.branch.v1',name:'Map',trigger:{kind:'manual'},entry,
  steps:steps??[script('worker')],controls:controls??[{id:'map',kind:'map',joinId:'join',workerId:'worker',source,maxItems,maxConcurrentItems},{id:'join',kind:'join',forkId:'map',mode,remainder:'finish',inputOrder:[],...(mode==='quorum'?{quorum:2}:{}),...(onUnmet?{onUnmet}:{})}],
  edges:edges??[edge('item','map','worker','selected'),edge('return','worker','join')],policy:{maxConcurrentExecutions:2,maxPathInstances:Math.max(1100,maxItems+10),maxStepInvocations:Math.max(1100,maxItems+10),failure:{action:'stop'},...policy}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir},...bindings}});
 branches.configure(branch.id,{...branches.configuration(branch.id),limits:{...branches.configuration(branch.id).limits,maxTraversals:Math.max(3000,maxItems*3)}},0);
 t.after(()=>{store.close();});
 return {get store(){return store},get branches(){return branches},get coordination(){return coordination},branch,definition,project,chat,dir,reopen(){store.close();open()},accept(input,key='run'){return branches.accept(branch.id,key,input)}};
}
function settleAll(f,executionId,{failure}={}){
 for(let pass=0;pass<3000;pass++){
  f.branches.advance();let lease,worked=false;
  while((lease=f.branches.claimScript('map-test'))){worked=true;f.branches.settleScript(lease,{failed:failure?.(lease.input)??false,output:lease.input});}
  if(['completed','failed','canceled'].includes(f.branches.execution(executionId).state))return;
  if(!worked&&pass>2)throw new Error(`Map stalled: ${f.branches.execution(executionId).waitReason}`);
 }
 throw new Error('Map did not settle');
}

for(const count of [0,1,10,100,1000])test(`Map seals and executes ${count} indexed items`,t=>{
 const f=fixture(t,{maxItems:Math.max(1,count),maxConcurrentItems:Math.max(1,Math.min(count,12))});
 const input=JSON.stringify(Array.from({length:count},(_,i)=>`r${i}`)),execution=f.accept(input);
 settleAll(f,execution.id);
 const detail=f.branches.detail(execution.id),items=detail.mapItems??[];
 assert.equal(detail.execution.state,'completed');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_map_items').get().n,count);
 assert.equal(detail.maps[0].itemCount,count);
 assert.equal(new Set(f.store.sqlite.prepare('SELECT path_id FROM branch_map_items').all().map(r=>r.path_id)).size,count);
 const finalText=detail.execution.output?.startsWith('branch-result-bundle:')?f.branches.resultBundle(detail.execution.output.split(':')[2])?.content:detail.execution.output;
 assert.ok((finalText??'').includes(count?`r${count-1}`:''));
 if(count===1000)assert.match(detail.execution.output,/^branch-result-bundle:/);
 if(count<=100){
  assert.equal(items.length,count);
  for(const item of items){
   assert.equal(detail.steps.find(step=>step.id===item.stepExecutionId)?.pathId,item.pathId);
   assert.equal(detail.sealedResults.find(result=>result.id===item.sealedResultId)?.stepExecutionId,item.stepExecutionId);
  }
 }
});

test('item attempt summaries survive execution-history pagination',t=>{
 const f=fixture(t,{maxItems:100,maxConcurrentItems:1,policy:{failure:{action:'retry',maxAttempts:2,delayMs:0}}});
 const execution=f.accept(JSON.stringify(Array.from({length:100},(_,i)=>`r${i}`)));
 f.branches.advance();f.branches.advance();
 const first=f.branches.claimScript('worker');assert.equal(first.input,'r0');
 f.branches.settleScript(first,{failed:true,output:'retry'});
 f.branches.advance();const retry=f.branches.claimScript('worker');assert.equal(retry.input,'r0');
 f.branches.settleScript(retry,{failed:false,output:'r0'});
 settleAll(f,execution.id);
 const detail=f.branches.detail(execution.id),item=detail.mapItems.find(row=>row.index===0);
 assert.equal(detail.attempts.length,100);
 assert.equal(detail.attempts.filter(attempt=>attempt.stepExecutionId===item.stepExecutionId).length,1);
 assert.equal(item.attemptCount,2);
 assert.ok(item.firstAttemptAt);assert.ok(item.lastAttemptAt);
 assert.equal(f.branches.mapItemEvidence(execution.id,item.id).attemptCount,2);
 assert.equal(f.branches.searchMapItems(execution.id,'r0').items[0].attemptCount,2);
 const fullAttempts=f.branches.stepEvidence(execution.id,item.stepExecutionId).attempts;
 assert.deepEqual(fullAttempts.map(attempt=>attempt.number),[1,2]);
 assert.ok(fullAttempts.every(attempt=>attempt.stepExecutionId===item.stepExecutionId&&Number.isSafeInteger(attempt.fence)&&attempt.purpose==='step'&&attempt.createdAt));
});

test('natural bullet extraction is sealed before workers and is not reinterpreted on reopen',t=>{
 const f=fixture(t,{source:'interpret',maxConcurrentItems:1}),execution=f.accept('I found these repositories:\n\n- Ponderosa\n- Branches\n- Engine');
 f.branches.advance();assert.equal(f.branches.detail(execution.id).maps[0].itemCount,3);
 const first=f.branches.claimScript('worker');assert.equal(first.input,'Ponderosa');f.branches.settleScript(first,{failed:false,output:'first'});
 const sealed=f.store.sqlite.prepare('SELECT items_hash FROM branch_map_invocations').get().items_hash;
 f.reopen();settleAll(f,execution.id);
 assert.equal(f.store.sqlite.prepare('SELECT items_hash FROM branch_map_invocations').get().items_hash,sealed);
 assert.equal(f.branches.detail(execution.id).maps.length,1);
});

test('an empty Map obeys its Join threshold and partial-result policy',t=>{
 for(const mode of ['all','any','quorum']){
  const f=fixture(t,{mode,maxItems:1,maxConcurrentItems:1}),execution=f.accept('[]',`empty-${mode}`);
  f.branches.advance();
  const detail=f.branches.detail(execution.id);
  assert.equal(detail.maps[0].itemCount,0);
  assert.equal(detail.execution.state,mode==='all'?'completed':'failed');
  assert.equal(detail.mapItems.length,0);
  assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='join_resolved'").get(execution.id).n,1);
 }
 const f=fixture(t,{mode:'any',onUnmet:'continue',maxItems:1,maxConcurrentItems:1}),execution=f.accept('[]');
 f.branches.advance();assert.equal(f.branches.execution(execution.id).state,'completed');
});

test('a Script-produced list binds Map cardinality to the exact sealed source invocation',t=>{
 const f=fixture(t,{entry:'discover',steps:[script('discover'),script('worker')],edges:[edge('discover-map','discover','map'),edge('item','map','worker','selected'),edge('return','worker','join')]}),execution=f.accept('find repositories');
 f.branches.advance();const discover=f.branches.claimScript('worker');f.branches.settleScript(discover,{failed:false,output:'["repo-a","repo-b"]'});
 const detail=f.branches.detail(execution.id),source=detail.sealedResults.find(result=>detail.steps.find(step=>step.id===result.stepExecutionId)?.stepId==='discover');
 assert.ok(source);assert.equal(detail.maps[0].sourceResultId,source.id);assert.equal(detail.maps[0].itemCount,2);
 settleAll(f,execution.id);assert.equal(f.branches.execution(execution.id).state,'completed');
});

test('malformed and over-limit lists fail visibly before starting a worker',t=>{
 const f=fixture(t,{source:'interpret',maxItems:2}),bad=f.accept('I found:\n- one\nprose in the middle\n- two','bad');f.branches.advance();
 assert.equal(f.branches.execution(bad.id).state,'failed');assert.match(f.branches.execution(bad.id).output,/ambiguous/);
 const large=f.accept('- one\n- two\n- three','large');f.branches.advance();
 assert.equal(f.branches.execution(large.id).state,'failed');assert.match(f.branches.execution(large.id).output,/maxItems/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_map_items').get().n,0);
});

test('Map concurrency bounds started items; out-of-order completion retains index order',t=>{
 const f=fixture(t,{maxConcurrentItems:2}),execution=f.accept('["A","B","C"]');
 f.branches.advance();f.branches.advance();
 const a=f.branches.claimScript('worker'),b=f.branches.claimScript('worker');assert.equal(a.input,'A');assert.equal(b.input,'B');assert.equal(f.branches.claimScript('worker'),undefined);
 f.branches.settleScript(b,{failed:false,output:'second'});f.branches.advance();
 const c=f.branches.claimScript('worker');assert.equal(c.input,'C');
 f.branches.settleScript(c,{failed:false,output:'third'});f.branches.settleScript(a,{failed:false,output:'first'});
 assert.match(f.branches.execution(execution.id).output,/first[\s\S]*second[\s\S]*third/);
});

test('one failed item retries without changing sibling identity or its sealed terminal result',t=>{
 const f=fixture(t,{policy:{failure:{action:'retry',maxAttempts:2,delayMs:0}}}),execution=f.accept('["A","B"]');
 f.branches.advance();f.branches.advance();const a=f.branches.claimScript('worker'),b=f.branches.claimScript('worker');
 f.branches.settleScript(a,{failed:true,output:'try again'});f.branches.settleScript(b,{failed:false,output:'B'});
 f.branches.advance();const retry=f.branches.claimScript('worker');assert.equal(retry.input,'A');f.branches.settleScript(retry,{failed:false,output:'A'});
 const detail=f.branches.detail(execution.id),aStep=detail.steps.find(s=>s.input==='A'),bStep=detail.steps.find(s=>s.input==='B');
 assert.equal(detail.execution.state,'completed');assert.equal(detail.attempts.filter(x=>x.stepExecutionId===aStep.id).length,2);assert.equal(detail.attempts.filter(x=>x.stepExecutionId===bStep.id).length,1);
 assert.equal(detail.sealedResults.length,2);assert.equal(detail.sealedResults.find(r=>r.stepExecutionId===aStep.id).terminalAttemptId,detail.attempts.find(x=>x.stepExecutionId===aStep.id&&x.number===2).id);
});

test('Join can continue with successful Map items after all failures settle',t=>{
 const f=fixture(t,{onUnmet:'continue'}),execution=f.accept('["good","bad","also good"]');
 settleAll(f,execution.id,{failure:item=>item==='bad'});
 assert.equal(f.branches.execution(execution.id).state,'completed');assert.match(f.branches.execution(execution.id).output,/good/);
 assert.doesNotMatch(f.branches.execution(execution.id).output,/\[2: bad\]/);
 assert.equal(f.branches.detail(execution.id).mapItems.filter(i=>i.state==='arrived').length,3);
});

test('Route chooses a declared edge and sends invalid Agent or Script text to explicit fallback',t=>{
 const steps=[script('triage'),script('billing'),script('other')],controls=[{id:'route',kind:'route',otherwise:'other'}],edges=[edge('triage-route','triage','route'),edge('billing-route','route','billing','selected',{choice:'Billing'}),edge('fallback','route','other','failure')];
 const f=fixture(t,{entry:'triage',steps,controls,edges});
 const good=f.accept('Billing','good');settleAll(f,good.id);assert.equal(f.branches.execution(good.id).state,'completed');assert.ok(f.branches.detail(good.id).decisions.some(d=>d.kind==='route_selected'));
 const bad=f.accept('Unknown','bad');settleAll(f,bad.id);assert.equal(f.branches.execution(bad.id).state,'completed');assert.ok(f.branches.detail(bad.id).decisions.some(d=>d.kind==='route_invalid'));
});

test('a restarted Map keeps settled workers and dispatches only its remaining sealed items',t=>{
 const f=fixture(t,{maxConcurrentItems:2}),execution=f.accept('["first","second","third","fourth"]');
 f.branches.advance();const first=f.branches.claimScript('worker'),second=f.branches.claimScript('worker');
 assert.equal(first.input,'first');assert.equal(second.input,'second');
 f.branches.settleScript(first,{failed:false,output:'done-first'});
 const sealed=f.branches.detail(execution.id).maps[0];
 f.reopen();
 assert.deepEqual(f.branches.scriptRecoveries('restarted').map(item=>item.attemptId),[second.attemptId]);
 f.branches.recoverScript(second.attemptId);
 const remaining=[];let lease;
 while((lease=f.branches.claimScript('worker'))){remaining.push(lease.input);f.branches.settleScript(lease,{failed:false,output:`done-${lease.input}`});f.branches.advance()}
 assert.deepEqual(remaining,['second','third','fourth']);
 assert.equal(f.branches.execution(execution.id).state,'completed');
 assert.equal(f.branches.detail(execution.id).maps[0].itemsHash,sealed.itemsHash);
 assert.equal(f.branches.detail(execution.id).sealedResults.length,4);
});

test('Map worker may call a child Branch and cancellation targets the exact child execution',t=>{
 const f=fixture(t,{steps:[script('worker')]});
 const child=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'child',definition:{schema:'ponderosa.branch.v1',name:'Item service',trigger:{kind:'manual'},entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Inspect item',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{}}});
 const parentDefinition={...f.definition,name:'Map calls',steps:[{id:'worker',kind:'branch_call',branchRef:'child'}]};
 const parent=f.branches.deploy({chatId:f.chat.id,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'parent-call',definition:parentDefinition,bindings:{agents:{},directories:{root:f.dir},branches:{child:child.id}}});
 const execution=f.branches.accept(parent.id,'map-call','["A","B"]');f.branches.advance();f.branches.advance();
 const children=f.branches.listExecutions(child.id).filter(e=>e.parentExecutionId===execution.id);
 assert.equal(children.length,2);assert.deepEqual(children.map(e=>e.input).sort(),['A','B']);
 const detail=f.branches.detail(execution.id);assert.equal(detail.mapItems.length,2);assert.ok(detail.attempts.every(a=>a.childExecution?.id&&a.childExecution?.versionId));
 f.branches.cancel(execution.id);f.branches.advance();
 assert.ok(children.every(e=>f.branches.execution(e.id).state==='canceled'));
 assert.equal(f.branches.execution(execution.id).state,'canceled');
});

test('a child Branch containing Map returns a deterministic joined result to its parent',t=>{
 const f=fixture(t,{maxItems:3});
 const parent=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'call-map',definition:{schema:'ponderosa.branch.v1',name:'Call Map',trigger:{kind:'manual'},entry:'call',steps:[{id:'call',kind:'branch_call',branchRef:'child'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{},branches:{child:f.branch.id}}});
 const execution=f.branches.accept(parent.id,'outer','["a","b","c"]');
 for(let i=0;i<20;i++){f.branches.advance();let lease;while((lease=f.branches.claimScript('worker'))){f.branches.settleScript(lease,{failed:false,output:lease.input})}if(f.branches.execution(execution.id).state==='completed')break}
 const child=f.branches.listExecutions(f.branch.id).find(e=>e.parentExecutionId===execution.id);
 assert.ok(child);assert.equal(f.branches.detail(child.id).mapItems.length,3);
 assert.equal(f.branches.execution(execution.id).state,'completed');assert.match(f.branches.execution(execution.id).output,/a[\s\S]*b[\s\S]*c/);
});

test('an impossible Map quorum fails once and preserves every item outcome',t=>{
 const f=fixture(t,{mode:'quorum',maxConcurrentItems:3}),execution=f.accept('["good","bad-1","bad-2"]');
 settleAll(f,execution.id,{failure:item=>item.startsWith('bad')});
 const detail=f.branches.detail(execution.id);
 assert.equal(detail.execution.state,'failed');assert.equal(detail.mapItems.length,3);
 assert.equal(detail.mapItems.filter(item=>item.state==='arrived').length,3);
 assert.equal(detail.sealedResults.length,3);
 assert.equal(detail.decisions.filter(d=>d.kind==='join_resolved').length,1);
 assert.equal(detail.decisions.find(d=>d.kind==='join_resolved').failed,true);
 const failed=f.branches.mapItemEvidence(execution.id,detail.mapItems.find(item=>item.result?.failed).id);
 const evidence=f.branches.stepEvidence(execution.id,failed.stepExecutionId);
 assert.equal(evidence.attempts.at(-1).state,'failed');
 assert.equal(evidence.attempts.at(-1).number,1);
});

test('an Any Join cancels only unneeded Map items and records their terminal item events',t=>{
 const controls=[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:4,maxConcurrentItems:1},{id:'join',kind:'join',forkId:'map',mode:'any',remainder:'cancel',inputOrder:[]}];
 const f=fixture(t,{controls,maxItems:4,maxConcurrentItems:1}),execution=f.accept('["winner","later-1","later-2","later-3"]');
 f.branches.advance();const first=f.branches.claimScript('worker');assert.equal(first.input,'winner');f.branches.settleScript(first,{failed:false,output:'won'});
 const detail=f.branches.detail(execution.id);assert.equal(detail.execution.state,'completed');assert.equal(detail.mapItems.filter(item=>item.state==='canceled').length,3);
 assert.equal(f.branches.claimScript('worker'),undefined);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='map_item_canceled'").get(execution.id).n,3);
});

test('Map closes after exact losing Script cleanup is observed',t=>{
 const controls=[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:2,maxConcurrentItems:2},{id:'join',kind:'join',forkId:'map',mode:'any',remainder:'cancel',inputOrder:[]}];
 const f=fixture(t,{controls,maxItems:2,maxConcurrentItems:2}),execution=f.accept('["slow","winner"]');f.branches.advance();
 const slow=f.branches.claimScript('worker'),winner=f.branches.claimScript('worker');f.branches.authorizeScript(slow,{pid:123,pgid:123,birthMarker:'test:fake'});
 f.branches.settleScript(winner,{failed:false,output:'won'});
 assert.equal(f.branches.execution(execution.id).state,'waiting');assert.equal(f.branches.detail(execution.id).maps[0].state,'open');
 f.branches.recoverScript(slow.attemptId);
 assert.equal(f.branches.execution(execution.id).state,'completed');assert.equal(f.branches.detail(execution.id).maps[0].state,'completed');
});

test('joined output beyond inline size stays addressable and a following Script receives its content',t=>{
 const large='X'.repeat(7_000);
 const steps=[script('worker',`process.stdout.write('${large}')`),script('consume')];
 const controls=[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:2,maxConcurrentItems:2},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}];
 const f=fixture(t,{steps,controls,edges:[edge('item','map','worker','selected'),edge('return','worker','join'),edge('continue','join','consume')],maxItems:2});
 const execution=f.accept('["a","b"]');f.branches.advance();
 for(let i=0;i<2;i++){const lease=f.branches.claimScript('worker');assert.ok(lease);f.branches.settleScript(lease,{failed:false,output:large})}
 const consume=f.branches.claimScript('worker');assert.ok(consume);assert.ok(consume.input.length>14_000);assert.match(consume.input,/\[1: a\]/);
 f.branches.settleScript(consume,{failed:false,output:'consumed'});assert.equal(f.branches.execution(execution.id).output,'consumed');
});

test('an explicitly passed large joined result expands in a child Branch Script',t=>{
 const large='X'.repeat(7_000);
 const f=fixture(t,{maxItems:2});
 const child=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'large-child',definition:{schema:'ponderosa.branch.v1',name:'Large-result consumer',trigger:{kind:'manual'},entry:'consume',steps:[script('consume')],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:f.dir}}});
 const definition={...f.definition,steps:[script('worker'),{id:'call',kind:'branch_call',branchRef:'child'}],edges:[edge('item','map','worker','selected'),edge('return','worker','join'),edge('to-child','join','call')]};
 const parent=f.branches.deploy({chatId:f.chat.id,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'large-parent',definition,bindings:{agents:{},directories:{root:f.dir},branches:{child:child.id}}});
 const execution=f.branches.accept(parent.id,'large-call','["a","b"]');f.branches.advance();
 for(let i=0;i<2;i++){const lease=f.branches.claimScript('worker');assert.ok(lease);f.branches.settleScript(lease,{failed:false,output:large})}
 f.branches.advance();
 const childExecution=f.branches.listExecutions(child.id).find(run=>run.parentExecutionId===execution.id);
 assert.ok(childExecution);assert.match(childExecution.input,/^branch-result-bundle:/);
 let consume;for(let pass=0;pass<5&&!consume;pass++){f.branches.advance();consume=f.branches.claimScript('worker')}
 assert.ok(consume,`Child ${f.branches.execution(childExecution.id).state} did not offer its Script`);
 assert.equal(consume.executionId,childExecution.id);
 assert.ok(consume.input.length>14_000);assert.match(consume.input,/\[1: a\]/);
 f.branches.settleScript(consume,{failed:false,output:'consumed'});f.branches.advance();
 assert.equal(f.branches.execution(execution.id).state,'completed');
});

test('a large result returned by one child is explicitly forwarded to a sibling child',t=>{
 const f=fixture(t,{maxItems:2});
 const consumer=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'sibling-consumer',definition:{schema:'ponderosa.branch.v1',name:'Sibling consumer',trigger:{kind:'manual'},entry:'consume',steps:[script('consume')],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:f.dir}}});
 const parent=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'sibling-parent',definition:{schema:'ponderosa.branch.v1',name:'Sibling parent',trigger:{kind:'manual'},entry:'produce',steps:[{id:'produce',kind:'branch_call',branchRef:'producer'},{id:'consume',kind:'branch_call',branchRef:'consumer'}],controls:[],edges:[edge('next','produce','consume')],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:f.dir},branches:{producer:f.branch.id,consumer:consumer.id}}});
 const execution=f.branches.accept(parent.id,'sibling-run','["a","b"]');
 for(let pass=0;pass<10;pass++){f.branches.advance();if(f.branches.listExecutions(f.branch.id).some(run=>run.parentExecutionId===execution.id))break}
 const producer=f.branches.listExecutions(f.branch.id).find(run=>run.parentExecutionId===execution.id);assert.ok(producer);
 const large='X'.repeat(7_000);
 for(let i=0;i<2;i++){let lease;for(let pass=0;pass<5&&!lease;pass++){f.branches.advance();lease=f.branches.claimScript('worker')}assert.ok(lease);assert.equal(lease.executionId,producer.id);f.branches.settleScript(lease,{failed:false,output:large})}
 let second;for(let pass=0;pass<10&&!second;pass++){f.branches.advance();second=f.branches.listExecutions(consumer.id).find(run=>run.parentExecutionId===execution.id)}
 assert.ok(second);assert.match(second.input,/^branch-result-bundle:/);
 const bundleId=second.input.split(':')[2];assert.equal(f.branches.resultBundle(bundleId).executionId,execution.id);
 f.reopen();
 let consume;for(let pass=0;pass<5&&!consume;pass++){f.branches.advance();consume=f.branches.claimScript('worker')}
 assert.ok(consume);assert.equal(consume.executionId,second.id);assert.ok(consume.input.length>14_000);assert.match(consume.input,/\[1: a\]/);
 f.branches.settleScript(consume,{failed:false,output:'received'});f.branches.advance();
 assert.equal(f.branches.execution(execution.id).state,'completed');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='result_bundle_forwarded'").get(execution.id).n,1);
});

test('an unrelated execution cannot expand a result bundle by copying its reference text',t=>{
 const f=fixture(t,{maxItems:2});
 const original=f.accept('["a","b"]','original');f.branches.advance();
 for(let i=0;i<2;i++){const lease=f.branches.claimScript('worker');assert.ok(lease);f.branches.settleScript(lease,{failed:false,output:'SECRET-'+ 'X'.repeat(7_000)})}
 const reference=f.branches.execution(original.id).output;assert.match(reference,/^branch-result-bundle:/);
 const other=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'unrelated-bundle-consumer',definition:{schema:'ponderosa.branch.v1',name:'Unrelated consumer',trigger:{kind:'manual'},entry:'consume',steps:[script('consume')],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:f.dir}}});
 const execution=f.branches.accept(other.id,'unrelated-reference',reference);f.branches.advance();
 const lease=f.branches.claimScript('worker');assert.equal(lease.executionId,execution.id);assert.equal(lease.input,reference);assert.equal(lease.input.includes('SECRET-'),false);
});

test('a human-edited choice is validated by Route without re-running prior work',t=>{
 const steps=[script('discover'),{id:'choice',kind:'human_gate',prompt:'Choose route',editable:true},script('billing'),script('fallback')];
 const controls=[{id:'route',kind:'route',otherwise:'fallback'}];
 const edges=[edge('review','discover','choice'),edge('chosen','choice','route','approved'),edge('billing','route','billing','selected',{choice:'Billing'}),edge('otherwise','route','fallback','failure')];
 const f=fixture(t,{entry:'discover',steps,controls,edges}),execution=f.accept('input');
 f.branches.advance();const prior=f.branches.claimScript('worker');f.branches.settleScript(prior,{failed:false,output:'proposal'});f.branches.advance();
 const gate=f.branches.detail(execution.id).gates[0];f.branches.resolveGate(gate.id,{commandKey:'choose',expectedRevision:gate.revision,decision:'approve',output:'Billing'});
 const selected=f.branches.claimScript('worker');assert.equal(selected.input,'Billing');f.branches.settleScript(selected,{failed:false,output:'done'});
 assert.equal(f.branches.execution(execution.id).state,'completed');assert.equal(f.branches.detail(execution.id).steps.filter(step=>step.stepId==='discover').length,1);
 assert.ok(f.branches.detail(execution.id).decisions.some(decision=>decision.kind==='route_selected'));
});

test('a persistent Agent result selects only a declared Route edge',t=>{
 const f=fixture(t),agent=f.store.createAgent(f.project.id,{title:'Triage',engine:'codex',conversationId:f.chat.id});
 const definition={...f.definition,name:'Agent route',entry:'triage',steps:[{id:'triage',kind:'agent',target:{kind:'persistent_agent',ref:'triage'},instructions:'Choose one route'},script('billing'),script('fallback')],controls:[{id:'route',kind:'route',otherwise:'fallback'}],edges:[edge('to-route','triage','route'),edge('billing','route','billing','selected',{choice:'Billing'}),edge('otherwise','route','fallback','failure')]};
 const deployed=f.branches.deploy({chatId:f.chat.id,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'agent-route',definition,bindings:{agents:{triage:agent.id},directories:{root:f.dir}}});
 const execution=f.branches.accept(deployed.id,'agent-choice','Find the owner');f.branches.advance();
 const request=f.branches.detail(execution.id).attempts[0].requestId;assert.ok(request);
 f.coordination.updateRequest({requestId:request,updateId:'choose-billing',kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'Billing'}});f.branches.advance();
 const billing=f.branches.claimScript('worker');assert.equal(billing.input,'Billing');f.branches.settleScript(billing,{failed:false,output:'handled'});
 assert.equal(f.branches.execution(execution.id).state,'completed');assert.equal(f.branches.detail(execution.id).steps.filter(step=>step.stepId==='fallback').length,0);
 assert.ok(f.branches.detail(execution.id).decisions.some(decision=>decision.kind==='route_selected'));
});

test('an invalid Route choice reaches an explicit human recovery gate',t=>{
 const steps=[script('triage'),script('billing'),{id:'review',kind:'human_gate',prompt:'Choose the correct team',editable:true}];
 const controls=[{id:'route',kind:'route',otherwise:'review'}];
 const edges=[edge('triage-route','triage','route'),edge('billing','route','billing','selected',{choice:'Billing'}),edge('invalid-review','route','review','failure')];
 const f=fixture(t,{entry:'triage',steps,controls,edges}),execution=f.accept('Unrecognized');f.branches.advance();
 const triage=f.branches.claimScript('worker');f.branches.settleScript(triage,{failed:false,output:'Unknown'});f.branches.advance();
 const gate=f.branches.detail(execution.id).gates[0];assert.ok(gate);assert.equal(f.branches.execution(execution.id).state,'waiting');
 assert.ok(f.branches.detail(execution.id).decisions.some(decision=>decision.kind==='route_invalid'));
 f.branches.resolveGate(gate.id,{commandKey:'resolved',expectedRevision:gate.revision,decision:'approve',output:'Escalated to a person'});
 assert.equal(f.branches.execution(execution.id).state,'completed');assert.equal(f.branches.execution(execution.id).output,'Escalated to a person');
});

test('Map can call a Branch that itself maps, preserving each nested execution boundary',t=>{
 const f=fixture(t,{maxItems:3});
 const childDefinition={...f.definition,name:'Nested review'};
 const child=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'nested-child',definition:childDefinition,bindings:{agents:{},directories:{root:f.dir}}});
 const parentDefinition={...f.definition,name:'Outer review',steps:[{id:'worker',kind:'branch_call',branchRef:'child'}]};
 const parent=f.branches.deploy({chatId:f.chat.id,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'nested-parent',definition:parentDefinition,bindings:{agents:{},directories:{root:f.dir},branches:{child:child.id}}});
 const execution=f.branches.accept(parent.id,'nested','["[\\"a\\",\\"b\\"]","[\\"c\\"]"]');
 for(let i=0;i<30;i++){f.branches.advance();let lease;while((lease=f.branches.claimScript('worker')))f.branches.settleScript(lease,{failed:false,output:lease.input});if(f.branches.execution(execution.id).state==='completed')break}
 const children=f.branches.listExecutions(child.id).filter(run=>run.parentExecutionId===execution.id);
 assert.equal(children.length,2);assert.deepEqual(children.map(run=>f.branches.detail(run.id).mapItems.length).sort(),[1,2]);
 assert.equal(f.branches.execution(execution.id).state,'completed');
 assert.equal(f.branches.detail(execution.id).mapItems.length,2);
});

test('a Map threshold above 100 can be configured when item budgets allow it',t=>{
 const f=fixture(t,{maxItems:150,maxConcurrentItems:15,mode:'quorum',controls:[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:150,maxConcurrentItems:15},{id:'join',kind:'join',forkId:'map',mode:'quorum',quorum:125,remainder:'finish',inputOrder:[]}]}),execution=f.accept(JSON.stringify(Array.from({length:150},(_,i)=>`item-${i}`)));
 settleAll(f,execution.id);assert.equal(f.branches.execution(execution.id).state,'completed');assert.equal(f.branches.detail(execution.id).mapItems.length,100);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_map_items').get().n,150);
});

test('Map item and sealed-result inspection pages use execution-scoped restart-safe cursors',t=>{
 const f=fixture(t,{maxItems:125,maxConcurrentItems:25}),execution=f.accept(JSON.stringify(Array.from({length:125},(_,i)=>`item-${i}`)));
 settleAll(f,execution.id);let page=f.branches.detail(execution.id),itemIds=[],resultIds=[];
 while(page){itemIds.push(...page.mapItems.map(item=>item.id));resultIds.push(...page.sealedResults.map(result=>result.id));if(!page.nextCursor)break;const cursor=page.nextCursor;f.reopen();page=f.branches.detail(execution.id,cursor)}
 assert.equal(itemIds.length,125);assert.equal(new Set(itemIds).size,125);
 assert.equal(resultIds.length,125);assert.equal(new Set(resultIds).size,125);
 const other=f.accept('[]','other');assert.throws(()=>f.branches.detail(other.id,f.branches.detail(execution.id).nextCursor),/cursor/i);
});

test('completed large result evidence persists across restart and is removed with its Branch',t=>{
 const f=fixture(t,{maxItems:2}),execution=f.accept('["a","b"]','retained-large-result');
 f.branches.advance();
 for(let i=0;i<2;i++){
  const lease=f.branches.claimScript('retained-result-worker');assert.ok(lease);
  f.branches.settleScript(lease,{failed:false,output:'R'.repeat(7_000)});
 }
 const reference=f.branches.execution(execution.id).output;
 assert.match(reference,/^branch-result-bundle:/);
 const bundleId=reference.split(':')[2];
 const original=f.branches.resultBundle(bundleId);assert.ok(original?.content.includes('[1: a]'));
 const sealedBefore=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results WHERE execution_id=?').get(execution.id).n;
 assert.equal(sealedBefore,2);
 f.reopen();
 assert.equal(f.branches.execution(execution.id).state,'completed');
 assert.equal(f.branches.resultBundle(bundleId)?.contentHash,original.contentHash);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results WHERE execution_id=?').get(execution.id).n,sealedBefore);
 for(let i=0;i<20&&f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_checkpoints WHERE audit_published=0').get().n;i++)f.branches.publishAudit(()=>{});
 f.branches.deleteBranch(f.branch.id);
 assert.equal(f.branches.resultBundle(bundleId),undefined);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results WHERE execution_id=?').get(execution.id).n,0);
});

test('Map cancellation closes its audit state after exact Agent cleanup while the workflow continues',t=>{
 const controls=[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:2,maxConcurrentItems:2},{id:'join',kind:'join',forkId:'map',mode:'any',remainder:'cancel',inputOrder:[]}];
 // A persistent worker is created only inside this disposable store; no provider executes.
 const f=fixture(t,{controls,steps:[script('worker')],maxItems:2,maxConcurrentItems:2});
 const worker=f.store.createAgent(f.project.id,{title:'Map worker',engine:'codex',conversationId:f.chat.id});
 const branch=f.branches.deploy({chatId:f.chat.id,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'agent-map',definition:{...f.definition,steps:[{id:'worker',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Review item'}]},bindings:{agents:{worker:worker.id},directories:{root:f.dir}}});
 const execution=f.branches.accept(branch.id,'agent-map-run','["slow","winner"]');f.branches.advance();f.branches.advance();
 const lease=f.coordination.leaseNextRun({workerId:'provider'});assert.ok(lease);
 const requests=f.coordination.requestIdsAttachedToRun(lease.runId,worker.id);assert.equal(requests.length,2);
 f.coordination.updateRequest({requestId:requests[0],updateId:'winner',kind:'completed',actor:{kind:'agent',id:worker.id},payload:{text:'Won'}});f.branches.advance();
 assert.equal(f.branches.detail(execution.id).maps[0].state,'open');assert.equal(f.branches.execution(execution.id).state,'waiting');
 // Shared work is held, not broadly interrupted. Existing exact operator
 // cancellation supplies independently observed cleanup for this fixture.
 f.coordination.cancelAgentRun({agentId:worker.id,expectedRunId:lease.runId,idempotencyKey:'owned-map-cleanup'});
 const [operation]=f.coordination.claimProviderOperations('cleanup');assert.ok(operation);f.coordination.completeProviderOperation(operation.id,'cleanup');
 f.branches.advance();assert.equal(f.branches.execution(execution.id).state,'completed');assert.equal(f.branches.detail(execution.id).maps[0].state,'completed');
});
