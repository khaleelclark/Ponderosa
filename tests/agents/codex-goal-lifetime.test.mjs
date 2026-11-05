import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CodexAdapter} from '../../packages/engines/dist/index.js';

async function fixture(t, mode, resume = false) {
 const root=await mkdtemp(path.join(tmpdir(),'codex-owned-goal-'));
 const bin=path.join(root,'codex-fixture'),log=path.join(root,'calls');
 const program=`
const fs=require('node:fs'),readline=require('node:readline');
const mode=${JSON.stringify(mode)},log=${JSON.stringify(log)};
let status=['resume','pause','lost'].includes(mode)?'paused':mode==='active-before-resume'?'active':null, reads=0, budget=null;
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const goal=()=>status===null?null:{threadId:'thread',objective:'Saved objective',status,tokenBudget:budget,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:2};
const note=(turnId=null)=>emit({method:'thread/goal/updated',params:{threadId:'thread',turnId,goal:goal()}});
const started=id=>emit({method:'turn/started',params:{threadId:'thread',turn:{id}}});
const finished=id=>emit({method:'turn/completed',params:{threadId:'thread',turn:{id,status:'completed'}}});
const usage=id=>emit({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:id,tokenUsage:{last:{inputTokens:10,outputTokens:2,totalTokens:12},modelContextWindow:1000}}});

readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method||m.id===undefined)return;
 fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 if(m.method==='initialize'){emit({id:m.id,result:{userAgent:'codex/0.159.2'}});return;}
 if(m.method==='thread/goal/get'){
   if(mode==='unsupported'){emit({id:m.id,error:{code:-32601,message:'Method not found'}});return;}
   if(mode==='disabled'){emit({id:m.id,error:{code:-32600,message:'goals feature is disabled'}});return;}
   if(mode==='malformed'){emit({id:m.id,result:{}});return;}
   reads++;emit({id:m.id,result:{goal:goal()}});
   if(['auto','usage-full','usage-partial'].includes(mode)&&status==='active'){setTimeout(()=>{started('two');if(mode.startsWith('usage-'))usage('two');status='complete';note('two');finished('two');},20);}
   return;
 }
 if(m.method==='thread/goal/set'){
   if(mode==='lost'||mode==='lost-create'){process.exit(0);return;}
   if(Object.hasOwn(m.params,'tokenBudget'))budget=m.params.tokenBudget;
   status=m.params.status;emit({id:m.id,result:{goal:goal()}});note();
   if(status==='active'){setTimeout(()=>{started('goal-turn');if(mode==='resume'||mode==='create'){status='complete';note('goal-turn');finished('goal-turn');}},10);}
   else if(mode==='pause')setTimeout(()=>finished('goal-turn'),10);
   return;
 }
 if(m.method==='thread/start'||m.method==='thread/resume'){emit({id:m.id,result:{thread:{id:'thread'},model:'fixture'}});return;}
 if(m.method==='turn/start'){
   emit({id:m.id,result:{turn:{id:'one'}}});started('one');
   if(['auto','fast','foreign-terminal','usage-full','usage-partial'].includes(mode)){status='active';note();}
   if(mode==='usage-full')usage('one');
   if(mode==='foreign-terminal'){status='complete';note('different-turn');}
   finished('one');
   if(mode==='fast'){started('two');status='complete';note('two');finished('two');}
   return;
 }
 emit({id:m.id,result:{}});
});
`;
 await writeFile(bin,'#!'+process.execPath+'\n'+program);await chmod(bin,0o700);
 const adapter=new CodexAdapter({bin,killGraceMs:100});
 let session;
 t.after(async()=>{await session?.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 const open=async()=>session=await adapter.openSession({cwd:root,agentId:'synthetic',...(resume?{resumeSessionId:'thread'}:{}),history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){},onRuntimeRootExit(){}});
 const calls=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
 return {open,calls};
}
const input={prompt:'An ordinary task',kind:'collaboration',assertCurrent(){}};
const resumeInput={...input,nativeAction:{kind:'goal-resume'}};
async function terminal(events) {
 const values=[];
 await Promise.race([(async()=>{for await(const value of events){values.push(value);if(value.type==='turn_done'||value.type==='error')return;}})(),new Promise((_,reject)=>setTimeout(()=>reject(Error('goal event timed out')),5000))]);
 return values;
}
test('auto-created native goal holds first completed turn through the exact subsequent turn', {timeout:12000},async t=>{
 const f=await fixture(t,'auto'),session=await f.open();
 await session.startTurn(input);const events=await terminal(session.events);
 assert.equal(events.filter(e=>e.type==='turn_done').length,1);
 assert.ok(events.some(e=>e.type==='work_item_update'&&e.workItemId==='native-goal:thread'&&e.status==='running'));
 assert.ok(events.some(e=>e.type==='work_item_update'&&e.status==='done'&&e.title==='Native goal: complete'));
 assert.ok((await f.calls()).filter(c=>c.method==='thread/goal/get').length>=2);
});
test('buffered goal continuation completion cannot release the prior turn early', {timeout:12000},async t=>{
 const f=await fixture(t,'fast'),session=await f.open();
 await session.startTurn(input);const events=await terminal(session.events);
 assert.equal(events.filter(e=>e.type==='turn_done').length,1);
 assert.ok(events.some(e=>e.type==='work_item_update'&&e.status==='done'&&e.title==='Native goal: complete'));
 assert.equal((await f.calls()).filter(c=>c.method==='thread/goal/get').length,2,'both exact turns were observed');
});
test('a terminal receipt for a different turn cannot settle the owned goal',{timeout:12000},async t=>{
 const f=await fixture(t,'foreign-terminal'),session=await f.open();
 await session.startTurn(input);let settled=false;
 const result=terminal(session.events).then(events=>{settled=true;return events;});
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(settled,false,'unmatched completion must remain held');
 await session.close();const events=await result;
 assert.equal(events.some(e=>e.type==='turn_done'),false);
 assert.equal(events.at(-1).terminalStatus,'unknown');
});
for(const mode of ['unsupported','disabled'])test(`explicit ${mode} goal protocol preserves ordinary saved-session work`,{timeout:12000},async t=>{
 const f=await fixture(t,mode,true),session=await f.open();
 await session.startTurn(input);const events=await terminal(session.events);
 assert.equal(events.at(-1).type,'turn_done');
 assert.equal((await f.calls()).filter(c=>c.method==='thread/resume').length,1);
});
test('malformed native goal state is held before saved-session resume',{timeout:12000},async t=>{
 const f=await fixture(t,'malformed',true);
 await assert.rejects(f.open(),/goal state is malformed/);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/resume').length,0);
});
test('saved active goal is held before native thread resume', {timeout:12000},async t=>{
 const f=await fixture(t,'active-before-resume',true);
 await assert.rejects(f.open(),/active native goal/);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/resume').length,0);
});
test('paused native goal resumes once and finishes after an actual turn', {timeout:12000},async t=>{
 const f=await fixture(t,'resume',true),session=await f.open();
 await session.startNativeGoal(resumeInput);const events=await terminal(session.events);
 assert.equal(events.filter(e=>e.type==='turn_done').length,1);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/goal/set'&&c.params.status==='active').length,1);
});
test('goal creation sends one exact human objective and budget', {timeout:12000},async t=>{
 const f=await fixture(t,'create'),session=await f.open();
 await session.startNativeGoal({...input,nativeAction:{kind:'goal-create',objective:'  Saved objective  ',tokenBudget:500}});
 const events=await terminal(session.events);assert.equal(events.at(-1).type,'turn_done');
 const mutations=(await f.calls()).filter(c=>c.method==='thread/goal/set');
 assert.equal(mutations.length,1);assert.deepEqual(mutations[0].params,{threadId:'thread',status:'active',origin:'user',objective:'  Saved objective  ',tokenBudget:500});
});
test('creation cannot overwrite a prior native goal', {timeout:12000},async t=>{
 const f=await fixture(t,'resume',true),session=await f.open();
 await assert.rejects(session.startNativeGoal({...input,nativeAction:{kind:'goal-create',objective:'Saved objective'}}),/existing.*goal/);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/goal/set').length,0);
});
test('lost creation acknowledgement is unknown and never repeated', {timeout:12000},async t=>{
 const f=await fixture(t,'lost-create'),session=await f.open();
 await assert.rejects(session.startNativeGoal({...input,nativeAction:{kind:'goal-create',objective:'Saved objective'}}),/outcome is unknown/);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/goal/set').length,1);
});
test('lost native activation response is unknown and is never retried', {timeout:12000},async t=>{
 const f=await fixture(t,'lost',true),session=await f.open();
 await assert.rejects(session.startNativeGoal(resumeInput),/outcome is unknown/);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/goal/set').length,1);
});
test('native pause is issued once and a paused goal is not reported as successful', {timeout:12000},async t=>{
 const f=await fixture(t,'pause',true),session=await f.open();
 await session.startNativeGoal(resumeInput);
 const result=terminal(session.events);await new Promise(resolve=>setTimeout(resolve,80));await session.pauseNativeGoal();
 const events=await result;assert.equal(events.at(-1).type,'error');assert.match(events.at(-1).message,/paused/);
 await assert.rejects(session.pauseNativeGoal(),/already attempted|No native goal/);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/goal/set'&&c.params.status==='paused').length,1);
});


test('goal activation rejects missing or unrelated native actions before mutation', {timeout:12000},async t=>{
 const f=await fixture(t,'resume',true),session=await f.open();
 await assert.rejects(session.startNativeGoal(input),/exact native goal action/);
 await assert.rejects(session.startNativeGoal({...input,nativeAction:{kind:'review',target:{type:'uncommittedChanges'}}}),/exact native goal action/);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/goal/set').length,0);
});


for(const [mode,expectUsage] of [['usage-full',true],['usage-partial',false]])test(`goal usage is ${expectUsage?'complete':'unavailable when a turn is missing'}`,{timeout:12000},async t=>{
 const f=await fixture(t,mode),session=await f.open();
 await session.startTurn(input);const events=await terminal(session.events);
 const done=events.find(event=>event.type==='turn_done');assert.ok(done);
 if(expectUsage){
  assert.deepEqual(done.usage,{inputTokens:20,outputTokens:4,totalTokens:24});
  assert.equal(done.providerRequestUsage.length,2);
 }else{
  assert.equal(done.usage,undefined);
  assert.equal(done.providerRequestUsage,undefined);
 }
});
