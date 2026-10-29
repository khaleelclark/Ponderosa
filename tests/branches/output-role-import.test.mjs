import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentStore,WorkspaceStore} from '../../packages/agents/dist/index.js';
import {withFixture,until} from '../shared/fixture.mjs';
import {validatePortableAgentPackage} from '../../apps/server/dist/portable-agent-package-validation.js';
const permission={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
const pkg=(mode='template')=>({schema:'ponderosa.agent-package.v1',mode,kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Role import fixture',rootRef:'root',agents:[{ref:'root',title:'Portable speaker',engine:'codex',managementPermissions:permission,...(mode==='full'?{history:[{role:'user',text:'Retained imported context'}]}:{})},{ref:'child',title:'Portable child',engine:'codex',managerRef:'root',managementPermissions:permission}],outputRoles:[{ref:'root',output:true,speaker:true},{ref:'child',output:true,speaker:false}]});
const installation=(portable=pkg())=>({schema:'ponderosa.branch-installation.v1',packageId:randomUUID(),mode:portable.mode,exportedAt:portable.exportedAt,definition:{schema:'ponderosa.branch.v1',name:'Role import',trigger:{kind:'manual'},entry:'worker',steps:[{id:'worker',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Perform controlled work'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats:[{ref:'chat',title:'Imported Chat',agents:portable.agents.map(node=>({ref:node.ref,...(node.managerRef?{managerRef:node.managerRef}:{}),definition:{...portable,kind:'agent',rootRef:node.ref,agents:[{...node,managerRef:undefined}],outputRoles:undefined}}))}],agentBindings:{worker:{chatRef:'chat',agentRef:'root'}},outputRoles:portable.outputRoles.map(({ref,...role})=>({chatRef:'chat',agentRef:ref,...role}))});
const preview=async(f,p,branchId)=>f.api('POST','/api/branches/install-preview',{package:p,bindings:{agents:{},directories:{workspace:f.root},engines:{codex:'codex'}},branchId});
async function installed(f,plan,full=false){let state=f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/confirm`,{acknowledgeFullImport:full}));if(state.state==='applying')state=await until(async()=>{const s=f.ok(await f.api('GET',`/api/branches/installations/${plan.id}`));return s.state==='completed'&&s;},'installation complete');assert.equal(state.state,'completed',state.error);return state;}
const blob=(p,chatId,metadata={})=>Buffer.from(JSON.stringify({conversationId:chatId,engineMapping:{codex:'codex'},...metadata})+'\n'+JSON.stringify(p));
const branchPrefix='/api/branches/engine';
const endpoint=(prefix,path)=>prefix?prefix+path.slice(4):path;
async function branchChat(f){const branch=f.ok(await f.api('POST','/api/branches',{name:'Destination',idempotencyKey:randomUUID()}));return f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Destination',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));}
async function reviewGeneric(f,p,chat,isBranch){return f.ok(await f.api('POST',endpoint(isBranch?branchPrefix:'',`/api/projects/${chat.projectId}/agent-role-preview`),blob(p,chat.id),{'content-type':'application/vnd.ponderosa.agent-import'}));}
async function importGeneric(f,p,chat,review,isBranch,key=randomUUID()){return f.api('POST',endpoint(isBranch?branchPrefix:'',`/api/projects/${chat.projectId}/import-agents`),{package:p,conversationId:chat.id,engineMapping:{codex:'codex'},...(review?{outputRoleReviewId:review.id}:{})},{'idempotency-key':key});}

test('portable output declarations reject unknown, foreign, duplicate and contradictory role authority',()=>{
 for(const mutate of [p=>p.outputRoles[0].url='/apps/foreign',p=>p.outputRoles[0].ref='foreign',p=>p.outputRoles.push(p.outputRoles[0]),p=>p.outputRoles[1].speaker=true,p=>p.outputRoles[0].output=false,p=>p.outputRoles[0].speaker='true']){const p=pkg();mutate(p);assert.throws(()=>validatePortableAgentPackage(p));}
});
for(const mode of ['template','full'])test(`${mode}: Branch role import/export/remap and collision preserve the existing speaker across restart`,async t=>withFixture(t,async f=>{
 const p=installation(pkg(mode)),one=f.ok(await preview(f,p));assert.equal(one.outputRoleReview.speaker,'activate');
 const first=await installed(f,one,mode==='full'),speaker=f.ok(await f.api('GET','/api/branches/assistant'));assert.equal(speaker.app.branchId,first.branchId);
 const exported=f.ok(await f.api('GET',`/api/branches/${first.branchId}/package?mode=${mode}`));assert.equal(exported.outputRoles.length,2);assert.equal(exported.chats[0].agents[0].definition.outputRoles,undefined);
 const next=f.ok(await preview(f,{...p,packageId:randomUUID()}));assert.match(next.outputRoleReview.warning,/You already have a Ponderosa speaker\. The imported speaker will be disabled\./);
 const second=await installed(f,next,mode==='full');assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,speaker.app.agentId);
 const chats=f.ok(await f.api('GET',`/api/branches/${second.branchId}/chats`));const agents=f.ok(await f.api('GET',`/api/branches/engine/projects/${chats[0].projectId}/agents`));assert.equal(agents.length,2);
 for(const agent of agents){const app=f.ok(await f.api('GET',`/api/branches/output-apps/${agent.id}`));assert.equal(app.speaker,false);}
 await f.reopen();assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,speaker.app.agentId);
}));

for(const mode of ['template','full'])test(`${mode}: generic organization imports require server review, activate only Branch owners, and expose inactive Core roles`,async t=>withFixture(t,async f=>{
 const core=await f.createChat('Core destination'),p=pkg(mode);assert.equal((await importGeneric(f,p,core)).status,400);
 const coreReview=await reviewGeneric(f,p,core,false);assert.equal(coreReview.inactive,true);assert.match(coreReview.warning,/inactive in this Core Chat/);
 const copied=f.ok(await importGeneric(f,p,core,coreReview,false));assert.equal((await f.api('GET',`/api/branches/output-apps/${copied.rootAgentId}`)).status,404);
 const dest=await branchChat(f),review=await reviewGeneric(f,p,dest,true),key=randomUUID();const result=f.ok(await importGeneric(f,p,dest,review,true,key));assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,result.rootAgentId);
 const exported=f.ok(await f.api('GET',`/api/branches/engine/agents/${result.rootAgentId}/export?mode=template&organization=true`));assert.equal(exported.outputRoles.length,2);assert.ok(exported.outputRoles.every(role=>exported.agents.some(a=>a.ref===role.ref)));
 const again=f.ok(await importGeneric(f,p,dest,review,true,key));assert.equal(again.rootAgentId,result.rootAgentId);
 const duplicate=f.ok(await f.api('POST',`/api/branches/engine/projects/${dest.projectId}/copy-agent`,{sourceAgentId:result.rootAgentId,conversationId:dest.id,mode,organization:true},{'idempotency-key':randomUUID()}));for(const id of duplicate.agentIds)assert.equal((await f.api('GET',`/api/branches/output-apps/${id}`)).status,404);
 const nextReview=await reviewGeneric(f,p,dest,true);assert.match(nextReview.warning,/already have/);const other=f.ok(await importGeneric(f,p,dest,nextReview,true));assert.equal(f.ok(await f.api('GET',`/api/branches/output-apps/${other.rootAgentId}`)).speaker,false);
 await f.reopen();assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,result.rootAgentId);
}));

test('two no-speaker previews and intervening default bootstrap require new collision review; reviewed inactive stays inactive',async t=>withFixture(t,async f=>{
 const p=installation(),first=f.ok(await preview(f,p)),second=f.ok(await preview(f,{...p,packageId:randomUUID()}));
 await installed(f,first);assert.equal((await f.api('POST',`/api/branches/installations/${second.id}/confirm`,{})).status,409);
 const inactive=f.ok(await preview(f,{...p,packageId:randomUUID()}));const before=f.ok(await f.api('GET','/api/branches/assistant'));
 f.ok(await f.api('POST','/api/branches/assistant',{enabled:false}));await installed(f,inactive);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);
 const pending=f.ok(await preview(f,{...p,packageId:randomUUID()}));const bootstrap=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true}));assert.notEqual(bootstrap.app.agentId,before.app.agentId);
 assert.equal((await f.api('POST',`/api/branches/installations/${pending.id}/confirm`,{})).status,409);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,bootstrap.app.agentId);
}));

for(const boundary of ['before-role-journal','after-role-journal','completion-receipt'])test(`generic finalization recovers ${boundary} without changing IDs or resurrecting later removals`,async t=>{
 let store;await withFixture(t,async f=>{
  const dest=await branchChat(f),p=pkg(),review=await reviewGeneric(f,p,dest,true),key=randomUUID();
  const original=WorkspaceStore.prototype.updatePreferences;let fired=false;
  if(boundary==='completion-receipt')store.sqlite.exec("CREATE TEMP TRIGGER refuse_role_receipt BEFORE UPDATE OF result_json ON agent_creation_operations WHEN json_extract(NEW.result_json,'$.outputRoleFinalization.done')=1 BEGIN SELECT RAISE(ABORT,'Controlled finalization receipt failure'); END");
  else WorkspaceStore.prototype.updatePreferences=function(patch){const applies=Object.values(patch.outputApps?.importReviews??{}).some(entry=>entry.applied);if(applies&&!fired){fired=true;if(boundary==='after-role-journal')original.call(this,patch);throw Error('Controlled '+boundary);}return original.call(this,patch);};
  let response;try{response=await importGeneric(f,p,dest,review,true,key);}finally{WorkspaceStore.prototype.updatePreferences=original;}
  assert.equal(response.status,409,JSON.stringify(response));
  const op=store.sqlite.prepare('SELECT id,result_json FROM agent_creation_operations WHERE idempotency_key=?').get(key),saved=JSON.parse(op.result_json);assert.ok(saved.rootAgentId);assert.equal(saved.outputRoleFinalization.done,undefined);
  if(boundary==='completion-receipt')store.sqlite.exec('DROP TRIGGER refuse_role_receipt');
  if(boundary!=='before-role-journal'){f.ok(await f.api('PUT',`/api/branches/output-apps/${saved.rootAgentId}`,{enabled:false}));assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);}
  await f.reopen();
  const recovered=f.ok(await importGeneric(f,p,dest,review,true,key));assert.equal(recovered.rootAgentId,saved.rootAgentId);assert.equal(recovered.outputRoleFinalization.done,true);
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,boundary==='before-role-journal');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM assistant_report_scan WHERE speaker_agent_id=?').get(saved.rootAgentId).n,1);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('published Branch outcome survives completion receipt failure and later explicit role removal',async t=>{
 let store;await withFixture(t,async f=>{
  const p=installation(),plan=f.ok(await preview(f,p));
  store.sqlite.exec("CREATE TEMP TRIGGER refuse_branch_role_completion BEFORE UPDATE OF state ON branch_installation_plans WHEN NEW.state='completed' AND json_extract(OLD.preview_json,'$.published')=1 BEGIN SELECT RAISE(ABORT,'Controlled Branch completion failure'); END");
  const response=f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/confirm`,{}));assert.equal(response.state,'applying');assert.match(response.error,/completion failure/);
  const current=f.ok(await f.api('GET','/api/branches/assistant'));assert.equal(current.enabled,true);
  f.ok(await f.api('PUT',`/api/branches/output-apps/${current.app.agentId}`,{enabled:false}));
  store.sqlite.exec('DROP TRIGGER refuse_branch_role_completion');await f.reopen();
  await until(async()=>f.ok(await f.api('GET',`/api/branches/installations/${plan.id}`)).state==='completed','recovered Branch finalization');
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);
  assert.equal(f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/confirm`,{})).branchId,response.branchId);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('Branch updates retain omitted roles and explicitly preview additions/removals without touching unrelated outputs',async t=>withFixture(t,async f=>{
 const p=installation(),first=await installed(f,f.ok(await preview(f,p))),before=f.ok(await f.api('GET','/api/branches/assistant'));
 const omitted=structuredClone(p);delete omitted.outputRoles;let review=f.ok(await preview(f,omitted,first.branchId));assert.equal(review.outputRoleReview,undefined);await installed(f,review);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,before.app.agentId);
 const removed=structuredClone(p);removed.outputRoles[0]={chatRef:'chat',agentRef:'root',output:false,speaker:false};review=f.ok(await preview(f,removed,first.branchId));assert.ok(review.operations.some(op=>op.resource==='Output role'));await installed(f,review);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);
 assert.equal((await f.api('GET',`/api/branches/output-apps/${before.app.agentId}`)).status,404);
 const added=f.ok(await preview(f,p,first.branchId));await installed(f,added);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,before.app.agentId);
 const self=f.ok(await preview(f,p,first.branchId));assert.equal(self.outputRoleReview.speaker,'activate');assert.equal(self.outputRoleReview.warning,undefined);await installed(f,self);
}));

test('Branch validator normalizes nested refs by Chat and refuses enclosing contradictions before publication',async t=>withFixture(t,async f=>{
 const p=installation();p.chats[0].agents[0].definition.outputRoles=[{ref:'root',output:true,speaker:true}];
 assert.equal((await preview(f,p)).status,200);
 p.outputRoles[0].speaker=false;assert.equal((await preview(f,p)).status,400);
 p.outputRoles[0].speaker=true;p.outputRoles[0].chatRef='foreign';assert.equal((await preview(f,p)).status,400);
 assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);
}));

test('new post-publication collision requires explicit generic re-review without recreating imported Agents',async t=>{
 let store;await withFixture(t,async f=>{
  const dest=await branchChat(f),p=pkg(),review=await reviewGeneric(f,p,dest,true),key=randomUUID(),original=WorkspaceStore.prototype.updatePreferences;
  WorkspaceStore.prototype.updatePreferences=function(patch){if(Object.values(patch.outputApps?.importReviews??{}).some(entry=>entry.applied))throw Error('Controlled publication-to-journal interruption');return original.call(this,patch);};
  let response;try{response=await importGeneric(f,p,dest,review,true,key);}finally{WorkspaceStore.prototype.updatePreferences=original;}
  assert.equal(response.status,409);const op=store.sqlite.prepare('SELECT id,result_json FROM agent_creation_operations WHERE idempotency_key=?').get(key),saved=JSON.parse(op.result_json);
  const current=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true}));await f.reopen();assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,current.app.agentId);
  assert.equal((await importGeneric(f,p,dest,review,true,key)).status,409);
  const route=endpoint(branchPrefix,`/api/projects/${dest.projectId}/agent-role-finalizations/${op.id}`);
  const next=f.ok(await f.api('POST',route,{}));assert.match(next.warning,/already have/);
  const finalized=f.ok(await f.api('POST',route,{reviewId:next.id}));assert.equal(finalized.rootAgentId,saved.rootAgentId);assert.equal(finalized.outputRoleFinalization.done,true);
  assert.equal(f.ok(await f.api('GET',`/api/branches/output-apps/${saved.rootAgentId}`)).speaker,false);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,current.app.agentId);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('Branch publication-to-role interruption re-reviews collision and preserves the winning speaker',async t=>withFixture(t,async f=>{
 const p=installation(),plan=f.ok(await preview(f,p)),original=WorkspaceStore.prototype.updatePreferences;
 WorkspaceStore.prototype.updatePreferences=function(patch){if(Object.values(patch.outputApps?.importReviews??{}).some(entry=>entry.applied))throw Error('Controlled Branch role interruption');return original.call(this,patch);};
 let response;try{response=f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/confirm`,{}));}finally{WorkspaceStore.prototype.updatePreferences=original;}
 assert.equal(response.state,'applying');assert.equal((await f.api('POST',`/api/branches/installations/${plan.id}/cancel`,{})).status,409);
 const current=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true}));
 const next=f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/role-review`,{}));assert.match(next.warning,/already have/);
 const final=f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/confirm`,{outputRoleReviewId:next.id}));assert.equal(final.state,'completed');assert.equal(final.branchId,response.branchId);
 assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,current.app.agentId);
}));

test('failed publication and cancellation leave no imported role effects; role-free imports still work',async t=>{
 let store;await withFixture(t,async f=>{
  const before=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true})),p=installation(),plan=f.ok(await preview(f,p));
  store.sqlite.exec("CREATE TEMP TRIGGER refuse_role_publication BEFORE UPDATE OF active_version_id ON branches WHEN NEW.id!=OLD.id OR NEW.id!='"+before.app.branchId+"' BEGIN SELECT RAISE(ABORT,'Controlled pre-publication failure'); END");
  const staged=f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/confirm`,{}));assert.equal(staged.state,'applying');assert.match(staged.error,/pre-publication/);
  f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/cancel`,{}));await until(async()=>f.ok(await f.api('GET',`/api/branches/installations/${plan.id}`)).state==='canceled','canceled staging cleanup');
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,before.app.agentId);
  store.sqlite.exec('DROP TRIGGER refuse_role_publication');const free=installation();delete free.outputRoles;const empty=f.ok(await preview(f,free));assert.equal(empty.outputRoleReview,undefined);await installed(f,empty);
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,before.app.agentId);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('inactive collision replay cannot resurrect a later human removal of an imported output',async t=>{
 let store;await withFixture(t,async f=>{
  const winner=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true})),dest=await branchChat(f),p=pkg(),review=await reviewGeneric(f,p,dest,true),key=randomUUID(),original=WorkspaceStore.prototype.updatePreferences;
  WorkspaceStore.prototype.updatePreferences=function(patch){if(Object.values(patch.outputApps?.importReviews??{}).some(entry=>entry.applied))throw Error('Controlled inactive role interruption');return original.call(this,patch);};
  let response;try{response=await importGeneric(f,p,dest,review,true,key);}finally{WorkspaceStore.prototype.updatePreferences=original;}
  assert.equal(response.status,409);const saved=JSON.parse(store.sqlite.prepare('SELECT result_json FROM agent_creation_operations WHERE idempotency_key=?').get(key).result_json);
  f.ok(await f.api('PUT',`/api/branches/output-apps/${saved.rootAgentId}`,{enabled:false}));
  await f.reopen();assert.equal((await importGeneric(f,p,dest,review,true,key)).status,409);assert.equal((await f.api('GET',`/api/branches/output-apps/${saved.rootAgentId}`)).status,404);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,winner.app.agentId);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('a real speaker move during generic record staging fences the old activation review and rolls back imported roles',async t=>{
 let store;await withFixture(t,async f=>{
  const dest=await branchChat(f),other=await branchChat(f),human=f.ok(await f.api('POST',`/api/branches/engine/projects/${other.projectId}/agents`,{title:'Human selected speaker',engine:'codex',conversationId:other.id,idempotencyKey:randomUUID()})),p=pkg('full'),review=await reviewGeneric(f,p,dest,true);
  p.agents[0].history=Array.from({length:500},(_,i)=>({role:'user',text:'Staged context '+i}));
  const bound=await reviewGeneric(f,p,dest,true),original=store.addAgentCreationOperationMember;let change;
  store.addAgentCreationOperationMember=function(...args){const result=original.apply(this,args);if(!change)change=f.api('PUT',`/api/branches/output-apps/${human.id}`,{enabled:true,speaker:true});return result;};
  let response;try{response=await importGeneric(f,p,dest,bound,true);}finally{store.addAgentCreationOperationMember=original;}
  assert.equal((await change).status,200);assert.equal(response.status,409,JSON.stringify(response));assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,human.id);
  assert.equal(f.ok(await f.api('GET',`/api/branches/engine/projects/${dest.projectId}/agents`)).length,0);assert.equal(review.speaker,'activate');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('pending default bootstrap preserves an intervening imported/human speaker and never publishes a second default',async t=>{
 const {OutputAgentApps}=await import('../../apps/server/dist/output-agent-apps.js');
 const {BranchStore,CoordinationV3Store}=await import('../../packages/agents/dist/index.js');let store;
 await withFixture(t,async f=>{
  const dest=await branchChat(f),human=f.ok(await f.api('POST',`/api/branches/engine/projects/${dest.projectId}/agents`,{title:'Chosen speaker',engine:'codex',conversationId:dest.id,idempotencyKey:randomUUID()}));
  let preferences={},resume,published=0;const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)),original=branches.deploy.bind(branches);branches.deploy=(...args)=>{published++;return original(...args);};
  const wait=new Promise(resolve=>resume=resolve),owner=new OutputAgentApps(store,branches,{cursor:()=>0,getPreferences:()=>preferences,updatePreferences:patch=>(preferences={...preferences,...patch})},async()=>{await wait;return {id:dest.id,projectId:dest.projectId};},{validateAgent(){},async importAgent(){return {rootAgentId:human.id,agentIds:[human.id]};}},()=> 'codex');
  const initializing=owner.initialize(true);assert.ok(preferences.outputApps.setup);owner.designate(human.id,true,true);resume();const result=await initializing;
  assert.equal(result.app.agentId,human.id);assert.equal(preferences.outputApps.setup,undefined);assert.equal(published,0);assert.equal((await owner.initialize(true)).app.agentId,human.id);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('equal Agent refs in different imported Chats map to distinct eligible output owners',async t=>withFixture(t,async f=>{
 const p=installation();p.chats.push({...structuredClone(p.chats[0]),ref:'second-chat',title:'Second Chat'});
 p.outputRoles.push({chatRef:'second-chat',agentRef:'root',output:true,speaker:false},{chatRef:'second-chat',agentRef:'child',output:true,speaker:false});
 const result=await installed(f,f.ok(await preview(f,p))),chats=f.ok(await f.api('GET',`/api/branches/${result.branchId}/chats`));assert.equal(chats.length,2);
 const ids=new Set();for(const chat of chats){const agents=f.ok(await f.api('GET',`/api/branches/engine/projects/${chat.projectId}/agents`));for(const agent of agents){ids.add(agent.id);assert.equal(f.ok(await f.api('GET',`/api/branches/output-apps/${agent.id}`)).chatId,chat.id);}}
 assert.equal(ids.size,4);assert.ok(ids.has(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId));
}));

test('generic confirmation is bound to exact package contents, destination and a single durable operation',async t=>withFixture(t,async f=>{
 const first=await branchChat(f),second=await branchChat(f),p=pkg(),review=await reviewGeneric(f,p,first,true);
 const altered=structuredClone(p);altered.agents[0].title='Changed after review';assert.ok((await importGeneric(f,altered,first,review,true)).status>=400);
 assert.ok((await importGeneric(f,p,second,review,true)).status>=400);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);
 const good=await reviewGeneric(f,p,first,true);f.ok(await importGeneric(f,p,first,good,true));assert.ok((await importGeneric(f,p,first,good,true)).status>=400);
 assert.equal(f.ok(await f.api('GET',`/api/branches/engine/projects/${first.projectId}/agents`)).length,2);assert.equal(f.ok(await f.api('GET',`/api/branches/engine/projects/${second.projectId}/agents`)).length,0);
}));

test('background binary import exposes durable role recovery and completes the same operation after collision confirmation',async t=>withFixture(t,async f=>{
 const dest=await branchChat(f),p=pkg(),review=await reviewGeneric(f,p,dest,true),key=randomUUID(),original=WorkspaceStore.prototype.updatePreferences;
 WorkspaceStore.prototype.updatePreferences=function(patch){if(Object.values(patch.outputApps?.importReviews??{}).some(entry=>entry.applied))throw Error('Controlled background role interruption');return original.call(this,patch);};
 let op,pending;
 try{
  op=f.ok(await f.api('POST',endpoint(branchPrefix,`/api/projects/${dest.projectId}/agent-import-operations`),blob(p,dest.id,{outputRoleReviewId:review.id}),{'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':key}));
  pending=await until(async()=>{const value=f.ok(await f.api('GET',endpoint(branchPrefix,`/api/projects/${dest.projectId}/agent-import-operations/${op.id}`)));return value.outputRoleRecoveryId&&value;},'durable background role recovery');
 }finally{WorkspaceStore.prototype.updatePreferences=original;}
 assert.equal(pending.status,'pending');assert.equal(pending.phase,'finalizing');assert.match(pending.error,/role/);
 const winner=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true}));
 const endpointPath=endpoint(branchPrefix,`/api/projects/${dest.projectId}/agent-role-finalizations/${pending.outputRoleRecoveryId}`);
 const next=f.ok(await f.api('POST',endpointPath,{}));assert.match(next.warning,/already have/);const finished=f.ok(await f.api('POST',endpointPath,{reviewId:next.id}));
 const terminal=await until(async()=>{const value=f.ok(await f.api('GET',endpoint(branchPrefix,`/api/projects/${dest.projectId}/agent-import-operations/${op.id}`)));return value.status==='completed'&&value;},'same background operation completion');
 assert.equal(terminal.id,op.id);assert.equal(terminal.result.rootAgentId,finished.rootAgentId);assert.equal(terminal.result.outputRoleFinalization.done,true);assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,winner.app.agentId);
}));

test('deleting the previously reviewed speaker does not activate an imported collision outcome',async t=>withFixture(t,async f=>{
 const previous=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true})),plan=f.ok(await preview(f,installation()));assert.equal(plan.outputRoleReview.speaker,'inactive');
 const removal=f.ok(await f.api('POST',`/api/branches/engine/projects/${previous.app.projectId}/agent-deletions/preview`,{rootAgentIds:[previous.app.agentId]}));
 f.ok(await f.api('POST',`/api/branches/engine/projects/${previous.app.projectId}/agent-deletions/commit`,{rootAgentIds:[previous.app.agentId],previewHash:removal.previewHash}));
 assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);await installed(f,plan);await f.reopen();assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);
}));

test('retiring a mapped speaker uses existing resource cleanup while unrelated imported outputs remain active',async t=>withFixture(t,async f=>{
 const p=installation(),first=await installed(f,f.ok(await preview(f,p))),speaker=f.ok(await f.api('GET','/api/branches/assistant')).app;
 const changed=structuredClone(p);changed.chats[0].agents=changed.chats[0].agents.filter(a=>a.ref==='child');delete changed.chats[0].agents[0].managerRef;changed.agentBindings.worker.agentRef='child';delete changed.outputRoles;
 const review=f.ok(await preview(f,changed,first.branchId));assert.ok(review.operations.some(op=>op.kind==='remove-after-active-executions-drain'));await installed(f,review);
 assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);assert.equal((await f.api('GET',`/api/branches/output-apps/${speaker.agentId}`)).status,404);
 const chats=f.ok(await f.api('GET',`/api/branches/${first.branchId}/chats`));await until(async()=>f.ok(await f.api('GET',`/api/branches/engine/projects/${chats[0].projectId}/agents`)).length===1,'retired speaker cleanup');
 const child=f.ok(await f.api('GET',`/api/branches/engine/projects/${chats[0].projectId}/agents`))[0];assert.equal(f.ok(await f.api('GET',`/api/branches/output-apps/${child.id}`)).speaker,false);
}));
