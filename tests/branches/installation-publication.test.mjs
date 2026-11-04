import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';
import {createServer} from '../../apps/server/dist/app.js';
import {composeAgentPackages} from '../../apps/server/dist/compose-agent-packages.js';

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
 assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL AND conversation_id=?').get(chat.id).n,1);
 // Grouped activation uses one receipt and one reviewed Shared cwd, including restart after access review.
 for(const forest of [false,true]){
 const grouped=structuredClone(pkg);grouped.packageId='test.grouped-publication-'+forest;grouped.mode='full';
 const leader=grouped.chats[0].agents[0];leader.definition.mode='full';
 const child=structuredClone(leader);child.ref='child';if(!forest)child.managerRef='speaker';child.definition.rootRef='child';child.definition.agents[0].ref='child';child.definition.agents[0].title='Child';grouped.chats[0].agents.push(child);
 const {CAPABILITY_IDS}=await import('@ponderosa/core');
 for(const entry of grouped.chats[0].agents){const node=entry.definition.agents[0];node.workingCopyMode='shared';node.sourceChat={ref:'original-chat',title:'Original'};node.workingFolder={directories:[],excludedPaths:[]};node.accessSettings={restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]};}
 const composed=(await composeAgentPackages(grouped.chats[0].agents.map(entry=>({ref:entry.ref,managerRef:entry.managerRef,package:entry.definition})))).package;
 const rootDestinations=Object.fromEntries([...new Set(composed.agents.map(node=>node.workingRootRef).filter(Boolean))].map((ref,i)=>[ref,path.join(root,'group-recovery-'+forest+'-'+i)]));
 const groupPreview=await api('POST','/api/branches/install-preview',{package:grouped,bindings:{directories:{workspace:root},agents:{},engines:{codex:'codex'}},fileSelections:{[JSON.stringify(['chat','speaker'])]:{newManagedChatFolderName:path.basename(root)+'-group-'+forest,workingFilesActivation:{},workingRootDestinations:rootDestinations}}});
 await api('POST','/api/branches/installations/'+groupPreview.id+'/confirm',{acknowledgeFullImport:true});
 const groupUrl='/api/branches/installations/'+groupPreview.id,rootReview=(await api('GET',groupUrl)).workingRootReview;assert.ok(rootReview);
 for(const payload of [{chatRef:'chat',agentRef:'speaker'},{chatRef:'chat',agentRef:'child',sharedRoot:rootReview.sharedRoot}]){
  assert.equal((await app.inject({method:'POST',url:groupUrl+'/working-root-review',payload})).statusCode,409);
 }
 const reviewedChat=store.getConversation(rootReview.chatId),reviewedProject=store.getProject(reviewedChat.projectId);
 assert.equal(store.isManagedProjectImportDestination(reviewedProject.id),true);
 const projectFile=path.join(root,'state','projects',reviewedProject.id,'project.json'),originalProject=readFileSync(projectFile,'utf8');
 const canonicalProject=JSON.parse(originalProject);
 for(const change of [{hostPath:path.join(root,'foreign')},{creationHostPath:'managed:workspaces/foreign'},{creationIdempotencyKey:undefined},{managedWorkspaceName:undefined}]){
  writeFileSync(projectFile,JSON.stringify({...canonicalProject,...change}));
  assert.equal(store.isManagedProjectImportDestination(reviewedProject.id),false,'missing or foreign managed identity must refuse');
 }
 writeFileSync(projectFile,originalProject);
 const invalidRoot=await app.inject({method:'POST',url:groupUrl+'/working-root-review',payload:{chatRef:'chat',agentRef:'speaker',sharedRoot:'/foreign'}});assert.equal(invalidRoot.statusCode,409);
 await api('POST',groupUrl+'/working-root-review',{chatRef:'chat',agentRef:'speaker',sharedRoot:rootReview.sharedRoot});
 await api('POST',groupUrl+'/confirm',{});
 const groupAccess=(await api('GET',groupUrl)).accessSettingsReview;assert.deepEqual(groupAccess.agentRefs,['speaker','child']);
 // A prior write-ahead destination intent with no directory is not retained data.
 const absent=path.join(root,'never-created-'+forest);
 const absentIntent=store.beginAgentCreationOperation({projectId:reviewedChat.projectId,conversationId:reviewedChat.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:'branch-install:'+groupPreview.id+':absent-intent',payloadHash:'fixture-absent-intent'}).operation;
 store.updateAgentCreationOperation(absentIntent.id,{status:'rolled_back',result:{workingRootDestinations:{uncreated:absent},liveWorkingProjectRoot:reviewedProject.hostPath}});
 assert.equal(existsSync(absent),false);assert.equal(existsSync(reviewedProject.hostPath),true);
 // A retained path on a different plan key must not hold this plan.
 const unrelated=path.join(root,'unrelated-retained-'+forest);mkdirSync(unrelated);
 const other=store.beginAgentCreationOperation({projectId:reviewedChat.projectId,conversationId:reviewedChat.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:'branch-install:'+groupPreview.id+'-other:0',payloadHash:'fixture-other-plan'}).operation;
 store.updateAgentCreationOperation(other.id,{status:'rolled_back',result:{workingFilesDestination:unrelated}});

 // Keep this restart test before grouped-import admission. TEMP trigger goes
 // away on close; no recovery folder or Agent import is created by the refusal.
 store.sqlite.exec("CREATE TEMP TRIGGER delay_group_import_before_restart BEFORE INSERT ON agent_creation_operations WHEN NEW.kind='import' AND NEW.idempotency_key LIKE 'branch-install:%:group' BEGIN SELECT RAISE(ABORT,'controlled pre-admission pause'); END");
 await api('POST',groupUrl+'/access-review',{chatRef:'chat',agentRef:'speaker',resolution:{action:'keep_destination',reviewSha256:groupAccess.review.reviewSha256,agentActions:{speaker:'keep_destination',child:'use_source'}}});
 assert.equal((await app.inject({method:'POST',url:groupUrl+'/working-root-review',payload:{chatRef:'chat',agentRef:'speaker',sharedRoot:rootReview.sharedRoot}})).statusCode,409,'consumed root review cannot be replayed');
 app.prepareForShutdown();await app.close();app=undefined;store.close();store=new AgentStore(path.join(root,'state'));
 app=createServer({dataDir:path.join(root,'state'),store,logger:false,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});
 await api('POST',groupUrl+'/confirm',{});
 let groupDone;const deadline=Date.now()+10000;while(Date.now()<deadline){groupDone=await api('GET',groupUrl);if(groupDone.state==='completed')break;await new Promise(r=>setTimeout(r,25));}assert.equal(groupDone.state,'completed',groupDone.error);
 const groupConfig=await api('GET','/api/branches/'+groupDone.branchId+'/configuration'),groupLeader=store.getAgent(groupConfig.agents.speaker),groupChild=store.listAgents(groupLeader.projectId).find(a=>a.id!==groupLeader.id);assert.ok(groupChild);assert.equal(groupChild.managerAgentId??null,forest?null:groupLeader.id);
 assert.equal(groupLeader.workingCopy.rootPath,rootReview.sharedRoot);assert.equal(groupChild.workingCopy.rootPath,rootReview.sharedRoot);
 const groupReceipts=store.sqlite.prepare("SELECT DISTINCT creation_operation_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref!=''").all(groupDone.branchId);assert.equal(groupReceipts.length,1);
 const {CapabilityPolicyStore}=await import('@ponderosa/agents'),policies=new CapabilityPolicyStore(store.sqlite);assert.equal(policies.resolveForAgent(groupLeader.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),false);assert.equal(policies.resolveForAgent(groupChild.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),true);
 assert.equal(groupDone.importResults[JSON.stringify(['chat','speaker'])].liveWorkingRoots[0].agentIds.length,2);
 t.after(()=>{if(passed)rmSync(rootReview.sharedRoot,{recursive:true,force:true});});
 }

 await app.close();app=undefined;store.close();store=new AgentStore(path.join(root,'state'));
 assert.equal(store.getAgent(agent.id).conversationId,chat.id);
 assert.equal(store.sqlite.prepare(`SELECT COUNT(*) n FROM agent_creation_operations WHERE status='completed' AND kind='import' AND idempotency_key LIKE 'branch-install:%'`).get().n,3);
 passed=true;
});
test('interrupted grouped import holds its retained working files without replay',async t=>{
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
 assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL AND conversation_id=?').get(chat.id).n,1);
 // Grouped activation uses one receipt and one reviewed Shared cwd, including restart after access review.
 for(const forest of [false]){
 const grouped=structuredClone(pkg);grouped.packageId='test.grouped-publication-'+forest;grouped.mode='full';
 const leader=grouped.chats[0].agents[0];leader.definition.mode='full';
 const child=structuredClone(leader);child.ref='child';if(!forest)child.managerRef='speaker';child.definition.rootRef='child';child.definition.agents[0].ref='child';child.definition.agents[0].title='Child';grouped.chats[0].agents.push(child);
 const {CAPABILITY_IDS}=await import('@ponderosa/core');
 for(const entry of grouped.chats[0].agents){const node=entry.definition.agents[0];node.workingCopyMode='shared';node.sourceChat={ref:'original-chat',title:'Original'};node.workingFolder={directories:[],excludedPaths:[]};node.accessSettings={restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]};}
 const composed=(await composeAgentPackages(grouped.chats[0].agents.map(entry=>({ref:entry.ref,managerRef:entry.managerRef,package:entry.definition})))).package;
 const rootDestinations=Object.fromEntries([...new Set(composed.agents.map(node=>node.workingRootRef).filter(Boolean))].map((ref,i)=>[ref,path.join(root,'group-recovery-'+forest+'-'+i)]));
 const groupPreview=await api('POST','/api/branches/install-preview',{package:grouped,bindings:{directories:{workspace:root},agents:{},engines:{codex:'codex'}},fileSelections:{[JSON.stringify(['chat','speaker'])]:{newManagedChatFolderName:path.basename(root)+'-group-'+forest,workingFilesActivation:{},workingRootDestinations:rootDestinations}}});
 await api('POST','/api/branches/installations/'+groupPreview.id+'/confirm',{acknowledgeFullImport:true});
 const groupUrl='/api/branches/installations/'+groupPreview.id,rootReview=(await api('GET',groupUrl)).workingRootReview;assert.ok(rootReview);
 for(const payload of [{chatRef:'chat',agentRef:'speaker'},{chatRef:'chat',agentRef:'child',sharedRoot:rootReview.sharedRoot}]){
  assert.equal((await app.inject({method:'POST',url:groupUrl+'/working-root-review',payload})).statusCode,409);
 }
 const reviewedChat=store.getConversation(rootReview.chatId),reviewedProject=store.getProject(reviewedChat.projectId);
 assert.equal(store.isManagedProjectImportDestination(reviewedProject.id),true);
 const projectFile=path.join(root,'state','projects',reviewedProject.id,'project.json'),originalProject=readFileSync(projectFile,'utf8');
 const canonicalProject=JSON.parse(originalProject);
 for(const change of [{hostPath:path.join(root,'foreign')},{creationHostPath:'managed:workspaces/foreign'},{creationIdempotencyKey:undefined},{managedWorkspaceName:undefined}]){
  writeFileSync(projectFile,JSON.stringify({...canonicalProject,...change}));
  assert.equal(store.isManagedProjectImportDestination(reviewedProject.id),false,'missing or foreign managed identity must refuse');
 }
 writeFileSync(projectFile,originalProject);
 const invalidRoot=await app.inject({method:'POST',url:groupUrl+'/working-root-review',payload:{chatRef:'chat',agentRef:'speaker',sharedRoot:'/foreign'}});assert.equal(invalidRoot.statusCode,409);
 await api('POST',groupUrl+'/working-root-review',{chatRef:'chat',agentRef:'speaker',sharedRoot:rootReview.sharedRoot});
 await api('POST',groupUrl+'/confirm',{});
 const groupAccess=(await api('GET',groupUrl)).accessSettingsReview;assert.deepEqual(groupAccess.agentRefs,['speaker','child']);
 const {AgentWorkingCopyService}=await import('../../apps/server/dist/agent-working-copy-service.js');
 const originalStage=AgentWorkingCopyService.prototype.stageImportedSharedGit;
 let releaseStage,notifyEntered;
 const stageEntered=new Promise(resolve=>{notifyEntered=resolve;}),stageGate=new Promise(resolve=>{releaseStage=resolve;});
 AgentWorkingCopyService.prototype.stageImportedSharedGit=async function(...args){notifyEntered();await stageGate;return originalStage.apply(this,args);};
 t.after(()=>{AgentWorkingCopyService.prototype.stageImportedSharedGit=originalStage;releaseStage();});
 await api('POST',groupUrl+'/access-review',{chatRef:'chat',agentRef:'speaker',resolution:{action:'keep_destination',reviewSha256:groupAccess.review.reviewSha256,agentActions:{speaker:'keep_destination',child:'use_source'}}});
 assert.equal((await app.inject({method:'POST',url:groupUrl+'/working-root-review',payload:{chatRef:'chat',agentRef:'speaker',sharedRoot:rootReview.sharedRoot}})).statusCode,409,'consumed root review cannot be replayed');
 await Promise.race([stageEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error('Timed out waiting for staged grouped import')),5000))]);
 const recovery=Object.values(rootDestinations)[0],marker=path.join(recovery,'retained-user-file.txt');
 writeFileSync(marker,'retained synthetic user bytes');
 app.prepareForShutdown();const closing=app.close();await new Promise(r=>setTimeout(r,50));releaseStage();await closing;
 AgentWorkingCopyService.prototype.stageImportedSharedGit=originalStage;
 const {DatabaseSync}=await import('node:sqlite'),inspection=new DatabaseSync(path.join(root,'state','ponderosa.db'),{readOnly:true});
 const closedPlan=inspection.prepare('SELECT state,error,next_attempt_at FROM branch_installation_plans WHERE id=?').get(groupPreview.id);
 const closedOp=inspection.prepare("SELECT status,last_error FROM agent_creation_operations WHERE kind='import' AND idempotency_key LIKE 'branch-install:%:group'").get();inspection.close();
 assert.equal(closedPlan.state,'applying');assert.match(closedPlan.error,/Automatic retry is held/);assert.ok(closedPlan.error.includes(recovery));
 assert.equal(closedPlan.next_attempt_at,'9999-12-31T23:59:59.999Z');assert.equal(closedOp.status,'rolled_back');
 assert.equal(readFileSync(marker,'utf8'),'retained synthetic user bytes');
 app=undefined;store.close();store=new AgentStore(path.join(root,'state'));
 app=createServer({dataDir:path.join(root,'state'),store,logger:false,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});
 const initial=await api('GET',groupUrl);assert.equal(initial.state,'applying');assert.match(initial.error,/Automatic retry is held/);assert.ok(initial.error.includes(recovery));
 const count=()=>store.sqlite.prepare("SELECT count(*) n FROM agent_creation_operations WHERE kind='import' AND substr(idempotency_key,1,?)=?").get(('branch-install:'+groupPreview.id+':').length,'branch-install:'+groupPreview.id+':').n;
 const before=count();assert.equal(before,1);
 assert.equal((await api('POST',groupUrl+'/confirm',{})).state,'applying');
 await new Promise(r=>setTimeout(r,2500));assert.equal(count(),before,'no new import is admitted while recovery bytes are retained');
 assert.equal(readFileSync(marker,'utf8'),'retained synthetic user bytes');
 assert.equal(store.sqlite.prepare('SELECT next_attempt_at FROM branch_installation_plans WHERE id=?').get(groupPreview.id).next_attempt_at,'9999-12-31T23:59:59.999Z');
 // Simulate a second service that checked before another same-Project import
 // left the recovery path, then waited on the real shared Project lock.
 const {withProjectImportLock}=await import('../../apps/server/dist/project-import-lock.js');
 let unlock,notifyLocked;const locked=new Promise(r=>{notifyLocked=r;}),lockGate=new Promise(r=>{unlock=r;});
 const lock=withProjectImportLock(reviewedChat.projectId,async()=>{notifyLocked();await lockGate;});await locked;
 const hidden=recovery+'-temporary-fixture';renameSync(recovery,hidden);
 try{
  store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL,error=NULL WHERE id=?').run(groupPreview.id);
  let finished=false;const attempt=api('POST',groupUrl+'/confirm',{}).finally(()=>{finished=true;});
  await new Promise(r=>setTimeout(r,100));assert.equal(finished,false,'the retry is waiting for the Project import lock');
  renameSync(hidden,recovery);unlock();await lock;
  const heldAgain=await attempt;assert.equal(heldAgain.state,'applying');assert.match(heldAgain.error,/Automatic retry is held/);
  assert.equal(count(),before,'post-lock recheck must prevent another import operation');
 }finally{if(existsSync(hidden))renameSync(hidden,recovery);unlock();await lock;}
 assert.equal(readFileSync(marker,'utf8'),'retained synthetic user bytes');
 // A later live-copy intent is uncertain even if the separate recovery path
 // is absent; its pre-existing managed root alone was not sufficient above.
 const creationId=store.sqlite.prepare("SELECT id FROM agent_creation_operations WHERE substr(idempotency_key,1,?)=? AND status='rolled_back'").get(('branch-install:'+groupPreview.id+':').length,'branch-install:'+groupPreview.id+':').id;
 const originalResult=store.getAgentCreationOperation(creationId).result;
 renameSync(recovery,hidden);
 try{
  store.updateAgentCreationOperation(creationId,{result:{...originalResult,liveWorkingRoots:[{path:rootReview.sharedRoot}]}});
  store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL,error=NULL WHERE id=?').run(groupPreview.id);
  const liveHold=await api('POST',groupUrl+'/confirm',{});assert.equal(liveHold.state,'applying');assert.match(liveHold.error,/Automatic retry is held/);assert.ok(liveHold.error.includes(rootReview.sharedRoot));
  assert.equal(count(),before,'an unconfirmed live-copy intent must not be replayed');
 }finally{store.updateAgentCreationOperation(creationId,{result:originalResult});renameSync(hidden,recovery);}
 assert.equal(readFileSync(marker,'utf8'),'retained synthetic user bytes');
 const canceled=await api('POST',groupUrl+'/cancel',{});assert.ok(['canceling','canceled'].includes(canceled.state));
 let state;const cancelDeadline=Date.now()+10000;while(Date.now()<cancelDeadline){state=await api('GET',groupUrl);if(state.state==='canceled')break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(state.state,'canceled',state.error);assert.equal(readFileSync(marker,'utf8'),'retained synthetic user bytes');
 assert.equal(count(),before,'cancel must not replay the import');
 passed=true;
 }
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
