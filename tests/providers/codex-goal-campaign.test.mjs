import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {withFixture,until} from '../shared/fixture.mjs';
import {inertCodexGoal} from '../shared/inert-codex-goal.mjs';

async function acceptedSession(f,store,native){
 const chat=await f.createChat('Native goal campaign'),agent=await f.createIdleAgent(chat,'Goal worker');
 store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
 await f.send(agent.id,'Establish the original accepted context.');
 await until(async()=>(await native.requests()).some(row=>row.method==='turn/start'),'ordinary native turn');
 await native.control('reply',{text:'Original context established.'});await f.settled(agent.id);
 const accepted=store.resumeSessionState(agent.id);assert.equal(accepted.sessionId,native.threadId);
 return agent;
}
const runs=(store,id)=>store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE agent_id=? ORDER BY created_at,id').all(id);
async function startCampaign(f,store,native,agent){
 const before=new Set(runs(store,agent.id).map(row=>row.id));
 const sent=await f.send(agent.id,'/goal-resume');
 const mutation=await until(async()=>(await native.requests()).find(row=>row.method==='thread/goal/set'&&row.params.status==='active'),'owned native goal resume',15000);
 const run=await until(()=>runs(store,agent.id).find(row=>!before.has(row.id)),'canonical goal Run');
 assert.equal(mutation.params.threadId,native.threadId);assert.equal(mutation.params.origin,'user');
 assert.equal(runs(store,agent.id).filter(row=>!before.has(row.id)).length,1);
 return {run,mutation,sent,before};
}
async function observedText(store,id,text){
 await until(()=>store.readEvents(id).some(row=>row.event.type==='text'&&row.event.delta?.includes(text)),'persisted native Worklog '+text);
}
test('inert native goal fixture establishes a real accepted session and canonical reply',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const agent=await acceptedSession(f,store,native);
  const calls=await native.requests();
  assert.equal(calls.filter(row=>row.toolResponse?.result?.success===true).length,1);
  assert.equal(calls.filter(row=>row.method==='thread/goal/set').length,0);
  assert.equal(runs(store,agent.id).length,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodexGoal(root)).adapter});
});
test('native Codex goal owns one scheduler Run across two turns and both completion boundaries',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const agent=await acceptedSession(f,store,native),{run,before}=await startCampaign(f,store,native,agent);
  const reads=(await native.requests()).filter(row=>row.method==='thread/goal/get').length;
  await native.control('complete',{text:'First goal cycle complete; objective remains active.'});
  await until(async()=>(await native.requests()).filter(row=>row.method==='thread/goal/get').length>reads,'host observed first native completion');
  await delay(100);
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run.id).status,'running','active native goal retains the same Run between turns');
  await native.control('next');await native.control('text',{text:'Second goal cycle is owned.'});await observedText(store,agent.id,'Second goal cycle is owned.');
  assert.equal(runs(store,agent.id).filter(row=>!before.has(row.id)).length,1,'native cycles do not create separate scheduler Runs');
  await native.control('goal',{status:'complete'});
  await native.control('text',{text:'Terminal goal observed, native turn still active.'});await observedText(store,agent.id,'Terminal goal observed, native turn still active.');
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run.id).status,'running','goal completion alone cannot settle an active native turn');
  await native.control('reply',{text:'Original goal completed exactly once.'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(run.id),'goal and final native turn complete');
  const calls=await native.requests();
  assert.equal(calls.filter(row=>row.method==='thread/goal/set'&&row.params.status==='active').length,1);
  assert.equal(calls.filter(row=>row.method==='turn/start').length,1,'only warmup uses explicit native turn/start');
  assert.equal(calls.filter(row=>row.notification==='turn/started'&&row.params.turn.id.startsWith('goal-')).length,2);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_run_activations WHERE run_id=?').get(run.id).n,1);
  assert.equal((await native.state()).goal.objective,'Preserve the entire original goal objective.');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodexGoal(root)).adapter});
});
test('user Stop pauses an owned native Codex goal once before process drain',{timeout:60000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const agent=await acceptedSession(f,store,native),{run,mutation}=await startCampaign(f,store,native,agent);
  f.ok(await f.api('POST','/api/agents/'+agent.id+'/cancel',{targetRunId:run.id,idempotencyKey:randomUUID()}));
  const rows=await until(async()=>{const list=await native.requests();return list.some(row=>row.pid===mutation.pid&&row.processExited)?list:undefined;},'owned native process exit');
  const pause=rows.findIndex(row=>row.pid===mutation.pid&&row.method==='thread/goal/set'&&row.params.status==='paused');
  const exit=rows.findIndex(row=>row.pid===mutation.pid&&row.processExited);
  assert.ok(pause>=0&&exit>pause,'goal pause is attempted before process exit');
  assert.equal(rows.filter(row=>row.pid===mutation.pid&&row.method==='thread/goal/set'&&row.params.status==='paused').length,1);
  assert.equal((await native.state()).goal.status,'paused');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='cancelled'").get(run.id),'canonical cancelled Run');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodexGoal(root)).adapter});
});
test('lost native goal-resume acknowledgement stays unreplayed across physical store reopen',{timeout:60000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const agent=await acceptedSession(f,store,native);
  const old=runs(store,agent.id).map(row=>row.id);
  await f.send(agent.id,'/goal-resume');
  await until(async()=>(await native.requests()).some(row=>row.lostGoalAcknowledgement),'lost native mutation acknowledgement');
  const unknown=await until(()=>runs(store,agent.id).find(row=>!old.includes(row.id)&&!['running','preparing'].includes(row.status)),'durable unconfirmed goal result');
  assert.notEqual(unknown.status,'completed');assert.equal((await native.state()).goal.status,'active','the provider applied the mutation before losing its acknowledgement');
  await f.reopen();await delay(300);
  assert.equal((await native.requests()).filter(row=>row.method==='thread/goal/set'&&row.params.status==='active').length,1,'restart must not repeat uncertain native work');
  assert.equal((await native.requests()).some(row=>row.notification==='turn/started'&&row.params.turn.id.startsWith('unowned-resumed-goal')),false);
  assert.equal(runs(store,agent.id).find(row=>row.id===unknown.id).status,unknown.status);
  assert.equal(runs(store,agent.id).filter(row=>!old.includes(row.id)).length,1,'restart does not allocate a replacement goal Run');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodexGoal(root,{dropResumeAcknowledgement:true})).adapter});
});
