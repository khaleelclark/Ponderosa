import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';
import {createServer} from '../../apps/server/dist/app.js';

test('Branch package atomically activates staged Chat and Agent before validating published bindings',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-install-publication-'));
 let store=new AgentStore(path.join(root,'state')),app,passed=false;
 t.after(async()=>{if(app){app.prepareForShutdown();await app.close()}store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic('Retained fixture: '+root)});
 const run=async function*(){throw new Error('No provider Run is allowed in installation regression')};
 const adapter={id:'codex',displayName:'Controlled installation adapter',trustedSystemPromptChannel:'developer',listModels:()=>[{id:'fixture',label:'Fixture'}],listEfforts:()=>[{id:'medium',label:'Medium'}],defaultModel:()=>'fixture',defaultEffort:()=>'medium',seed:run,continue:run};
 app=createServer({dataDir:path.join(root,'state'),store,logger:false,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});
 const api=async(method,url,payload)=>{const r=await app.inject({method,url,...(payload?{payload}:{})});assert.equal(r.statusCode,200,r.body);return r.json()};
 const exportedAt=new Date().toISOString();
 const pkg={schema:'ponderosa.branch-installation.v1',packageId:'test.installation-publication',mode:'template',exportedAt,
  definition:{schema:'ponderosa.branch.v1',name:'Installation fixture',trigger:{kind:'manual'},entry:'agent',controls:[],steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'speaker'},instructions:'Synthetic only'}],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},
  chats:[{ref:'chat',title:'Installed Chat',agents:[{ref:'speaker',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt,sourceLabel:'Synthetic',rootRef:'speaker',agents:[{ref:'speaker',title:'Speaker',engine:'codex',model:'fixture',effort:'medium',initialInstructions:'Keep initial guidance distinct from portable history.',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]}}]}],
  agentBindings:{speaker:{chatRef:'chat',agentRef:'speaker'}}};
 const badDestinations=await app.inject({method:'POST',url:'/api/branches/install-preview',payload:{package:pkg,bindings:{directories:{workspace:root},agents:{},engines:{codex:'codex'}},fileSelections:{[JSON.stringify(['chat','speaker'])]:{workingRootDestinations:{a:path.join(root,'new'),b:path.join(root,'new','child')}}}}});
 assert.equal(badDestinations.statusCode,400);assert.match(badDestinations.json().error,/distinct|nest/);
 for(const choice of [
  {workingFilesActivation:{}},
  {workingFilesActivation:{sharedRoot:root},workingFilesDestination:path.join(root,'recovery')},
  {newManagedChatFolderName:'../escape',workingFilesActivation:{},workingFilesDestination:path.join(root,'recovery')}
 ]){
  const invalid=await app.inject({method:'POST',url:'/api/branches/install-preview',payload:{package:pkg,bindings:{directories:{workspace:root},agents:{},engines:{codex:'codex'}},fileSelections:{[JSON.stringify(['chat','speaker'])]:choice}}});
  assert.equal(invalid.statusCode,400,'live roots require recovery copies and post-creation exact review');
 }

 const preview=await api('POST','/api/branches/install-preview',{package:pkg,bindings:{directories:{workspace:root},agents:{},engines:{codex:'codex'}}});
 const result=await api('POST','/api/branches/installations/'+preview.id+'/confirm',{});
 assert.equal(result.state,'completed',result.error);
 const config=await api('GET','/api/branches/'+result.branchId+'/configuration');
 const agent=store.getAgent(config.agents.speaker);assert.ok(agent);
 const chat=store.getConversation(agent.conversationId);assert.equal(chat.branchId,result.branchId);
 const resources=store.sqlite.prepare('SELECT state,staging_plan_id FROM branch_installation_resources WHERE branch_id=?').all(result.branchId);
 assert.equal(resources.length,2);assert.ok(resources.every(r=>r.state==='active'&&r.staging_plan_id===null));
 assert.equal((await api('POST','/api/branches/installations/'+preview.id+'/confirm',{})).state,'completed');
 assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n,1);
 await app.close();app=undefined;store.close();store=new AgentStore(path.join(root,'state'));
 assert.equal(store.getAgent(agent.id).conversationId,chat.id);
 assert.equal(store.sqlite.prepare(`SELECT COUNT(*) n FROM agent_creation_operations WHERE status='completed'`).get().n,1);
 passed=true;
});

for(const action of ['keep_destination','use_source','cancel'])test('workflow installation durably reviews access before import: '+action,async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-access-review-'));
 let store=new AgentStore(path.join(root,'state')),app,passed=false;
 t.after(async()=>{if(app){app.prepareForShutdown();await app.close()}store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic('Retained fixture: '+root)});
 const run=async function*(){throw new Error('No provider Run is allowed in installation regression')};
 const adapter={id:'codex',displayName:'Controlled installation adapter',trustedSystemPromptChannel:'developer',listModels:()=>[{id:'fixture',label:'Fixture'}],listEfforts:()=>[{id:'medium',label:'Medium'}],defaultModel:()=>'fixture',defaultEffort:()=>'medium',seed:run,continue:run};
 app=createServer({dataDir:path.join(root,'state'),store,logger:false,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});
 const api=async(method,url,payload)=>{const r=await app.inject({method,url,...(payload?{payload}:{})});assert.equal(r.statusCode,200,r.body);return r.json()};
 const exportedAt=new Date().toISOString();
 const pkg={schema:'ponderosa.branch-installation.v1',packageId:'test.installation-publication',mode:'template',exportedAt,
  definition:{schema:'ponderosa.branch.v1',name:'Installation fixture',trigger:{kind:'manual'},entry:'agent',controls:[],steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'speaker'},instructions:'Synthetic only'}],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},
  chats:[{ref:'chat',title:'Installed Chat',agents:[{ref:'speaker',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt,sourceLabel:'Synthetic',rootRef:'speaker',agents:[{ref:'speaker',title:'Speaker',engine:'codex',model:'fixture',effort:'medium',initialInstructions:'Keep initial guidance distinct from portable history.',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]}}]}],
  agentBindings:{speaker:{chatRef:'chat',agentRef:'speaker'}}};
 const {CAPABILITY_IDS}=await import('@ponderosa/core');
 pkg.chats[0].agents[0].definition.agents[0].accessSettings={restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]};
 const preview=await api('POST','/api/branches/install-preview',{package:pkg,bindings:{directories:{workspace:root},agents:{},engines:{codex:'codex'}}});
 await api('POST','/api/branches/installations/'+preview.id+'/confirm',{});
 const url='/api/branches/installations/'+preview.id;
 const waiting=await api('GET',url),pending=waiting.accessSettingsReview;
 assert.equal(waiting.state,'applying');assert.ok(pending);
 assert.equal(store.sqlite.prepare("SELECT count(*) n FROM branch_installation_resources WHERE branch_id=? AND agent_ref!=''").get(waiting.branchId).n,0);
 if(action==='cancel'){
  await api('POST',url+'/cancel',{});
  const refused=await app.inject({method:'POST',url:url+'/access-review',payload:{chatRef:pending.chatRef,agentRef:pending.agentRef,resolution:{action:'use_source',reviewSha256:pending.review.reviewSha256}}});
  assert.equal(refused.statusCode,409);assert.notEqual((await api('GET',url)).state,'applying');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM branch_installation_resources WHERE branch_id=? AND agent_ref!=''").get(waiting.branchId).n,0);passed=true;return;
 }
 const stale=await app.inject({method:'POST',url:url+'/access-review',payload:{chatRef:pending.chatRef,agentRef:pending.agentRef,resolution:{action,reviewSha256:'0'.repeat(64)}}});
 assert.equal(stale.statusCode,409);assert.ok(stale.json().accessSettingsReview);
 await api('POST',url+'/access-review',{chatRef:pending.chatRef,agentRef:pending.agentRef,resolution:{action,reviewSha256:pending.review.reviewSha256}});
 // A fresh confirm drives the ordinary scheduler path; approval is not publication.
 await api('POST',url+'/confirm',{});
 const finished=await api('GET',url);assert.equal(finished.state,'completed',finished.error);
 const config=await api('GET','/api/branches/'+finished.branchId+'/configuration');
 const {CapabilityPolicyStore}=await import('@ponderosa/agents');
 const policy=new CapabilityPolicyStore(store.sqlite).resolveForAgent(config.agents.speaker);
 assert.equal(policy.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),action==='use_source');
 assert.equal((await app.inject({method:'POST',url:url+'/access-review',payload:{chatRef:pending.chatRef,agentRef:pending.agentRef,resolution:{action,reviewSha256:pending.review.reviewSha256}}})).statusCode,409);
 passed=true;
});
