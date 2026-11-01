import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {verifyAcceptedMethod,finalizeLedger,sha256,inputManifestDigest} from './qualification-ledger.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {sendQualificationTask,readLeasedRun,readCanonicalProgress,workIdentity,assertProgressWindow,settleLoadAgents} from '../shared/ui-load-fixture.mjs';
test('normal asset maintenance retry uses one idempotency key and retains the actual refusal',async()=>{
 const attempts=[],keys=[];const f={api:async(_method,_path,body)=>{keys.push(body.idempotencyKey);return keys.length===1?{status:409,body:{error:'Agent asset maintenance is in progress; retry safely'}}:{status:200,body:{accepted:true}};},ok:response=>{assert.equal(response.status,200);return response.body;}};
 assert.deepEqual(await sendQualificationTask(f,'/api','agent','task',row=>attempts.push(row)),{accepted:true});assert.equal(new Set(keys).size,1);assert.equal(attempts[0].status,409);assert.equal(attempts[1].status,200);
});
test('an unrelated refusal never becomes a retry or a successful task',async()=>{
 let calls=0;const f={api:async()=>{calls++;return {status:409,body:{error:'Other refusal'}};},ok:()=>{throw Error('Other refusal');}};await assert.rejects(sendQualificationTask(f,'/api','agent','task'),/Other refusal/);assert.equal(calls,1);
});
test('lease binding requires exact Agent, live expiry, fencing and provider session',()=>{
 const row={id:'run',agent_id:'agent',status:'running',lease_owner:'owner',lease_expires_at:new Date(Date.now()+60000).toISOString(),fencing_token:7,provider_session_id:'session'};
 const store={sqlite:{prepare:()=>({get:id=>id==='run'?row:undefined})}};
 assert.equal(readLeasedRun(store,'agent','run','session'),row);assert.throws(()=>readLeasedRun(store,'foreign','run','session'));assert.throws(()=>readLeasedRun(store,'agent','run','foreign'));row.fencing_token=0;assert.throws(()=>readLeasedRun(store,'agent','run','session'));row.fencing_token=7;row.lease_expires_at='2000-01-01';assert.throws(()=>readLeasedRun(store,'agent','run','session'));
});

test('canonical progress binds persisted text segments to the exact execution',()=>{
 const rows=[{executionId:'run',text:'Working checkpoint 2. Working checkpoint 3.',seq:7},{executionId:'foreign',text:'Working checkpoint 99.'}];
 assert.equal(readCanonicalProgress({getRunOutputs:()=>rows},'agent','run').sequence,3);assert.equal(readCanonicalProgress({getRunOutputs:()=>rows},'agent','missing').sequence,0);assert.equal(readCanonicalProgress({getRunOutputs:()=>[{executionId:'run',text:'Canonical method checkpoint 3.'}]},'agent','run').sequence,3);
});

test('owner, fencing and process epoch participate in actual work identity',()=>{
 const run={agentId:'a',runId:'r',sessionId:'s',lease:{lease_owner:'owner',fencing_token:1},processIdentity:{pid:1,pgid:1,birthMarker:'birth'}};
 const identity=workIdentity(run);for(const change of [{lease:{...run.lease,lease_owner:'other'}},{lease:{...run.lease,fencing_token:2}},{processIdentity:{...run.processIdentity,birthMarker:'replacement'}}])assert.notEqual(workIdentity({...run,...change}),identity);
 assert.throws(()=>workIdentity({...run,processIdentity:undefined}));
});
test('twenty-work window rejects postcapture persistence and out-of-window provider credit',()=>{
 const agents=Array.from({length:20},(_,i)=>'agent-'+i),rows=agents.map(agentId=>({agentId,runId:'run-'+agentId,identity:'identity-'+agentId,sequence:2,providerAt:200,observedAt:300}));
 assert.equal(assertProgressWindow(agents,rows,100,400).length,20);
 for(const change of [{observedAt:401},{providerAt:99},{providerAt:350}])assert.throws(()=>assertProgressWindow(agents,rows.map((r,i)=>i? r:{...r,...change}),100,400));
 assert.throws(()=>assertProgressWindow(agents,rows,100,20000));
});

test('method acceptance requires structured METHOD decision bound to pinned head and input digest',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'method-binding-'));
 try{
  const head='a'.repeat(40),review=join(dir,'decision.json'),input=join(dir,'collector.mjs'),receipt=join(dir,'receipt.json');await writeFile(input,'collector');
  const inputs=[{path:input,sha256:sha256('collector')}],decision={schemaVersion:1,scope:'METHOD',decision:'ACCEPT',reviewedHead:head,inputManifestSha256:inputManifestDigest(inputs)};
  const bind=async text=>{await writeFile(review,text);const value={decision:'ACCEPT',scope:'METHOD',review:{path:review,sha256:sha256(text)},go32:{authorizedBy:'manager',communicationReference:'synthetic-test-only'},inputs};const bytes=JSON.stringify(value);await writeFile(receipt,bytes);return sha256(bytes);};
  let hash=await bind(JSON.stringify(decision));assert.equal((await verifyAcceptedMethod(receipt,hash,[input],head)).decision.reviewedHead,head);
  await assert.rejects(verifyAcceptedMethod(receipt,'wrong',[input],head));await assert.rejects(verifyAcceptedMethod(receipt,hash,['missing'],head));await assert.rejects(verifyAcceptedMethod(receipt,hash,[input],'b'.repeat(40)));
  for(const text of ['ACCEPT narrowly PRODUCT\nMETHOD REQUEST_CHANGES','> ACCEPT METHOD historical quote',JSON.stringify({...decision,decision:'REQUEST_CHANGES'}),JSON.stringify({...decision,inputManifestSha256:'wrong'}),JSON.stringify({...decision,productDecision:'ACCEPT',methodDecision:'REQUEST_CHANGES'})]){hash=await bind(text);await assert.rejects(verifyAcceptedMethod(receipt,hash,[input],head));}
  hash=await bind(JSON.stringify(decision));await writeFile(input,'drift');await assert.rejects(verifyAcceptedMethod(receipt,hash,[input],head));
 }finally{await rm(dir,{recursive:true});}
});
test('terminal ledger retains planned cells and cleanup failures after all cleanup attempts',async()=>{
 const rows=[{id:'one',status:'started'},{id:'two',status:'planned'}],ledger={status:'failed',error:'setup failed'},calls=[];let persisted;
 await assert.rejects(finalizeLedger(ledger,rows,async()=>{persisted=JSON.parse(JSON.stringify({ledger,rows}));},[['browser',async()=>{calls.push('browser');throw Error('cleanup failed');}],['fixture',async()=>{calls.push('fixture');}]]));
 assert.deepEqual(calls,['browser','fixture']);assert(rows.every(r=>r.status==='not-run'&&r.terminalAt));assert.equal(persisted.ledger.cleanup[0].status,'failed');assert.equal(persisted.ledger.cleanup[1].status,'complete');assert(persisted.ledger.terminalAt);
});

test('provider failure after monitoring stops still fails settlement and closes every session',async()=>{
 const calls=[],monitorStopped=true;const f={settled:async id=>{assert(monitorStopped);calls.push('settle-'+id);if(id==='late-failure')throw Error('provider failed after final in-window checkpoint');return {runs:[{status:'completed'}]};},sessions:new Map(['late-failure','healthy'].map(id=>[id,{close:async()=>calls.push('close-'+id)}]))};
 await assert.rejects(settleLoadAgents(f,[{id:'late-failure'},{id:'healthy'}]),/Provider terminal settlement failed/);assert.deepEqual(calls,['settle-late-failure','close-late-failure','settle-healthy','close-healthy']);
});
test('non-success terminal outcome and close failure cannot waive later cleanup',async()=>{
 const closed=[];const f={settled:async()=>({runs:[{status:'cancelled'}]}),sessions:new Map(['a','b'].map(id=>[id,{close:async()=>{closed.push(id);if(id==='a')throw Error('close failed');}}]))};await assert.rejects(settleLoadAgents(f,[{id:'a'},{id:'b'}]));assert.deepEqual(closed,['a','b']);
});
