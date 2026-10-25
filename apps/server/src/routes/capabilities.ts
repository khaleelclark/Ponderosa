import type {FastifyInstance,FastifyRequest} from 'fastify';
import {CapabilityPolicyStore,CapabilityPolicyRevisionConflictError,type AgentStore,type BranchStore} from '@ponderosa/agents';
import {BUILT_IN_CAPABILITIES,CAPABILITY_IDS,connectorCapability,parseConnectorCapabilityId,type Adapter,type EngineRegistration,type EngineCapabilities,type CapabilityCatalogEntry,type CapabilityPolicyResponse,type CapabilityScopeKind} from '@ponderosa/core';
import {activeChatResourceOwner} from '../branch-resource-owner.js';
import {requestProduct,resourceInProduct} from '../product-scope.js';
import {providerDynamicTools} from '../runtime-selection.js';

type Scope={kind:Extract<CapabilityScopeKind,'product'|'branch'|'chat'|'agent'>;id:string;product:'interactive'|'branches';branchId?:string};
class CapabilityOwnerError extends Error{}
interface Context {
 store:AgentStore;branches:BranchStore;engines:ReadonlyMap<string,EngineRegistration>;dataDir:string;localMemoryEnabled:boolean;
 providerEnabled(id:string):boolean;
 discoverCapabilities(projectId:string,cwd:string,adapter:Adapter,model:string|undefined,refresh:boolean):Promise<EngineCapabilities>;
}

/** One operator contract for both products; runtime authority stays in CapabilityPolicyStore. */
export function registerCapabilityRoutes(app:FastifyInstance,context:Context):void {
 const {store,branches,engines}=context,policies=new CapabilityPolicyStore(store.sqlite);
 const tools=new Map(providerDynamicTools(context.localMemoryEnabled).map(tool=>[tool.name,tool]));
 const catalog=async(scope:Scope)=>{
  let partial=false;
  const selections=new Map<string,{projectId:string;cwd:string;engineId:string;model?:string}>();
  const add=(projectId:string,cwd:string,engineId:string,model?:string)=>selections.set([projectId,cwd,engineId,model??''].join('\0'),{projectId,cwd,engineId,model});
  const addAgent=(id:string)=>{const a=store.getAgent(id),chat=a?store.getChatContext(a.conversationId):undefined;if(a&&chat)add(chat.id,a.workingCopy?.rootPath??chat.hostPath,a.activeEngine,a.model)};
  if(scope.kind==='agent')addAgent(scope.id);
  else if(scope.kind==='chat'){
   const chat=store.getConversation(scope.id),project=chat?store.getChatContext(scope.id):undefined;
   if(chat&&project)for(const engineId of chat.defaultEngine?[chat.defaultEngine]:engines.keys())add(project.id,project.hostPath,engineId,chat.defaultModel);
   const rows=store.sqlite.prepare("SELECT MIN(id) id FROM agents WHERE conversation_id=? AND deleted_at IS NULL GROUP BY active_engine,model,json_extract(working_copy_json,'$.rootPath') LIMIT 101").all(scope.id) as {id:string}[];partial=rows.length>100;for(const row of rows.slice(0,100))addAgent(row.id);
  }else if(scope.kind==='branch'){
   for(const id of new Set(Object.values(branches.localConfiguration(scope.id)?.engines??{})))add(`branch:${scope.id}`,context.dataDir,id);
   const rows=store.sqlite.prepare(`SELECT MIN(a.id) id FROM agents a JOIN conversations c ON c.id=a.conversation_id WHERE c.branch_id=? AND c.branch_execution_id IS NULL AND a.deleted_at IS NULL GROUP BY a.project_id,a.active_engine,a.model,json_extract(a.working_copy_json,'$.rootPath') LIMIT 101`).all(scope.id) as {id:string}[];partial=rows.length>100;for(const row of rows.slice(0,100))if(activeChatResourceOwner(store,'agent',row.id))addAgent(row.id);
  }else for(const id of engines.keys())add(`product:${scope.product}`,context.dataDir,id);
  const available=(id:string)=>Boolean(engines.get(id)&&engines.get(id)!.isInstalled?.()!==false&&context.providerEnabled(id));
  const hasProvider=[...selections.values()].some(s=>available(s.engineId));
  const entries:CapabilityCatalogEntry[]=BUILT_IN_CAPABILITIES.filter(item=>scope.product==='branches'||item.categoryId!=='workflow').map(item=>{
   const memory=item.id===CAPABILITY_IDS.memoryRead||item.id===CAPABILITY_IDS.memoryWrite;
   const reason=memory&&!context.localMemoryEnabled?'Local Memory is not configured on this Engine.':item.categoryId!=='workflow'&&!hasProvider?'No installed, enabled provider is available for this scope.':undefined;
   const includedTools=(item.runtimeToolNames??[]).flatMap(name=>{const tool=tools.get(name);return tool?[{name,description:tool.description}]:[]});
   if(item.id===CAPABILITY_IDS.managedAgentCreate){const manage=tools.get('ponderosa_manage');if(manage)includedTools.push({name:manage.name,description:`Only its create_agent operation is controlled here. ${manage.description}`})}
   return {...item,available:!reason,...(reason?{unavailableReason:reason}:{}),includedTools,...(!includedTools.length?{toolDetailsReason:item.id===CAPABILITY_IDS.filesystemWrite?'Enforced by the provider’s filesystem sandbox or denied native tools. The provider does not advertise a complete native tool inventory.':item.categoryId==='workflow'?'Enforced at workflow Step boundaries.':reason??'No tool definitions are currently reported.'}:{})};
  });
  // Reuse discovery's cache/owned process boundary without a per-dialog process fan-out.
  const discovered:Array<{engineId:string;capabilities:EngineCapabilities}>=[];let failed=false;
  for(const s of selections.values())if(available(s.engineId))try{discovered.push({engineId:s.engineId,capabilities:await context.discoverCapabilities(s.projectId,s.cwd,engines.get(s.engineId)!.adapter,s.model,false)})}catch{failed=true}

  // ponytail: 64 KiB of optional connector details per response; inspect an Agent for its exact inventory.
  const connectors=new Map<string,CapabilityCatalogEntry>();let detailsBytes=64*1024,detailsPartial=false;
  for(const result of discovered)for(const server of result.capabilities.mcpServers){
   // Ponderosa's own dynamic tools already belong to the groups above.
   if(server.name==='ponderosa')continue;
   const descriptor=connectorCapability(result.engineId,server.name),prior=connectors.get(descriptor.id),included=new Map((prior?.includedTools??[]).map(tool=>[tool.name,tool]));
   for(const tool of server.tools??[])if(!included.has(tool.name)){const bytes=Buffer.byteLength(JSON.stringify(tool),'utf8')+96;if(bytes>detailsBytes){detailsPartial=true;continue}detailsBytes-=bytes;included.set(tool.name,tool)}
   connectors.set(descriptor.id,{...descriptor,label:`${server.name} (${engines.get(result.engineId)!.adapter.displayName})`,available:Boolean(prior?.available||server.usable),...(!server.usable&&!prior?.available?{unavailableReason:server.detail??'This service is not connected to the provider.'}:{}),includedTools:[...included.values()],...(server.toolCount>included.size?{toolDetailsReason:`Showing ${included.size} of ${server.toolCount} reported tools.`}:!included.size?{toolDetailsReason:'The provider has not reported tool names or descriptions for this service.'}:{})});
  }
  return {catalog:[...entries,...connectors.values()],...((partial||failed||detailsPartial)?{catalogNotice:[partial?"Tool availability includes the first 100 distinct Agent runtime selections. Open an Agent’s Settings for its exact services.":'',failed?"Some provider tool inventories could not be loaded. Open the relevant Agent’s Settings to inspect its services.":'',detailsPartial?"Some tool details are omitted from this scope’s bounded catalog. Open an Agent’s Settings for its exact services.":''].filter(Boolean).join(' ')}:{})};
 };
 const response=async(scope:Scope):Promise<CapabilityPolicyResponse>=>{
  const policy=policies.get(scope.kind,scope.id)??{scopeKind:scope.kind,scopeId:scope.id,revision:0,restrictedCapabilityIds:[],updatedAt:''};
  const effective=scope.kind==='product'?policies.resolveForProduct(scope.product):scope.kind==='branch'?policies.resolveForBranch(scope.id):scope.kind==='chat'?policies.resolveForChat(scope.id):policies.resolveForAgent(scope.id);
  const inventory=await catalog(scope),rows=inventory.catalog,known=new Set(rows.map(item=>item.id));
  for(const id of effective.restrictedCapabilityIds){const connector=parseConnectorCapabilityId(id);if(connector&&!known.has(id))rows.push({...connectorCapability(connector.engineId,connector.connectorName),available:false,unavailableReason:'This service is not currently reported for this scope.',includedTools:[]})}
  return {policy,effective,catalog:rows,...(inventory.catalogNotice?{catalogNotice:inventory.catalogNotice}:{})};
 };
 const scopeFor=(request:FastifyRequest,kind:Scope['kind'],branchRoute:boolean):Scope=>{
  const params=request.params as {id:string;chatId?:string;agentId?:string},product=branchRoute?'branches':requestProduct(request)==='branches'?'branches':'interactive';
  const id=kind==='product'?product:kind==='chat'&&branchRoute?params.chatId!:kind==='agent'&&branchRoute?params.agentId!:params.id;
  const scope:Scope={kind,id,product,...(branchRoute?{branchId:params.id}:{})};
  if(branchRoute&&!store.sqlite.prepare('SELECT 1 FROM branches WHERE id=? AND deleting=0').get(params.id))throw new CapabilityOwnerError('Branch not found');
  if(kind==='product'||kind==='branch')return scope;
  const owner=activeChatResourceOwner(store,kind,id);
  if(!owner||(branchRoute?owner.branchId!==params.id:!resourceInProduct(store,kind,id,product==='branches'?'branches':'dev')))throw new CapabilityOwnerError('Resource not found in this product');
  if(request.method==='PUT'&&owner.executionId)throw new CapabilityOwnerError('Execution-owned temporary resources are read-only');
  return scope;
 };
 // Match provider routes: CLI discovery may outlast socket idle, within unchanged request/handler budgets.
 for(const [path,kind,branchRoute] of [
  ['/api/workspace/capabilities','product',false],['/api/conversations/:id/capabilities','chat',false],['/api/agents/:id/capabilities','agent',false],
  ['/api/branches/:id/capabilities','branch',true],['/api/branches/:id/chats/:chatId/capabilities','chat',true],['/api/branches/:id/agents/:agentId/capabilities','agent',true],
 ] as const){
  app.get(path,async(request,reply)=>{request.raw.socket.setTimeout?.(app.server.requestTimeout||120_000);try{return await response(scopeFor(request,kind,branchRoute))}catch(error){if(error instanceof CapabilityOwnerError)return reply.code(404).send({error:error.message});throw error}});
  app.put(path,async(request,reply)=>{request.raw.socket.setTimeout?.(app.server.requestTimeout||120_000);try{
   const scope=scopeFor(request,kind,branchRoute),body=request.body as {revision:number;restrictedCapabilityIds:string[]};
   if(!body||!Number.isSafeInteger(body.revision)||body.revision<0||!Array.isArray(body.restrictedCapabilityIds)||!body.restrictedCapabilityIds.every(id=>typeof id==='string'&&(BUILT_IN_CAPABILITIES.some(item=>item.id===id)||parseConnectorCapabilityId(id))))throw new Error('Invalid capability policy');
   policies.put({scopeKind:scope.kind,scopeId:scope.id,expectedRevision:body.revision,restrictedCapabilityIds:body.restrictedCapabilityIds});
   return await response(scope);
  }catch(error){return reply.code(error instanceof CapabilityPolicyRevisionConflictError?409:error instanceof CapabilityOwnerError?404:400).send({error:(error as Error).message,...(error instanceof CapabilityPolicyRevisionConflictError?{current:error.current}:{})})}});
 }
}
