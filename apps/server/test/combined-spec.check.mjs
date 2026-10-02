import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root = process.argv[2];
const load = name => import(pathToFileURL(path.join(root,name)));
const require = createRequire(path.join(root,'apps/server/package.json'));
const Fastify = require('fastify');
const {AgentStore,CoordinationV3Store} = await load('packages/agents/dist/index.js');
const {createServer} = await load('apps/server/dist/app.js');
const {registerAgentCoordinationRoutes} = await load('apps/server/dist/routes/agent-coordination.js');
const {registerRequestSecurityHooks} = await load('apps/server/dist/server-request-hooks.js');
const {mapCodexAppServerNotification} = await load('packages/engines/dist/codex-app-server.js');
const {projectAgentEvent} = await load('packages/engines/dist/agent-event-projection.js');
const {classifyToolFailure} = await load('packages/core/dist/tool-failure.js');
const {PONDEROSA_UPDATE_REQUEST_TOOL,PONDEROSA_MESSAGE_TOOL} = await load('packages/core/dist/managed-tools.js');
const {codexAuthStatus} = await load('packages/engines/dist/auth.js');
const directory = fs.mkdtempSync(path.join(tmpdir(),'ponderosa-combined-base-'));
const store = new AgentStore(directory);
const coordination = new CoordinationV3Store(store.sqlite);
const project = store.createProject({label:'Synthetic coordination qualification',hostPath:directory,defaultEngine:'codex'});
const chat = store.createConversation(project.id,{title:'Synthetic'});
const manager = store.createAgent(project.id,{title:'Manager',engine:'codex',conversationId:chat.id});
const worker = store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id});
const authorize = lease => ({runId:lease.runId,agentId:lease.agentId,fencingToken:lease.fencingToken});
const acknowledge = lease => {
  coordination.preparePromptInjection({injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken,prompt:'Synthetic turn'});
  coordination.markPromptSubmitted({injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken});
  coordination.acknowledgePromptInjection({injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken});
};
const output = (area,value) => console.log(JSON.stringify({area,...value}));
try {
  coordination.coordinate({projectId:project.id,conversationId:chat.id,actorScope:'user:local-operator',idempotencyKey:'parent',requests:[{requestId:'parent',recipientAgentId:manager.id,lifetime:{kind:'indefinite'},payload:{text:'Integrate result'}}]});
  const parent = coordination.leaseNextRun({workerId:'synthetic-parent'}); assert.ok(parent);
  acknowledge(parent);
  coordination.coordinate({projectId:project.id,conversationId:chat.id,requesterAgentId:manager.id,actorScope:`agent:${manager.id}:run:${parent.runId}`,runAuthorization:authorize(parent),idempotencyKey:'dependency',requests:[{requestId:'child',recipientAgentId:worker.id,lifetime:{kind:'indefinite'},payload:{text:'Return result'}}],join:{id:'dependency',mode:'all',continuationRequestIds:['parent']}});
  const child = coordination.leaseNextRun({workerId:'synthetic-worker'}); assert.equal(child.agentId,worker.id); acknowledge(child);
  coordination.updateRequest({requestId:'child',updateId:'child-result',kind:'completed',actor:{kind:'agent',id:worker.id},runAuthorization:authorize(child),payload:{text:'Child result'}});
  coordination.completeRun(child.runId,child.fencingToken);
  coordination.updateRequest({requestId:'parent',updateId:'parent-progress',kind:'progress',actor:{kind:'agent',id:manager.id},runAuthorization:authorize(parent),payload:{text:'Progress after child completion'}});
  const before = coordination.getRequest('parent').state;
  coordination.completeRun(parent.runId,parent.fencingToken);
  output('dependency-finalization',{before,after:coordination.getRequest('parent').state,pendingWakeups:store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_activations WHERE agent_id=? AND kind='coordination_join_satisfied' AND state='pending'").get(manager.id).n});

  // Real creation route and canonical store; no provider is launched.
  const app = Fastify();
  const lease = coordination.leaseNextRun({workerId:'synthetic-manager'}); assert.ok(lease);
  const capability = {agentId:manager.id,conversationId:chat.id,runId:lease.runId,v3SchedulerRunId:lease.runId,v3FencingToken:lease.fencingToken};
  const adapter = {id:'disabled',label:'Disabled',listModels:()=>[],listEfforts:()=>[]};
  registerAgentCoordinationRoutes(app,{store,coordinationV3:coordination,engines:new Map([['disabled',{adapter}]]),providerEnabled:()=>false,deletingAgentIds:new Set(),deletingProjectIds:new Set(),deletingConversationIds:new Set(),conversationDeliveryLeases:new Map(),agentDeliveryLeases:new Map(),agentMessageCapabilities:new Map([['synthetic-capability',capability]]),activeRuns:new Map([[manager.id,{messageCapability:'synthetic-capability'}]]),cachedModelOptions:()=>[],capabilityOwnsAuthoritativeRun:()=>true,runAuthorization:()=>authorize(lease),reconcileRuntimeCommunicationProjections:async()=>0,recordCommunication:x=>x,projectCommunicationToAgentAudit:()=>{},publishCoordinationV3Changed:()=>{},notifyScheduler:()=>{},resolveExplicitCollaborationIntents:()=>({text:'',intents:[]}),logWarn:()=>{}});
  const counts = () => Object.fromEntries(['agents','coordination_requests','coordination_joins','runtime_communications','agent_activations'].map(table=>[table,store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const initial = counts();
  const result = await app.inject({method:'POST',url:'/api/agent-spawn',headers:{authorization:'Bearer synthetic-capability'},payload:{idempotencyKey:'disabled-creation',title:'Disabled child',engine:'disabled',text:'Do work',lifetime:{kind:'indefinite'}}});
  output('disabled-managed-creation',{status:result.statusCode,response:result.json(),before:initial,after:counts()});
  await app.close();
  acknowledge(lease);
  coordination.completeRun(lease.runId,lease.fencingToken);

  const full = createServer({dataDir:directory,store,engines:[{adapter:{...adapter,id:'codex'},authStatus:async()=>({authenticated:true})}],logger:false,startDrained:true});
  try {
    await full.ready();
    const preferences = await full.inject({method:'PATCH',url:'/api/workspace/preferences',payload:{providerAvailability:{codex:false}}}); assert.equal(preferences.statusCode,200,preferences.body);
    const humanBefore=counts();
    const human=await full.inject({method:'POST',url:`/api/projects/${project.id}/agents`,payload:{title:'Human-created disabled assignment',engine:'codex',conversationId:chat.id,initialMessage:'Executable opening',idempotencyKey:'human-disabled'}});
    output('disabled-human-creation',{status:human.statusCode,before:humanBefore,after:counts()});
    coordination.coordinate({projectId:project.id,conversationId:chat.id,actorScope:'user:local-operator',idempotencyKey:'queued-disabled',requests:[{requestId:'queued-disabled',recipientAgentId:worker.id,lifetime:{kind:'indefinite'},payload:{text:'Pending disabled work'}}]});
    const health = await full.inject({method:'GET',url:`/api/conversations/${chat.id}/agent-health`});
    output('queued-health',{status:health.statusCode,health:health.json().agents.find(a=>a.agentId===worker.id)});
  } finally {full.prepareForShutdown();await full.close();}

  output('tool-contract',{updateDescription:PONDEROSA_UPDATE_REQUEST_TOOL.description,acceptedKinds:PONDEROSA_UPDATE_REQUEST_TOOL.inputSchema.properties.kind.enum,messageDescription:PONDEROSA_MESSAGE_TOOL.description});

  for (const mode of ['implicit','explicit','throw']) {
    const logs=[];const sink={write:line=>logs.push(JSON.parse(line))};
    const timeoutApp=Fastify({logger:{level:'warn',stream:sink}});
    registerRequestSecurityHooks(timeoutApp,{opts:{dataDir:directory,engines:[],requestLimits:{maxRequestsPerMinute:100,maxInflight:1,handlerDeadlineMs:10}},v3DispatchKey:'test',agentMessageCapabilities:new Map(),deletingAgentIds:new Set(),validLauncherSession:()=>false,artifactFilesystemError:()=>undefined,isArtifactDependentWorkIntake:()=>false,isPublicWebAssetRequest:()=>false});
    timeoutApp.get('/api/delayed',async(_request,reply)=>{await new Promise(resolve=>setTimeout(resolve,40));if(mode==='throw')throw Error('Late failure');if(mode==='explicit')return reply.send({late:true});return {late:true};});
    timeoutApp.get('/api/quick',async()=>({ok:true}));
    const response=await timeoutApp.inject('/api/delayed');
    const during=await timeoutApp.inject('/api/quick');
    await new Promise(resolve=>setTimeout(resolve,60));
    const after=await timeoutApp.inject('/api/quick');
    output('handler-deadline',{mode,status:response.statusCode,during:during.statusCode,after:after.statusCode,warnings:logs.map(l=>({code:l.err?.code,msg:l.msg}))});
    await timeoutApp.close();
  }

  const command = mapCodexAppServerNotification({method:'item/completed',params:{item:{type:'commandExecution',id:'command',aggregatedOutput:'',exitCode:1,signal:'SIGTERM'}}},directory)[0];
  output('command-outcomes',{mapped:command,projected:projectAgentEvent(command)});
  const envelope = JSON.stringify({error_code:'INVALID_ARGUMENT',error_data:{error_type:'RATE_LIMIT_EXCEEDED',retry_after_seconds:12}});
  output('connector-rate-limit',{envelope,classification:classifyToolFailure(envelope,true)});
  output('auth-probe-error',{status:await codexAuthStatus({...process.env,PONDEROSA_CODEX_BIN:path.join(directory,'missing-codex')})});
  for (const status of ['completed','failed','interrupted','inProgress','unknown',undefined]) {
    output('terminal-status',{status:status ?? 'missing',events:mapCodexAppServerNotification({method:'turn/completed',params:{turn:{id:'synthetic-exact',status}}},directory)});
  }
} finally {
  try{store.close();}catch{}
  fs.rmSync(directory,{recursive:true,force:true});
}
