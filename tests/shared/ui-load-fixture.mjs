// Owned qualification state only: normal settings, real resource observation and canonical seed/projection APIs.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {appendFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture,until} from './fixture.mjs';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {sampleLinuxResources,RESOURCE_ADMISSION_DEFAULTS} from '../../apps/server/dist/resource-admission.js';
export async function createLoadFixture(out,{messages=10000}={}){
 let store,closing=false,monitor;const work=new Map(),progress=new Map(),lastProgress=new Map(),continuityFailures=[],pending=new Set(),identities=new Map();
 const record=value=>appendFileSync(out+'/lifecycle.jsonl',JSON.stringify({time:Date.now(),...value})+'\n');
 const sample=await sampleLinuxResources();record({event:'preflight',sample,admissionDefaults:RESOURCE_ADMISSION_DEFAULTS});
 assert.ok(sample.availableBytes>=RESOURCE_ADMISSION_DEFAULTS.reserveBytes+20*RESOURCE_ADMISSION_DEFAULTS.startupBytes,'Real effective headroom must admit twenty, without a guard override');
 assert.ok(sample.memoryFullPercent<5&&sample.ioFullPercent<10,'No pressured preflight');
 // Passing {} selects createServer's actual default sampler; shared fixture's fixed sample is NOT used.
 const f=await fixture({resourceAdmissionObservation:{},schedulerMaxConcurrentRuns:20,storeFactory:dir=>(store=new AgentStore(dir))});
 const products={};
 try{
  for(const product of ['core','branches']){
   const prefix=product==='core'?'/api':'/api/branches/engine';
   const preferences=f.ok(await f.api('PATCH',prefix+'/workspace/preferences',{maxConcurrentAgentRuns:20}));
   assert.equal(preferences.maxConcurrentAgentRuns,20);record({event:'human-visible-concurrency',product,value:preferences.maxConcurrentAgentRuns});
   const branch=product==='branches'?f.ok(await f.api('POST','/api/branches',{name:'Load qualification',idempotencyKey:randomUUID()})):undefined;
   const chat=branch?f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Load qualification',defaultEngine:'codex'},{'idempotency-key':randomUUID()})):await f.createChat('Load qualification');
   const seed=seedQualificationHistory(store,chat,messages,()=>record({event:'seeding',product}));
   const agents=[];for(let i=0;i<20;i++)agents.push(f.ok(await f.api('POST',`${prefix}/projects/${chat.projectId}/agents`,{title:`Working ${i+1}`,engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()})));
   products[product]={prefix,branch,chat,agents,seed,route:branch?`/branches?branch=${branch.id}&tab=chats&chat=${chat.id}`:`/projects/${chat.projectId}/chats/${chat.id}`};
   record({event:'seed-verified',product,...products[product].seed});
  }
  async function snapshot(product){
   const p=products[product],runs=[];
   for(const agent of p.agents){const d=f.ok(await f.api('GET',`${p.prefix}/agents/${agent.id}`));const run=d.runs.find(r=>r.status==='running');runs.push({agentId:agent.id,canonicalRun:run??null,sessionId:f.sessions.get(agent.id)?.engineAgentId??null,progressAgeMs:Date.now()-(lastProgress.get(agent.id)??0),runId:run?.id,status:run?.status,progress:progress.get(agent.id)??0,alive:f.sessions.get(agent.id)?.isAlive()??false});}
   for(const run of runs){
    const key=`${product}/${run.agentId}`,identity=JSON.stringify([run.runId,run.sessionId]);
    if(identities.has(key)&&identities.get(key)!==identity)continuityFailures.push({agentId:run.agentId,reason:'Run/session identity changed'});
    identities.set(key,identity);
    if(run.status!=='running'||!run.alive||run.progressAgeMs>10000)continuityFailures.push({agentId:run.agentId,reason:'inactive or progress gap exceeds 10s',run});
   }
   const leases=runs.map(run=>{
    return readLeasedRun(store,run.agentId,run.runId,run.sessionId);
   });
   const sample=await sampleLinuxResources(),value={product,runs,leases,canonicalMessageCount:store.getConversationMessages(p.chat.id).length,sample,failures:f.failures?.map(String)??[]};record({event:'active-snapshot',...value});return value;
  }
  async function activate(product){
   const p=products[product];
   for(const agent of p.agents){progress.set(agent.id,0);work.set(agent.id,true);f.plans.set(agent.id,[{output:false,run:async session=>{
    while(!closing&&work.get(agent.id)&&session.isAlive()){
     const result=await session.tool('ponderosa_workspace_projects',{});assert.equal(result.success,true,result.text);
     const detail=f.ok(await f.api('GET',`${p.prefix}/agents/${agent.id}`)),run=detail.runs.find(r=>r.status==='running');assert.ok(run,'Each progress tick requires its canonical running Run');
     const n=(progress.get(agent.id)??0)+1;progress.set(agent.id,n);lastProgress.set(agent.id,Date.now());session.events.push({type:'text',delta:`Working checkpoint ${n}. `});record({event:'provider-work',product,agentId:agent.id,sessionId:session.engineAgentId,sequence:n,runId:run.id,runStatus:run.status,processIdentity:session.processIdentity,tool:'ponderosa_workspace_projects',success:result.success});
     await delay(2000);
    }
   }}]);await sendQualificationTask(f,p.prefix,agent.id,'Continuously inspect granted workspace status and report short progress until qualification ends.',attempt=>record({event:'keyed-task-submission',agentId:agent.id,...attempt}));}
   await until(()=>p.agents.every(a=>(progress.get(a.id)??0)>=2),'twenty working provider loops',60000);
   const value=await snapshot(product);assert.equal(value.runs.filter(r=>r.status==='running'&&r.alive&&r.progress>=2).length,20);monitor=setInterval(()=>{const task=snapshot(product).catch(error=>{continuityFailures.push({reason:String(error)});record({event:'monitor-failed',error:String(error)});});pending.add(task);task.finally(()=>pending.delete(task));},1000);
   return value;
  }
  async function deactivate(product){
   clearInterval(monitor);await Promise.all(pending);
   for(const agent of products[product].agents)work.set(agent.id,false);
   await until(async()=>{for(const a of products[product].agents){const d=f.ok(await f.api('GET',`${products[product].prefix}/agents/${a.id}`));if(d.runs.some(r=>['running','preparing'].includes(r.status)))return false;}return true;},'controlled work completes',30000);
   for(const agent of products[product].agents)await f.sessions.get(agent.id)?.close();
   record({event:'deactivated',product});
  }
  writeFileSync(out+'/seed.json',JSON.stringify({root:f.root,products},null,2));
  return {f,products,activate,deactivate,snapshot,assertContinuity(){assert.deepEqual(continuityFailures,[],'Per-Agent continuity failure; no active-work credit');},async close(){closing=true;clearInterval(monitor);await Promise.all(pending);record({event:'closing'});await f.dispose(false);record({event:'fixture-closed-owned-roots-observed-exited'});}};
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
 return {messages,orderedTextSha256:hash,firstId:rows[0].id,lastId:rows.at(-1).id,lastText:rows.at(-1).text};
}
export function readLeasedRun(store,agentId,runId,sessionId){
 const lease=store.sqlite.prepare('SELECT id,agent_id,status,lease_owner,lease_expires_at,fencing_token,provider_session_id,heartbeat_at,scope_key FROM scheduler_runs WHERE id=?').get(runId);
 assert(lease&&lease.agent_id===agentId&&lease.status==='running'&&lease.lease_owner&&lease.fencing_token>0&&Date.parse(lease.lease_expires_at)>Date.now(),'Canonical scheduler lease must be live and fenced');
 assert.equal(lease.provider_session_id,sessionId,'Provider session must belong to exact scheduler Run');return lease;
}

export async function sendQualificationTask(f,prefix,agentId,text,onAttempt=()=>{}){
 const idempotencyKey=randomUUID();
 for(let attempt=0;attempt<30;attempt++){
  const response=await f.api('POST',`${prefix}/agents/${agentId}/messages`,{text,idempotencyKey});onAttempt({attempt,idempotencyKey,status:response.statusCode,body:response.json()});
  if(response.statusCode!==409||response.json().error!=='Agent asset maintenance is in progress; retry safely')return f.ok(response);
  await delay(100);
 }
 throw Error('Agent asset maintenance did not settle; no guard bypass');
}
