import type {
  DecisionDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
  UpdateWorkspacePreferencesRequest,
} from '@ponderosa/core';
import { userCommunicationArtifactOwners, artifactAgentProductSql, type AgentStore, type WorkspaceStore } from '@ponderosa/agents';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
export type ProductScope = 'dev' | 'branches';
type ProductRequest = IncomingMessage & { ponderosaProduct?: ProductScope };
/** Namespace selection is transport, never ownership authority. */
export function rewriteProductUrl(request: IncomingMessage): string {
  const url=request.url??'/';
  if(url.startsWith('/api/branches/engine/')){
    (request as ProductRequest).ponderosaProduct='branches';
    return '/api/'+url.slice('/api/branches/engine/'.length);
  }
  (request as ProductRequest).ponderosaProduct='dev';return url;
}
export function requestProduct(request:FastifyRequest):ProductScope {return (request.raw as ProductRequest).ponderosaProduct??'dev';}
export function chatProductSql(chatAlias:string,product:ProductScope):string {return `${chatAlias}.branch_id IS ${product==='branches'?'NOT ':''}NULL`;}
const activeChatSql=(alias:string):string =>
  `NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive WHERE inactive.local_id=${alias}.id AND inactive.state!='active')`;
export function activeChatProductSql(chatAlias:string,product:ProductScope):string {
  return `(${chatProductSql(chatAlias,product)}) AND (${activeChatSql(chatAlias)})`;
}
export function projectProductSql(projectExpression:string,product:ProductScope):string {
  const branchOwned=`EXISTS(SELECT 1 FROM conversations product_chat WHERE product_chat.project_id=${projectExpression} AND product_chat.branch_id IS NOT NULL AND ${activeChatSql('product_chat')})`;
  const devOwned=`EXISTS(SELECT 1 FROM conversations product_chat WHERE product_chat.project_id=${projectExpression} AND product_chat.branch_id IS NULL AND ${activeChatSql('product_chat')})`;
  const devRemoved=`EXISTS(SELECT 1 FROM conversation_deletion_receipts product_removed WHERE product_removed.project_id=${projectExpression} AND product_removed.branch_id IS NULL)`;
  const hasCanonicalHistory=`EXISTS(SELECT 1 FROM conversations product_chat WHERE product_chat.project_id=${projectExpression}) OR EXISTS(SELECT 1 FROM conversation_deletion_receipts product_removed WHERE product_removed.project_id=${projectExpression})`;
  return product==='branches'?`(${branchOwned})`:`((${devOwned}) OR (${devRemoved}) OR NOT (${hasCanonicalHistory}))`;
}
export function projectInProduct(store:Pick<AgentStore,'sqlite'>,id:string,product:ProductScope):boolean {
  return Boolean(store.sqlite.prepare(`SELECT 1 FROM projects WHERE id=? AND ${projectProductSql('projects.id',product)}`).get(id));
}
/** One canonical Automation ownership predicate for collection and direct routes. */
export function triggerProductSql(triggerAlias:string,product:ProductScope):string {
  const branchDestination=`${triggerAlias}.branch_id IS NOT NULL AND EXISTS(SELECT 1 FROM branches destination_branch WHERE destination_branch.id=${triggerAlias}.branch_id AND destination_branch.deleting=0)`;
  const agentDestination=`${triggerAlias}.branch_id IS NULL AND ${triggerAlias}.agent_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM agents destination_agent JOIN conversations destination_chat ON destination_chat.id=destination_agent.conversation_id
    WHERE destination_agent.id=${triggerAlias}.agent_id AND destination_agent.deleted_at IS NULL
      AND destination_chat.id=${triggerAlias}.conversation_id
      AND ${chatProductSql('destination_chat',product)}
      AND ${activeChatSql('destination_chat')}
      AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive WHERE inactive.local_id=destination_agent.id AND inactive.state!='active')
  )`;
  return product==='branches'?`((${branchDestination}) OR (${agentDestination}))`:`(${agentDestination})`;
}
export function occurrenceProductSql(occurrenceAlias:string,product:ProductScope):string {
  return `COALESCE(json_extract(${occurrenceAlias}.trigger_snapshot_json,'$.productScope'),CASE WHEN ${occurrenceAlias}.branch_id IS NOT NULL THEN 'branches' ELSE 'dev' END)='${product}'`;
}
/** Canonical active Chat ownership for resources whose product follows a Chat.
 * Installation state is authority: staging and retiring resources are not live. */
export function activeChatResourceOwner(store:Pick<AgentStore,'sqlite'>,kind:'conversation'|'chat'|'agent',id:string):{branchId:string|null}|undefined {
 const row=kind==='agent'
  ? store.sqlite.prepare(`SELECT c.branch_id FROM agents a JOIN conversations c ON c.id=a.conversation_id
      WHERE a.id=? AND a.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive WHERE inactive.local_id IN (a.id,c.id) AND inactive.state!='active')`).get(id)
  : store.sqlite.prepare(`SELECT c.branch_id FROM conversations c WHERE c.id=?
      AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive WHERE inactive.local_id=c.id AND inactive.state!='active')`).get(id);
 if(!row)return undefined;return {branchId:(row as {branch_id:string|null}).branch_id};
}
export function artifactAgentInProduct(store:Pick<AgentStore,'sqlite'>,agentId:string,projectId:string,product:ProductScope):boolean {
  return Boolean(store.sqlite.prepare(`SELECT 1 FROM agents artifact_agent WHERE artifact_agent.id=?
    AND artifact_agent.project_id=? AND ${artifactAgentProductSql('artifact_agent',product)}`).get(agentId,projectId));
}
function artifactInProduct(store:AgentStore,projectId:string,artifactId:string,product:ProductScope):boolean {
  const artifact=store.getProjectArtifact(projectId,artifactId);
  if(!artifact)return false;
  const owner=artifact.legacyRecovery?.custodianAgentId??artifact.originAgentId??artifact.agentId;
  const events=store.readCommunicationEvents(projectId);
  if(owner==='local-operator'||events.some(event=>event.sender.kind==='user'&&event.document?.artifactId===artifactId))
    return userCommunicationArtifactOwners(store.sqlite,events,projectId).get(artifactId)?.product===product;
  return artifactAgentInProduct(store,owner,projectId,product);
}
export function resourceInProduct(store:Pick<AgentStore,'sqlite'>,kind:string,id:string,product:ProductScope):boolean {
  if(kind==='project')return projectInProduct(store,id,product);
  if(kind==='agent'){
   const owner=activeChatResourceOwner(store,'agent',id);return Boolean(owner)&&(owner!.branchId?product==='branches':product==='dev');
  }
  if(kind==='conversation'||kind==='chat'){
   const owner=activeChatResourceOwner(store,kind,id);return Boolean(owner)&&(owner!.branchId?product==='branches':product==='dev');
  }
  if(kind==='trigger')return Boolean(store.sqlite.prepare(`SELECT 1 FROM trigger_definitions scoped_trigger WHERE scoped_trigger.id=? AND ${triggerProductSql('scoped_trigger',product)}`).get(id));
  return false;
}
/** Decisions inherit their product from their canonical Chat and Agent, never
 * from a Project row that may legitimately contain both products. */
export function decisionInProduct(
  store:Pick<AgentStore,'sqlite'>,
  decision:Pick<DecisionDto,'conversationId'|'agentId'>,
  product:ProductScope,
):boolean {
  if(!decision.conversationId)return resourceInProduct(store,'agent',decision.agentId,product);
  if(!resourceInProduct(store,'conversation',decision.conversationId,product))return false;
  const active=store.sqlite.prepare('SELECT conversation_id FROM agents WHERE id=? AND deleted_at IS NULL').get(decision.agentId) as {conversation_id:string}|undefined;
  if(active)return active.conversation_id===decision.conversationId&&resourceInProduct(store,'agent',decision.agentId,product);
  const historical=store.sqlite.prepare('SELECT conversation_id FROM agent_deletion_tombstones WHERE agent_id=?').get(decision.agentId) as {conversation_id:string|null}|undefined;
  return historical?.conversation_id===decision.conversationId;
}
/** One canonical notification ownership predicate for reads and every mutation.
 * A mixed Project is insufficient authority: a notification must carry a
 * canonical Chat/Agent reference, an explicit Branch, or belong to a Project
 * with only one product. */
export function notificationInProduct(
  store:Pick<AgentStore,'sqlite'>,
  notification:WorkspaceNotificationDto,
  product:ProductScope,
):boolean {
  const chatIds=[...new Set([
    ...(notification.conversationId?[notification.conversationId]:[]),
    ...(notification.conversationIds??[]),
  ])];
  const agentIds=[...new Set([
    ...(notification.agentId?[notification.agentId]:[]),
    ...(notification.agentIds??[]),
    ...(notification.sourceAgentId?[notification.sourceAgentId]:[]),
  ])];
  const hasCanonicalOwner=chatIds.length>0||agentIds.length>0;
  if(chatIds.some(id=>!resourceInProduct(store,'conversation',id,product)))return false;
  if(agentIds.some(id=>!resourceInProduct(store,'agent',id,product)))return false;
  if(hasCanonicalOwner){
    if(notification.branchId&&product!=='branches')return false;
    return true;
  }
  if(notification.branchId)return product==='branches';
  if(!notification.projectId)return product==='dev';
  const dev=projectInProduct(store,notification.projectId,'dev');
  const branches=projectInProduct(store,notification.projectId,'branches');
  return dev!==branches&&(product==='dev'?dev:branches);
}
const preferenceResourceKinds:Record<string,string>={projectOrder:'project',starredProjectIds:'project',chatOrder:'conversation',agentOrder:'agent',triggerOrder:'trigger',homeOrder:'key',starredResourceIds:'key'};
function preferenceMember(store:Pick<AgentStore,'sqlite'>,kind:string,id:string,product:ProductScope):boolean {
 if(kind!=='key')return resourceInProduct(store,kind,id,product);
 const split=id.indexOf(':');return split>0&&resourceInProduct(store,id.slice(0,split),id.slice(split+1),product);
}
export function productPreferences(store:Pick<AgentStore,'sqlite'>,preferences:WorkspacePreferencesDto,product:ProductScope):WorkspacePreferencesDto {
 const result={...preferences} as WorkspacePreferencesDto & Record<string,unknown>;
 for(const [key,kind]of Object.entries(preferenceResourceKinds))if(Array.isArray(result[key]))result[key]=(result[key] as string[]).filter(id=>preferenceMember(store,kind,id,product));
 result.notificationScopes=Object.fromEntries(Object.entries(preferences.notificationScopes??{}).filter(([key])=>preferenceMember(store,'key',key,product)));
 result.projectFolders=preferences.projectFolders?.filter(folder=>folder.projectIds.length?folder.projectIds.some(id=>resourceInProduct(store,'project',id,product)):product==='dev').map(folder=>({...folder,projectIds:folder.projectIds.filter(id=>resourceInProduct(store,'project',id,product))}));
 result.chatFolders=preferences.chatFolders?.filter(folder=>folder.conversationIds.length?folder.conversationIds.some(id=>resourceInProduct(store,'conversation',id,product)):product==='dev').map(folder=>({...folder,conversationIds:folder.conversationIds.filter(id=>resourceInProduct(store,'conversation',id,product))}));
 return result;
}
export function mergeProductPreferencePatch(store:Pick<AgentStore,'sqlite'>,current:WorkspacePreferencesDto,patch:UpdateWorkspacePreferencesRequest,product:ProductScope):UpdateWorkspacePreferencesRequest {
 const result={...patch} as UpdateWorkspacePreferencesRequest & Record<string,unknown>;
 for(const [key,kind]of Object.entries(preferenceResourceKinds))if(Array.isArray(result[key])){
  const own=(result[key] as string[]).filter(id=>preferenceMember(store,kind,id,product));
  const foreign=((current as unknown as Record<string,unknown>)[key] as string[]|undefined)?.filter(id=>!preferenceMember(store,kind,id,product))??[];
  result[key]=[...own,...foreign];
 }
 for(const key of ['projectFolders','chatFolders'] as const)if(result[key]){
  const member=key==='projectFolders'?'projectIds':'conversationIds',kind=key==='projectFolders'?'project':'conversation';
  const incoming=result[key] as unknown as Array<Record<string,unknown>>,previous=(current[key]??[]) as unknown as Array<Record<string,unknown>>;
  const merged=incoming.flatMap(folder=>{
   const old=previous.find(f=>f.id===folder.id),oldMembers=(old?.[member]??[]) as string[],own=(folder[member] as string[]).filter(id=>resourceInProduct(store,kind,id,product));
   if(old&&((oldMembers.length&&!oldMembers.some(id=>resourceInProduct(store,kind,id,product)))||(!oldMembers.length&&product!=='dev')))return [old];
   if(!old&&!own.length&&product!=='dev')return [];
   const foreign=oldMembers.filter(id=>!resourceInProduct(store,kind,id,product));
   return [{...(foreign.length?old:folder),[member]:[...own,...foreign]}];
  });
  for(const folder of previous)if(!incoming.some(f=>f.id===folder.id)){const foreign=(folder[member] as string[]).filter(id=>!resourceInProduct(store,kind,id,product));if(foreign.length||(!(folder[member] as string[]).length&&product!=='dev'))merged.push({...folder,[member]:foreign});}
  result[key]=merged as never;
 }
 return result;
}
// Draft surface IDs are storage keys, not globally valid conversation aliases.
// Keep this list aligned with the registered DraftService routes and methods.
const agentDraftMethods: Readonly<Record<string, readonly string[]>> = {
  '/api/conversations/:id/draft': ['GET', 'HEAD', 'PUT'],
  '/api/conversations/:id/draft-conflicts': ['GET', 'HEAD'],
  '/api/conversations/:id/draft-conflicts/:conflictId/restore': ['POST'],
  '/api/conversations/:id/draft-conflicts/:conflictId': ['DELETE'],
  '/api/conversations/:id/draft-attachments': ['POST'],
  '/api/conversations/:id/draft-attachments/:attachmentId': ['GET', 'HEAD', 'DELETE'],
};
function agentDraftOwner(store:AgentStore,request:FastifyRequest):{surfaceId:string;agentId:string;conversationId:string}|undefined {
  if(!agentDraftMethods[request.routeOptions.url??'']?.includes(request.method))return undefined;
  const surfaceId=(request.params as {id?:string}).id;
  const match=typeof surfaceId==='string'?/^agent:([^:\s/\\%]+)$/u.exec(surfaceId):null;
  if(!match||surfaceId!.length>200)return undefined;
  const agentId=match[1]!;
  const row=store.sqlite.prepare(`SELECT a.conversation_id FROM agents a
    JOIN conversations c ON c.id=a.conversation_id AND c.project_id=a.project_id
    JOIN projects p ON p.id=c.project_id
    WHERE a.id=? AND a.deleted_at IS NULL AND a.archived=0 AND c.archived=0
      AND NOT EXISTS(SELECT 1 FROM agent_deletion_pending WHERE agent_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM project_deletion_pending WHERE project_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive
        WHERE inactive.local_id IN (a.id,c.id) AND inactive.state!='active')`).get(agentId) as {conversation_id:string}|undefined;
  if(!row||store.agentCreationPending(agentId))return undefined;
  return {surfaceId:surfaceId!,agentId,conversationId:row.conversation_id};
}
/** Supplied only after server authentication and exact live scheduler ownership. */
export interface RuntimeProductOwner { conversationId: string; agentId: string; runId: string; fencingToken: number }
function retainedRuntimeResources(store:Pick<AgentStore,'sqlite'>,owner:string|RuntimeProductOwner|undefined):Set<string> {
  if(!owner||typeof owner==='string')return new Set();
  const retained=store.sqlite.prepare(`SELECT chat.project_id FROM scheduler_runs run
    JOIN scheduler_run_activations attached ON attached.run_id=run.id
    JOIN agent_activations activation ON activation.id=attached.activation_id AND activation.agent_id=run.agent_id
    JOIN activation_sources source ON source.activation_id=activation.id AND source.source_kind='request'
    JOIN coordination_requests request ON request.id=source.source_id AND request.recipient_agent_id=run.agent_id
    JOIN branch_attempts attempt ON attempt.request_id=request.id
    JOIN branch_step_executions step ON step.id=attempt.step_execution_id
    JOIN branch_executions execution ON execution.id=step.execution_id
    JOIN branch_resource_references ref ON ref.execution_id=execution.id AND ref.chat_id=?
    JOIN agents agent ON agent.id=run.agent_id AND agent.conversation_id=ref.chat_id AND agent.deleted_at IS NULL
    JOIN conversations chat ON chat.id=ref.chat_id AND chat.branch_id=execution.branch_id
    WHERE run.id=? AND run.agent_id=? AND run.fencing_token=? AND run.status IN ('leased','running')
      AND run.side_effects_fenced_at IS NULL AND run.lease_expires_at>?
      AND request.state IN ('open','in_progress','waiting_dependency','awaiting_answer')
      AND execution.state IN ('running','waiting') AND execution.cancel_requested=0 AND attempt.cancel_requested=0
      AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive
        WHERE inactive.local_id IN (agent.id,chat.id) AND inactive.state NOT IN ('active','retiring'))
      AND EXISTS(SELECT 1 FROM branch_installation_resources retired
        WHERE retired.local_id IN (agent.id,chat.id) AND retired.state='retiring')
    LIMIT 1`).get(owner.conversationId,owner.runId,owner.agentId,owner.fencingToken,new Date().toISOString()) as {project_id:string}|undefined;
  return new Set(retained?[owner.conversationId,owner.agentId,retained.project_id]:[]);
}
export function registerProductScope(app:FastifyInstance,store:AgentStore,workspace:WorkspaceStore,
  runtimeOwner:(request:FastifyRequest)=>string|RuntimeProductOwner|undefined,lifecycleAuthority:(request:FastifyRequest)=>boolean):void {
  const ordinaryBelongs=(id:string,kind:string,product:ProductScope):boolean=>{
    if(['project','agent','conversation','chat','trigger'].includes(kind))return resourceInProduct(store,kind,id,product);
    if(kind==='notification'){const notification=workspace.getNotification(id);return Boolean(notification&&notificationInProduct(store,notification,product));}
    if(kind==='decision'){const decision=workspace.getDecision(id);return Boolean(decision&&decisionInProduct(store,decision,product));}
    return true;
  };
  app.addHook('preHandler',async(request,reply)=>{
    if(!request.url.startsWith('/api/'))return;
    const owner=runtimeOwner(request);
    const runtimeChat=typeof owner==='string'?owner:owner?.conversationId;
    const retained=retainedRuntimeResources(store,owner);
    const belongs=(id:string,kind:string,product:ProductScope):boolean=>
      (product==='branches'&&['agent','conversation','chat','project'].includes(kind)&&retained.has(id))||ordinaryBelongs(id,kind,product);
    if(runtimeChat){(request.raw as ProductRequest).ponderosaProduct=store.getConversation(runtimeChat)?.branchId?'branches':'dev';}
    const product=requestProduct(request);
    const draftOwner=agentDraftOwner(store,request);
    const externalMutation=!['GET','HEAD','OPTIONS'].includes(request.method)&&!runtimeChat&&!lifecycleAuthority(request);
    // The Branch lifecycle must be able to finish deleting a Chat after its
    // installation binding has moved to retiring. Ordinary product reads and
    // mutations still treat that Chat as unavailable.
    if(lifecycleAuthority(request)&&product==='branches'&&request.method==='DELETE'&&request.routeOptions.url==='/api/conversations/:id'){
      const id=(request.params as {id?:string}).id;
      if(id&&store.sqlite.prepare(`SELECT 1 FROM branch_installation_resources resource
        LEFT JOIN conversations chat ON chat.id=resource.local_id
        LEFT JOIN conversation_deletion_receipts receipt ON receipt.conversation_id=resource.local_id
        WHERE resource.local_id=? AND resource.agent_ref='' AND resource.state='retiring'
          AND COALESCE(chat.branch_id,receipt.branch_id) IS NOT NULL`).get(id))return;
    }
    const resourceMutable=(id:string):boolean=>(retained.has(id)||!store.sqlite.prepare("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND state!='active'").get(id))&&(!externalMutation||!store.sqlite.prepare("SELECT 1 FROM conversations c JOIN branch_installation_plans p ON p.branch_id=c.branch_id WHERE p.state IN ('applying','canceling') AND (c.id=? OR c.project_id=? OR EXISTS(SELECT 1 FROM agents a WHERE a.conversation_id=c.id AND a.id=?))").get(id,id,id));
    // Branch lifecycle routes validate their own installed Branch and Chat bindings.
    if(/^\/api\/branch(?:es|\-executions|\-gates)(?:\/|$)/.test(request.url))return;
    if(externalMutation&&product==='branches'){
      const tempChat=(id:string)=>Boolean(store.sqlite.prepare('SELECT 1 FROM conversations WHERE id=? AND branch_execution_id IS NOT NULL').get(id));
      const tempAgent=(id:string)=>Boolean(store.sqlite.prepare('SELECT 1 FROM agents a JOIN conversations c ON c.id=a.conversation_id WHERE a.id=? AND c.branch_execution_id IS NOT NULL').get(id));
      const scoped=request.routeOptions.url??'';
      const params=request.params as Record<string,string>;
      const pathTarget=(draftOwner&&tempAgent(draftOwner.agentId))||(scoped.startsWith('/api/agents/:id')&&params.id&&tempAgent(params.id))||(scoped.startsWith('/api/conversations/:id')&&params.id&&tempChat(params.id));
      const targetIds=(value:unknown,depth=0):boolean=>{
        if(depth>12||!value||typeof value!=='object'||Buffer.isBuffer(value))return false;
        if(Array.isArray(value))return value.some(item=>targetIds(item,depth+1));
        return Object.entries(value).some(([key,item])=>{
          if(typeof item==='string'&&['conversationId','chatId'].includes(key))return tempChat(item);
          if(typeof item==='string'&&['agentId','rootAgentId','managerAgentId','sourceAgentId','recipientAgentId','targetAgentId'].includes(key))return tempAgent(item);
          if(key==='rootAgentIds'&&Array.isArray(item))return item.some(id=>typeof id==='string'&&tempAgent(id));
          return key==='package'||key==='definition'?false:targetIds(item,depth+1);
        });
      };
      const tempProject=/^\/api\/projects\/:(?:id|projectId)(?:\/|$)/.test(scoped)&&(params.id||params.projectId)&&store.sqlite.prepare('SELECT 1 FROM conversations WHERE project_id=? AND branch_execution_id IS NOT NULL').get(params.id??params.projectId);
      if(pathTarget||tempProject||targetIds(request.params)||targetIds(request.body)||targetIds(request.query))return reply.code(409).send({error:'Execution-owned temporary Chats and Agents are read-only outside workflow runtime'});
    }
    // Installed Branch resources are deleted only by the Branch lifecycle. The
    // exact internal dispatch capability is admitted by lifecycleAuthority;
    // ordinary generic API calls must never bypass dependency/drain handling.
    if(externalMutation&&request.method==='DELETE'){
      const path=/^\/api\/(projects|conversations|chats|agents)\/([^/?]+)/.exec(request.url);
      if(path){
        const kind=path[1],id=decodeURIComponent(path[2]!);
        const branchOwned=kind==='projects'
          ? store.sqlite.prepare('SELECT 1 FROM conversations WHERE project_id=? AND branch_id IS NOT NULL LIMIT 1').get(id)
          : kind==='agents'
            ? store.sqlite.prepare("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND agent_ref!='' AND state='active'").get(id)
            : store.sqlite.prepare('SELECT 1 FROM conversations WHERE id=? AND branch_id IS NOT NULL').get(id);
        if(branchOwned)return reply.code(409).send({error:'Installed Branch resources must be removed through the Branch lifecycle'});
      }
    }
    const agentDeletionRoute=externalMutation&&request.routeOptions.url?.startsWith('/api/projects/:id/agent-deletions/');
    if(agentDeletionRoute){
      const body=request.body as {rootAgentIds?:unknown;previewHash?:unknown};
      if(Array.isArray(body?.rootAgentIds)&&body.rootAgentIds.every(id=>typeof id==='string'&&id.trim())){
        let affectedIds:string[]|undefined;
        const receipt=typeof body.previewHash==='string'?store.getAgentDeletionReceiptByPreviewHash(body.previewHash):undefined;
        if(receipt){
          if(receipt.projectId!==(request.params as {id?:string}).id||receipt.productScope!==product)return reply.code(404).send({error:'Deletion receipt is unavailable in this product'});
          affectedIds=receipt.deletedAgentIds;
        }else{
          try{affectedIds=store.previewAgentDeletion(body.rootAgentIds).affectedAgents.map(agent=>agent.id);}
          catch{/* The canonical route returns its normal validation error. */}
        }
        if(affectedIds){
          if(!receipt&&affectedIds.some(id=>!resourceInProduct(store,'agent',id,product)))return reply.code(404).send({error:'Agent deletion includes a resource unavailable in this product'});
          if(affectedIds.some(id=>store.sqlite.prepare("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND agent_ref!='' AND state='active'").get(id)))return reply.code(409).send({error:'Installed Branch Agents must be removed through a reviewed Branch update'});
        }
      }
    }
    const scopeKinds:Record<string,string>={projectId:'project',conversationId:'conversation',chatId:'chat',agentId:'agent',rootAgentId:'agent',managerAgentId:'agent',sourceAgentId:'agent',recipientAgentId:'agent',targetAgentId:'agent',triggerId:'trigger',notificationId:'notification',decisionId:'decision'};
    const inspect=(value:unknown,depth=0):boolean=>{
      if(depth>12)return false;
      if(Array.isArray(value))return value.every(v=>inspect(v,depth+1));
      if(!value||typeof value!=='object')return true;
      return Object.entries(value).every(([key,v])=>{
        if(agentDeletionRoute&&key==='rootAgentIds')return true;
        if(scopeKinds[key]&&typeof v==='string')return resourceMutable(v)&&belongs(v,scopeKinds[key]!,product);
        if(key.endsWith('Ids')&&Array.isArray(v)&&scopeKinds[key.slice(0,-1)]){
          if(v.some(id=>typeof id!=='string'||!id||id.length>200))return true;
          return v.every(id=>resourceMutable(id)&&belongs(id,scopeKinds[key.slice(0,-1)]!,product));
        }
        // Portable definitions contain logical identities; they are validated by their own importer.
        return key==='package'||key==='definition'||inspect(v,depth+1);
      });
    };
    if(request.routeOptions.url==='/api/notification-settings/:kind/:id'){const p=request.params as {kind:string;id:string};if(!resourceInProduct(store,p.kind,p.id,product))return reply.code(404).send({error:'Resource is unavailable in this product'});}
    if(request.routeOptions.url==='/api/workspace/recent-resources/use'){const b=request.body as {kind?:string;resourceId?:string};if(b?.kind&&b.resourceId&&!resourceInProduct(store,b.kind,b.resourceId,product))return reply.code(404).send({error:'Resource is unavailable in this product'});}
    // Nested :id belongs to its declared resource, not the outer Project.
    const resource=/\/(projects|agents|conversations|chats|triggers|notifications|decisions)\/:id(?:\/|$)/.exec(request.routeOptions.url??'')
      ?? /^\/api\/(projects|agents|conversations|chats|triggers|notifications|decisions)\/([^/?]+)/.exec(request.url);
    const params=request.params as Record<string,string>;
    if(params.projectId&&params.aid&&!artifactInProduct(store,params.projectId,params.aid,product))return reply.code(404).send({error:'Resource is unavailable in this product'});
    const pathAvailable=draftOwner
      ? resourceMutable(draftOwner.agentId)&&resourceMutable(draftOwner.conversationId)
        &&ordinaryBelongs(draftOwner.agentId,'agent',product)&&ordinaryBelongs(draftOwner.conversationId,'conversation',product)
      : !resource||!params.id||(resourceMutable(params.id)&&belongs(params.id,resource[1]!.replace(/s$/,''),product));
    if(!pathAvailable||!inspect(request.body)||!inspect(request.query)||!inspect(request.params))return reply.code(404).send({error:'Resource is unavailable in this product'});
    if(product==='branches'&&request.method==='POST'&&['/api/projects','/api/chats'].includes(request.url))return reply.code(400).send({error:'Create Chats inside a Branch'});
  });
  // Defense in depth for global projections; primary collections filter before pagination.
  app.addHook('preSerialization',async(request,_reply,payload)=>{
    if(!request.url.startsWith('/api/')||/^\/api\/branch(?:es|\-executions|\-gates)(?:\/|$)/.test(request.url))return payload;
    const product=requestProduct(request);
    const draftOwner=agentDraftOwner(store,request);
    const retained=retainedRuntimeResources(store,runtimeOwner(request));
    const belongs=(id:string,kind:string,scope:ProductScope):boolean=>
      (scope==='branches'&&['agent','conversation','chat','project'].includes(kind)&&retained.has(id))||ordinaryBelongs(id,kind,scope);
    if(['/api/workspace/preferences','/api/notification-settings/:kind/:id'].includes(request.routeOptions.url??'')&&payload&&typeof payload==='object'&&'projectOrder' in payload)return productPreferences(store,payload as WorkspacePreferencesDto,product);
    const filter=(value:unknown):unknown=>{
      if(Array.isArray(value))return value.map(filter).filter(v=>v!==undefined);
      if(!value||typeof value!=='object'||Buffer.isBuffer(value))return value;
      const object=value as Record<string,unknown>;
      // Branch trigger occurrences can have no Project target. Their immutable
      // occurrence scope, rather than a Project fallback, decides visibility.
      if(['/api/triggers/:id/occurrences','/api/agents/:id/trigger-occurrences','/api/projects/:id/trigger-occurrences','/api/trigger-occurrences/:id'].includes(request.routeOptions.url??'')
        &&typeof object.id==='string'&&typeof object.triggerId==='string'&&typeof object.occurredAt==='string')
        return store.sqlite.prepare(`SELECT 1 FROM trigger_occurrences occurrence WHERE occurrence.id=? AND ${occurrenceProductSql('occurrence',product)}`).get(object.id)?object:undefined;
      // Branch triggers are owned by their Branch and deliberately have no Chat, Agent, or Project target.
      if(typeof object.id==='string'&&typeof object.branchId==='string'&&typeof object.sourceKind==='string')return belongs(object.id,'trigger',product)?object:undefined;
      const artifactRoute=request.routeOptions.url?.startsWith('/api/projects/:projectId/artifacts');
      const artifactOwner=typeof object.originAgentId==='string'?object.originAgentId:typeof object.agentId==='string'?object.agentId:undefined;
      const scopedArtifact=Boolean(artifactRoute&&typeof object.id==='string'&&typeof object.path==='string'&&typeof object.projectId==='string'&&artifactOwner);
      if(scopedArtifact&&!artifactInProduct(store,object.projectId as string,object.id as string,product))return undefined;
      if(typeof object.id==='string'&&typeof object.hostPath==='string'&&!belongs(object.id,'project',product))return undefined;
      if(typeof object.id==='string'&&typeof object.activeEngine==='string'&&!belongs(object.id,'agent',product))return undefined;
      if(typeof object.id==='string'&&typeof object.defaultEngine==='string'&&typeof object.projectId==='string'&&!belongs(object.id,'conversation',product))return undefined;
      if(!scopedArtifact&&typeof object.agentId==='string'&&!belongs(object.agentId,'agent',product)&&
        !(typeof object.conversationId==='string'&&decisionInProduct(store,{agentId:object.agentId,conversationId:object.conversationId},product)))return undefined;
      if(!scopedArtifact&&typeof object.originAgentId==='string'&&!belongs(object.originAgentId,'agent',product))return undefined;
      if(typeof object.conversationId==='string'&&!(draftOwner&&object.conversationId===draftOwner.surfaceId
        &&ordinaryBelongs(draftOwner.agentId,'agent',product)&&ordinaryBelongs(draftOwner.conversationId,'conversation',product))
        &&!belongs(object.conversationId,'conversation',product))return undefined;
      if(!scopedArtifact&&typeof object.projectId==='string'&&!belongs(object.projectId,'project',product))return undefined;
      const result:Record<string,unknown>=Object.create(null);
      for(const [key,v] of Object.entries(object)){
        if(key==='lastConversationId'&&typeof v==='string'&&!belongs(v,'conversation',product))continue;
        const next=product==='branches'&&['downloadUrl','thumbnailUrl','contentUrl'].includes(key)&&typeof v==='string'&&v.startsWith('/api/')?'/api/branches/engine/'+v.slice(5):filter(v);
        if(next!==undefined)result[key]=next;
      }
      return result;
    };
    return filter(payload)??{error:'Resource is unavailable in this product'};
  });
}
