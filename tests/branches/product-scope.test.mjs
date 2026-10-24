import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {chatBrowserOwnerId} from '@ponderosa/core';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {conversationJsonPath} from '../../packages/agents/dist/paths.js';
import {withFixture,until} from '../shared/fixture.mjs';

const prefix=product=>product==='branches'?'/api/branches/engine':'/api';
async function setup(f){
 const branch=f.ok(await f.api('POST','/api/branches',{name:'Scoped product',idempotencyKey:randomUUID()}));
 const products={dev:[],branches:[]};
 // Interleave products so filtering after LIMIT would lose valid rows.
 for(let index=0;index<2;index++)for(const product of ['dev','branches']){
  const chat=product==='dev'?await f.createChat(`Scope ${index}`):f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:`Scope ${index}`,defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`${prefix(product)}/projects/${chat.projectId}/agents`,{title:`Scope Agent ${index}`,engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
  products[product].push({chat,agent});
 }
 return {branch,products};
}

test('recency limits and starred expansion only count canonical resources in the requested product across reopen',async t=>withFixture(t,async f=>{
 const {branch,products}=await setup(f);
 for(const product of ['dev','branches'])for(const {chat,agent} of products[product])for(const [kind,resourceId] of [['project',chat.projectId],['conversation',chat.id],['agent',agent.id]])
  f.ok(await f.api('POST',`${prefix(product)}/workspace/recent-resources/use`,{kind,resourceId}));
 for(const product of ['dev','branches']){
  const starred=products[product][0].chat.id;
  f.ok(await f.api('PATCH',`${prefix(product)}/workspace/preferences`,{starredResourceIds:[`conversation:${starred}`]}));
 }
 f.ok(await f.api('POST','/api/branches/engine/workspace/recent-resources/use',{kind:'branch',resourceId:branch.id}));
 const check=async()=>{for(const product of ['dev','branches']){
  const rows=f.ok(await f.api('GET',`${prefix(product)}/workspace/recent-resources?limit=1`));
  assert.equal(rows.resources.length,2,'Return the own star plus the own newest unstarred record');assert.equal(rows.truncated,true);
  const own=new Set(products[product].flatMap(({chat,agent})=>[chat.projectId,chat.id,agent.id]));if(product==='branches')own.add(branch.id);
  assert.ok(rows.resources.every(row=>own.has(row.resourceId)),'Foreign rows must not enter starred expansion or consume the limit');
 }};
 await check();await f.reopen();await check();
}));

test('completed deletion receipts replay only in their canonical product without reopening deleted private history',async t=>withFixture(t,async f=>{
 const chat=await f.createChat('Replay deleted Chat');
 assert.equal(f.ok(await f.api('DELETE',`/api/conversations/${chat.id}`)).deleted,true);
 assert.equal((await f.api('GET',`/api/conversations/${chat.id}`)).status,404);
 assert.equal(f.ok(await f.api('DELETE',`/api/conversations/${chat.id}`)).replayed,true);
 assert.equal((await f.api('DELETE',`/api/branches/engine/conversations/${chat.id}`)).status,404);
 assert.equal(f.ok(await f.api('DELETE',`/api/projects/${chat.projectId}`)).deleted,true);
 assert.equal(f.ok(await f.api('DELETE',`/api/projects/${chat.projectId}`)).replayed,true);
 assert.equal((await f.api('DELETE',`/api/branches/engine/projects/${chat.projectId}`)).status,404);
 await f.reopen();assert.equal(f.ok(await f.api('DELETE',`/api/projects/${chat.projectId}`)).replayed,true);assert.equal((await f.api('GET',`/api/projects/${chat.projectId}`)).status,404);
}));

test('product-scoped DMs preserve honest missing-recipient diagnostics and reject a known foreign recipient before delivery',async t=>withFixture(t,async f=>{
 const {products}=await setup(f);
 for(const product of ['dev','branches']){
  const {chat,agent}=products[product][0],missing=randomUUID(),payload={text:'Deliver once to the available member',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id},{agentId:missing}]},route=`${prefix(product)}/conversations/${chat.id}/direct-messages`;
  const receipt=f.ok(await f.api('POST',route,payload));assert.deepEqual(receipt.unavailableRecipients,[{agentId:missing,reason:'missing'}]);assert.deepEqual(receipt.recipients.map(recipient=>recipient.agentId),[agent.id]);assert.equal(f.ok(await f.api('POST',route,payload)).messageId,receipt.messageId);
  const foreign=products[product==='dev'?'branches':'dev'][1].agent;
  assert.equal((await f.api('POST',route,{...payload,idempotencyKey:randomUUID(),recipients:[{agentId:foreign.id}]})).status,404);
  assert.equal(f.turns.some(turn=>turn.agentId===foreign.id),false);
 }
}));

test('indirect Run, Request and activation URLs retain the canonical product owner',async t=>{
 let store;
 await withFixture(t,async f=>{
  const {products}=await setup(f),{chat,agent}=products.branches[0],base=prefix('branches');
  const worker=f.ok(await f.api('POST',`${base}/projects/${chat.projectId}/agents`,{title:'Scoped request worker',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`${base}/agents/${agent.id}/messages`,{text:'Coordinate the controlled work',idempotencyKey:randomUUID()}));
  await until(()=>f.sessions.get(agent.id),'scoped coordinator');
  const detail=await until(async()=>{const d=f.ok(await f.api('GET',`${base}/agents/${agent.id}`));return d.runs.length&&d;},'owned Run');
  const runId=detail.runs[0].id,url=`/api/runs/${runId}/provider-input?exact=1`;
  assert.equal((await f.api('GET',url)).status,404,'Exact provider input must not escape through an unscoped Run URL');
  assert.equal((await f.api('GET',url.replace('/api/',base+'/'))).status,200);
  f.plans.set(worker.id,[{hold:true}]);
  const coordinated=f.ok(await f.tool(f.sessions.get(agent.id),'ponderosa_coordinate',{idempotencyKey:randomUUID(),requests:[{recipientAgentId:worker.id,text:'Controlled task',lifetime:{kind:'indefinite'}}]}));
  const requestId=coordinated.requestIds[0],requestUrl=`/api/requests/${encodeURIComponent(requestId)}/cancel`,before=store.sqlite.prepare('SELECT state,version FROM coordination_requests WHERE id=?').get(requestId);
  assert.equal((await f.api('POST',requestUrl,{idempotencyKey:randomUUID()})).status,404,'A Request URL must not grant cross-product mutation');
  assert.deepEqual(store.sqlite.prepare('SELECT state,version FROM coordination_requests WHERE id=?').get(requestId),before);
  const activation=store.sqlite.prepare('SELECT id FROM agent_activations WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(worker.id);
  assert.ok(activation);const activationUrl=`/api/communication-v3/activations/${activation.id}/settle-recipient-unavailable`,body={projectId:chat.projectId,idempotencyKey:randomUUID()};
  assert.equal((await f.api('POST',activationUrl,body)).status,404);
  assert.equal((await f.api('POST',activationUrl.replace('/api/',base+'/'),body)).status,409,'The owned route must preserve canonical recipient-availability validation');
  assert.equal((await f.api('POST',requestUrl.replace('/api/',base+'/'),{idempotencyKey:randomUUID()})).status,200);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('product collections filter before paging and bind continuations to their product',async t=>withFixture(t,async f=>{
 const {branch,products}=await setup(f);
 const agentPage=await f.api('GET',`/api/branches/${branch.id}/agents?limit=1`);f.ok(agentPage);assert.equal(agentPage.body.length,1);assert.equal(agentPage.headers['x-total-count'],'2');assert.ok(agentPage.headers['x-next-cursor']);
 const agentNext=f.ok(await f.api('GET',`/api/branches/${branch.id}/agents?limit=1&cursor=${encodeURIComponent(agentPage.headers['x-next-cursor'])}`));assert.equal(agentNext.length,1);assert.notEqual(agentNext[0].id,agentPage.body[0].id);
 assert.deepEqual(f.ok(await f.api('GET',`/api/branches/${branch.id}/agents?search=Scope%20Agent%201`)).map(agent=>agent.id),[products.branches[1].agent.id]);
 const branchPage=await f.api('GET',`/api/branches/${branch.id}/chats?limit=1`);f.ok(branchPage);assert.equal(branchPage.body.length,1);assert.equal(branchPage.headers['x-total-count'],'2');assert.ok(branchPage.headers['x-next-cursor']);
 const branchNext=f.ok(await f.api('GET',`/api/branches/${branch.id}/chats?limit=1&cursor=${encodeURIComponent(branchPage.headers['x-next-cursor'])}`));assert.equal(branchNext.length,1);assert.notEqual(branchNext[0].id,branchPage.body[0].id);
 for(const product of ['dev','branches'])for(const kind of ['project','conversation','agent']){
  const base=`${prefix(product)}/workspace/directory/${kind}?limit=1&sort=alphabetical`,seen=[];let cursor,first;
  do{
   const page=f.ok(await f.api('GET',base+(cursor?`&cursor=${encodeURIComponent(cursor)}`:'')));first??=page;
   assert.equal(page.total,2,`${product} ${kind} count`);assert.equal(page.items.length,1,'Foreign rows consumed a page');
   seen.push(...page.items.map(item=>item[kind].id));cursor=page.history.cursor;
   assert.ok(seen.length<=2,'Pagination repeated a page');
  }while(cursor);
  assert.deepEqual(seen.sort(),products[product].map(item=>kind==='agent'?item.agent.id:kind==='project'?item.chat.projectId:item.chat.id).sort());
  assert.ok(first.history.cursor);const foreign=product==='dev'?'branches':'dev';
  assert.ok([400,409].includes((await f.api('GET',`${prefix(foreign)}/workspace/directory/${kind}?limit=1&sort=alphabetical&cursor=${encodeURIComponent(first.history.cursor)}`)).status));
 }
 for(const product of ['dev','branches']){
  const other=product==='dev'?'branches':'dev';
  assert.equal((await f.api('GET',`${prefix(product)}/agents/${products[other][0].agent.id}`)).status,404);
  assert.equal((await f.api('GET',`${prefix(product)}/conversations/${products[other][0].chat.id}/files`)).status,404);
  assert.equal(f.ok(await f.api('GET',`${prefix(product)}/projects?limit=100`)).length,2);
 }
}));

test('search, All Chat, file search, usage and preferences retain product ownership across restart',async t=>withFixture(t,async f=>{
 const {branch,products}=await setup(f),marker=`scoped${randomUUID().replaceAll('-','')}`;
 for(const product of ['dev','branches'])for(const {chat,agent} of products[product]){
  f.ok(await f.api('POST',`${prefix(product)}/conversations/${chat.id}/messages`,{text:`${marker} ${product}`,idempotencyKey:randomUUID()}));
  await writeFile(path.join(chat.workingDirectory,`${marker}-${product}.txt`),product);
  f.ok(await f.api('POST',`${prefix(product)}/agents/${agent.id}/messages`,{text:`${marker} private ${product}`,idempotencyKey:randomUUID()}));
  await until(async()=>{const d=f.ok(await f.api('GET',`${prefix(product)}/agents/${agent.id}`));return d.runs.length&&d.runs.every(r=>['completed','failed','interrupted'].includes(r.status));},'controlled scoped Run');
 }
 for(const product of ['dev','branches']){
  const projectIds=products[product].map(item=>item.chat.projectId),chatIds=products[product].map(item=>item.chat.id);
  const search=f.ok(await f.api('GET',`${prefix(product)}/search?q=${marker}&limit=100`));assert.ok(search.results.length>=2);assert.ok(search.results.every(item=>projectIds.includes(item.project.id)));
  const files=f.ok(await f.api('GET',`${prefix(product)}/search/files?q=${marker}`));assert.equal(files.results.length,2);assert.ok(files.results.every(item=>chatIds.includes(item.conversationId)));
  const feedBase=`${prefix(product)}/all-chat?limit=1`,seen=[];let cursor;
  do{const page=f.ok(await f.api('GET',feedBase+(cursor?`&cursor=${encodeURIComponent(cursor)}`:'')));assert.ok(page.items.every(item=>projectIds.includes(item.project.id)));seen.push(...page.items.map(item=>item.communicationEventId));cursor=page.history.cursor;assert.ok(seen.length<30);}while(cursor);
  assert.ok(seen.length>=4);assert.equal(new Set(seen).size,seen.length);
  const first=f.ok(await f.api('GET',feedBase)),other=product==='dev'?'branches':'dev';assert.equal((await f.api('GET',`${prefix(other)}/all-chat?limit=1&cursor=${encodeURIComponent(first.history.cursor)}`)).status,400);
  const prefs=f.ok(await f.api('PATCH',`${prefix(product)}/workspace/preferences`,{starredResourceIds:products[product].map(item=>`conversation:${item.chat.id}`)}));assert.equal(prefs.starredResourceIds.length,2);
  const usage=f.ok(await f.api('GET',`${prefix(product)}/usage`));assert.equal(usage.finalizedRuns,2);assert.equal(usage.inputTokens,40);
 }
 assert.equal(f.ok(await f.api('GET',`/api/branches/${branch.id}/usage`)).finalizedRuns,2);
 const empty=f.ok(await f.api('POST','/api/branches',{name:'Unrelated empty workflow',idempotencyKey:randomUUID()}));assert.equal(f.ok(await f.api('GET',`/api/branches/${empty.id}/usage`)).finalizedRuns,0);
 await f.reopen();
 for(const product of ['dev','branches'])assert.deepEqual(f.ok(await f.api('GET',`${prefix(product)}/workspace/preferences`)).starredResourceIds.sort(),products[product].map(item=>`conversation:${item.chat.id}`).sort());
}));

test('notification counts, page boundaries and dismissal cannot affect the other product',async t=>withFixture(t,async f=>{
 const {products}=await setup(f);
 for(const product of ['dev','branches'])for(const {agent} of products[product]){
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`${prefix(product)}/agents/${agent.id}/messages`,{text:'Controlled scoped Decision',idempotencyKey:randomUUID()}));
  await until(()=>f.sessions.get(agent.id),'scoped provider session');
  f.ok(await f.tool(f.sessions.get(agent.id),'ponderosa_decision',{question:`Question for ${product}`,mode:'text',blocking:true}));
 }
 const first={};
 for(const product of ['dev','branches']){
  const page=f.ok(await f.api('GET',`${prefix(product)}/notifications?limit=1`));assert.equal(page.openActionCount,2);assert.equal(page.items.length,1);assert.ok(page.nextCursor);first[product]=page;
  assert.ok(products[product].some(item=>item.agent.id===page.items[0].agentId));
  const next=f.ok(await f.api('GET',`${prefix(product)}/notifications?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`));assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,page.items[0].id);
 }
 assert.equal((await f.api('GET',`/api/notifications?cursor=${encodeURIComponent(first.branches.nextCursor)}`)).status,400);
 assert.equal((await f.api('POST',`/api/notifications/${first.branches.items[0].id}/acknowledge`)).status,404);
 f.ok(await f.api('POST','/api/branches/engine/notifications/acknowledge-batch',{notificationIds:[first.branches.items[0].id]}));
 assert.equal(f.ok(await f.api('GET','/api/notifications')).unacknowledgedActionCount,2);
 assert.equal(f.ok(await f.api('GET','/api/branches/engine/notifications')).unacknowledgedActionCount,1);
}));

test('inactive installation resources disappear from direct and paginated read models',async t=>{
 let store;
 await withFixture(t,async f=>{
  const {branch,products}=await setup(f),{chat,agent}=products.branches[0];
  const page=f.ok(await f.api('GET','/api/branches/engine/workspace/directory/agent?limit=1&sort=alphabetical'));
  store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,'chat','agent',?,'retiring')").run(branch.id,'controlled-scope-installation',agent.id);
  assert.equal((await f.api('GET',`/api/branches/engine/agents/${agent.id}`)).status,404);
  assert.equal(f.ok(await f.api('GET','/api/branches/engine/workspace/directory/agent')).total,1);
  assert.equal((await f.api('GET',`/api/branches/engine/workspace/directory/agent?limit=1&sort=alphabetical&cursor=${encodeURIComponent(page.history.cursor)}`)).status,409,'A visibility change must invalidate the prior continuation');
  store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,'chat','',?,'retiring')").run(branch.id,'controlled-scope-installation',chat.id);
  assert.equal(f.ok(await f.api('GET','/api/branches/engine/workspace/directory/conversation')).total,1);
  assert.equal(f.ok(await f.api('GET','/api/branches/engine/projects')).length,1);
  assert.equal(f.ok(await f.api('GET','/api/projects')).length,2);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('live workspace streams scope draft invalidations and preference payloads to each product',async t=>withFixture(t,async f=>{
 const {products}=await setup(f),origin=await f.listen(),streams={};
 try{
  for(const product of ['dev','branches']){
   const abort=new AbortController(),response=await fetch(`${origin}${prefix(product)}/workspace/stream`,{signal:abort.signal});assert.equal(response.status,200);
   const record={abort,text:'',error:undefined};streams[product]=record;
   record.done=(async()=>{try{for await(const bytes of response.body)record.text+=Buffer.from(bytes).toString('utf8');}catch(error){if(!abort.signal.aborted)record.error=error;}})();
   await until(()=>record.text.includes('workspace_status'),'initial workspace stream');
  }
  for(const product of ['dev','branches']){
   const {chat}=products[product][0],url=`${prefix(product)}/conversations/${chat.id}/draft`,initial=f.ok(await f.api('GET',`${url}?ownerId=scope-browser`));
   f.ok(await f.api('PUT',url,{ownerId:'scope-browser',clientId:'scope-tab',text:`Private draft ${product}`,attachmentIds:[],expectedRevision:initial.revision}));
   f.ok(await f.api('PATCH',`${prefix(product)}/workspace/preferences`,{starredResourceIds:[`conversation:${chat.id}`]}));
  }
  for(const product of ['dev','branches']){
   const own=products[product][0].chat.id,other=products[product==='dev'?'branches':'dev'][0].chat.id,record=streams[product];
   await until(()=>record.text.includes(own)&&record.text.includes(`conversation:${own}`),'scoped draft and preference events');
   assert.equal(record.error,undefined);assert.equal(record.text.includes(other),false,'Foreign owner leaked through the workspace stream');
   assert.equal(record.text.includes('Private draft'),false,'Draft invalidations must not broadcast draft content');
  }
 }finally{for(const record of Object.values(streams))record.abort.abort();await Promise.all(Object.values(streams).map(record=>record.done));}
}));

test('published Branch results remain readable after private Agent deletion and reopening with exact product ownership',async t=>{
 let store;
 await withFixture(t,async f=>{
  const {products}=await setup(f),{chat,agent}=products.branches[0],base=prefix('branches'),bytes=`Retained shared result ${randomUUID()}`;
  const file=path.join(chat.workingDirectory,'shared-result.txt');await writeFile(file,bytes);
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`${base}/agents/${agent.id}/messages`,{text:'Capture the controlled result',idempotencyKey:randomUUID()}));await until(()=>f.sessions.get(agent.id),'result author');
  const session=f.sessions.get(agent.id),captured=f.ok(await f.tool(session,'ponderosa_import_file',{path:'shared-result.txt'}));
  f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Published result',artifactIds:[captured.artifact.id]}));
  const url=`${base}/projects/${chat.projectId}/artifacts/${encodeURIComponent(captured.artifact.id)}/download`;
  assert.equal(f.ok(await f.api('GET',url)),bytes);assert.equal((await f.api('GET',url.replace(base,'/api'))).status,404);
  const unpublished=store.beginAgentCreationOperation({projectId:chat.projectId,conversationId:chat.id,actorScope:'qualification',kind:'import',idempotencyKey:randomUUID(),payloadHash:'controlled-publication'}).operation;
  store.addAgentCreationOperationMember(unpublished.id,agent.id,0);
  assert.equal((await f.api('GET',url)).status,404,'Unpublished Agent imports must not expose their captured files');
  assert.equal(f.ok(await f.api('GET',`${base}/projects/${chat.projectId}/artifacts`)).items.length,0);
  store.updateAgentCreationOperation(unpublished.id,{status:'completed',result:{rootAgentId:agent.id,agentIds:[agent.id]}});
  assert.equal(f.ok(await f.api('GET',url)),bytes);
  const preview=f.ok(await f.api('POST',`${base}/projects/${chat.projectId}/agent-deletions/preview`,{rootAgentIds:[agent.id]}));
  const removed=f.ok(await f.api('POST',`${base}/projects/${chat.projectId}/agent-deletions/commit`,{rootAgentIds:[agent.id],previewHash:preview.previewHash}));
  assert.equal(removed.cleanupPending,false);assert.equal(session.isAlive(),false);assert.equal(store.getAgentDeletionReceiptByPreviewHash(preview.previewHash).productScope,'branches');
  assert.equal((await f.api('GET',`${base}/agents/${agent.id}`)).status,404);assert.equal(await readFile(file,'utf8'),bytes);
  assert.equal(f.ok(await f.api('GET',url)),bytes);
  assert.equal((await f.api('POST',`/api/projects/${chat.projectId}/agent-deletions/commit`,{rootAgentIds:[agent.id],previewHash:preview.previewHash})).status,404);
  await f.reopen();assert.equal(f.ok(await f.api('GET',url)),bytes);
  const page=f.ok(await f.api('GET',`${base}/projects/${chat.projectId}/artifacts?limit=1`));assert.equal(page.items.length,1);assert.equal(page.items[0].id,captured.artifact.id);assert.ok(page.items[0].downloadUrl.startsWith(`${base}/`));
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('a restored current-format mixed Project scopes Chat counts and user-published files before pagination',async t=>{
 let store;
 await withFixture(t,async f=>{
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Restored owner',idempotencyKey:randomUUID()}));
  const project=store.createProject({label:'Mixed restored Project',hostPath:f.root,defaultEngine:'codex'});
  const dev=store.listConversations(project.id)[0],branchChats=[store.createConversation(project.id,{title:'Branch A'}),store.createConversation(project.id,{title:'Branch B'})];
  // Reproduce an offline-restored current-format layout. This is disposable
  // canonical authored content, not a runtime compatibility or migration path.
  for(const chat of branchChats){const filename=conversationJsonPath(f.dataDir,project.id,chat.id),record=JSON.parse(await readFile(filename,'utf8'));record.branchId=branch.id;await writeFile(filename,JSON.stringify(record));}
  store.rebuildProjections();
  for(const product of ['dev','branches']){
   assert.equal((await f.api('GET',`${prefix(product)}/projects/${project.id}/agent-work`)).status,400);
   const ownChat=product==='dev'?dev:branchChats[0];assert.equal((await f.api('GET',`${prefix(product)}/projects/${project.id}/agent-work?conversationId=${ownChat.id}`)).status,200);
  }
  for(const product of ['dev','branches']){
   const chats=product==='dev'?[dev]:branchChats;
   const directory=f.ok(await f.api('GET',`${prefix(product)}/workspace/directory/conversation?projectId=${project.id}&limit=1`));assert.equal(directory.total,chats.length);assert.equal(directory.items.length,1);assert.ok(chats.some(chat=>chat.id===directory.items[0].conversation.id));
   for(const chat of chats){
    const text=`Published user document ${product} ${chat.id}\n`+'Retained authored text.\n'.repeat(1000);
    f.ok(await f.api('POST',`${prefix(product)}/conversations/${chat.id}/messages`,{text,idempotencyKey:randomUUID()}));
   }
  }
  for(const product of ['dev','branches']){
   const expected=product==='dev'?1:2,ids=[];let cursor;
   do{const page=f.ok(await f.api('GET',`${prefix(product)}/projects/${project.id}/artifacts?limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`));assert.equal(page.items.length,1);ids.push(page.items[0].id);const content=f.ok(await f.api('GET',page.items[0].downloadUrl));assert.match(content,new RegExp(`Published user document ${product}`));cursor=page.history.cursor;assert.ok(ids.length<=expected);}while(cursor);
   assert.equal(ids.length,expected);assert.equal(new Set(ids).size,expected);
  }
  assert.equal((await f.api('DELETE',`/api/projects/${project.id}`)).status,409,'The normal product cannot delete Branch-owned history in a mixed Project');
  for(const prefix of ['/api','/api/branches/engine'])assert.equal((await f.api('GET',`${prefix}/projects/${project.id}/deletion-preview`)).status,409,'Project-wide deletion previews must not disclose cross-product resource totals');
  await f.reopen();assert.equal(f.ok(await f.api('GET',`/api/branches/engine/workspace/directory/conversation?projectId=${project.id}`)).total,2);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});


test('versioned browser Chat owner handles preserve product ownership without becoming Project aliases',async t=>withFixture(t,async f=>{
 const {products}=await setup(f);
 for(const product of ['dev','branches']){
  const {chat}=products[product][0],owner=encodeURIComponent(chatBrowserOwnerId(chat.id)),base=prefix(product),foreign=prefix(product==='dev'?'branches':'dev');
  const url=`/projects/${owner}/browser/preferences`;
  assert.equal((await f.api('GET',base+url)).status,200,'The owning product must retain the canonical Chat browser handle');
  assert.equal((await f.api('GET',foreign+url)).status,404);
  assert.equal((await f.api('GET',`${base}/projects/${owner}/conversations`)).status,404,'A browser handle is not a generic Project identity');
 }
}));


test('Chat attachment metadata and bytes retain their canonical product owner',async t=>{
 await withFixture(t,async f=>{
  const normal=await f.createChat('Normal upload owner');
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Branch upload owner',idempotencyKey:'branch-upload-owner'}));
  const chat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Branch upload Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const bytes=Buffer.from('Owned attachment bytes'),name='資料 100% literal.txt';
  for(const [owner,prefix,foreign] of [[normal,'/api','/api/branches/engine'],[chat,'/api/branches/engine','/api']]){
   const path=`/conversations/${owner.id}/attachments`;
   const headers={'content-type':'application/x-ponderosa-attachment','x-ponderosa-media-type':'text/plain','x-ponderosa-filename':encodeURIComponent(name)};
   const uploaded=await f.api('POST',prefix+path,bytes,headers);
   assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));
   assert.equal(uploaded.body.name,name);assert.equal(uploaded.body.agentId,owner.id);assert.equal(uploaded.body.conversationId,owner.id);
   assert.ok(uploaded.body.downloadUrl.startsWith(prefix+'/conversations/'));
   assert.deepEqual((await f.api('GET',uploaded.body.downloadUrl)).rawBody,bytes);
   assert.equal((await f.api('POST',foreign+path,bytes,headers)).status,404);
   const foreignUrl=foreign+uploaded.body.downloadUrl.slice(prefix.length);
   assert.equal((await f.api('GET',foreignUrl)).status,404);
   await f.reopen();
   assert.deepEqual((await f.api('GET',uploaded.body.downloadUrl)).rawBody,bytes);
  }
 });
});


for(const product of ['dev','branches'])test(`${product} draft attachments can be removed without bypassing owner, reference or lifecycle guards`,async t=>withFixture(t,async f=>{
 const {products}=await setup(f),{chat}=products[product][0],base=prefix(product),foreign=prefix(product==='dev'?'branches':'dev'),ownerId='attachment-browser';
 const root=`${base}/conversations/${chat.id}`,bytes=Buffer.from('Owned draft attachment');
 const upload=async()=>f.ok(await f.api('POST',`${root}/draft-attachments`,bytes,{'content-type':'application/x-ponderosa-attachment','x-ponderosa-media-type':'text/plain','x-ponderosa-filename':'draft.txt','x-ponderosa-draft-owner':ownerId}));
 const asset=await upload();
 assert.equal((await f.api('DELETE',asset.downloadUrl.replace(base,foreign))).status,404,'The other product cannot remove this draft attachment');
 assert.equal((await f.api('DELETE',asset.downloadUrl.replace(ownerId,'another-browser'))).status,404,'A foreign draft owner cannot remove the attachment');
 const draftUrl=`${root}/draft`,initial=f.ok(await f.api('GET',`${draftUrl}?ownerId=${ownerId}`));
 const saved=f.ok(await f.api('PUT',draftUrl,{ownerId,clientId:'attachment-tab',text:'Unsent draft',attachmentIds:[asset.id],expectedRevision:initial.revision}));
 assert.equal((await f.api('DELETE',asset.downloadUrl)).status,409,'A referenced attachment must remain readable');
 assert.deepEqual((await f.api('GET',asset.downloadUrl)).rawBody,bytes);
 f.ok(await f.api('PUT',draftUrl,{ownerId,clientId:'attachment-tab',text:'Unsent draft',attachmentIds:[],expectedRevision:saved.revision}));
 await until(async()=>(await f.api('GET',asset.downloadUrl)).status===404,'automatic cleanup after draft reference removal');
 const staged=await upload();await f.reopen();
 assert.deepEqual((await f.api('GET',staged.downloadUrl)).rawBody,bytes);
 assert.equal((await f.api('DELETE',staged.downloadUrl)).status,204,'Removing an unreferenced draft attachment must not require deleting its Branch');
 assert.equal((await f.api('GET',staged.downloadUrl)).status,404);
 await f.reopen();assert.equal((await f.api('GET',staged.downloadUrl)).status,404,'Deleted attachment must remain absent after restart');
 if(product==='branches'){
  assert.equal((await f.api('DELETE',root)).status,409,'The persistent Branch Chat still requires its lifecycle');
  assert.equal((await f.api('DELETE',`${base}/projects/${chat.projectId}`)).status,409);
 }
 assert.equal(f.ok(await f.api('GET',`${draftUrl}?ownerId=${ownerId}`)).text,'Unsent draft');
}));


test('draft attachment deletion still fences retiring installations and execution-owned temporary Chats',async t=>{
 let store;
 await withFixture(t,async f=>{
  const {branch,products}=await setup(f),{chat}=products.branches[0],base=prefix('branches');
  const route=`${base}/conversations/${chat.id}/draft-attachments/${randomUUID()}?ownerId=scope-browser`;
  store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,'chat','',?,'retiring')").run(branch.id,'attachment-guard',chat.id);
  assert.equal((await f.api('DELETE',route)).status,404,'Inactive installation resources cannot be mutated');
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const deployed=branches.deploy({chatId:'',branchId:branch.id,expectedVersionId:'',idempotencyKey:'attachment-execution',definition:{schema:'ponderosa.branch.v1',name:'Temporary attachment boundary',trigger:{kind:'manual'},entry:'review',steps:[{id:'review',kind:'human_gate',prompt:'Review',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{}}});
  const execution=branches.accept(deployed.id,'attachment-input','Review');
  const temporary=store.createProject({label:'Temporary attachment context',chatOwned:true,branchId:branch.id,executionId:execution.id,hostPath:f.root,defaultEngine:'codex'});
  const denied=await f.api('DELETE',`${base}/conversations/${temporary.lastConversationId}/draft-attachments/${randomUUID()}?ownerId=scope-browser`);
  assert.equal(denied.status,409);assert.match(denied.body.error,/Execution-owned temporary/);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
