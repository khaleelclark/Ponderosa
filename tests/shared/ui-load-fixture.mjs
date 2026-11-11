// Owned qualification state only: normal settings, real resource observation and canonical seed/projection APIs.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {appendFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {fixture,until} from './fixture.mjs';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {sampleLinuxResources,RESOURCE_ADMISSION_DEFAULTS} from '../../apps/server/dist/resource-admission.js';
export async function createLoadFixture(out,{messages=10000}={}){
 let store,closing=false,monitor;const work=new Map(),progress=new Map(),lastProgress=new Map(),lastCanonicalProgress=new Map(),continuityFailures=[],pending=new Set(),identities=new Map(),canonicalReceipts=[],providerReceipts=new Map(),activatedAgents=new Set();
 const record=value=>appendFileSync(out+'/lifecycle.jsonl',JSON.stringify({time:Date.now(),...value})+'\n');
 const sample=await sampleLinuxResources();record({event:'preflight',sample,admissionDefaults:RESOURCE_ADMISSION_DEFAULTS});
 assert.ok(sample.availableBytes>=RESOURCE_ADMISSION_DEFAULTS.reserveBytes+20*RESOURCE_ADMISSION_DEFAULTS.startupBytes,'Real effective headroom must admit twenty, without a guard override');
 assert.ok(sample.memoryFullPercent<5&&sample.ioFullPercent<10,'No pressured preflight');
 // Passing {} selects createServer's actual default sampler; shared fixture's fixed sample is NOT used.
 // Use the installed static routes on the API listener, with no extra UI proxy.
 const f=await fixture({webDist:fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),resourceAdmissionObservation:{},schedulerMaxConcurrentRuns:20,storeFactory:dir=>(store=new AgentStore(dir))});
 const products={},runIds=new Map(),seedIds=new Map();
 function leaseFor(agentId,sessionId){
  const lease=readLeasedRun(store,agentId,runIds.get(agentId),sessionId);
  if(!runIds.has(agentId))runIds.set(agentId,lease.id);
  return lease;
 }
 function verifyHistory(product){
  const p=products[product],verified=verifyQualificationHistory(store,p.chat,p.seed,seedIds.get(product));
  record({event:'history-verified',product,...verified});return verified;
 }
 try{
  for(const product of ['core','branches']){
   const prefix=product==='core'?'/api':'/api/branches/engine';
   const preferences=f.ok(await f.api('PATCH',prefix+'/workspace/preferences',{maxConcurrentAgentRuns:20}));
   assert.equal(preferences.maxConcurrentAgentRuns,20);record({event:'human-visible-concurrency',product,value:preferences.maxConcurrentAgentRuns});
   const branch=product==='branches'?f.ok(await f.api('POST','/api/branches',{name:'Load qualification',idempotencyKey:randomUUID()})):undefined;
   const chat=branch?f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Load qualification',defaultEngine:'codex'},{'idempotency-key':randomUUID()})):await f.createChat('Load qualification');
   const {messageIds,...seed}=seedQualificationHistory(store,chat,messages,()=>record({event:'seeding',product}));seedIds.set(product,messageIds);
   const agents=[];for(let i=0;i<20;i++)agents.push(f.ok(await f.api('POST',`${prefix}/projects/${chat.projectId}/agents`,{title:`Working ${i+1}`,engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()})));
   products[product]={prefix,branch,chat,agents,seed,route:branch?`/branches?branch=${branch.id}&tab=chats&chat=${chat.id}`:`/projects/${chat.projectId}/chats/${chat.id}`};
   record({event:'seed-verified',product,...products[product].seed});
  }
  async function snapshot(product){
   const p=products[product],runs=[];
   for(const agent of p.agents){const session=f.sessions.get(agent.id),sessionId=session?.engineAgentId??null,lease=leaseFor(agent.id,sessionId);runs.push({agentId:agent.id,canonicalRun:{id:lease.id,agentId:lease.agent_id,status:lease.status},lease,sessionId,progressAgeMs:Date.now()-(lastProgress.get(agent.id)??0),runId:lease.id,status:lease.status,progress:progress.get(agent.id)??0,alive:session?.isAlive()??false});}
   for(const run of runs){
    const persisted=readCanonicalProgress(store,run.agentId,run.runId);run.canonicalProgress=persisted;const observedAt=Date.now();
    run.processIdentity=f.sessions.get(run.agentId)?.processIdentity;const key=`${product}/${run.agentId}`,identity=workIdentity(run);
    if(identities.has(key)&&identities.get(key)!==identity)continuityFailures.push({agentId:run.agentId,reason:'Run/session/lease owner/fence/process epoch changed'});identities.set(key,identity);
    const previous=lastCanonicalProgress.get(run.agentId);if(!previous||persisted.sequence>previous.sequence){lastCanonicalProgress.set(run.agentId,{sequence:persisted.sequence,at:observedAt});const provider=providerReceipts.get(run.agentId)?.get(persisted.sequence);canonicalReceipts.push({agentId:run.agentId,runId:run.runId,sequence:persisted.sequence,outputs:persisted.outputs,providerAt:provider?.runId===run.runId?provider.at:null,observedAt,identity});}
    else if(Date.now()-previous.at>10000)continuityFailures.push({agentId:run.agentId,reason:'Canonical persisted progress gap exceeds 10s'});
    if(run.status!=='running'||!run.alive||run.progressAgeMs>10000)continuityFailures.push({agentId:run.agentId,reason:'inactive or progress gap exceeds 10s',run});
   }
   const leases=runs.map(run=>run.lease);
   const sample=await sampleLinuxResources(),value={product,runs,leases,historySeed:p.seed,sample,continuityFailures:[...continuityFailures],observedAt:Date.now()};record({event:'active-snapshot',...value});return value;
  }
  async function activate(product){
   const p=products[product];
   for(const agent of p.agents){activatedAgents.add(agent.id);progress.set(agent.id,0);work.set(agent.id,true);f.plans.set(agent.id,[{output:false,run:async session=>{
    while(!closing&&work.get(agent.id)&&session.isAlive()){
     const result=await session.tool('ponderosa_workspace_projects',{});assert.equal(result.success,true,result.text);
     const run=leaseFor(agent.id,session.engineAgentId);
     const n=(progress.get(agent.id)??0)+1;progress.set(agent.id,n);lastProgress.set(agent.id,Date.now());if(!providerReceipts.has(agent.id))providerReceipts.set(agent.id,new Map());providerReceipts.get(agent.id).set(n,{at:Date.now(),runId:run.id});session.events.push({type:'text',delta:`Working checkpoint ${n}. `});record({event:'provider-work',product,agentId:agent.id,sessionId:session.engineAgentId,sequence:n,runId:run.id,runStatus:run.status,processIdentity:session.processIdentity,tool:'ponderosa_workspace_projects',success:result.success});
     await delay(2000);
    }
   }}]);await sendQualificationTask(f,p.prefix,agent.id,'Continuously inspect granted workspace status and report short progress until qualification ends.',attempt=>record({event:'keyed-task-submission',agentId:agent.id,...attempt}));}
   await until(()=>p.agents.every(a=>(progress.get(a.id)??0)>=2),'twenty working provider loops',60000);
   const value=await snapshot(product);assert.equal(value.runs.filter(r=>r.status==='running'&&r.alive&&r.progress>=2).length,20);monitor=setInterval(()=>sampleLoadOnce(pending,()=>snapshot(product),error=>{continuityFailures.push({reason:String(error)});record({event:'monitor-failed',error:String(error)});}),1000);
   return value;
  }
  async function deactivate(product){
   clearInterval(monitor);await Promise.all(pending);
   for(const agent of products[product].agents)work.set(agent.id,false);
   await until(async()=>{for(const a of products[product].agents){const d=f.ok(await f.api('GET',`${products[product].prefix}/agents/${a.id}`));if(d.runs.some(r=>['running','preparing'].includes(r.status)))return false;}return true;},'controlled work completes',30000);
   await settleLoadAgents(f,products[product].agents,record,products[product].prefix);
   for(const agent of products[product].agents)activatedAgents.delete(agent.id);
   verifyHistory(product);assertContinuity();record({event:'deactivated',product});
  }
  function assertContinuity(){assert.deepEqual(continuityFailures,[],'Per-Agent continuity failure; no active-work credit');}
  writeFileSync(out+'/seed.json',JSON.stringify({root:f.root,products},null,2));
  return {f,products,activate,deactivate,snapshot,assertContinuity,async drain(){await Promise.all([...pending]);assertContinuity();},assertWindow(product,start,end){return assertProgressWindow(products[product].agents.map(a=>a.id),canonicalReceipts,start,end);},async close(){closing=true;clearInterval(monitor);await Promise.all(pending);record({event:'closing'});try{const errors=[];for(const p of Object.values(products)){try{await settleLoadAgents(f,p.agents.filter(agent=>activatedAgents.has(agent.id)),record,p.prefix);}catch(error){errors.push(error);}}if(errors.length)throw new AggregateError(errors,'Product provider settlement failed');for(const product of Object.keys(products))verifyHistory(product);assertContinuity();}finally{await f.dispose(false);record({event:'fixture-closed-owned-roots-observed-exited'});}}};
 }catch(error){closing=true;record({event:'setup-failed',error:error.stack});await f.dispose(false);throw error;}
}

export function seedQualificationHistory(store,chat,messages=10000,onProgress=()=>{}){
 const expected=createHash('sha256');
 for(let i=0;i<messages;i++){
  if(i%1000===0)onProgress(i);
  const text=`Qualification ${i}: **shared history** λ😀. A concise retained message with a [local anchor](#history).`,eventId=randomUUID();expected.update(text+'\n');
  store.appendCommunicationEvent({schemaVersion:2,eventId,projectId:chat.projectId,conversationId:chat.id,sender:{kind:'user',userId:'local-operator'},intent:'broadcast',audience:{kind:'organization',organizationId:chat.projectId},text,createdAt:new Date(1700000000000+i).toISOString()});
  assert.ok(store.appendConversationMessage(chat.id,{text,role:'user'},undefined,'main',undefined,undefined,eventId));
 }
 const rows=store.getConversationMessages(chat.id),actual=createHash('sha256');for(const row of rows)actual.update(row.text+'\n');
 const hash=actual.digest('hex');assert.equal(rows.length,messages);assert.equal(hash,expected.digest('hex'));
 return {messages,messageIds:rows.map(row=>row.id),recordSha256:historyRecordHash(rows),orderedTextSha256:hash,firstId:rows[0].id,lastId:rows.at(-1).id,lastText:rows.at(-1).text};
}
function historyRecordHash(rows){return createHash('sha256').update(JSON.stringify(rows.map(({id,text})=>[id,text]))).digest('hex');}
export function verifyQualificationHistory(store,chat,seed,messageIds){
 const rows=store.getConversationMessages(chat.id),ids=new Set(messageIds),originals=rows.filter(row=>ids.has(row.id));
 assert.equal(messageIds.length,seed.messages);assert.equal(ids.size,seed.messages);
 assert.deepEqual(originals.map(row=>row.id),messageIds,'Original canonical seed IDs and order must survive');
 const hash=historyRecordHash(originals);assert.equal(hash,seed.recordSha256,'Original canonical seed bytes must survive');
 return {seededMessageCount:originals.length,totalMessageCount:rows.length,recordSha256:hash};
}
export function sampleLoadOnce(pending,read,onFailure){
 if(pending.size)return false;
 const task=Promise.resolve().then(read).catch(onFailure);pending.add(task);
 task.then(()=>pending.delete(task),()=>pending.delete(task));return true;
}

export function readLeasedRun(store,agentId,runId,sessionId){
 const lease=runId===undefined?(()=>{const rows=store.sqlite.prepare("SELECT id,agent_id,status,lease_owner,lease_expires_at,fencing_token,provider_session_id,heartbeat_at,scope_key FROM scheduler_runs WHERE agent_id=? AND status='running' LIMIT 2").all(agentId);assert.equal(rows.length,1,'Exactly one canonical running Run is required');return rows[0];})():store.sqlite.prepare('SELECT id,agent_id,status,lease_owner,lease_expires_at,fencing_token,provider_session_id,heartbeat_at,scope_key FROM scheduler_runs WHERE id=?').get(runId);
 assert(lease&&lease.agent_id===agentId&&lease.status==='running'&&lease.lease_owner&&lease.fencing_token>0&&Date.parse(lease.lease_expires_at)>Date.now(),'Canonical scheduler lease must be live and fenced');
 assert.equal(lease.provider_session_id,sessionId,'Provider session must belong to exact scheduler Run');return lease;
}

export async function sendQualificationTask(f,prefix,agentId,text,onAttempt=()=>{}){
 const idempotencyKey=randomUUID();
 for(let attempt=0;attempt<30;attempt++){
  const response=await f.api('POST',`${prefix}/agents/${agentId}/messages`,{text,idempotencyKey});onAttempt({attempt,idempotencyKey,status:response.status,body:response.body});
  if(response.status!==409||response.body.error!=='Agent asset maintenance is in progress; retry safely')return f.ok(response);
  await delay(100);
 }
 throw Error('Agent asset maintenance did not settle; no guard bypass');
}

export function readCanonicalProgress(store,agentId,runId){
 const outputs=store.getRunOutputs(agentId).filter(row=>row.executionId===runId);
 const checkpoints=outputs.flatMap(row=>[...row.text.matchAll(/(?:Working|Canonical method) checkpoint (\d+)\./g)].map(match=>Number(match[1])));
 return {sequence:Math.max(0,...checkpoints),outputs:outputs.map(({id,executionId,seq,sourceSeqStart,sourceSeqEnd,completed})=>({id,executionId,seq,sourceSeqStart,sourceSeqEnd,completed}))};
}

export function workIdentity(run){
 const lease=run.lease,p=run.processIdentity;
 assert(lease?.lease_owner&&lease.fencing_token>0&&p?.pid>0&&p?.pgid>0&&p.birthMarker,'Lease owner/fence and actual process epoch required');
 return JSON.stringify([run.agentId,run.runId,run.sessionId,lease.lease_owner,lease.fencing_token,p.pid,p.pgid,p.birthMarker]);
}

export function assertProgressWindow(agentIds,receipts,start,end,maxGapMs=10000){
 assert.equal(new Set(agentIds).size,20,'Exactly twenty distinct Agents');
 assert(Number.isFinite(start)&&Number.isFinite(end)&&end>start,'Bounded navigation-to-last-presentation window');
 return agentIds.map(agentId=>{
  const rows=receipts.filter(r=>r.agentId===agentId&&r.providerAt>=start&&r.providerAt<=r.observedAt&&r.observedAt<=end).sort((a,b)=>a.observedAt-b.observedAt);
  assert(rows.length>0,'Each Agent must persist actual in-window work: '+agentId);
  assert(rows.every(r=>r.identity===rows[0].identity&&r.runId===rows[0].runId),'Stable in-window lease/fence/process identity');
  for(let i=1;i<rows.length;i++)assert(rows[i].sequence>rows[i-1].sequence,'Canonical progress must advance');
  const times=[start,...rows.map(r=>r.observedAt),end];for(let i=1;i<times.length;i++)assert(times[i]-times[i-1]<=maxGapMs,'In-window canonical progress gap');
  return {agentId,start,end,receipts:rows};
 });
}

// Monitor completion does not waive retained provider errors or terminal Run failure.
export async function settleLoadAgents(f,agents,record=()=>{},prefix='/api'){
 const errors=[];
 for(const agent of agents){
  try{const detail=await f.settled(agent.id,[],prefix);assert(detail.runs.length>0&&detail.runs.every(r=>r.status==='completed'),'Every controlled Run must complete successfully');record({event:'provider-settled',agentId:agent.id,runs:detail.runs});}
  catch(error){errors.push(error);record({event:'provider-settlement-failed',agentId:agent.id,error:String(error)});}
  finally{try{await f.sessions.get(agent.id)?.close();}catch(error){errors.push(error);record({event:'session-close-failed',agentId:agent.id,error:String(error)});}}
 }
 if(errors.length)throw new AggregateError(errors,'Provider terminal settlement failed');
}


export function verifyQueuedLoadMessage(request,receipt,agents){
 assert.equal(request.activeRunDelivery,'queue','A busy Agent submission must use explicit Queue');
 assert.equal(request.recipients.length,1,'The timed action addresses one working Agent');
 const agentId=request.recipients[0].agentId,agent=agents.find(agent=>agent.id===agentId);assert(agent?.handle,'Queue target must be one of the twenty working Agents');
 assert.equal(request.text,'#'+agent.handle+' Timed short message','Keep the exact authored handle and task');
 assert.equal(receipt.recipients.length,1);const delivery=receipt.recipients[0];
 assert.equal(delivery.agentId,agentId);assert.equal(delivery.queued,true);assert.equal(delivery.state,'queued');
 assert.equal(typeof receipt.messageId,'string');assert(receipt.messageId);assert.equal(typeof delivery.deliveryId,'string');assert(delivery.deliveryId);
 assert.equal(receipt.unavailableRecipients?.length??0,0);
 return {messageId:receipt.messageId,deliveryId:delivery.deliveryId,agentId,state:delivery.state};
}

// The agreed stress population exists before navigation; setup uses the same canonical Queue API.
export async function seedQueuedLoadMessages(f,product,receipts=[]){
 assert.equal(product.agents.length,20);assert.equal(receipts.length,0);
 const agent=product.agents.at(-1),seen=new Set();
 for(let i=0;i<30;i++){
  const request={text:'#'+agent.handle+' Timed short message',recipients:[{agentId:agent.id,attachmentIds:[]}],idempotencyKey:randomUUID(),activeRunDelivery:'queue',engine:'codex',model:'fixture',effort:'medium'};
  const receipt=verifyQueuedLoadMessage(request,f.ok(await f.api('POST',product.prefix+'/conversations/'+product.chat.id+'/direct-messages',request)),product.agents);
  assert(!seen.has(receipt.deliveryId)&&!seen.has(receipt.messageId));seen.add(receipt.deliveryId);seen.add(receipt.messageId);receipts.push(receipt);
 }
 await assertQueuedLoadMessages(f,product,receipts);return receipts;
}

// Count alone cannot establish that the same queued tasks and targets survived.
export async function assertQueuedLoadMessages(f,product,receipts){
 const pending=f.ok(await f.api('GET',product.prefix+'/conversations/'+product.chat.id+'/queued-messages'));
 assert.equal(pending.length,receipts.length,receipts.length?'The canonical queued population must stay exact':'No disposable follow-up may remain for a later Run');
 const expected=new Map(receipts.map(receipt=>[receipt.deliveryId,receipt]));assert.equal(expected.size,receipts.length);
 assert.deepEqual(pending.map(item=>item.deliveryId).sort(),[...expected.keys()].sort(),'The exact retained queue IDs must survive');
 for(const item of pending){assert.equal(item.status,'queued');assert.equal(item.targetAgentId,expected.get(item.deliveryId).agentId);}
 return pending;
}

// Only cancel this disposable test's exact pending deliveries, after timing ends.
export async function cancelQueuedLoadMessages(f,product,receipts,remaining=[]){
 const retained=new Set(remaining.map(receipt=>receipt.deliveryId));
 assert.equal(new Set(receipts.map(receipt=>receipt.deliveryId)).size,receipts.length,'Cancel receipts must be distinct');
 assert(receipts.every(receipt=>!retained.has(receipt.deliveryId)),'A cell cannot cancel retained baseline receipts');
 const cancelled=[];
 for(const receipt of receipts){
  const result=f.ok(await f.api('POST',product.prefix+'/conversations/'+product.chat.id+'/queued-messages/'+receipt.deliveryId+'/cancel',{idempotencyKey:randomUUID()}));
  assert.equal(result.cancelled,true,'Disposable queued delivery must cancel before workload release');
  assert.equal(result.status,'cancelled');
  cancelled.push({deliveryId:receipt.deliveryId,...result});
 }
 await assertQueuedLoadMessages(f,product,remaining);
 return cancelled;
}
