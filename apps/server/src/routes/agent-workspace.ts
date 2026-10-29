import {createHash,randomUUID} from 'node:crypto';
import {CapabilityPolicyStore,stableJson,type AgentStore,type CoordinationV3Store,type WorkspaceStore} from '@ponderosa/agents';
import {CAPABILITY_IDS,PONDEROSA_WORKSPACE_TOOLS,type CommunicationEvent} from '@ponderosa/core';
import type {FastifyInstance} from 'fastify';
import type {ActiveRun,AgentMessageCapability} from '../app-contracts.js';
import type {ChatCreator} from './projects.js';
import type {OutputAgentApps} from '../output-agent-apps.js';
import {validatedObject,exactObjectFields} from '../object-validation.js';
import {activeChatResourceOwner} from '../product-scope.js';

interface Context {
 store:AgentStore;coordinationV3:CoordinationV3Store;workspace:WorkspaceStore;outputApps:OutputAgentApps;createChat:ChatCreator;
 capabilities:ReadonlyMap<string,AgentMessageCapability>;activeRuns:ReadonlyMap<string,ActiveRun>;
 ownsRun(capability:AgentMessageCapability,run:ActiveRun|undefined):boolean;
 recordCommunication(event:CommunicationEvent):CommunicationEvent;
 reconcile(filter:{projectId:string;communicationEventId:string}):Promise<unknown>;
 notify():void;providerEnabled(id:string):boolean;
}
const failure=(message:string,statusCode=403)=>Object.assign(new Error(message),{statusCode});
const hash=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
const toolFor=(operation:string)=>operation==='check'?'ponderosa_assistant_check':`ponderosa_workspace_${operation}`;
const required=(body:Record<string,unknown>,key:string,max=200)=>{const v=body[key];if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max)throw failure(`Invalid ${key}`,400);return v.trim();};

/** Workspace actions are a separate host relay, never cross-Chat Communication authority. */
export function registerAgentWorkspaceActions(app:FastifyInstance,context:Context):void {
 const {store,coordinationV3}=context,policies=new CapabilityPolicyStore(store.sqlite);
 const denied=(ids:readonly string[],id:string)=>ids.includes(id);
 const chatAllowed=(chatId:string,id:string)=>{
  const owner=activeChatResourceOwner(store,'chat',chatId);
  return Boolean(owner&&!owner.executionId&&!denied(policies.resolveForChat(chatId).restrictedCapabilityIds,id));
 };
 app.post('/api/agent-workspace',async(request,reply)=>{
  try{
   const token=request.headers.authorization?.replace(/^Bearer\s+/i,''),capability=token?context.capabilities.get(token):undefined;
   const live=()=>{const active=capability&&context.activeRuns.get(capability.agentId);if(!capability||!context.ownsRun(capability,active)||active?.messageCapability!==token||!activeChatResourceOwner(store,'agent',capability.agentId))throw failure('Invalid or expired workspace Run capability',401);};live();
   const cap=capability!,author=store.getAgent(cap.agentId)!;
   const body=validatedObject(request.body,'workspace action'),operation=required(body,'operation'),tool=toolFor(operation);
   if(!PONDEROSA_WORKSPACE_TOOLS.some(t=>t.name===tool)||!cap.availableToolNames.includes(tool))throw failure('Workspace tool unavailable for this Run');
   const authorization={runId:cap.v3SchedulerRunId,agentId:cap.agentId,fencingToken:cap.v3FencingToken};
   const sourceAllows=()=>{live();const ids=policies.resolveForAgent(cap.agentId,cap.runId).restrictedCapabilityIds;
    const id=operation==='create_chat'?CAPABILITY_IDS.workspaceCreateChat:operation==='start_work'?CAPABILITY_IDS.workspaceStartWork:CAPABILITY_IDS.workspaceRead;
    if(denied(ids,id))throw failure('Human workspace access settings restrict this action');return ids;};sourceAllows();
   const fence=()=>{sourceAllows();coordinationV3.requireCurrentPromptInjection(authorization,typeof body.steeringInjectionId==='string'?body.steeringInjectionId:null);};
   if(operation==='projects'){
    exactObjectFields(body,['operation','afterId'],'project listing');
    if(body.afterId!==undefined&&typeof body.afterId!=='string')throw failure('Invalid afterId',400);
    const rows=store.sqlite.prepare(`SELECT id,project_id projectId,title FROM conversations WHERE id>? ORDER BY id LIMIT 51`).all(body.afterId??'') as Array<{id:string;projectId:string;title:string}>;
    const items=rows.slice(0,50).filter(row=>chatAllowed(row.id,CAPABILITY_IDS.workspaceRead)).map(row=>({...row,agents:store.listAgents(row.projectId).filter(a=>a.conversationId===row.id&&activeChatResourceOwner(store,'agent',a.id)&&!policies.resolveForAgent(a.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.workspaceRead)).slice(0,50).map(a=>({id:a.id,title:a.title,state:a.state}))}));
    return {items,hasMore:rows.length>50,...(rows.length>50?{afterId:rows[49]!.id}:{})};
   }
   if(operation==='check'){
    exactObjectFields(body,['operation','steeringInjectionId'],'Assistant check');
    if(context.outputApps.status().app?.agentId!==author.id)throw failure('Only the current Ponderosa speaker can publish an Assistant check');
    const everyMs=context.outputApps.get(author.id).everyMs??600000;
    const last=store.sqlite.prepare('SELECT MAX(reported_at) at FROM assistant_report_sources WHERE speaker_agent_id=?').get(author.id) as {at:string|null};
    if(last.at&&Date.now()-Date.parse(last.at)<everyMs)return {published:false,deferred:true};
    // Only explicit terminal task results count as completed work; a successful provider Run alone does not.
    const cursor=store.sqlite.prepare('SELECT after_sequence sequence FROM assistant_report_scan WHERE speaker_agent_id=?').get(author.id) as {sequence:number}|undefined;
    const rows=store.sqlite.prepare(`SELECT s.sequence,s.source_key sourceKey,s.project_id projectId,s.chat_id chatId,s.agent_id agentId,
      CASE s.kind WHEN 'communication' THEN substr(json_extract(c.payload_json,'$.communication.text'),1,300)
       WHEN 'request' THEN substr(json_extract(u.payload_json,'$.text'),1,300) ELSE substr(r.title,1,300) END text,
      CASE WHEN s.kind='communication' OR u.resulting_state='completed' THEN 'completed' ELSE 'issue' END state
      FROM assistant_status_sources s
      LEFT JOIN runtime_communications c ON s.kind='communication' AND c.id=s.source_id
      LEFT JOIN coordination_request_updates u ON s.kind='request' AND u.id=(SELECT update_row.id FROM coordination_request_updates update_row WHERE update_row.request_id=s.source_id AND update_row.resulting_version=s.source_version ORDER BY update_row.rowid DESC LIMIT 1)
      LEFT JOIN runs r ON s.kind='run' AND r.id=s.source_id AND r.agent_id=s.agent_id
      WHERE s.sequence>? AND s.agent_id<>? ORDER BY s.sequence LIMIT 201`).all(cursor?.sequence??0,author.id) as Array<{sequence:number;sourceKey:string;projectId:string;chatId:string;agentId:string;text:string;state:string}>;
    const seen=store.sqlite.prepare('SELECT 1 FROM assistant_report_sources WHERE speaker_agent_id=? AND source_key=?');
    const fresh:typeof rows=[];let scanned:typeof rows[number]|undefined,scanCount=0;
    for(const row of rows.slice(0,200)){
     scanned=row;scanCount++;
     if(chatAllowed(row.chatId,CAPABILITY_IDS.workspaceRead)&&activeChatResourceOwner(store,'agent',row.agentId)&&!policies.resolveForAgent(row.agentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.workspaceRead)&&!seen.get(author.id,row.sourceKey))fresh.push(row);
     if(fresh.length===50)break;
    }
    const advance=()=>{const sequence=scanned?.sequence??(store.sqlite.prepare('SELECT COALESCE(MAX(sequence),0) sequence FROM assistant_status_sources').get() as {sequence:number}).sequence;store.sqlite.prepare('INSERT INTO assistant_report_scan VALUES(?,?) ON CONFLICT(speaker_agent_id) DO UPDATE SET after_sequence=excluded.after_sequence').run(author.id,sequence);};
    const hasMore=scanCount<rows.length;
    if(!fresh.length){store.sqlite.transaction(()=>{fence();advance();})();return {published:false,changes:0,hasMore};}
    const event:CommunicationEvent={eventId:`assistant-report:${randomUUID()}`,schemaVersion:2,projectId:author.projectId,conversationId:author.conversationId!,sender:{kind:'agent',agentId:author.id,executionId:cap.runId},intent:'user_dm',audience:{kind:'user_agent',userId:'local-operator',agentId:author.id},createdAt:new Date().toISOString(),text:fresh.map(r=>`${r.state==='completed'?'Completed':'Issue'} — ${store.getConversation(r.chatId)?.title??'Chat'} / ${store.getAgent(r.agentId)?.title??'Agent'}: ${String(r.text??'Work requires attention').slice(0,300)}`).join('\n')};
    store.sqlite.transaction(()=>{
     fence();
     coordinationV3.recordRuntimeCommunication({id:event.eventId,projectId:event.projectId,sender:event.sender,intent:event.intent,audience:event.audience,payload:{communication:event,assistantSources:fresh.map(r=>({key:r.sourceKey,projectId:r.projectId,chatId:r.chatId,agentId:r.agentId}))},scopeKey:`conversation:${author.conversationId}`,runAuthorization:authorization});
     advance();
     for(const row of fresh)store.sqlite.prepare('INSERT INTO assistant_report_sources VALUES(?,?,?,?)').run(author.id,row.sourceKey,event.eventId,event.createdAt);
    })();
    await context.reconcile({projectId:event.projectId,communicationEventId:event.eventId});
    return {published:true,hasMore,communicationId:event.eventId,sources:fresh.map(r=>r.sourceKey)};
   }
   const idempotencyKey=required(body,'idempotencyKey',128),payloadHash=hash({...body,steeringInjectionId:undefined});
   const id=`workspace:${hash([author.id,operation,idempotencyKey])}`;
   const replay=store.sqlite.prepare('SELECT payload_hash hash,result_json result FROM workspace_agent_actions WHERE id=?').get(id) as {hash:string;result:string}|undefined;
   if(replay){
    if(replay.hash!==payloadHash)throw failure('Workspace action idempotency conflict',409);
    const result=JSON.parse(replay.result);
    if(!result.pending){
     if(operation==='create_chat'&&(policies.resolveForProduct('interactive').restrictedCapabilityIds.includes(CAPABILITY_IDS.workspaceCreateChat)||!activeChatResourceOwner(store,'chat',result.chat.id)))throw failure('Created Chat is unavailable or restricted');
     if(operation==='start_work'&&(!chatAllowed(result.chatId,CAPABILITY_IDS.workspaceStartWork)||!activeChatResourceOwner(store,'agent',result.agentId)||policies.resolveForAgent(result.agentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.workspaceStartWork)))throw failure('Destination work is unavailable or restricted');
     return {...result,replayed:true};
    }
   }
   const receipt=(result:object)=>{const committed=store.sqlite.prepare('SELECT payload_hash hash,result_json result FROM workspace_agent_actions WHERE id=?').get(id) as {hash:string;result:string}|undefined;if(committed){if(committed.hash!==payloadHash)throw failure('Workspace action idempotency conflict',409);return {...JSON.parse(committed.result),replayed:true};}const value={...result,actionId:id,sourceAgentId:author.id,sourceRunId:cap.runId};store.sqlite.prepare('INSERT INTO workspace_agent_actions VALUES(?,?,?,?,?,?,?,?)').run(id,author.id,cap.runId,operation,idempotencyKey,payloadHash,JSON.stringify(value),new Date().toISOString());return value;};
   if(operation==='create_chat'){
    exactObjectFields(body,['operation','label','engine','idempotencyKey','steeringInjectionId'],'Chat creation');
    if(policies.resolveForProduct('interactive').restrictedCapabilityIds.includes(CAPABILITY_IDS.workspaceCreateChat))throw failure('Human destination settings restrict Chat creation');
    const engine=required(body,'engine'),label=required(body,'label',240);if(!context.providerEnabled(engine))throw failure('Selected provider is unavailable',409);
    fence();if(!replay)receipt({pending:true});
    const chat=await context.createChat({label,defaultEngine:engine},`workspace-${hash([author.id,idempotencyKey]).slice(0,48)}`);
    const accepted=JSON.parse((store.sqlite.prepare('SELECT result_json result FROM workspace_agent_actions WHERE id=?').get(id) as {result:string}).result);
    if(!accepted.pending)return {...accepted,replayed:true};
    const result={chat,actionId:id,sourceAgentId:accepted.sourceAgentId,sourceRunId:accepted.sourceRunId};
    store.sqlite.prepare('UPDATE workspace_agent_actions SET result_json=? WHERE id=?').run(JSON.stringify(result),id);return result;
   }
   exactObjectFields(body,['operation','chatId','agentId','title','engine','text','idempotencyKey','steeringInjectionId'],'work request');
   const chatId=required(body,'chatId'),chat=store.getConversation(chatId);if(!chat||!chatAllowed(chatId,CAPABILITY_IDS.workspaceStartWork))throw failure('Human destination settings restrict work in this Chat');
   const text=required(body,'text',16000),existing=body.agentId===undefined?undefined:store.getAgent(required(body,'agentId'));
   if(body.agentId!==undefined&&(!existing||existing.conversationId!==chatId||!activeChatResourceOwner(store,'agent',existing.id)||policies.resolveForAgent(existing.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.workspaceStartWork)))throw failure('Destination Agent is unavailable or restricted');
   const engine=existing?.activeEngine??required(body,'engine'),title=existing?.title??required(body,'title',240);
   if(!existing&&sourceAllows().includes(CAPABILITY_IDS.managedAgentCreate))throw failure('Human settings restrict Agent creation');
   if(!context.providerEnabled(engine))throw failure('Selected provider is unavailable',409);
   const result=store.sqlite.transaction(()=>{
    fence();
    let agent=existing;
    if(!agent){
     const creation=store.beginAgentCreationOperation({projectId:chat.projectId,actorScope:`agent:${author.id}:workspace`,kind:'managed',idempotencyKey:id,payloadHash});
     agent=store.createAgent(chat.projectId,{title,engine,conversationId:chatId},{agentId:author.id,executionId:cap.runId,idempotencyKey,prompt:text});
     store.addAgentCreationOperationMember(creation.operation.id,agent.id,0);
     store.updateAgentCreationOperation(creation.operation.id,{status:'completed',result:{agentId:agent.id}});
    }
    // A host relay is system-authored in the destination, with immutable source provenance.
    const event:CommunicationEvent={eventId:id,schemaVersion:2,projectId:chat.projectId,conversationId:chatId,sender:{kind:'system',component:'workspace-relay'},intent:'collaboration',audience:{kind:'agents',agentIds:[agent.id]},text,createdAt:new Date().toISOString()};
    coordinationV3.recordRuntimeCommunication({id,projectId:chat.projectId,sender:event.sender,intent:event.intent,audience:event.audience,payload:{communication:event,workspaceOrigin:{agentId:author.id,runId:cap.runId,actionId:id}},scopeKey:`conversation:${chatId}`});
    const work=coordinationV3.coordinate({projectId:chat.projectId,conversationId:chatId,actorScope:`workspace:${id}`,idempotencyKey:id,requests:[{requestId:id,recipientAgentId:agent.id,communicationEventId:id,lifetime:{kind:'indefinite'},payload:{text,workspaceOrigin:{agentId:author.id,runId:cap.runId,actionId:id}}}]});
    return receipt({agentId:agent.id,chatId,projectId:chat.projectId,communicationId:id,requestId:work.requestIds[0]});
   })();
   await context.reconcile({projectId:chat.projectId,communicationEventId:id});context.notify();return result;
  }catch(error){return reply.code((error as {statusCode?:number}).statusCode??409).send({error:(error as Error).message});}
 });
}
