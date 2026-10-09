import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,WorkspaceStore} from '@ponderosa/agents';
import {createServer} from '../dist/app.js';
const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
const ownerId='browser-fixture';
const draft=(extra={})=>({text:'Private draft',attachmentIds:[],mentionBindings:[],expectedRevision:0,clientId:'page:one',ownerId,...extra});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'draft-owner-')),store=new AgentStore(dir);
 const project=store.createProject({label:'Dev',hostPath:dir,defaultEngine:'codex'}),chat=store.getConversation(project.lastConversationId);
 const ordinary=store.createAgent(project.id,{title:'Ordinary',engine:'codex',conversationId:chat.id,managementPermissions:permissions});
 const coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),branch=branches.create('Draft Branch','draft-fixture');
 const bp=store.createProject({label:'Branch',hostPath:dir,chatOwned:true,branchId:branch.id,defaultEngine:'codex'}),bc=store.getConversation(bp.lastConversationId);
 const ba=store.createAgent(bp.id,{title:'Branch Agent',engine:'codex',conversationId:bc.id,managementPermissions:permissions});
 let starts=0;
 const adapter={id:'codex',displayName:'Fake subscription Adapter',listModels:()=>[],listEfforts:()=>[],run:()=>{starts++;throw Error('Live execution forbidden');}};
 const app=createServer({dataDir:dir,store,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,startDrained:true});await app.ready();
 t.after(async()=>{app.prepareForShutdown();await app.close();store.close();await rm(dir,{recursive:true,force:true});});
 const cone=await app.inject({method:'POST',url:`/api/projects/${project.id}/agents`,payload:{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:chat.id,idempotencyKey:'cone'}});assert.equal(cone.statusCode,200,cone.body);
 return {dir,store,project,chat,ordinary,coordination,branches,branch,bp,bc,ba,cone:cone.json(),app,starts:()=>starts};
}
const base=(id,branch=false)=>`${branch?'/api/branches/engine':'/api'}/conversations/${encodeURIComponent(`agent:${id}`)}`;
const upload=(app,url)=>app.inject({method:'POST',url:`${url}/draft-attachments`,headers:{'content-type':'application/octet-stream','x-ponderosa-draft-owner':ownerId,'x-ponderosa-filename':'note.txt','x-ponderosa-media-type':'text/plain'},payload:Buffer.from('private staged bytes')});
async function files(dir){
 try {const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await files(p));else out.push([p,(await readFile(p)).toString('base64')]);}return out.sort();}catch(e){if(e.code==='ENOENT')return [];throw e;}
}
async function effects(f){return {workspace:new WorkspaceStore(f.dir).cursor(),files:await files(join(f.dir,'draft-attachments')),communications:f.store.sqlite.prepare('SELECT count(*) n FROM runtime_communications').get().n,activations:f.store.sqlite.prepare('SELECT count(*) n FROM agent_activations').get().n};}
async function denyAll(f,id,branch=false,status=404){
 const url=base(id,branch),before=await effects(f);
 const requests=[
  {url:`${url}/draft?ownerId=${ownerId}`},{method:'HEAD',url:`${url}/draft?ownerId=${ownerId}`},
  {method:'PUT',url:`${url}/draft`,payload:draft()},
  {url:`${url}/draft-conflicts?ownerId=${ownerId}`},
  {method:'POST',url:`${url}/draft-conflicts/unknown/restore`,payload:{ownerId,expectedRevision:0,clientId:'restore'}},
  {method:'DELETE',url:`${url}/draft-conflicts/unknown?ownerId=${ownerId}`},
  {url:`${url}/draft-attachments/unknown?ownerId=${ownerId}`},
  {method:'DELETE',url:`${url}/draft-attachments/unknown?ownerId=${ownerId}`},
 ];
 for(const r of requests){const response=await f.app.inject(r);assert.equal(response.statusCode,status,`${JSON.stringify(r)}: ${response.body}`);}
 const posted=await upload(f.app,url);assert.equal(posted.statusCode,status,posted.body);
 assert.deepEqual(await effects(f),before,'denied draft operations must not write events, assets or activations');
}

test('actual ordinary Dev, Pinecone and Branch draft routes retain save/read/revision/conflict/attachment/Send semantics',async t=>{
 const f=await fixture(t);
 for(const [agent,branch] of [[f.ordinary,false],[f.cone,false],[f.ba,true]]){
  const url=base(agent.id,branch);
  const empty=await f.app.inject(`${url}/draft?ownerId=${ownerId}`);assert.equal(empty.statusCode,200,empty.body);assert.equal(empty.json().conversationId,`agent:${agent.id}`);
  const posted=await upload(f.app,url);assert.equal(posted.statusCode,201,posted.body);const attachment=posted.json();
  const download=await f.app.inject(`${url}/draft-attachments/${attachment.id}?ownerId=${ownerId}`);assert.equal(download.statusCode,200,download.body);assert.equal(download.body,'private staged bytes');
  assert.equal((await f.app.inject(`${url}/draft-attachments/${attachment.id}?ownerId=other-browser`)).statusCode,404);
  const saved=await f.app.inject({method:'PUT',url:`${url}/draft`,payload:draft({attachmentIds:[attachment.id]})});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,1);assert.equal(saved.json().text,'Private draft');
  const read=await f.app.inject(`${url}/draft?ownerId=${ownerId}`);assert.equal(read.json().text,'Private draft');assert.equal(read.json().attachments[0].id,attachment.id);
  const stale=await f.app.inject({method:'PUT',url:`${url}/draft`,payload:draft({text:'Stale private copy',clientId:'page:stale'})});assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().current.text,'Private draft');assert.equal(stale.json().displaced.text,'Stale private copy');
  const conflicts=await f.app.inject(`${url}/draft-conflicts?ownerId=${ownerId}`);assert.equal(conflicts.statusCode,200,conflicts.body);const conflict=conflicts.json().conflicts[0];assert.ok(conflict);
  const restored=await f.app.inject({method:'POST',url:`${url}/draft-conflicts/${conflict.id}/restore`,payload:{ownerId,expectedRevision:1,clientId:'restore'}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().draft.text,'Stale private copy');
  const replay=await f.app.inject({method:'POST',url:`${url}/draft-conflicts/${conflict.id}/restore`,payload:{ownerId,expectedRevision:1,clientId:'restore'}});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);
  const displaced=await f.app.inject({method:'PUT',url:`${url}/draft`,payload:draft({text:'Discard this copy',clientId:'page:second-stale'})});assert.equal(displaced.statusCode,409,displaced.body);
  const discarded=await f.app.inject({method:'DELETE',url:`${url}/draft-conflicts/${displaced.json().id}?ownerId=${ownerId}`});assert.equal(discarded.statusCode,200,discarded.body);assert.equal(discarded.json().action,'discarded');
  const fresh=await upload(f.app,url);assert.equal(fresh.statusCode,201,fresh.body);const deleted=await f.app.inject({method:'DELETE',url:`${url}/draft-attachments/${fresh.json().id}?ownerId=${ownerId}`});assert.equal(deleted.statusCode,204,deleted.body);
  const route=`${branch?'/api/branches/engine':'/api'}/agents/${agent.id}/messages`;
  const sent=await f.app.inject({method:'POST',url:route,payload:{text:'Explicit private send',idempotencyKey:`first-${agent.id}`,activeRunDelivery:'queue'}});assert.equal(sent.statusCode,202,sent.body);
  const authored=f.store.readCommunicationEvents(agent.projectId).find(e=>e.audience.agentId===agent.id);assert.equal(authored.intent,'user_dm');assert.deepEqual(authored.audience,{kind:'user_agent',userId:'local-operator',agentId:agent.id});
 }
 assert.equal(f.starts(),0);
});

test('wrong product, malformed compound IDs and aliases outside the exact draft routes fail closed without effects',async t=>{
 const f=await fixture(t);await denyAll(f,f.ordinary.id,true);await denyAll(f,f.ba.id,false);await denyAll(f,'missing');
 for(const surface of [`agent: ${f.ordinary.id}`,`agent:${f.ordinary.id} `,`agent:agent:${f.ordinary.id}`,`other:${f.ordinary.id}`,`collaboration:${f.chat.id}`,`agent:${f.ordinary.id}/nested`,`agent:${f.ordinary.id}%20`]){
  const before=await effects(f),url=`/api/conversations/${encodeURIComponent(surface)}/draft`;
  const denied=await f.app.inject({method:'PUT',url,payload:draft()});assert.equal(denied.statusCode,404,denied.body);assert.deepEqual(await effects(f),before);
 }
 for(const suffix of ['', '/messages','/members']){const r=await f.app.inject(`${base(f.ordinary.id)}${suffix}`);assert.equal(r.statusCode,404,r.body);}
 const foreignQuery=await f.app.inject(`${base(f.ordinary.id)}/draft?ownerId=${ownerId}&agentId=${f.ba.id}`);assert.equal(foreignQuery.statusCode,404,foreignQuery.body);
 const foreignBody=await f.app.inject({method:'PUT',url:`${base(f.ordinary.id)}/draft`,payload:draft({mentionBindings:[{projectId:f.bp.id,agentId:f.ba.id,handle:f.ba.handle,currentHandle:f.ba.handle,currentTitle:f.ba.title}]})});assert.equal(foreignBody.statusCode,404,foreignBody.body);
 const ordinaryChat=await f.app.inject(`/api/conversations/${f.chat.id}/draft?ownerId=${ownerId}`);assert.equal(ordinaryChat.statusCode,200,ordinaryChat.body);
});

test('pending creation, deletion, archived and missing canonical Agent/Chat owners deny all draft operations',async t=>{
 const f=await fixture(t);
 const operation=f.store.beginAgentCreationOperation({projectId:f.project.id,conversationId:f.chat.id,productScope:'dev',kind:'human',actorScope:'user:local-operator',idempotencyKey:'pending',payloadHash:'fixture'}).operation;
 f.store.addAgentCreationOperationMember(operation.id,f.ordinary.id,0);
 for(const status of ['preparing','canonical_committed','rolling_back']){f.store.sqlite.prepare('UPDATE agent_creation_operations SET status=? WHERE id=?').run(status,operation.id);await denyAll(f,f.ordinary.id);}
 f.store.sqlite.prepare("UPDATE agent_creation_operations SET status='completed' WHERE id=?").run(operation.id);
 f.store.updateAgent(f.ordinary.id,{archived:true});await denyAll(f,f.ordinary.id);f.store.updateAgent(f.ordinary.id,{archived:false});
 f.store.updateConversation(f.chat.id,{archived:true});await denyAll(f,f.ordinary.id);f.store.updateConversation(f.chat.id,{archived:false});
 f.store.sqlite.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run('missing-chat',f.ordinary.id);await denyAll(f,f.ordinary.id);f.store.sqlite.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run(f.chat.id,f.ordinary.id);
 f.store.markConversationDeletionPending(f.chat.id);await denyAll(f,f.ordinary.id);f.store.sqlite.prepare('DELETE FROM conversation_deletion_receipts WHERE conversation_id=?').run(f.chat.id);
 f.store.markProjectDeletionPending(f.project.id);await denyAll(f,f.ordinary.id);f.store.sqlite.prepare('DELETE FROM project_deletion_pending WHERE project_id=?').run(f.project.id);
 f.store.sqlite.prepare('INSERT INTO agent_deletion_pending(agent_id,project_id,conversation_id,tombstone_name,ownership_token,created_at) VALUES(?,?,?,?,?,?)').run(f.ordinary.id,f.project.id,f.chat.id,'fixture','fixture',new Date().toISOString());await denyAll(f,f.ordinary.id);
 f.store.sqlite.prepare('DELETE FROM agent_deletion_pending WHERE agent_id=?').run(f.ordinary.id);
 f.store.deleteAgent(f.ordinary.id,id=>f.coordination.handleAgentDeletion(id));await denyAll(f,f.ordinary.id);
});

test('underlying Branch Agent and owner Chat staging/retiring and installation-plan mutation fences remain enforced',async t=>{
 const f=await fixture(t);
 for(const [id,ref] of [[f.ba.id,'agent'],[f.bc.id,'']])for(const state of ['staging','retiring']){
  f.store.sqlite.prepare('INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,?)').run(f.branch.id,'fixture',`chat-${id}`,ref,id,state);
  await denyAll(f,f.ba.id,true);
  f.store.sqlite.prepare('DELETE FROM branch_installation_resources WHERE local_id=?').run(id);
 }
 for(const state of ['applying','canceling']){
  f.store.sqlite.prepare('INSERT INTO branch_installation_plans(id,branch_id,package_json,bindings_json,preview_json,state,created_at) VALUES(?,?,?,?,?,?,?)').run('draft-plan',f.branch.id,'{}','{}','{}',state,new Date().toISOString());
  const url=base(f.ba.id,true),before=await effects(f);
  for(const r of [{method:'PUT',url:`${url}/draft`,payload:draft()},{method:'DELETE',url:`${url}/draft-conflicts/unknown?ownerId=${ownerId}`},{method:'POST',url:`${url}/draft-conflicts/unknown/restore`,payload:{ownerId,expectedRevision:0,clientId:'restore'}}]){const result=await f.app.inject(r);assert.equal(result.statusCode,404,result.body);}
  assert.equal((await upload(f.app,url)).statusCode,404);assert.deepEqual(await effects(f),before);
  assert.equal((await f.app.inject(`${url}/draft?ownerId=${ownerId}`)).statusCode,200,'installation plan preserves ordinary read semantics');
  f.store.sqlite.prepare('DELETE FROM branch_installation_plans WHERE id=?').run('draft-plan');
 }
});

test('execution-owned temporary Agent drafts remain readable; every external mutation is fenced without effects',async t=>{
 const f=await fixture(t),definition={schema:'ponderosa.branch.v1',name:'Fixture',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'console.log(1)',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 f.branches.deploy({chatId:'',branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'draft-deploy',definition,bindings:{agents:{},directories:{root:f.dir}}});
 const execution=f.branches.accept(f.branch.id,'draft-run','input');
 const project=f.store.createProject({label:'Temporary',chatOwned:true,branchId:f.branch.id,executionId:execution.id,defaultEngine:'codex'}),chat=f.store.getConversation(project.lastConversationId);
 const agent=f.store.createAgent(project.id,{title:'Temporary',engine:'codex',conversationId:chat.id,managementPermissions:permissions});
 const url=base(agent.id,true),before=await effects(f);
 assert.equal((await f.app.inject(`${url}/draft?ownerId=${ownerId}`)).statusCode,200);
 assert.equal((await f.app.inject(`${url}/draft-conflicts?ownerId=${ownerId}`)).statusCode,200);
 for(const r of [{method:'PUT',url:`${url}/draft`,payload:draft()},{method:'DELETE',url:`${url}/draft-conflicts/unknown?ownerId=${ownerId}`},{method:'POST',url:`${url}/draft-conflicts/unknown/restore`,payload:{ownerId,expectedRevision:0,clientId:'restore'}},{method:'DELETE',url:`${url}/draft-attachments/unknown?ownerId=${ownerId}`}]){const result=await f.app.inject(r);assert.equal(result.statusCode,409,result.body);}
 assert.equal((await upload(f.app,url)).statusCode,409);assert.deepEqual(await effects(f),before);assert.equal(f.starts(),0);
});
