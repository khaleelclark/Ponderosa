import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,stat,lstat,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {AgentStore,destinationAdmissionHeld} from '@ponderosa/agents';
import {createBranchWorkingData} from '../../apps/server/dist/branch-working-data.js';
import {branchWorkingRootDestinations,prepareBranchWorkingDataChild} from '../../apps/server/dist/apply-branch-working-data.js';
import {exportWorkingFiles} from '../../apps/server/dist/portable-working-files.js';
import {encodePortableArtifactData} from '../../apps/server/dist/agent-package-codec.js';
import {withFixture,until} from '../shared/fixture.mjs';
const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
function installation({shared=false,nested=false}={}){
 const refs={a:randomUUID(),b:shared?undefined:randomUUID()};if(shared)refs.b=refs.a;
 const source=(ref,root,files,links)=>({ref,title:ref,engine:'codex',managementPermissions:permissions,workingCopyMode:'shared',workingRootRef:root,...(files||links?{workingFolder:{directories:[],excludedPaths:nested&&ref==='source-a'?['child']:[],links:links??[]},workingFiles:files??[],artifacts:(files??[]).map(file=>({ref:file.artifactRef,kind:'document',path:file.path,createdAt:'2026-11-03T00:00:00.000Z',dataBase64:Buffer.from('complete original').toString('base64')}))}:{})});
 const agents=[source('source-a',refs.a,[{path:'original',artifactRef:'original-ref'}],[]),source('source-b',refs.b,shared?undefined:[],shared?undefined:[{path:'hard',kind:'hardlink',target:'original',targetRootRef:refs.a},{path:'symbolic',kind:'symlink',target:'original',targetRootRef:refs.a,sourceTarget:'/selected-root-a/original'}])];
 const portable={schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:'2026-11-03T00:00:00.000Z',sourceLabel:'Closed physical originals',rootRef:'source-a',rootRefs:['source-a','source-b'],agents,...(nested?{workingRootNesting:[{parentRootRef:refs.a,childRootRef:refs.b,path:'child'}]}:{})};
 const workingData=createBranchWorkingData(portable,{'source-a':{chatRef:'chat-a',agentRef:'a'},'source-b':{chatRef:'chat-b',agentRef:'b'}});
 const chats=['a','b'].map(ref=>({ref:'chat-'+ref,title:'Chat '+ref,agents:[{ref,definition:{schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',exportedAt:portable.exportedAt,sourceLabel:'private-'+ref,rootRef:ref,agents:[{ref,title:'Agent '+ref,engine:'codex',managementPermissions:permissions,workingCopyMode:'shared',history:[{role:'user',text:'PRIVATE_'+ref.toUpperCase()+' 🐘 '+('long text '.repeat(40000))}]}]}}]}));
 return {refs,pkg:{schema:'ponderosa.branch-installation.v1',packageId:randomUUID(),mode:'full',exportedAt:portable.exportedAt,definition:{schema:'ponderosa.branch.v1',name:'Physical closure',trigger:{kind:'manual'},entry:'worker',steps:[{id:'worker',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Wait for explicit execution'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats,agentBindings:{worker:{chatRef:'chat-a',agentRef:'a'}},workingData}};
}
const key=ref=>JSON.stringify(['chat-'+ref,ref]),route=id=>'/api/branches/installations/'+id;
async function preview(f,value,live=false){
 const first=path.join(f.root,'recovery-first'),second=value.pkg.workingData.package.workingRootNesting?path.join(first,'child'):path.join(f.root,'recovery-second');
 const fileSelections={[key('a')]:{workingRootDestinations:{[value.refs.a]:first},...(live?{workingFilesActivation:{},newManagedChatFolderName:'Physical first'}:{})},[key('b')]:{...(value.refs.a!==value.refs.b?{workingRootDestinations:{[value.refs.b]:second}}:{}),...(live?{workingFilesActivation:{},...(value.refs.a===value.refs.b||value.pkg.workingData.package.workingRootNesting?{}:{newManagedChatFolderName:'Physical second'})}:{})}};
 const plan=f.ok(await f.api('POST','/api/branches/install-preview',{package:value.pkg,bindings:{agents:{},directories:{workspace:f.root},engines:{codex:'codex'}},fileSelections}));return {plan,first,second};
}
async function finish(f,plan,live=false){
 f.ok(await f.api('POST',route(plan.id)+'/confirm',{acknowledgeFullImport:true}));
 return until(async()=>{const current=f.ok(await f.api('GET',route(plan.id)));if(live&&current.workingRootReview){const {chatRef,agentRef,sharedRoot}=current.workingRootReview;f.ok(await f.api('POST',route(plan.id)+'/working-root-review',{chatRef,agentRef,sharedRoot}));return false;}assert.notEqual(current.state,'review_required',JSON.stringify(current));assert.notEqual(current.workingDataApplication?.state,'incomplete',JSON.stringify(current));return current.state==='completed'&&current;},'closed physical installation');
}
test('live shared roots refuse incompatible member ownership before creating destinations',async()=>{
 for(const modes of [['shared','separate_git'],['separate_git','separate_git']]){
  const value=installation({shared:true}),pkg=value.pkg.workingData.package;
  pkg.agents[0].workingCopyMode=modes[0];pkg.agents[1].workingCopyMode=modes[1];
  const data=createBranchWorkingData(pkg,value.pkg.workingData.owners);
  const root=path.join('/tmp','prospective-root-'+randomUUID()),base={[key('a')]:{workingRootDestinations:{[value.refs.a]:root}}};
  assert.deepEqual(branchWorkingRootDestinations(data,base),{[value.refs.a]:root},'Recovery-only copies remain available');
  assert.throws(()=>branchWorkingRootDestinations(data,{...base,[key('a')]:{...base[key('a')],workingFilesActivation:{}},[key('b')]:{workingFilesActivation:{}}}),/compatible ownership mode/);
  await assert.rejects(lstat(root),error=>error.code==='ENOENT');
 }
 const value=installation({shared:true}),root=path.join('/tmp','prospective-root-'+randomUUID());
 assert.throws(()=>branchWorkingRootDestinations(value.pkg.workingData,{[key('a')]:{workingRootDestinations:{[value.refs.a]:root},workingFilesActivation:{}}}),/activate that folder together/);
 await assert.rejects(lstat(root),error=>error.code==='ENOENT');
});

test('contained-root preparation rejects a staged Agent from a different source root before allocation',async()=>{
 const value=installation({nested:true}),data=value.pkg.workingData;
 let allocations=0;
 const store={getAgent:id=>({id,projectId:'project',workingCopy:{mode:'shared'}}),getProject:()=>({id:'project'}),sqlite:{prepare:()=>({get:()=>({chat_ref:'chat-b',agent_ref:'b'})})}};
 const copies={beginModeChange:()=>{allocations++;throw Error('must not allocate');}};
 await assert.rejects(prepareBranchWorkingDataChild(store,copies,{planId:'plan',data,parentRootRef:value.refs.a,childRootRef:value.refs.b,parentAgentId:'foreign-root-agent'},()=>{}),/exact staged canonical import for the reviewed parent root/);
 assert.equal(allocations,0);
});

test('cross-Chat carrier restores originals once and retains exact separate histories across reopen',{skip:process.platform==='win32'},async t=>{
 let store;await withFixture(t,async f=>{
  const value=installation(),{plan,first,second}=await preview(f,value),complete=await finish(f,plan);assert.equal(complete.workingDataApplication.state,'completed');
  const original=await stat(path.join(first,'original')),alias=await stat(path.join(second,'hard'));assert.equal(original.ino,alias.ino);assert.equal(original.dev,alias.dev);assert.equal(await readFile(path.join(second,'symbolic'),'utf8'),'complete original');
  const resources=store.sqlite.prepare("SELECT chat_ref,local_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref!=''").all(complete.branchId);
  for(const resource of resources){const archive=store.getImportedHistory(resource.local_id),own=resource.chat_ref==='chat-a'?'PRIVATE_A':'PRIVATE_B',foreign=own==='PRIVATE_A'?'PRIVATE_B':'PRIVATE_A';assert.ok(archive.messages.some(message=>message.text.startsWith(own)));assert.ok(!archive.messages.some(message=>message.text.startsWith(foreign)));assert.ok(archive.portableState.workingFiles);await assert.rejects(store.attachImportedWorkingStateAsync(resource.local_id,plan.id,{workingFiles:[]}),/exact completed staged|already attempted/);}
  await f.reopen();assert.equal(await readFile(path.join(first,'original'),'utf8'),'complete original');assert.equal(f.ok(await f.api('GET',route(plan.id))).workingDataApplication.state,'completed');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});
test('shared physical root aliases survive refused direct deletion and reopening',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const value=installation({shared:true}),{plan}=await preview(f,value,true),complete=await finish(f,plan,true),roots=complete.workingDataApplication.roots;assert.equal(roots.length,1);assert.ok(roots[0].livePath);assert.equal(roots[0].agentIds.length,2);
 const chats=f.ok(await f.api('GET','/api/branches/'+complete.branchId+'/chats'));assert.equal(chats.length,2);
 const members=f.ok(await f.api('GET','/api/branches/engine/projects/'+chats[0].projectId+'/agents'));const deletion=await f.api('DELETE','/api/branches/engine/conversations/'+chats[0].id,{expectedAgentIds:members.map(agent=>agent.id)});assert.equal(deletion.status,409);assert.match(deletion.body.error,/Branch lifecycle/);
 assert.equal(await readFile(path.join(roots[0].livePath,'original'),'utf8'),'complete original');await f.reopen();assert.equal(await readFile(path.join(roots[0].livePath,'original'),'utf8'),'complete original');assert.equal(f.ok(await f.api('GET','/api/branches/engine/projects/'+chats[1].projectId+'/agents')).length,1);
 const branchDeletion=await f.api('DELETE','/api/branches/'+complete.branchId);assert.ok([200,202].includes(branchDeletion.status),JSON.stringify(branchDeletion.body));
 await until(async()=>{const result=await f.api('GET','/api/branches/'+complete.branchId);return result.status===404;},'Branch lifecycle deletion completes');
 assert.equal(await readFile(path.join(roots[0].livePath,'original'),'utf8'),'complete original');
 await f.reopen();assert.equal(await readFile(path.join(roots[0].livePath,'original'),'utf8'),'complete original');
}));
test('nested recovery roots retain cross-root inode links without duplicating the child tree',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const value=installation({nested:true}),{plan,first,second}=await preview(f,value),complete=await finish(f,plan);assert.equal(complete.workingDataApplication.roots.length,2);assert.equal((await lstat(path.join(second,'hard'))).ino,(await lstat(path.join(first,'original'))).ino);
}));
test('missing compacted source and uncertain physical receipt stay held without replay',async t=>{
 let store;await withFixture(t,async f=>{
  const value=installation(),{plan,first}=await preview(f,value);await finish(f,plan);const before=await stat(path.join(first,'original'));
  let row=store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(plan.id),state=JSON.parse(row.preview_json);
  delete state.importResults;store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=?,next_attempt_at=NULL,error=NULL WHERE id=?").run(JSON.stringify(state),plan.id);
  await f.reopen();const sourceHeld=await until(async()=>{const status=f.ok(await f.api('GET',route(plan.id)));return /source is unavailable or invalid/.test(status.error??'')&&status;},'compacted source hold');
  assert.equal(sourceHeld.workingDataApplication.state,'completed');assert.match(sourceHeld.error,/without replay/);assert.equal((await stat(path.join(first,'original'))).ino,before.ino);
  assert.equal(store.sqlite.prepare('SELECT next_attempt_at FROM branch_installation_plans WHERE id=?').get(plan.id).next_attempt_at,'9999-12-31T23:59:59.999Z');
  row=store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(plan.id);state=JSON.parse(row.preview_json);state.workingDataApplication.state='applying';
  store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=?,next_attempt_at=NULL WHERE id=?").run(JSON.stringify(state),plan.id);
  await f.reopen();const held=await until(async()=>{const status=f.ok(await f.api('GET',route(plan.id)));return status.workingDataApplication?.state==='incomplete'&&status;},'uncertain receipt hold');assert.match(held.error,/without replay|stopped before/i);assert.equal((await stat(path.join(first,'original'))).ino,before.ino);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('acyclic physical nesting with cross-Chat Separate parents does not form a Chat-registration deadlock',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const value=installation(),p=randomUUID(),q=randomUUID(),data=value.pkg.workingData;
 const extra=(ref,root)=>({ref,title:ref,engine:'codex',managementPermissions:permissions,workingCopyMode:'separate_git',workingRootRef:root,workingFolder:{directories:[],excludedPaths:['child'],links:[]},workingFiles:[]});
 data.package.agents.push(extra('source-p',p),extra('source-q',q));data.package.rootRefs.push('source-p','source-q');
 data.package.workingRootNesting=[{parentRootRef:p,childRootRef:value.refs.a,path:'child'},{parentRootRef:q,childRootRef:value.refs.b,path:'child'}];
 data.owners['source-p']={chatRef:'chat-b',agentRef:'p'};data.owners['source-q']={chatRef:'chat-a',agentRef:'q'};
 for(const [chatRef,ref,parent] of [['chat-a','q','a'],['chat-b','p','b']]){
  const chat=value.pkg.chats.find(chat=>chat.ref===chatRef),definition=structuredClone(chat.agents[0].definition);definition.rootRef=ref;definition.agents=[{...definition.agents[0],ref,title:ref,history:[{role:'user',text:'PRIVATE_'+ref.toUpperCase()}]}];chat.agents.push({ref,managerRef:parent,definition});
 }
 value.pkg.workingData=createBranchWorkingData(data.package,data.owners);
 const pDestination=path.join(f.root,'recovery-p'),qDestination=path.join(f.root,'recovery-q'),destinations={[p]:pDestination,[q]:qDestination,[value.refs.a]:path.join(pDestination,'child'),[value.refs.b]:path.join(qDestination,'child')};
 const fileSelections={[key('a')]:{workingRootDestinations:destinations,workingFilesActivation:{}},[key('b')]:{workingFilesActivation:{}}};
 const plan=f.ok(await f.api('POST','/api/branches/install-preview',{package:value.pkg,bindings:{agents:{},directories:{workspace:f.root},engines:{codex:'codex'}},fileSelections}));
 const complete=await finish(f,plan,true),roots=Object.fromEntries(complete.workingDataApplication.roots.map(root=>[root.ref,root]));
 assert.equal(roots[value.refs.a].livePath,path.join(roots[p].livePath,'child'));assert.equal(roots[value.refs.b].livePath,path.join(roots[q].livePath,'child'));
 assert.equal(await readFile(path.join(roots[value.refs.b].livePath,'hard'),'utf8'),'complete original');await f.reopen();assert.equal(await readFile(path.join(roots[value.refs.a].livePath,'original'),'utf8'),'complete original');
}));

test('interrupted exact final Project metadata binding reopens consistently while physical outcome remains held',{skip:process.platform==='win32'},async t=>{
 let store;await withFixture(t,async f=>{
  const value=installation({nested:true}),{plan}=await preview(f,value,true),complete=await finish(f,plan,true);
  const resource=store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND chat_ref='chat-b' AND agent_ref='b'").get(complete.branchId),agent=store.getAgent(resource.local_id),projectFile=path.join(f.dataDir,'projects',agent.projectId,'project.json'),project=JSON.parse(await readFile(projectFile,'utf8')),intent=project.importedRootBinding;
  assert.equal(intent.state,'completed');project.importedRootBinding.state='binding';await writeFile(projectFile,JSON.stringify(project)+'\n');
  const agentFile=path.join(f.dataDir,'projects',agent.projectId,'agents',agent.id,'agent.json'),json=JSON.parse(await readFile(agentFile,'utf8'));json.workingCopy.rootPath=intent.previousPath;delete json.workingCopy.importedParent;await writeFile(agentFile,JSON.stringify(json)+'\n');
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='staging',staging_plan_id=? WHERE branch_id=?").run(plan.id,complete.branchId);
  const row=store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(plan.id),state=JSON.parse(row.preview_json);state.workingDataApplication.state='applying';store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=?,next_attempt_at=NULL WHERE id=?").run(JSON.stringify(state),plan.id);
  const before=await stat(intent.path);await f.reopen();assert.equal(store.getAgent(agent.id).workingCopy.rootPath,intent.path);assert.equal((await stat(intent.path)).ino,before.ino);
  await until(async()=>f.ok(await f.api('GET',route(plan.id))).workingDataApplication?.state==='incomplete','held physical outcome after metadata-only reconciliation');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

for(const changedRoot of ['moved','replaced'])test('one '+changedRoot+' held imported root quarantines its owner and leaves independent Agents available',{skip:process.platform==='win32'},async t=>{
 let store;await withFixture(t,async f=>{
  const independentChat=await f.createChat('Independent valid Chat'),independent=await f.createIdleAgent(independentChat,'Independent valid Agent');
  const value=installation({nested:true}),{plan}=await preview(f,value,true),complete=await finish(f,plan,true);
  const owned=store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND chat_ref='chat-b' AND agent_ref='b'").get(complete.branchId),agent=store.getAgent(owned.local_id),projectFile=path.join(f.dataDir,'projects',agent.projectId,'project.json'),canonical=JSON.parse(await readFile(projectFile,'utf8')),intent=canonical.importedRootBinding;
  canonical.importedRootBinding.state='binding';await writeFile(projectFile,JSON.stringify(canonical)+'\n');
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='staging',staging_plan_id=? WHERE branch_id=?").run(plan.id,complete.branchId);
  const row=store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(plan.id),state=JSON.parse(row.preview_json);state.workingDataApplication.state='applying';
  store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=?,next_attempt_at=NULL WHERE id=?").run(JSON.stringify(state),plan.id);
  const retained=intent.path+'-retained-exact-original';await rename(intent.path,retained);if(changedRoot==='replaced')await mkdir(intent.path);
  await f.reopen();
  assert.ok(store.getAgent(independent.id),'Independent valid Agent still loads');assert.equal(store.getAgent(agent.id),undefined,'Affected Project is unavailable, not active');
  assert.equal(destinationAdmissionHeld(store.sqlite,agent.id,agent.conversationId),true);assert.equal(destinationAdmissionHeld(store.sqlite,independent.id,independentChat.id),false);
  const status=f.ok(await f.api('GET',route(plan.id)));assert.equal(status.workingDataApplication.state,'incomplete');assert.equal(status.workingDataApplication.recoveryHolds[agent.projectId].state,'unavailable');assert.match(status.error,/unavailable/);
  assert.ok(store.startupProfile().recoveryIssues.some(issue=>issue.projectId===agent.projectId));
  assert.equal(await readFile(path.join(retained,'hard'),'utf8'),'complete original');
  const after=JSON.parse(await readFile(projectFile,'utf8'));assert.equal(after.importedRootBinding.state,'binding');assert.equal(after.importedRootBinding.recoveryError.code,'ERR_IMPORTED_ROOT_RECOVERY_HELD');assert.deepEqual(after.importedRootBinding.parent,intent.parent);
  await f.send(independent.id,'Independent Agent still accepts explicit work');await f.settled(independent.id);await f.reopen();assert.ok(store.getAgent(independent.id));assert.equal(destinationAdmissionHeld(store.sqlite,agent.id,agent.conversationId),true);assert.equal(await readFile(path.join(retained,'hard'),'utf8'),'complete original');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});


/** Build actual exported working data, rather than inventing part metadata. */
async function largeBranchPackage(f,{corrupt=false}={}){
 const source=path.join(f.root,'large-source');await mkdir(source);
 const content=Buffer.alloc(64*1024*1024+17);
 content[0]=1;content[32*1024*1024-1]=2;content[content.length-1]=3;
 const sourceFile=path.join(source,'original');await writeFile(sourceFile,content);
 const digest=createHash('sha256').update(content).digest('hex');
 const exported=await exportWorkingFiles(source,['original'],content.length);
 assert.equal(exported.files.length,1);
 assert.equal(exported.files[0].parts?.byteLength,content.length);
 assert.equal(exported.files[0].parts?.sha256,digest);
 assert.equal(exported.files[0].parts?.refs.length,3);
 const value=installation({shared:true}),pkg=value.pkg.workingData.package,owner=pkg.agents.find(node=>node.ref==='source-a');
 owner.workingFiles=exported.files;owner.artifacts=exported.artifacts;
 if(corrupt){
  const second=owner.artifacts.find(artifact=>artifact.ref===owner.workingFiles[0].parts.refs[1]);
  const changed=Buffer.alloc(32*1024*1024);changed[0]=9;
  Object.assign(second,await encodePortableArtifactData(changed));
 }
 value.pkg.workingData=createBranchWorkingData(pkg,value.pkg.workingData.owners);
 return {value,content,digest,sourceFile};
}

test('Branch working data imports one complete large original and retains its private parts across restart',{skip:process.platform==='win32',timeout:120000},async t=>{
 let store;await withFixture(t,async f=>{
  const {value,content,digest,sourceFile}=await largeBranchPackage(f);
  const {plan,first}=await preview(f,value);
  const reviewed=plan.fullImportReview.agents.find(agent=>agent.chat==='Chat a');
  assert.ok(reviewed,'preview includes the source owner');
  const originals=reviewed.artifacts.items.filter(item=>item.name==='original');
  assert.equal(originals.length,1,'physical carrier appears as one logical original');
  assert.equal(originals[0].bytes,content.length,'preview reports the whole original size');
  assert.ok(reviewed.artifacts.items.every(item=>!item.name.startsWith('portable-working-part/')),'transport pieces are not presented as independent files');
  const complete=await finish(f,plan);
  assert.equal(complete.workingDataApplication.state,'completed');
  const restored=path.join(first,'original'),bytes=await readFile(restored);
  assert.equal(bytes.length,content.length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest,'one complete reconstructed original');
  assert.equal(createHash('sha256').update(await readFile(sourceFile)).digest('hex'),digest,'source original remains unchanged');
  const resource=store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND chat_ref='chat-a' AND agent_ref='a'").get(complete.branchId);
  assert.ok(resource);
  const agent=store.getAgent(resource.local_id),working=store.getImportedHistory(agent.id).portableState.workingFiles;
  assert.equal(working.length,1);assert.equal(working[0].path,'original');
  assert.equal(working[0].parts.byteLength,content.length);assert.equal(working[0].parts.sha256,digest);
  assert.equal(working[0].parts.refs.length,3);
  for(const id of working[0].parts.refs)assert.equal(store.isWorkingFileTransportPart(agent.projectId,id),true);
  const visible=f.ok(await f.api('GET','/api/branches/engine/projects/'+agent.projectId+'/artifacts'));
  assert.ok(visible.items.every(item=>!working[0].parts.refs.includes(item.id)),'transport pieces are not independent visible artifacts');
  for(const id of working[0].parts.refs){
   const response=await f.api('GET','/api/branches/engine/projects/'+agent.projectId+'/artifacts/'+id+'/download');
   assert.equal(response.status,404,'transport pieces cannot be downloaded as standalone originals');
  }
  const again=await exportWorkingFiles(first,['original'],content.length);
  assert.equal(again.files.length,1);assert.equal(again.files[0].parts.byteLength,content.length);
  assert.equal(again.files[0].parts.sha256,digest,'re-export retains full logical bytes');
  await f.reopen();
  assert.equal(createHash('sha256').update(await readFile(restored)).digest('hex'),digest);
  const reopened=store.getImportedHistory(agent.id).portableState.workingFiles[0];
  assert.equal(reopened.parts.sha256,digest);assert.deepEqual(reopened.parts.refs,working[0].parts.refs);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('Branch working data refuses a changed large original before publishing parts or destination files',{skip:process.platform==='win32',timeout:120000},async t=>{
 let store;await withFixture(t,async f=>{
  const {value,content,digest,sourceFile}=await largeBranchPackage(f,{corrupt:true});
  const {plan,first}=await preview(f,value);
  const before=store.sqlite.prepare('SELECT COUNT(*) n FROM managed_artifact_projection').get().n;
  f.ok(await f.api('POST',route(plan.id)+'/confirm',{acknowledgeFullImport:true}));
  const status=await until(async()=>{
   const result=f.ok(await f.api('GET',route(plan.id)));
   return result.state==='review_required'||result.workingDataApplication?.state==='incomplete'?result:false;
  },'invalid large-original hold',30000);
  assert.match(status.error??status.workingDataApplication?.error?.message??'',/original length or SHA-256 differs/);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM managed_artifact_projection').get().n,before,'no transport part published');
  await assert.rejects(lstat(first),error=>error.code==='ENOENT','no destination created');
  assert.equal((await readFile(sourceFile)).length,content.length);
  assert.equal(createHash('sha256').update(await readFile(sourceFile)).digest('hex'),digest,'source original remains unchanged');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('Branch package HTTP export retains a live large working original',{skip:process.platform==='win32',timeout:120000},async t=>{
 let store;await withFixture(t,async f=>{
  const {value,content,digest}=await largeBranchPackage(f);
  const {plan}=await preview(f,value,true),complete=await finish(f,plan,true);
  const resource=store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND chat_ref='chat-a' AND agent_ref='a'").get(complete.branchId);
  assert.ok(resource);
  const selections=encodeURIComponent(JSON.stringify({[resource.local_id]:{wholeWorkingFolder:true}}));
  const exported=f.ok(await f.api('GET',`/api/branches/${complete.branchId}/package?mode=full&fileSelections=${selections}`));
  const files=exported.workingData?.package.agents.flatMap(node=>node.workingFiles??[])??[];
  const original=files.find(file=>file.path==='original');
  assert.ok(original,'the exported Branch includes the selected original');
  assert.equal(original.parts?.byteLength,content.length);
  assert.equal(original.parts?.sha256,digest);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('interrupted large Branch working-data receipt stays held without replay',{skip:process.platform==='win32',timeout:120000},async t=>{
 let store;await withFixture(t,async f=>{
  const {value,digest}=await largeBranchPackage(f),{plan,first}=await preview(f,value);
  await finish(f,plan);
  const original=path.join(first,'original'),before=await stat(original);
  const row=store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(plan.id),state=JSON.parse(row.preview_json);
  state.workingDataApplication.state='applying';
  store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=?,next_attempt_at=NULL WHERE id=?").run(JSON.stringify(state),plan.id);
  await f.reopen();
  const held=await until(async()=>{const status=f.ok(await f.api('GET',route(plan.id)));return status.workingDataApplication?.state==='incomplete'&&status;},'large physical outcome remains held');
  assert.match(held.error,/without replay|stopped before/i);
  assert.equal((await stat(original)).ino,before.ino,'the existing original was not recreated');
  assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'),digest,'the complete original remains intact');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

for(const scenario of ['exact','exact-zero','exact-mixed','occupied','input-mismatch','source-mismatch','artifact-mismatch','owner-mismatch','later-phase'])test('reserved physical import restart: '+scenario,{timeout:60000,skip:process.platform==='win32'},async t=>{
 let store,captured,intercept=true;
 await withFixture(t,async f=>{
  const value=installation();
  if(scenario==='exact-zero'||scenario==='exact-mixed'){
   const data=value.pkg.workingData,node=data.package.agents[0];
   if(scenario==='exact-zero')node.artifacts[0].dataBase64='';
   else{const ref=randomUUID();node.workingFiles.unshift({path:'empty',artifactRef:ref,mode:0o640,mtime:'2026-11-02T01:02:03.000Z'});node.artifacts.unshift({ref,kind:'document',path:'empty',createdAt:data.package.exportedAt,dataBase64:''});}
   value.pkg.workingData=createBranchWorkingData(data.package,data.owners);
  }
  const {plan,first,second}=await preview(f,value);
  const confirmation=await f.api('POST',route(plan.id)+'/confirm',{acknowledgeFullImport:true});
  assert.equal(confirmation.status,200,JSON.stringify(confirmation.body));
  await until(()=>captured,'durable reserved receipt');
  assert.equal(captured.state,'applying');assert.equal(captured.phase,'reserved');
  for(const root of captured.roots)assert.equal(root.state,'planned');
  await assert.rejects(lstat(first),error=>error.code==='ENOENT');
  await assert.rejects(lstat(second),error=>error.code==='ENOENT');
  const priorIds=captured.artifacts.map(item=>item.id);
  assert.ok(priorIds.length);
  for(const id of priorIds)assert.equal(store.sqlite.prepare('SELECT count(*) n FROM artifacts WHERE id=?').get(id).n,0);
  // Simulate process loss immediately after the reservation commit: restore
  // only the known pre-write row, with no synthetic in-process error marker.
  const row=store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(plan.id),state=JSON.parse(row.preview_json);
  state.workingDataApplication=structuredClone(captured);
  if(scenario==='input-mismatch')state.workingDataApplication.inputSha256='0'.repeat(64);
  if(scenario==='source-mismatch')state.workingDataApplication.sourceSha256='0'.repeat(64);
  if(scenario==='artifact-mismatch')state.workingDataApplication.artifacts[0].sha256='1'.repeat(64);
  if(scenario==='owner-mismatch')state.workingDataApplication.roots[0].agentIds=['different-owner'];
  if(scenario==='later-phase')state.workingDataApplication.phase='publishing-originals';
  if(scenario==='occupied'||scenario==='later-phase'){
   await mkdir(first);await writeFile(path.join(first,'user-kept.txt'),'user bytes must remain');
  }
  store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=?,error=NULL,next_attempt_at=NULL WHERE id=?").run(JSON.stringify(state),plan.id);
  await f.reopen();
  if(['exact','exact-zero','exact-mixed'].includes(scenario)){
   const done=await until(async()=>{const r=f.ok(await f.api('GET',route(plan.id)));return r.state==='completed'&&r;},'reserved-only recovery',30000);
   assert.equal(done.workingDataApplication.state,'completed');
   assert.deepEqual(done.workingDataApplication.artifacts.map(item=>item.id),priorIds,'original reserved artifact identities survive');
   const expected=scenario==='exact-zero'?'':'complete original';
   assert.equal(await readFile(path.join(first,'original'),'utf8'),expected);
   assert.equal(await readFile(path.join(second,'hard'),'utf8'),expected);
   if(scenario==='exact-zero'||scenario==='exact-mixed'){
    assert.equal(done.workingDataApplication.artifacts.filter(item=>item.size===0).length,1,'durable reservations retain the zero original identity');
    const empty=done.workingDataApplication.artifacts.find(item=>item.size===0);
    assert.equal(store.getProjectArtifacts(empty.projectId).some(item=>item.id===empty.id),false,'zero original never enters the managed-blob catalog');
   }
   if(scenario==='exact-mixed'){const empty=await stat(path.join(first,'empty'));assert.equal(empty.size,0);assert.equal(empty.mode&0o777,0o640);assert.equal(empty.mtime.toISOString(),'2026-11-02T01:02:03.000Z');}
  }else{
   const held=await until(async()=>{const r=f.ok(await f.api('GET',route(plan.id)));return r.error&&r;},'unsafe reserved receipt held',30000);
   assert.notEqual(held.state,'completed');
   if(['input-mismatch','source-mismatch','artifact-mismatch','owner-mismatch'].includes(scenario))assert.match(held.error,/reserved physical receipt differs/i);
   if(scenario==='occupied')assert.match(held.error,/destination now exists/i);
   if(scenario==='later-phase')assert.match(held.error,/stopped before|without replay/i);
   if(['occupied','later-phase'].includes(scenario))assert.equal(await readFile(path.join(first,'user-kept.txt'),'utf8'),'user bytes must remain');
   for(const id of priorIds)assert.equal(store.sqlite.prepare('SELECT count(*) n FROM artifacts WHERE id=?').get(id).n,0);
  }
 },{storeFactory:dir=>{
  store=new AgentStore(dir);
  if(intercept){
   const prepare=store.sqlite.prepare.bind(store.sqlite);
   store.sqlite.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.includes('UPDATE branch_installation_plans SET preview_json=?,updated_at=?'))return statement;
    return new Proxy(statement,{get(target,property){
     if(property!=='run'){const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}
     return (...args)=>{
      const result=target.run(...args);
      try{const state=JSON.parse(args[0]);if(intercept&&state.workingDataApplication?.phase==='reserved'){
       captured=structuredClone(state.workingDataApplication);intercept=false;throw new Error('controlled crash after reservation commit');
      }}catch(error){if(error.message==='controlled crash after reservation commit')throw error;}
      return result;
     };
    }});
   };
  }
  return store;
 }});
});
