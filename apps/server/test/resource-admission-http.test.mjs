import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore,CoordinationV3Store} from '@ponderosa/agents';
import {createServer} from '../dist/app.js';

test('production HTTP/scheduler admission retains exact accepted work across a resource hold and complete app reopening', {skip:process.platform!=='linux',timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'resource-http-'));
 let store=new AgentStore(root),app,starts=0;
 const adapter={id:'codex',displayName:'Disposable',trustedSystemPromptChannel:'developer',listModels:()=>[],listEfforts:()=>[],seed:async function*(){starts++;yield{type:'turn_done'};},continue:async function*(){starts++;yield{type:'turn_done'};}};
 const open=async reserveBytes=>{app=createServer({dataDir:root,store,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,resourceAdmission:{reserveBytes,startupBytes:1024**2},communicationV3:{pollMs:20}});await app.ready();};
 const close=async()=>{app.prepareForShutdown();await app.close();store.close();};
 const wait=async(predicate)=>{for(let i=0;i<100;i++){if(await predicate())return;await delay(50);}throw Error('expected resource/scheduler transition was not observed');};
 try{
  const project=store.createProject({label:'Disposable',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Disposable'});
  // Deliberately unattainable configured reserve establishes a real measured
  // hold without creating pressure on a shared host. Memory pressure/recovery
  // itself is separately qualified in a private bounded Linux cgroup.
  await open(1024**4);
  await wait(async()=> (await app.inject('/api/engines')).json()[0].resourceAdmission?.state==='held');
  const text='Exact original opening message; do not prepend anything.';
  const accepted=await app.inject({method:'POST',url:`/api/projects/${project.id}/agents`,payload:{title:'Pending',engine:'codex',conversationId:chat.id,initialMessage:text,idempotencyKey:'exact-opening'}});
  assert.equal(accepted.statusCode,200,accepted.body);const agent=accepted.json();
  await delay(200);assert.equal(starts,0);assert.equal(new CoordinationV3Store(store.sqlite).activeRunCount(),0);
  const before=store.sqlite.prepare('SELECT id,state,delivery_failures,payload_json FROM agent_activations WHERE agent_id=?').all(agent.id);
  assert.ok(before.length);assert.ok(before.every(row=>row.state==='pending'&&row.delivery_failures===0));
  await close();store=new AgentStore(root);await open(1024**2);
  await wait(()=>starts===1);
  const after=store.sqlite.prepare('SELECT id,delivery_failures,payload_json FROM agent_activations WHERE agent_id=?').all(agent.id);
  assert.deepEqual(after.map(row=>({id:row.id,payload:row.payload_json})),before.map(row=>({id:row.id,payload:row.payload_json})));assert.ok(after.every(row=>row.delivery_failures===0));
 }finally{if(app)await close();await rm(root,{recursive:true,force:true});}
});
