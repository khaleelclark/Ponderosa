import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {AgentStore,WorkspaceStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
import {AssetStore} from '../dist/assets.js';
import {registerProductScope,rewriteProductUrl} from '../dist/product-scope.js';
import {createCommunicationArtifactAuthority} from '../dist/communication-artifacts.js';
import {createCommunicationDocumentAuthority} from '../dist/communication-document-authority.js';
import {registerCommunicationDocumentRoutes} from '../dist/routes/communication-documents.js';
import {createServer} from '../dist/app.js';

test('historical full communication documents survive canonical author deletion in each product',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fast020-document-history-'));
const store=new AgentStore(dir),workspace=new WorkspaceStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),assets=new AssetStore(dir),app=Fastify({rewriteUrl:rewriteProductUrl});
try {
  registerProductScope(app,store,workspace,()=>undefined,()=>false);
  const artifacts=createCommunicationArtifactAuthority({dataDir:dir,store,assets});
  const authority=createCommunicationDocumentAuthority(app,{store,coordinationV3:coordination,assets,communicationArtifactAccess:artifacts.communicationArtifactAccess,agentMessageCapabilities:new Map(),activeRuns:new Map(),capabilityOwnsAuthoritativeRun:()=>false});
  registerCommunicationDocumentRoutes(app,authority.authoritativeCommunicationDocument,store);
  for(const product of ['dev','branches']) {
    const branch=product==='branches'?branches.create('Document history','document-history'):undefined;
    const project=store.createProject({label:`${product} history`,hostPath:dir,defaultEngine:'codex',...(branch?{chatOwned:true,branchId:branch.id}:{})});
    const conversationId=project.lastConversationId,agent=store.createAgent(project.id,{title:'Author',engine:'codex',conversationId});
    const executionId=randomUUID(),eventId=randomUUID(),createdAt=new Date().toISOString(),content='Canonical historical full message';
    const artifact=await artifacts.stageCommunicationArtifact({projectId:project.id,communicationId:eventId,role:'document',title:'Full message',content,originAgentId:agent.id,executionId,createdAt});
    const document={id:artifact.id,artifactId:artifact.id,title:artifact.title,mediaType:artifact.mediaType,byteLength:artifact.byteLength,authorAgentId:agent.id,executionId,createdAt};
    const event={eventId,schemaVersion:2,projectId:project.id,conversationId,sender:{kind:'agent',agentId:agent.id,executionId},text:'Preview remains',intent:'broadcast',audience:{kind:'organization',organizationId:project.id},createdAt,document};
    store.appendCommunicationEvent(event);
    artifacts.projectCommunicationArtifact(project.id,agent.id,artifact,artifacts.communicationArtifactAccess(event));
    const path=`/projects/${project.id}/communication-documents/${document.id}`,own=product==='dev'?'/api':'/api/branches/engine',foreign=product==='dev'?'/api/branches/engine':'/api';
    assert.equal(authority.authoritativeCommunicationDocument(project.id,document.id)?.document.content,content);
    for(const suffix of ['', '/download'])assert.equal((await app.inject(own+path+suffix)).statusCode,200);
    assert.equal((await app.inject(foreign+path)).statusCode,404);
    store.deleteAgent(agent.id);
    assert.equal(authority.authoritativeCommunicationDocument(project.id,document.id)?.document.content,content);
    assert.ok(store.readCommunicationEvents(project.id).some(e=>e.eventId===eventId));
    assert.ok(store.getConversation(conversationId));
    for(const suffix of ['','/download']){
      const response=await app.inject(own+path+suffix);assert.equal(response.statusCode,200,response.body);
      assert.equal(suffix?response.body:response.json().content,content);
      assert.equal((await app.inject(foreign+path+suffix)).statusCode,404);
    }
    const wrongProject=store.createProject({label:'Wrong custody',hostPath:dir,defaultEngine:'codex'});
    assert.equal((await app.inject(`${own}/projects/${wrongProject.id}/communication-documents/${document.id}`)).statusCode,404);
    if(branch){
      for(const resource of [agent.id,conversationId]){
        store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES (?,?,?,?,?,?)").run(branch.id,'document-custody',resource,resource===agent.id?'author':'',resource,'staging');
        for(const state of ['staging','retiring']){
          store.sqlite.prepare('UPDATE branch_installation_resources SET state=? WHERE local_id=?').run(state,resource);
          for(const suffix of ['','/download'])assert.equal((await app.inject(own+path+suffix)).statusCode,404,'inactive historical custody stays closed');
        }
        store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE local_id=?").run(resource);
      }
      assert.equal((await app.inject(own+path)).statusCode,200);
    }
    console.log(`PASS ${product}: deleted-author historical documents preserve content and exact product/custody fences.`);
  }
} finally {await app.close();assets.close();store.close();rmSync(dir,{recursive:true,force:true});}

});

test('sidebar HTTP search preserves distinct Chats before limiting and product filtering',async()=>{
const dir=mkdtempSync(join(tmpdir(),'fast020-sidebar-search-')),store=new AgentStore(dir);
let app;
try {
 const project=store.createProject({label:'Canonical Dev search',hostPath:dir,defaultEngine:'codex'}),a=store.getConversation(project.lastConversationId),b=store.createConversation(project.id,{title:'Second match'});
 app=createServer({dataDir:dir,store,engines:[],startDrained:true,logger:false,resourceAdmission:{enabled:false}});
 for(const [chat,index] of [[b,0],[a,1],[a,2],[a,3],[a,4],[a,5]]){
  const sent=await app.inject({method:'POST',url:`/api/conversations/${chat.id}/messages`,payload:{text:`#broadcast needle ${index}`,idempotencyKey:`search-probe-${index}`}});
  assert.equal(sent.statusCode,200,sent.body);
 }
 const direct=store.searchGlobalChats({query:'needle',limit:5,chatKind:'conversation',distinctChats:true,product:'dev'});
 assert.equal(new Set(direct.results.map(r=>r.chat.id)).size,2);
 const reply=await app.inject('/api/search?q=needle&limit=5&kind=conversation&distinct=chats');
 assert.equal(reply.statusCode,200,reply.body);
 const result=reply.json();assert.equal(result.results.length,2);assert.deepEqual(new Set(result.results.map(r=>r.chat.id)),new Set([a.id,b.id]));
 const general=await app.inject('/api/search?q=needle&limit=5&kind=conversation');assert.equal(general.json().results.length,5);
 const foreign=await app.inject('/api/branches/engine/search?q=needle&limit=5&kind=conversation&distinct=chats');assert.deepEqual(foreign.json().results,[]);
 const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));const branch=branches.create('Search own','search-own');
 const branchProject=store.createProject({label:'Branch own match',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id});
 const sent=await app.inject({method:'POST',url:`/api/branches/engine/conversations/${branchProject.lastConversationId}/messages`,payload:{text:'#broadcast needle branch',idempotencyKey:'branch-search'}});assert.equal(sent.statusCode,200,sent.body);
 const branchRead=await app.inject('/api/branches/engine/search?q=needle&limit=5&kind=conversation&distinct=chats&product=dev');
 assert.deepEqual(branchRead.json().results.map(r=>r.chat.id),[branchProject.lastConversationId],'query cannot choose foreign product');
 const devRead=await app.inject('/api/search?q=needle&limit=5&kind=conversation&distinct=chats&product=branches');
 assert.deepEqual(new Set(devRead.json().results.map(r=>r.chat.id)),new Set([a.id,b.id]));
 console.log(JSON.stringify({routeStatus:reply.statusCode,routeChatIds:result.results.map(r=>r.chat.id),directDistinctChatIds:direct.results.map(r=>r.chat.id)},null,2));
 console.log('PASS actual sidebar HTTP search returns both distinct Chats and rejects foreign-product matches.');
} finally {app?.prepareForShutdown();await app?.close();store.close();rmSync(dir,{recursive:true,force:true});}

});
