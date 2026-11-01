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
 // Deferred integration: grouped activation uses one receipt and one reviewed Shared cwd.
 const grouped=structuredClone(pkg);grouped.packageId='test.grouped-publication';grouped.mode='full';
 const leader=grouped.chats[0].agents[0];leader.definition.mode='full';
 const child=structuredClone(leader);child.ref='child';child.managerRef='speaker';child.definition.rootRef='child';child.definition.agents[0].ref='child';child.definition.agents[0].title='Child';grouped.chats[0].agents.push(child);
 const {CAPABILITY_IDS}=await import('@ponderosa/core');
 for(const entry of grouped.chats[0].agents){const node=entry.definition.agents[0];node.workingCopyMode='shared';node.workingRootRef='independent-export-root';node.workingFolder={directories:[],excludedPaths:[]};node.accessSettings={restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]};}
 const groupPreview=await api('POST','/api/branches/install-preview',{package:grouped,bindings:{directories:{workspace:root},agents:{},engines:{codex:'codex'}},fileSelections:{[JSON.stringify(['chat','speaker'])]:{newManagedChatFolderName:path.basename(root)+'-group',workingFilesActivation:{},workingFilesDestination:path.join(root,'group-recovery')}}});
 await api('POST','/api/branches/installations/'+groupPreview.id+'/confirm',{acknowledgeFullImport:true});
 const groupUrl='/api/branches/installations/'+groupPreview.id,rootReview=(await api('GET',groupUrl)).workingRootReview;assert.ok(rootReview);
 const invalidRoot=await app.inject({method:'POST',url:groupUrl+'/working-root-review',payload:{chatRef:'chat',agentRef:'speaker',sharedRoot:'/foreign'}});assert.equal(invalidRoot.statusCode,409);
 await api('POST',groupUrl+'/working-root-review',{chatRef:'chat',agentRef:'speaker',sharedRoot:rootReview.sharedRoot});
 await api('POST',groupUrl+'/confirm',{});
 const groupAccess=(await api('GET',groupUrl)).accessSettingsReview;assert.deepEqual(groupAccess.agentRefs,['speaker','child']);
 await api('POST',groupUrl+'/access-review',{chatRef:'chat',agentRef:'speaker',resolution:{action:'keep_destination',reviewSha256:groupAccess.review.reviewSha256,agentActions:{speaker:'keep_destination',child:'use_source'}}});
 await api('POST',groupUrl+'/confirm',{});
 const groupDone=await api('GET',groupUrl);assert.equal(groupDone.state,'completed',groupDone.error);
 const groupConfig=await api('GET','/api/branches/'+groupDone.branchId+'/configuration'),groupLeader=store.getAgent(groupConfig.agents.speaker),groupChild=store.listAgents(groupLeader.projectId).find(a=>a.managerAgentId===groupLeader.id);assert.ok(groupChild);
 assert.equal(groupLeader.workingCopy.rootPath,rootReview.sharedRoot);assert.equal(groupChild.workingCopy.rootPath,rootReview.sharedRoot);
 const groupReceipts=store.sqlite.prepare("SELECT DISTINCT creation_operation_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref!=''").all(groupDone.branchId);assert.equal(groupReceipts.length,1);
 const {CapabilityPolicyStore}=await import('@ponderosa/agents'),policies=new CapabilityPolicyStore(store.sqlite);assert.equal(policies.resolveForAgent(groupLeader.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),false);assert.equal(policies.resolveForAgent(groupChild.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),true);
 assert.equal(groupDone.importResults[JSON.stringify(['chat','speaker'])].liveWorkingRoots[0].agentIds.length,2);
 t.after(()=>{if(passed)rmSync(rootReview.sharedRoot,{recursive:true,force:true});});

 await app.close();app=undefined;store.close();store=new AgentStore(path.join(root,'state'));
 assert.equal(store.getAgent(agent.id).conversationId,chat.id);
 assert.equal(store.sqlite.prepare(`SELECT COUNT(*) n FROM agent_creation_operations WHERE status='completed'`).get().n,2);
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
