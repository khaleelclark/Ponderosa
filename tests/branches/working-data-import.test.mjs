import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,stat,lstat} from 'node:fs/promises';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';
import {createBranchWorkingData} from '../../apps/server/dist/branch-working-data.js';
import {withFixture,until} from '../shared/fixture.mjs';
const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
function installation({shared=false,nested=false}={}){
 const refs={a:randomUUID(),b:shared?undefined:randomUUID()};if(shared)refs.b=refs.a;
 const source=(ref,root,files,links)=>({ref,title:ref,engine:'codex',managementPermissions:permissions,workingCopyMode:'shared',workingRootRef:root,...(files||links?{workingFolder:{directories:[],excludedPaths:nested&&ref==='source-a'?['child']:[],links:links??[]},workingFiles:files??[],artifacts:(files??[]).map(file=>({ref:file.artifactRef,kind:'document',path:file.path,createdAt:'2026-11-03T00:00:00.000Z',dataBase64:Buffer.from('complete original').toString('base64')}))}:{})});
 const agents=[source('source-a',refs.a,[{path:'original',artifactRef:'original-ref'}],[]),source('source-b',refs.b,shared?undefined:[],shared?undefined:[{path:'hard',kind:'hardlink',target:'original',targetRootRef:refs.a},{path:'symbolic',kind:'symlink',target:'original',targetRootRef:refs.a}])];
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
test('cross-Chat carrier restores originals once and retains exact separate histories across reopen',{skip:process.platform==='win32'},async t=>{
 let store;await withFixture(t,async f=>{
  const value=installation(),{plan,first,second}=await preview(f,value),complete=await finish(f,plan);assert.equal(complete.workingDataApplication.state,'completed');
  const original=await stat(path.join(first,'original')),alias=await stat(path.join(second,'hard'));assert.equal(original.ino,alias.ino);assert.equal(original.dev,alias.dev);assert.equal(await readFile(path.join(second,'symbolic'),'utf8'),'complete original');
  const resources=store.sqlite.prepare("SELECT chat_ref,local_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref!=''").all(complete.branchId);
  for(const resource of resources){const archive=store.getImportedHistory(resource.local_id),own=resource.chat_ref==='chat-a'?'PRIVATE_A':'PRIVATE_B',foreign=own==='PRIVATE_A'?'PRIVATE_B':'PRIVATE_A';assert.ok(archive.messages.some(message=>message.text.startsWith(own)));assert.ok(!archive.messages.some(message=>message.text.startsWith(foreign)));assert.ok(archive.portableState.workingFiles);await assert.rejects(store.attachImportedWorkingStateAsync(resource.local_id,plan.id,{workingFiles:[]}),/exact completed staged|already attempted/);}
  await f.reopen();assert.equal(await readFile(path.join(first,'original'),'utf8'),'complete original');assert.equal(f.ok(await f.api('GET',route(plan.id))).workingDataApplication.state,'completed');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});
test('shared physical root aliases survive deleting the first owning Chat and reopening',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const value=installation({shared:true}),{plan}=await preview(f,value,true),complete=await finish(f,plan,true),roots=complete.workingDataApplication.roots;assert.equal(roots.length,1);assert.ok(roots[0].livePath);assert.equal(roots[0].agentIds.length,2);
 const chats=f.ok(await f.api('GET','/api/branches/'+complete.branchId+'/chats'));assert.equal(chats.length,2);
 const members=f.ok(await f.api('GET','/api/branches/engine/projects/'+chats[0].projectId+'/agents'));f.ok(await f.api('DELETE','/api/branches/engine/conversations/'+chats[0].id,{expectedAgentIds:members.map(agent=>agent.id)}));
 assert.equal(await readFile(path.join(roots[0].livePath,'original'),'utf8'),'complete original');await f.reopen();assert.equal(await readFile(path.join(roots[0].livePath,'original'),'utf8'),'complete original');assert.equal(f.ok(await f.api('GET','/api/branches/engine/projects/'+chats[1].projectId+'/agents')).length,1);
}));
test('nested recovery roots retain cross-root inode links without duplicating the child tree',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const value=installation({nested:true}),{plan,first,second}=await preview(f,value),complete=await finish(f,plan);assert.equal(complete.workingDataApplication.roots.length,2);assert.equal((await lstat(path.join(second,'hard'))).ino,(await lstat(path.join(first,'original'))).ino);
}));
test('completed physical receipt recovers result projections and uncertain receipt stays held without writes',async t=>{
 let store;await withFixture(t,async f=>{
  const value=installation(),{plan,first}=await preview(f,value);await finish(f,plan);const before=await stat(path.join(first,'original'));
  let row=store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(plan.id),state=JSON.parse(row.preview_json);
  delete state.importResults;store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=?,next_attempt_at=NULL,error=NULL WHERE id=?").run(JSON.stringify(state),plan.id);
  await f.reopen();await until(async()=>f.ok(await f.api('GET',route(plan.id))).state==='completed','projection-only recovery');
  const recovered=f.ok(await f.api('GET',route(plan.id)));assert.equal(Object.keys(recovered.importResults).length,2);assert.equal((await stat(path.join(first,'original'))).ino,before.ino);
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
