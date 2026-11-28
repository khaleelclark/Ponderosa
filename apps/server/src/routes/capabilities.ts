import type {FastifyInstance,FastifyRequest} from 'fastify';
import {CapabilityPolicyStore,CapabilityPolicyRevisionConflictError,type AgentStore,type BranchStore} from '@ponderosa/agents';
import {BUILT_IN_CAPABILITIES,CAPABILITY_IDS,connectorCapability,parseConnectorCapabilityId,type Adapter,type EngineRegistration,type EngineCapabilities,type CapabilityCatalogEntry,type CapabilityPolicyResponse,type CapabilityScopeKind,type ConnectedToolsResponse} from '@ponderosa/core';
import {activeChatResourceOwner} from '../branch-resource-owner.js';
import {requestProduct,resourceInProduct} from '../product-scope.js';
import {providerDynamicTools} from '../runtime-selection.js';

type Scope={kind:Extract<CapabilityScopeKind,'product'|'branch'|'chat'|'agent'>;id:string;product:'interactive'|'branches';branchId?:string};
class CapabilityOwnerError extends Error{}
interface Context {
 store:AgentStore;branches:BranchStore;engines:ReadonlyMap<string,EngineRegistration>;dataDir:string;localMemoryEnabled:boolean;
 providerEnabled(id:string):boolean;
 discoverCapabilities(projectId:string,cwd:string,adapter:Adapter,model:string|undefined,refresh:boolean,waitForRefresh?:boolean):Promise<EngineCapabilities>;
 policyChange<T>(apply:()=>T):T;
}

/** One operator contract for both products; runtime authority stays in CapabilityPolicyStore. */
export function registerCapabilityRoutes(app:FastifyInstance,context:Context):void {
 const {store,branches,engines}=context,policies=new CapabilityPolicyStore(store.sqlite);
 const tools=new Map(providerDynamicTools(context.localMemoryEnabled).map(tool=>[tool.name,tool]));
 const selectionsFor=(scope:Scope)=>{
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
  return {selections:[...selections.values()],partial};
 };
 const available=(id:string)=>Boolean(engines.get(id)&&engines.get(id)!.isInstalled?.()!==false&&context.providerEnabled(id));
 const response=(scope:Scope):CapabilityPolicyResponse=>{
  const policy=policies.get(scope.kind,scope.id)??{scopeKind:scope.kind,scopeId:scope.id,revision:0,restrictedCapabilityIds:[],updatedAt:''};
  const effective=scope.kind==='product'?policies.resolveForProduct(scope.product):scope.kind==='branch'?policies.resolveForBranch(scope.id):scope.kind==='chat'?policies.resolveForChat(scope.id):policies.resolveForAgent(scope.id);
  const {selections}=selectionsFor(scope);
  const hasProvider=selections.some(selection=>available(selection.engineId));
  const entries:CapabilityCatalogEntry[]=BUILT_IN_CAPABILITIES.filter(item=>scope.product==='branches'||item.categoryId!=='workflow').map(item=>{
   const memory=item.id===CAPABILITY_IDS.memoryRead||item.id===CAPABILITY_IDS.memoryWrite;
   const reason=memory&&!context.localMemoryEnabled?'Local Memory is not configured on this Engine.':item.categoryId!=='workflow'&&!hasProvider?'No installed, enabled provider is available for this scope.':undefined;
   const includedTools=(item.runtimeToolNames??[]).flatMap(name=>{const tool=tools.get(name);return tool?[{name,description:tool.description}]:[]});
   if(item.id===CAPABILITY_IDS.managedAgentCreate){const manage=tools.get('ponderosa_manage');if(manage)includedTools.push({name:manage.name,description:`Only its create_agent operation is controlled here. ${manage.description}`})}
   return {...item,available:!reason,...(reason?{unavailableReason:reason}:{}),includedTools,...(!includedTools.length?{toolDetailsReason:item.id===CAPABILITY_IDS.filesystemWrite?'Enforced by the provider’s filesystem sandbox or denied native tools. The provider does not advertise a complete native tool inventory.':item.categoryId==='workflow'?'Enforced at workflow Step boundaries.':reason??'No tool definitions are currently reported.'}:{})};
  });
  for(const id of effective.restrictedCapabilityIds){
   const connector=parseConnectorCapabilityId(id);
   if(connector)entries.push({...connectorCapability(connector.engineId,connector.connectorName),available:false,unavailableReason:'This service is not in the connected tools list.',includedTools:[]});
  }
  return {policy,effective,catalog:entries};
 };
 const connectedTools=async(scope:Scope,refresh:boolean):Promise<ConnectedToolsResponse>=>{
  const {selections,partial}=selectionsFor(scope);
  const discovered:Array<{engineId:string;capabilities:EngineCapabilities}>=[];
  let discoveryFailed=false;
  for(const selection of selections)if(available(selection.engineId))try{
   const {projectId,cwd,engineId,model}=selection;
   const capabilities=await context.discoverCapabilities(projectId,cwd,engines.get(engineId)!.adapter,model,refresh,true);
   discoveryFailed ||= capabilities.mcpInventoryIncomplete===true;
   discovered.push({engineId,capabilities});
  }catch{discoveryFailed=true}

  // ponytail: 64 KiB of optional connector details per response; inspect an Agent for its exact inventory.
  const connectors=new Map<string,{entry:CapabilityCatalogEntry;named:Set<string>;total:number;reports:number;unnamed:boolean;toolsDiscovered:boolean}>();
  let detailsBytes=64*1024;
  for(const result of discovered)for(const server of result.capabilities.mcpServers){
   if(server.name==='ponderosa')continue;
   // Configured-only entries in a partial response do not confirm whether the service is connected.
   if(result.capabilities.mcpInventoryIncomplete&&!server.toolsDiscovered&&server.initialization==='not_initialized'&&!server.detail)continue;
   const descriptor=connectorCapability(result.engineId,server.name);
   let connector=connectors.get(descriptor.id);
   if(!connector){
    connector={entry:{...descriptor,label:`${server.name} (${engines.get(result.engineId)!.adapter.displayName})`,available:false,includedTools:[]},named:new Set(),total:0,reports:0,unnamed:false,toolsDiscovered:false};
    connectors.set(descriptor.id,connector);
   }
   const {entry,named}=connector;
   entry.available ||= server.usable;
   entry.unavailableReason=entry.available?undefined:server.detail??'This service is not connected to the provider.';
   const reported=server.tools??[];
   connector.reports++;
   connector.toolsDiscovered ||= server.toolsDiscovered;
   connector.total=Math.max(connector.total,server.toolCount);
   connector.unnamed ||= server.toolCount>reported.length;
   for(const tool of reported)if(!named.has(tool.name)){
    named.add(tool.name);
    const bytes=Buffer.byteLength(JSON.stringify(tool),'utf8')+96;
    if(bytes>detailsBytes)continue;
    detailsBytes-=bytes;
    entry.includedTools!.push(tool);
   }
  }
  const catalog=[...connectors.values()].map(({entry,named,total,reports,unnamed,toolsDiscovered})=>{
   if(!toolsDiscovered&&discoveryFailed)entry.toolDetailsUnavailable=true;
   const included=entry.includedTools!.length;
   if(unnamed&&reports>1)entry.toolDetailsReason='Some tool details are unavailable.';
   else if(Math.max(total,named.size)>included)entry.toolDetailsReason=`Showing ${included} of ${Math.max(total,named.size)} tools.`;
   return entry;
  });
  return {catalog,...(partial?{selectionLimited:true}:{}),...(discoveryFailed?{discoveryFailed:true}:{})};
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
  app.get(path,async(request,reply)=>{
   try{return response(scopeFor(request,kind,branchRoute))}
   catch(error){if(error instanceof CapabilityOwnerError)return reply.code(404).send({error:error.message});throw error}
  });
  app.get(`${path}/connected-tools`,async(request,reply)=>{
   request.raw.socket.setTimeout?.(app.server.requestTimeout||120_000);
   try{
    const scope=scopeFor(request,kind,branchRoute);
    const refresh=(request.query as {refresh?:string}).refresh==='1';
    const inventory=await connectedTools(scope,refresh);
    scopeFor(request,kind,branchRoute);
    return inventory;
   }catch(error){if(error instanceof CapabilityOwnerError)return reply.code(404).send({error:error.message});throw error}
  });
  app.get(`${path}/history`,async(request,reply)=>{try{
   const scope=scopeFor(request,kind,branchRoute),raw=(request.query as {beforeRevision?:string}).beforeRevision;
   const beforeRevision=raw===undefined?undefined:Number(raw);
   if(beforeRevision!==undefined&&(!Number.isSafeInteger(beforeRevision)||beforeRevision<1))return reply.code(400).send({error:"Invalid history revision"});
   return policies.history(scope.kind,scope.id,beforeRevision);
  }catch(error){if(error instanceof CapabilityOwnerError)return reply.code(404).send({error:error.message});throw error}});
  app.put(path,async(request,reply)=>{try{
   const scope=scopeFor(request,kind,branchRoute),body=request.body as {revision:number;restrictedCapabilityIds:string[]};
   if(!body||!Number.isSafeInteger(body.revision)||body.revision<0||!Array.isArray(body.restrictedCapabilityIds)||!body.restrictedCapabilityIds.every(id=>typeof id==='string'&&(BUILT_IN_CAPABILITIES.some(item=>item.id===id)||parseConnectorCapabilityId(id))))throw new Error('Invalid capability policy');
   context.policyChange(()=>policies.put({scopeKind:scope.kind,scopeId:scope.id,expectedRevision:body.revision,restrictedCapabilityIds:body.restrictedCapabilityIds,actor:"operator",reason:"Human updated tool permissions through Settings or the operator API"}));
   return response(scope);
  }catch(error){return reply.code(error instanceof CapabilityPolicyRevisionConflictError?409:error instanceof CapabilityOwnerError?404:400).send({error:(error as Error).message,...(error instanceof CapabilityPolicyRevisionConflictError?{current:error.current}:{})})}});
 }
}
