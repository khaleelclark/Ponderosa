import '../shared/workspace-resolution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentStore,CoordinationV3Store} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {withFixture,until} from '../shared/fixture.mjs';

async function assistant(f){return f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app;}
async function run(f,store,agent,work){
 let done=false,result,error;const before=store.sqlite.prepare('SELECT count(*) n FROM runs WHERE agent_id=?').get(agent.agentId??agent.id).n;
 const id=agent.agentId??agent.id,chatId=agent.chatId??agent.conversationId,projectId=agent.projectId;
 f.plans.set(id,[{output:false,run:async session=>{try{result=await work(session);}catch(e){error=e;}finally{done=true;}}}]);
 new CoordinationV3Store(store.sqlite).enqueueMessageActivation({projectId,agentId:id,scopeKey:`conversation:${chatId}`,messageId:randomUUID(),kind:'ordinary',payload:{text:'Execute the explicit controlled workspace tool check.'}});
 await until(()=>done,'workspace tool execution',20000);
 await until(()=>store.sqlite.prepare("SELECT count(*) n FROM runs WHERE agent_id=? AND status IN ('completed','failed','cancelled')").get(id).n>before,'settled workspace Run',20000);
 if(error)throw error;return result;
}
async function restrict(f,path,ids){const current=f.ok(await f.api('GET',path));return f.ok(await f.api('PUT',path,{revision:current.policy.revision,restrictedCapabilityIds:ids}));}
const options={timeout:60000};

test('Assistant creates Chat and starts cross-project work with exact durable source provenance, replay and conflict checks',options,t=>{
 let store;return withFixture(t,async f=>{
  const app=await assistant(f),key=randomUUID();let created,started;
  await run(f,store,app,async session=>{
   created=f.ok(await f.tool(session,'ponderosa_workspace_create_chat',{label:'Requested work',engine:'codex',idempotencyKey:key}));
   const replay=f.ok(await f.tool(session,'ponderosa_workspace_create_chat',{label:'Requested work',engine:'codex',idempotencyKey:key}));assert.equal(replay.chat.id,created.chat.id);assert.equal(replay.replayed,true);
   assert.equal((await f.tool(session,'ponderosa_workspace_create_chat',{label:'Changed',engine:'codex',idempotencyKey:key})).status,409);
   const recovering=randomUUID();store.sqlite.exec("CREATE TEMP TRIGGER interrupt_chat_receipt BEFORE UPDATE ON workspace_agent_actions BEGIN SELECT RAISE(ABORT,'Controlled receipt interruption'); END");
   assert.equal((await f.tool(session,'ponderosa_workspace_create_chat',{label:'Recover original Chat',engine:'codex',idempotencyKey:recovering})).status,409);
   store.sqlite.exec('DROP TRIGGER interrupt_chat_receipt');
   const pending=store.sqlite.prepare("SELECT * FROM workspace_agent_actions WHERE idempotency_key=?").get(recovering);assert.equal(JSON.parse(pending.result_json).pending,true);
   const recovered=f.ok(await f.tool(session,'ponderosa_workspace_create_chat',{label:'Recover original Chat',engine:'codex',idempotencyKey:recovering}));assert.equal(recovered.sourceRunId,pending.source_run_id);assert.equal(recovered.chat.title,'Recover original Chat');

   started=f.ok(await f.tool(session,'ponderosa_workspace_start_work',{chatId:created.chat.id,title:'Worker',engine:'codex',text:'Build the requested report',idempotencyKey:key}));
   const again=f.ok(await f.tool(session,'ponderosa_workspace_start_work',{chatId:created.chat.id,title:'Worker',engine:'codex',text:'Build the requested report',idempotencyKey:key}));assert.equal(again.agentId,started.agentId);assert.equal(again.replayed,true);
  });
  assert.notEqual(created.chat.projectId,app.projectId);const target=store.getAgent(started.agentId);assert.equal(target.conversationId,created.chat.id);assert.equal(target.spawnedByAgentId,app.agentId);assert.equal(target.spawnedByExecutionId,started.sourceRunId);
  const row=store.sqlite.prepare('SELECT * FROM workspace_agent_actions WHERE id=?').get(started.actionId);assert.equal(row.source_agent_id,app.agentId);assert.equal(row.source_run_id,started.sourceRunId);
  const communication=JSON.parse(store.sqlite.prepare('SELECT payload_json FROM runtime_communications WHERE id=?').get(started.communicationId).payload_json);
  assert.equal(communication.communication.sender.kind,'system');assert.equal(communication.communication.sender.component,'workspace-relay');assert.deepEqual(communication.workspaceOrigin,{agentId:app.agentId,runId:started.sourceRunId,actionId:started.actionId});
  assert.equal(new CoordinationV3Store(store.sqlite).getRequest(started.requestId).recipientAgentId,started.agentId);
  assert.equal(communication.communication.projectId,created.chat.projectId);assert.equal(communication.communication.text,'Build the requested report');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM agents WHERE spawned_by_agent_id=?').get(app.agentId).n,1);
  await until(()=>f.turns.some(turn=>turn.agentId===started.agentId),'target provider receives work');
  assert.ok(JSON.stringify(f.turns.find(turn=>turn.agentId===started.agentId)).includes('Build the requested report'));
  await f.reopen();assert.equal(store.sqlite.prepare('SELECT source_agent_id FROM workspace_agent_actions WHERE id=?').get(started.actionId).source_agent_id,app.agentId);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('human source and destination grants deny workspace reads and writes, including live revocation',options,t=>{
 let store;return withFixture(t,async f=>{
  const app=await assistant(f),chat=await f.createChat('Restricted Project'),target=await f.createIdleAgent(chat,'Existing Worker');
  const source=`/api/branches/${app.branchId}/agents/${app.agentId}/capabilities`,dest=`/api/conversations/${chat.id}/capabilities`;
  await restrict(f,dest,[CAPABILITY_IDS.workspaceRead,CAPABILITY_IDS.workspaceStartWork]);
  await run(f,store,app,async session=>{
   const list=f.ok(await f.tool(session,'ponderosa_workspace_projects',{}));assert.equal(list.items.some(item=>item.id===chat.id),false);
   assert.equal((await f.tool(session,'ponderosa_workspace_start_work',{chatId:chat.id,agentId:target.id,text:'Do not run',idempotencyKey:randomUUID()})).status,403);
   await restrict(f,source,[CAPABILITY_IDS.workspaceCreateChat]);
   assert.equal((await f.tool(session,'ponderosa_workspace_create_chat',{label:'Denied',engine:'codex',idempotencyKey:randomUUID()})).status,403);
   await restrict(f,source,[CAPABILITY_IDS.workspaceRead,CAPABILITY_IDS.workspaceStartWork]);
   assert.equal((await f.tool(session,'ponderosa_workspace_projects',{})).status,403);
   assert.equal((await f.tool(session,'ponderosa_workspace_start_work',{chatId:chat.id,agentId:target.id,text:'Still denied',idempotencyKey:randomUUID()})).status,403);
  });
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM workspace_agent_actions').get().n,0);assert.equal(f.turns.some(turn=>turn.agentId===target.id),false);
  await restrict(f,source,[]);await restrict(f,dest,[]);
  f.plans.set(target.id,[{output:false,run:async worker=>{f.ok(await f.tool(worker,'ponderosa_update_request',{kind:'completed',text:'The explicitly allowed cross-project task finished'}));}}]);
  let accepted;
  await run(f,store,app,async session=>{assert.ok(f.ok(await f.tool(session,'ponderosa_workspace_projects',{})).items.some(item=>item.id===chat.id));accepted=f.ok(await f.tool(session,'ponderosa_workspace_start_work',{chatId:chat.id,agentId:target.id,text:'Explicitly allowed now',idempotencyKey:randomUUID()}));});
  await until(()=>new CoordinationV3Store(store.sqlite).getRequest(accepted.requestId)?.state==='completed','granted target completes the exact created work');
  const acceptedKey=store.sqlite.prepare('SELECT idempotency_key key FROM workspace_agent_actions WHERE id=?').get(accepted.actionId).key;
  await restrict(f,dest,[CAPABILITY_IDS.workspaceStartWork]);
  await run(f,store,app,async session=>{assert.equal((await f.tool(session,'ponderosa_workspace_start_work',{chatId:chat.id,agentId:target.id,text:'Explicitly allowed now',idempotencyKey:acceptedKey})).status,403,'replay also rechecks destination permission');});
  await restrict(f,dest,[]);
  await run(f,store,app,async session=>{const digest=f.ok(await f.tool(session,'ponderosa_assistant_check',{}));assert.equal(digest.published,true);assert.ok(digest.sources.some(key=>key.startsWith('request:'+accepted.requestId+':')));});
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

for(const enabled of [false,true,'muted','attention'])test(`Assistant check aggregates completion and planted issue, persists dedup and respects notifications=${enabled}`,options,t=>{
 let store;return withFixture(t,async f=>{
  const app=await assistant(f),chat=await f.createChat('Launch'),completed=await f.createIdleAgent(chat,'Delivery'),broken=await f.createIdleAgent(chat,'Inspection');
  f.ok(await f.api('PATCH','/api/workspace/preferences',{notifications:{directResponses:enabled!==false,broadcasts:false}}));
  const alerts=enabled===true;
  if(typeof enabled==='string')f.ok(await f.api('PUT',`/api/branches/engine/notification-settings/agent/${app.agentId}`,{mode:enabled}));
  // These are real tracked task outcomes, not fabricated successful Run statuses.
  const coordination=new CoordinationV3Store(store.sqlite);
  f.plans.set(completed.id,[{output:false,run:async s=>{f.ok(await f.tool(s,'ponderosa_update_request',{kind:'completed',text:'Report delivered and verified'}));}}]);
  f.plans.set(broken.id,[{output:false,run:async s=>{f.ok(await f.tool(s,'ponderosa_update_request',{kind:'failed',text:'Planted issue: release checklist is missing'}));}}]);
  const receipts=coordination.coordinate({projectId:chat.projectId,conversationId:chat.id,actorScope:'user:local-operator',idempotencyKey:randomUUID(),requests:[{recipientAgentId:completed.id,payload:{text:'Deliver report'},lifetime:{kind:'indefinite'}},{recipientAgentId:broken.id,payload:{text:'Inspect release'},lifetime:{kind:'indefinite'}}]});
  await until(()=>receipts.requestIds.every(id=>['completed','failed'].includes(coordination.getRequest(id)?.state)),'real terminal task outcomes');
  const colleague=f.ok(await f.api('POST',`/api/branches/engine/projects/${app.projectId}/agents`,{title:'Same Project colleague',engine:'codex',conversationId:app.chatId,idempotencyKey:randomUUID()}));
  f.plans.set(colleague.id,[{output:false,run:async s=>{f.ok(await f.tool(s,'ponderosa_update_request',{kind:'completed',text:'Same Project work is also finished'}));}}]);
  const own=coordination.coordinate({projectId:app.projectId,conversationId:app.chatId,actorScope:'user:local-operator',idempotencyKey:randomUUID(),requests:[{recipientAgentId:colleague.id,payload:{text:'Finish local work'},lifetime:{kind:'indefinite'}}]});
  await until(()=>coordination.getRequest(own.requestIds[0])?.state==='completed','same-Project colleague result');

  let digest;f.plans.set(app.agentId,[{output:false,run:async s=>{
   digest=f.ok(await f.tool(s,'ponderosa_assistant_check',{}));assert.equal(digest.published,true);
   f.plans.set(completed.id,[{output:false,run:async worker=>{f.ok(await f.tool(worker,'ponderosa_update_request',{kind:'completed',text:'Additional work finished after the digest'}));}}]);
   const extra=coordination.coordinate({projectId:chat.projectId,conversationId:chat.id,actorScope:'user:local-operator',idempotencyKey:randomUUID(),requests:[{recipientAgentId:completed.id,payload:{text:'Follow-up task'},lifetime:{kind:'indefinite'}}]});
   await until(()=>coordination.getRequest(extra.requestIds[0])?.state==='completed','new activity after digest');
   // Source-time regressions cannot reorder the monotonic observation index.
   store.sqlite.prepare("UPDATE assistant_status_sources SET observed_at='1900-01-01T00:00:00.000Z' WHERE source_id=?").run(extra.requestIds[0]);
   for(let i=0;i<30;i++)assert.equal(f.ok(await f.tool(s,'ponderosa_assistant_check',{})).published,false);
   f.ok(await f.tool(s,'ponderosa_update_request',{kind:'completed',text:'Scheduled check finished.'}));
  }}]);
  const {BranchStore}=await import('@ponderosa/agents'),branches=new BranchStore(store.sqlite,coordination),trigger=branches.trigger(app.branchId);
  branches.triggers.updateTriggerDefinition(trigger.id,{nextFireAt:new Date(Date.now()-1).toISOString()});
  await until(()=>digest,'automatic scheduled digest',20000);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM branch_executions WHERE branch_id=? AND state='completed'").get(app.branchId),'scheduled report execution completes',20000);
  const report=JSON.parse(store.sqlite.prepare('SELECT payload_json FROM runtime_communications WHERE id=?').get(digest.communicationId).payload_json);
  assert.match(report.communication.text,/Completed.*Report delivered and verified/s);assert.match(report.communication.text,/Issue.*Planted issue: release checklist is missing/s);assert.equal(report.assistantSources.length,3);assert.match(report.communication.text,/Same Project work is also finished/);
  const notices=f.ok(await f.api('GET','/api/branches/engine/notifications')).items.filter(n=>n.communicationEventId===digest.communicationId);assert.equal(notices.length,alerts?1:0);
  const projection=f.ok(await f.api('POST','/api/branches/engine/notifications/projection',{projectIds:[app.projectId],conversationIds:[app.chatId]}));assert.equal(projection.conversations[app.chatId].quietUnreadCount??0,alerts?0:1,'quiet unread activity is preserved without alert tags');

  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM assistant_report_sources WHERE speaker_agent_id=?').get(app.agentId).n,3);
  f.ok(await f.api('POST','/api/branches/engine/notifications/read-visible',{communicationEventIds:[digest.communicationId]}));
  const read=f.ok(await f.api('POST','/api/branches/engine/notifications/projection',{projectIds:[app.projectId],conversationIds:[app.chatId]}));assert.equal(read.conversations[app.chatId].quietUnreadCount??0,0);assert.equal(read.conversations[app.chatId].totalCount,0);
  // Interval elapsed/restart: source receipts still prevent the same report.
  store.sqlite.prepare("UPDATE assistant_report_sources SET reported_at='2000-01-01T00:00:00.000Z'").run();await f.reopen();
  await run(f,store,app,async s=>{const next=f.ok(await f.tool(s,'ponderosa_assistant_check',{}));assert.equal(next.published,true);assert.equal(next.sources.length,1,'only the deferred new task is reported after restart');assert.equal(f.ok(await f.tool(s,'ponderosa_assistant_check',{})).published,false);});
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM runtime_communications WHERE json_extract(payload_json,'$.assistantSources') IS NOT NULL").get().n,2);
  const version=f.ok(await f.api('GET',`/api/branches/${app.branchId}/versions/${app.versionId}`));assert.equal(app.everyMs,600000);assert.equal(version.definition.steps[0].requireUserCommunication,false);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('default ten-minute automation invokes the check, stays quiet without changes, and its interval is configurable',options,t=>{
 let store;return withFixture(t,async f=>{
  const app=await assistant(f);let checked=false;
  f.plans.set(app.agentId,[{output:false,run:async s=>{
   const result=f.ok(await f.tool(s,'ponderosa_assistant_check',{}));assert.equal(result.published,false);checked=true;
   f.ok(await f.tool(s,'ponderosa_update_request',{kind:'completed',text:'Project check finished; nothing new to report.'}));
  }}]);
  // Advance only the source's due marker; the live schedule service and scheduler do the rest.
  const {BranchStore}=await import('@ponderosa/agents'),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const trigger=branches.trigger(app.branchId);assert.equal(trigger.sourceConfig.everyMs,600000);
  branches.triggers.updateTriggerDefinition(trigger.id,{nextFireAt:new Date(Date.now()-1).toISOString()});
  await until(()=>checked,'actual automatic Assistant check',20000);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM branch_executions WHERE branch_id=? AND state='completed'").get(app.branchId),'quiet automatic execution completes',20000);
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM runtime_communications WHERE json_extract(payload_json,'$.assistantSources') IS NOT NULL").get().n,0);
  const changed=f.ok(await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{expectedVersionId:app.versionId,automatic:true,everyMs:1200000}));assert.equal(changed.everyMs,1200000);assert.equal(branches.trigger(app.branchId).sourceConfig.everyMs,1200000);
  assert.equal((await f.api('POST','/api/agent-workspace',{operation:'projects'})).status,401);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('workspace schema upgrade accepts only exact published predecessor and preserves malformed state',async()=>{
 const {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),path=await import('node:path'),{createRequire}=await import('node:module');
 const require=createRequire(new URL('../../apps/server/package.json',import.meta.url)),Database=require('better-sqlite3');
 for(const scenario of ['exact predecessor','missing one table']){
  const root=mkdtempSync(path.join(tmpdir(),'assistant-state-upgrade-')),state=path.join(root,'data'),folder=path.join(root,'work');mkdirSync(folder);
  try{
   let store=new AgentStore(state);const chat=store.createProject({label:'Preserved Project',chatOwned:true,hostPath:folder,defaultEngine:'codex'});store.close();
   const db=new Database(path.join(state,'ponderosa.db'));
   db.exec(scenario==='exact predecessor'?"DROP TRIGGER assistant_status_communication; DROP TRIGGER assistant_status_request; DROP TRIGGER assistant_status_run; DROP TABLE assistant_status_sources; DROP TABLE assistant_report_scan; DROP TABLE assistant_report_sources; DROP TABLE workspace_agent_actions; DELETE FROM sqlite_sequence WHERE name='assistant_status_sources'":'DROP TABLE assistant_report_scan');
   if(scenario==='exact predecessor')db.prepare('DELETE FROM _schema_version WHERE name=?').run('0029_assistant_workspace.sql');db.close();
   const snapshot=()=>JSON.stringify(readdirSync(state).filter(name=>name.endsWith('.db')||name.endsWith('.json')||name.includes('layout-version')).sort().map(name=>[name,readFileSync(path.join(state,name)).toString('base64')]));const before=snapshot();
   if(scenario==='exact predecessor'){store=new AgentStore(state);assert.equal(store.getProject(chat.id).label,'Preserved Project');assert.ok(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_agent_actions'").get());store.close();}
   else{assert.throws(()=>new AgentStore(state));assert.equal(snapshot(),before);}
  }finally{rmSync(root,{recursive:true,force:true});}
 }
});

test('bundled MCP forwards every workspace tool through the dedicated Run-capability endpoint',options,async()=>{
 const {createServer}=await import('node:http'),{spawn}=await import('node:child_process'),{createInterface}=await import('node:readline'),{once}=await import('node:events'),{fileURLToPath}=await import('node:url');
 const {PONDEROSA_WORKSPACE_TOOLS}=await import('@ponderosa/core'),{encodeSessionTools}=await import('../../packages/engines/dist/ponderosa-mcp-contract.js');
 const requests=[],pending=new Map();let child,exited;
 const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push({url:req.url,authorization:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())});res.setHeader('content-type','application/json');res.end(JSON.stringify({forwarded:true}));});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  child=spawn(process.execPath,[fileURLToPath(new URL('../../packages/engines/dist/ponderosa-mcp.js',import.meta.url))],{env:{PATH:process.env.PATH,PONDEROSA_AGENT_MESSAGE_URL:`http://127.0.0.1:${server.address().port}/api/agent-messages`,PONDEROSA_AGENT_MESSAGE_TOKEN:'inert-test-only',PONDEROSA_AGENT_TOOL_DEFINITIONS:encodeSessionTools(PONDEROSA_WORKSPACE_TOOLS)},stdio:['pipe','pipe','pipe']});exited=once(child,'exit');let errors='';child.stderr.on('data',b=>{errors+=b;});
  createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value);});
  const rpc=(id,method,params)=>new Promise(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const list=await rpc('list','tools/list');assert.deepEqual(list.result.tools.map(t=>t.name),PONDEROSA_WORKSPACE_TOOLS.map(t=>t.name.replace('ponderosa_','')));
  for(const tool of PONDEROSA_WORKSPACE_TOOLS){const response=await rpc(tool.name,'tools/call',{name:tool.name.replace('ponderosa_',''),arguments:{fixtureMarker:tool.name}});assert.notEqual(response.result.isError,true);}
  assert.deepEqual(requests.map(r=>r.body.operation),['projects','create_chat','start_work','check']);assert.ok(requests.every(r=>r.url==='/api/agent-workspace'&&r.authorization==='Bearer inert-test-only'));assert.deepEqual(requests.map(r=>r.body.fixtureMarker),PONDEROSA_WORKSPACE_TOOLS.map(t=>t.name));assert.equal(errors,'');
  child.stdin.end();await exited;child=undefined;
 }finally{if(child){child.kill();await exited;}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
