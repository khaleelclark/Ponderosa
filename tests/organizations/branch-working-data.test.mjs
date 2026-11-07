import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,link,symlink,readFile,readlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,WorkspaceStore} from '@ponderosa/agents';
import {registerAgentPackageRoutes} from '../../apps/server/dist/routes/agent-packages.js';
import {createBranchWorkingData,validateBranchWorkingData,branchWorkingDataHash} from '../../apps/server/dist/branch-working-data.js';
import {collectBranchGitStorageSelections} from '../../apps/server/dist/branch-export-selections.js';
import {validateWorkingRootNesting,orderWorkingRoots} from '../../apps/server/dist/portable-working-files.js';
import {validatePortableAgentPackage} from '../../apps/server/dist/portable-agent-package-validation.js';

const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
const node=(ref,root,files=[],links=[])=>({ref,title:ref,engine:'codex',managementPermissions:permissions,workingCopyMode:'shared',workingRootRef:root,workingFolder:{directories:[],excludedPaths:[],links},workingFiles:files,artifacts:files.map(file=>({ref:file.artifactRef,kind:'document',path:file.path,createdAt:'2026-11-03T00:00:00.000Z',dataBase64:Buffer.from('original').toString('base64')}))});
const definition=ref=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',exportedAt:'2026-11-03T00:00:00.000Z',sourceLabel:ref,rootRef:ref,agents:[{ref,title:ref,engine:'codex',managementPermissions:permissions,workingCopyMode:'shared',history:[{role:'user',text:'private '+ref}]}]});
const chats=()=>[{ref:'chat-a',title:'A',agents:[{ref:'a',definition:definition('a')}]},{ref:'chat-b',title:'B',agents:[{ref:'b',definition:definition('b')}]}];
function carrier(){const agents=[node('source-a','root-a',[{path:'original',artifactRef:'physical-original'}]),node('source-b','root-b',[],[{path:'alias',kind:'hardlink',target:'original',targetRootRef:'root-a'}])];return createBranchWorkingData({schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:'2026-11-03T00:00:00.000Z',sourceLabel:'closed roots',rootRef:'source-a',rootRefs:['source-a','source-b'],agents},{'source-a':{chatRef:'chat-a',agentRef:'a'},'source-b':{chatRef:'chat-b',agentRef:'b'}});}
const rehash=value=>({...value,sha256:branchWorkingDataHash({schema:value.schema,package:value.package,owners:value.owners})});

test('repeated global storage selections deduplicate by exact binding ID and conflicting identities refuse',()=>{
 const common={id:'common',worktreeAgentId:'a',storageAgentId:'b',relativePath:'.',role:'common'},privateBinding={id:'private',worktreeAgentId:'a',storageAgentId:'b',relativePath:'worktrees/a',role:'private'};
 const selected=[common,privateBinding];
 assert.deepEqual(collectBranchGitStorageSelections({a:{gitStorageBindings:selected},b:{gitStorageBindings:structuredClone(selected)}}),selected);
 assert.throws(()=>collectBranchGitStorageSelections({a:{gitStorageBindings:selected},b:{gitStorageBindings:[{...common,storageAgentId:'c'}]}}),/Conflicting global/);
});

test('typed nesting preserves exact parent/child destination membership and forbids undeclared collisions',()=>{
 const refs=new Set(['parent','child','sibling']),nested=[{parentRootRef:'parent',childRootRef:'child',path:'modules/selected'}];
 const destinations={parent:'/tmp/fresh-parent',child:'/tmp/fresh-parent/modules/selected',sibling:'/tmp/fresh-sibling'};
 assert.doesNotThrow(()=>validateWorkingRootNesting(refs,nested,destinations));
 assert.throws(()=>validateWorkingRootNesting(refs,[],destinations),/overlap/);
 assert.throws(()=>validateWorkingRootNesting(refs,nested,{...destinations,child:'/tmp/unrelated'}),/exact selected/);
 assert.throws(()=>validateWorkingRootNesting(refs,[...nested,{parentRootRef:'child',childRootRef:'parent',path:'loop'}]),/Cyclic/);
 assert.deepEqual(orderWorkingRoots([{ref:'child',links:[]},{ref:'parent',links:[]}],nested).map(root=>root.ref),['parent','child']);
});

test('one Branch physical carrier closes cross-Chat hardlinks while histories remain separate',()=>{
 const value=carrier(),source=chats();assert.doesNotThrow(()=>validateBranchWorkingData(value,source,'full'));
 assert.equal(value.package.agents.flatMap(node=>node.artifacts??[]).length,1);
 assert.deepEqual(source.map(chat=>chat.agents[0].definition.agents[0].history[0].text),['private a','private b']);
 assert.ok(value.package.agents.every(node=>node.history===undefined&&node.sourceChat===undefined));
});
test('carrier validation refuses missing owners, altered bytes, context/grants and physical duplication',()=>{
 const source=chats();
 for(const mutate of [value=>delete value.owners['source-b'],value=>value.owners['source-b']={chatRef:'chat-a',agentRef:'a'},value=>value.package.agents[0].history=[{role:'user',text:'foreign history'}],value=>value.package.agents[0].managementPermissions={...permissions,allowAutomaticDescendantDeletion:true}]){
  const value=carrier();mutate(value);assert.throws(()=>validateBranchWorkingData(rehash(value),source,'full'));
 }
 const changed=carrier();changed.package.agents[0].artifacts[0].dataBase64=Buffer.from('changed').toString('base64');assert.throws(()=>validateBranchWorkingData(changed,source,'full'),/bytes/);
 const duplicate=chats();duplicate[0].agents[0].definition.agents[0].workingFolder={directories:[],excludedPaths:[]};assert.throws(()=>validateBranchWorkingData(carrier(),duplicate,'full'),/duplicated/);
 assert.throws(()=>validateBranchWorkingData(carrier(),source,'template'));
});

test('shared export captures all selected source roots once across separate Chat owners, without copying their history into physical data',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'branch-working-closure-')),dataDir=path.join(root,'state'),first=path.join(root,'first'),second=path.join(root,'second');
 await mkdir(dataDir);await mkdir(first);await mkdir(second);await writeFile(path.join(first,'original'),'complete original');await link(path.join(first,'original'),path.join(second,'hard'));await symlink('../first/original',path.join(second,'symbolic'));
 const store=new AgentStore(dataDir),workspace=new WorkspaceStore(dataDir),coordination=new CoordinationV3Store(store.sqlite),app=Fastify();let complete=false;
 try{
  const aProject=store.createProject({label:'A',hostPath:first,defaultEngine:'codex',chatOwned:true}),bProject=store.createProject({label:'B',hostPath:second,defaultEngine:'codex',chatOwned:true});
  const a=store.createAgent(aProject.id,{title:'A',engine:'codex',conversationId:aProject.lastConversationId}),b=store.createAgent(bProject.id,{title:'B',engine:'codex',conversationId:bProject.lastConversationId});
  store.setImportedHistory(a.id,'private-a',[{role:'user',text:'ONLY_A_HISTORY'}]);store.setImportedHistory(b.id,'private-b',[{role:'user',text:'ONLY_B_HISTORY'}]);
  const {packageEngine}=registerAgentPackageRoutes(app,{dataDir,store,workspace,coordination,assets:{},engines:new Map([['codex',{adapter:{id:'codex',listModels:()=>[],listEfforts:()=>[]}}]]),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:()=>[],createOperationalNotification(){}});
  await app.ready();
  const exported=await packageEngine.exportAgentSet([a.id,b.id],'full',{[a.id]:{wholeWorkingFolder:true},[b.id]:{wholeWorkingFolder:true}});
  const working=exported.working;validatePortableAgentPackage(working);
  const aNode=working.agents.find(node=>node.ref===a.id),bNode=working.agents.find(node=>node.ref===b.id);
  assert.equal(aNode.workingFiles.length,1);assert.equal(bNode.workingFolder.links.filter(link=>link.kind==='hardlink').length,1);
  assert.equal(bNode.workingFolder.links.find(link=>link.kind==='hardlink').targetRootRef,aNode.workingRootRef);
  assert.equal(bNode.workingFolder.links.find(link=>link.kind==='symlink').targetRootRef,aNode.workingRootRef);
  assert.ok(working.agents.every(node=>node.history===undefined&&node.accessSettings===undefined&&node.sourceChat===undefined));
  assert.ok(exported.agents[a.id].agents[0].history.some(message=>message.text==='ONLY_A_HISTORY'));
  assert.ok(!exported.agents[a.id].agents[0].history.some(message=>message.text==='ONLY_B_HISTORY'));
  assert.ok(exported.agents[b.id].agents[0].history.some(message=>message.text==='ONLY_B_HISTORY'));
  assert.ok(exported.agents[a.id].agents.every(node=>node.workingFolder===undefined&&node.workingRootRef===undefined));
  assert.equal(await readFile(path.join(first,'original'),'utf8'),'complete original');assert.equal(await readlink(path.join(second,'symbolic')),'../first/original');
  const moduleRoot=path.join(first,'module');await mkdir(moduleRoot);await writeFile(path.join(moduleRoot,'nested-only'),'one physical path');
  const moduleProject=store.createProject({label:'Module',hostPath:moduleRoot,defaultEngine:'codex',chatOwned:true}),moduleAgent=store.createAgent(moduleProject.id,{title:'Module',engine:'codex',conversationId:moduleProject.lastConversationId});
  const nested=await packageEngine.exportAgentSet([moduleAgent.id,b.id,a.id],'full',Object.fromEntries([moduleAgent.id,b.id,a.id].map(id=>[id,{wholeWorkingFolder:true}])));
  validatePortableAgentPackage(nested.working);
  const parentNode=nested.working.agents.find(node=>node.ref===a.id),childNode=nested.working.agents.find(node=>node.ref===moduleAgent.id);
  assert.deepEqual(nested.working.workingRootNesting,[{parentRootRef:parentNode.workingRootRef,childRootRef:childNode.workingRootRef,path:'module'}]);
  assert.ok(parentNode.workingFolder.excludedPaths.includes('module'));
  assert.ok(!parentNode.workingFiles.some(file=>file.path.startsWith('module/')));
  assert.deepEqual(childNode.workingFiles.map(file=>file.path),['nested-only']);
  assert.equal(await readFile(path.join(moduleRoot,'nested-only'),'utf8'),'one physical path');
  const choices={[a.id]:{wholeWorkingFolder:true,reviewedUserData:{git:true,harness:false},gitStorageBindings:[{id:'same',worktreeAgentId:a.id,storageAgentId:b.id,relativePath:'.',role:'common'}]},[b.id]:{wholeWorkingFolder:true,gitStorageBindings:[{id:'same',worktreeAgentId:a.id,storageAgentId:b.id,relativePath:'other',role:'common'}]}};
  await assert.rejects(packageEngine.exportAgentSet([a.id,b.id],'full',choices),/Conflicting global/);
  await assert.rejects(packageEngine.exportAgentSet([a.id],'full',{[a.id]:choices[a.id]}),/every source\/storage root/);
  const retainedBinding={id:'retained',worktreeAgentId:a.id,storageAgentId:b.id,relativePath:'.',role:'common'};
  await assert.rejects(packageEngine.exportAgentSet([b.id,a.id],'full',{[b.id]:{wholeWorkingFolder:true},[a.id]:{wholeWorkingFolder:true,reviewedUserData:{git:true,harness:false,source:'retained_originals'},gitStorageBindings:[retainedBinding]}}),/explicitly selected live whole-folder Git roots/);
  const selected=Array.from({length:80},(_,index)=>String(index).padStart(3,'0')+'-'+ 'x'.repeat(180));
  for(const filename of selected)await writeFile(path.join(first,filename),'selected');
  const body={mode:'full',workingFiles:selected,download:true};
  assert.ok(Buffer.byteLength(JSON.stringify(body))>14000,'accepted choices exceed ordinary URL/header budgets');
  const preparedResponse=await app.inject({method:'POST',url:'/api/agents/'+a.id+'/export',payload:body});
  assert.equal(preparedResponse.statusCode,200,preparedResponse.body);
  const prepared=preparedResponse.json(),downloaded=await app.inject(prepared.downloadUrl);
  assert.equal(downloaded.statusCode,200);assert.deepEqual(downloaded.json().agents[0].workingFiles.map(file=>file.path).sort(),selected.sort());
  assert.equal((await app.inject(prepared.downloadUrl)).body,downloaded.body,'native retry reuses one exact original snapshot');
  assert.equal((await app.inject({method:'POST',url:'/api/agents/'+a.id+'/export',payload:{mode:'full',organization:'true'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/agents/'+a.id+'/export',payload:{mode:'full',gitStorageBindings:[]}})).statusCode,400);
  complete=true;
 }finally{await app.close();workspace.close();store.close();if(complete)await rm(root,{recursive:true,force:true});else t.diagnostic('Retained failed Branch closure fixture: '+root);}
});
