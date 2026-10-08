import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {BranchInstallationService} from '../dist/branch-installation-service.js';
import {registerAgentPackageRoutes} from '../dist/routes/agent-packages.js';
import {AssetStore} from '../dist/assets.js';
import {createServer} from '../dist/app.js';
const gate={id:'gate',kind:'human_gate',prompt:'Approve',editable:false};
const definition={schema:'ponderosa.branch.v1',name:'Retained',trigger:{kind:'manual'},entry:'gate',steps:[gate,{id:'agent',kind:'agent',target:{kind:'persistent_organization',ref:'lead'},instructions:'Complete the retained task'}],controls:[],edges:[{id:'next',from:'gate',to:'agent',on:'approved'}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
function pkg(){const chat=(ref)=>({ref,title:ref,agents:[{ref:'lead',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:ref,rootRef:'lead',agents:[{ref:'lead',title:ref,engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]}}]});return {schema:'ponderosa.branch-installation.v1',packageId:'retained-runtime',mode:'template',exportedAt:new Date().toISOString(),definition,chats:[chat('work'),chat('sibling')],agentBindings:{lead:{chatRef:'work',agentRef:'lead'}},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}}}
async function until(predicate){const deadline=Date.now()+10000;while(Date.now()<deadline){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,10))}assert.fail('retained execution did not drain')}
for(const [mode,removal,cancel] of [['gate','chat',false],['gate','agent',false],['held-budget','chat',false],['held-budget','agent',false],['gate','chat',true]])test(`production scheduler ${cancel?'cancels':'continues'} ${mode} through removed ${removal} after reopening`,{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'branch-retained-runtime-'));let store=new AgentStore(dir),assets=new AssetStore(dir),setup=Fastify(),app;
 let coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const installations=new BranchInstallationService(store,branches,async()=>{throw Error('pinned Chat must not drain')},async()=>{throw Error('pinned Agent must not drain')});
 installations.setPublisher((input,configuration)=>branches.deploy(input,new Date().toISOString(),undefined,configuration));
 registerAgentPackageRoutes(setup,{dataDir:dir,store,coordination,assets,branchInstallations:installations,engines:new Map([['codex',{adapter:{id:'codex',listModels:()=>[],listEfforts:()=>[]}}]]),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:()=>[],createOperationalNotification(){}});
 const p=pkg(),bindings={agents:{},directories:{workspace:dir},engines:{codex:'codex',default:'codex'}};
 let starts=0,token,release,entered=false;
 const hold=new Promise(r=>release=r);
 try {
  const installed=await installations.confirm(installations.preview(p,bindings).id);assert.equal(installed.state,'completed',installed.error);
  const branchId=installed.branchId,agentId=branches.localConfiguration(branchId).agents.lead,chatId=store.getAgent(agentId).conversationId;
  const siblingId=store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND chat_ref='sibling' AND agent_ref!=''").get(branchId).local_id;
  let old;
  if(mode==='held-budget'){
   let budget=branches.executionBudget(branchId);branches.updateExecutionBudget(branchId,{commandKey:'budget',expectedRevision:budget.revision,expectedPeriodId:budget.periodId,policy:{limit:1,period:'lifetime'},acknowledgeNewPeriod:true});
   const owner=branches.create('Caller','caller');
   const caller=branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'caller',definition:{...definition,entry:'call',steps:[{id:'call',kind:'branch_call',branchRef:'child'}],edges:[]},bindings:{agents:{},directories:{},branches:{child:branchId}}});
   const first=branches.accept(caller.id,'exhaust','input');branches.advance();branches.advance();
   const second=branches.accept(caller.id,'held','input');branches.advance();branches.advance();
   old=branches.listExecutions(branchId).find(e=>e.parentExecutionId===second.id);assert.ok(old);assert.ok(branches.execution(old.id).budgetWait);branches.cancel(first.id);
  }else {old=branches.accept(branchId,'old','input');branches.advance()}
  const removed={...p,agentBindings:{},definition:{...p.definition,steps:[gate],edges:[]},chats:removal==='chat'?[]:p.chats.map(c=>({...c,agents:[]}))};
  const updated=await installations.confirm(installations.preview(removed,bindings,branchId).id);assert.equal(updated.state,'completed',updated.error);
  assert.equal(store.sqlite.prepare('SELECT state FROM branch_installation_resources WHERE local_id=?').get(agentId).state,'retiring');
  await setup.close();assets.close();assets=undefined;store.close();store=new AgentStore(dir);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination);
  const run=async function*(options){
   starts++;assert.equal(options.agentId,agentId);token=options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN;
   const headers={authorization:`Bearer ${token}`};
   const own=await app.inject({url:`/api/agents/${agentId}`,headers});assert.equal(own.statusCode,200,own.body);assert.equal(own.json().agent.id,agentId,'own projection survives');
   const directory=await app.inject({url:'/api/agent-directory',headers});assert.equal(directory.statusCode,200,directory.body);assert.ok(directory.json().agents.some(a=>a.agentId===agentId),'canonical capability directory retains owner');
   assert.equal((await app.inject({url:`/api/agents/${siblingId}`,headers})).statusCode,404,'one pinned Request cannot read an unrelated retiring Agent');
   assert.equal((await app.inject({url:`/api/branches/${branchId}/agents/${agentId}/capabilities`,headers})).statusCode,404,'staging/editable Branch policy surface stays unavailable');
   entered=true;await hold;
   if(cancel){yield {type:'turn_done'};return}
   const result=await app.inject({method:'POST',url:'/api/agent-request-updates',headers,payload:{text:'Retained canonical task complete'}});
   assert.equal(result.statusCode,200,result.body);assert.ok(!result.json().error,result.body);
   yield {type:'turn_done'};
  };
  const adapter={id:'codex',displayName:'Disposable',trustedSystemPromptChannel:'developer',listModels:()=>[],listEfforts:()=>[],seed:run,continue:run};
  app=createServer({dataDir:dir,store,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,communicationV3:{pollMs:10}});await app.ready();
  assert.equal((await app.inject(`/api/branches/engine/agents/${agentId}`)).statusCode,404,'external reads still reject retirement');
  assert.equal((await app.inject({method:'POST',url:`/api/branches/engine/agents/${agentId}/messages`,payload:{text:'new intake'}})).statusCode,404);
  if(mode==='held-budget'){const budget=branches.executionBudget(branchId);branches.grantExecutions(branchId,{commandKey:'grant',expectedRevision:budget.revision,expectedPeriodId:budget.periodId,additional:1});branches.advance();assert.equal(branches.executionBudget(branchId).used,2)}
  const opened=branches.detail(old.id).gates[0];assert.ok(opened);branches.resolveGate(opened.id,{commandKey:'approve',expectedRevision:opened.revision,decision:'approve'});branches.advance();
  await until(()=>{const failed=store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE status='failed'").get();if(failed)throw Error(JSON.stringify(store.readEvents(agentId).slice(-5)));return entered});
  assert.equal(starts,1);assert.ok(store.getAgent(agentId));
  const headers={authorization:`Bearer ${token}`};
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='staging' WHERE local_id=?").run(agentId);
  assert.equal((await app.inject({url:`/api/agents/${agentId}`,headers})).statusCode,404,'exact runtime ownership never admits staging');
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='retiring' WHERE local_id=?").run(agentId);
  const leaseRow=store.sqlite.prepare("SELECT id,fencing_token FROM scheduler_runs WHERE agent_id=? AND status='running'").get(agentId);
  store.sqlite.prepare('UPDATE scheduler_runs SET side_effects_fenced_at=? WHERE id=?').run(new Date().toISOString(),leaseRow.id);
  assert.equal((await app.inject({url:`/api/agents/${agentId}`,headers})).statusCode,404,'an otherwise exact capability cannot cross a fenced Run');
  store.sqlite.prepare('UPDATE scheduler_runs SET side_effects_fenced_at=NULL WHERE id=?').run(leaseRow.id);
  if(cancel){branches.cancel(old.id);assert.equal((await app.inject({url:`/api/agents/${agentId}`,headers})).statusCode,404,'canceled Request revokes retained-resource authority before provider exit')}
  release();
  await until(()=>branches.execution(old.id).state===(cancel?'canceled':'completed'));await until(()=>!store.getAgent(agentId));
  assert.equal((await app.inject({url:'/api/agent-directory',headers:{authorization:`Bearer ${token}`}})).statusCode,401,'terminal capability fenced');
  if(removal==='chat')await until(()=>!store.getConversation(chatId));else assert.ok(store.getConversation(chatId));
  assert.equal(starts,1);
 }finally{release();if(app){app.prepareForShutdown();await app.close()}await setup.close();assets?.close();store.close();rmSync(dir,{recursive:true,force:true})}
});
