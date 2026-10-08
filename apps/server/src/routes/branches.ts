import type {BranchInstallationService} from '../branch-installation-service.js';
import { normalizeTriggerSourceConfig, type TriggerSourceService } from '../trigger-service.js';
import { triggerSourceConfig } from '../trigger-validation.js';
import { realpathSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { CapabilityPolicyRevisionConflictError, CapabilityPolicyStore, exportBranchPackage, importBranchPackage, stableJson, validateBranchDefinition, validateBranchBindings, validateBranchConfiguration, resolveBranchParameterReferences, interpolateBranchText, type AgentStore, type BranchStore } from '@ponderosa/agents';
import { BUILT_IN_CAPABILITIES, connectorCapability, parseConnectorCapabilityId, type BranchGateResolution, type BranchIntervention, type CapabilityDescriptor, type CapabilityPolicyRecord, type CapabilityScopeKind, type DeployBranchRequest, type EffectiveCapabilityPolicy } from '@ponderosa/core';
import {activeChatResourceOwner} from '../product-scope.js';
import {previewBranchExecutionDetail} from '../branch-detail-preview.js';
import {branchOperationalSummary, type ProviderIntakeStatus} from '../branch-operations.js';

interface BranchCapabilityResponse {
  policy: CapabilityPolicyRecord;
  effective: EffectiveCapabilityPolicy;
  catalog: Array<CapabilityDescriptor & { available: boolean; unavailableReason?: string }>;
}
class BranchCapabilityOwnerError extends Error{}

export function registerBranchRoutes(app: FastifyInstance, context: { branches: BranchStore; installations:BranchInstallationService; store: AgentStore; sources: TriggerSourceService; engineAvailable?(id:string):boolean; providerStatus?(id:string):Promise<ProviderIntakeStatus|undefined>; discoverConnectors?(branchId:string):Promise<Array<{engineId:string;name:string;usable:boolean;detail?:string}>>; notify(): void }): void {
  const { branches, store, sources, notify } = context;
  const capabilityPolicies = new CapabilityPolicyStore(store.sqlite);
  const policyOrDefault=(scopeKind:CapabilityScopeKind,scopeId:string):CapabilityPolicyRecord=>capabilityPolicies.get(scopeKind,scopeId)??{scopeKind,scopeId,revision:0,restrictedCapabilityIds:[],updatedAt:''};
  const capabilityCatalog=async(branchId:string)=>{
    const connectors=await context.discoverConnectors?.(branchId)??[];
    const unique=new Map<string,CapabilityDescriptor&{available:boolean;unavailableReason?:string}>();
    for(const capability of BUILT_IN_CAPABILITIES)unique.set(capability.id,{...capability,available:true});
    for(const connector of connectors){const capability=connectorCapability(connector.engineId,connector.name);unique.set(capability.id,{...capability,available:connector.usable,...(!connector.usable?{unavailableReason:connector.detail??'Connector is unavailable'}:{})});}
    return [...unique.values()];
  };
  const capabilityResponse=async(scopeKind:'branch'|'chat'|'agent',scopeId:string,branchId:string):Promise<BranchCapabilityResponse>=>{
    const policy=policyOrDefault(scopeKind,scopeId);
    const effective=scopeKind==='branch'?capabilityPolicies.resolveForBranch(scopeId):scopeKind==='chat'?capabilityPolicies.resolveForChat(scopeId):capabilityPolicies.resolveForAgent(scopeId);
    const catalog=await capabilityCatalog(branchId),known=new Set(catalog.map(capability=>capability.id));
    for(const id of effective.restrictedCapabilityIds){
      const connector=parseConnectorCapabilityId(id);
      if(connector&&!known.has(id))catalog.push({...connectorCapability(connector.engineId,connector.connectorName),available:false,unavailableReason:'Connector is not currently reported by the Engine.'});
    }
    return {policy,effective,catalog};
  };
  const assertCapabilityOwner=(branchId:string,scopeKind:'branch'|'chat'|'agent',scopeId:string)=>{
    if(!branches.getBranch(branchId))throw new BranchCapabilityOwnerError('Branch not found');
    if(scopeKind==='branch'&&scopeId===branchId)return;
    const owner=activeChatResourceOwner(store,scopeKind==='chat'?'chat':'agent',scopeId);
    if(!owner||owner.branchId!==branchId)throw new BranchCapabilityOwnerError(scopeKind==='chat'?'Chat not found in this Branch':'Agent not found in this Branch');
  };
  const putCapabilities=async(scopeKind:'branch'|'chat'|'agent',scopeId:string,branchId:string,body:{revision:number;restrictedCapabilityIds:string[]})=>{
    assertCapabilityOwner(branchId,scopeKind,scopeId);
    if(scopeKind==='chat'&&store.getConversation(scopeId)?.executionId || scopeKind==='agent'&&store.getConversation(store.getAgent(scopeId)?.conversationId??'')?.executionId)throw new BranchCapabilityOwnerError('Execution-owned temporary resources are read-only');
    if(!Number.isInteger(body.revision)||body.revision<0||!Array.isArray(body.restrictedCapabilityIds)||!body.restrictedCapabilityIds.every(id=>typeof id==='string'))throw new Error('Invalid capability policy');
    const known=new Set(BUILT_IN_CAPABILITIES.map(capability=>capability.id));
    if(body.restrictedCapabilityIds.some(id=>!known.has(id)&&!parseConnectorCapabilityId(id)))throw new Error('Unknown capability');
    capabilityPolicies.put({scopeKind,scopeId,expectedRevision:body.revision,restrictedCapabilityIds:body.restrictedCapabilityIds});
    return capabilityResponse(scopeKind,scopeId,branchId);
  };
  const assertEditable=(id:string)=>{
    if(store.sqlite.prepare("SELECT 1 FROM branch_installation_plans WHERE branch_id=? AND state IN ('applying','canceling')").get(id))throw new Error('An installation update is applying; wait for it to finish');
  };
  const publicSettings=(id:string)=>{
    const {secretBindings,...configuration}=branches.configuration(id);
    const row=store.sqlite.prepare('SELECT configuration_revision revision FROM branches WHERE id=?').get(id) as {revision:number};
    return {...row,configuration,secretStatus:Object.fromEntries(Object.keys(secretBindings??{}).map(key=>[key,'configured']))};
  };
  function validateLocal(input:DeployBranchRequest,configuration?:import('@ponderosa/core').BranchConfiguration){
    input={...input,definition:validateBranchDefinition(input.definition)};
    input.bindings=validateBranchBindings(input.bindings,input.definition);
    if(input.chatId)throw new Error('Branch ownership is independent of a working Chat');
    if(!input.branchId || !branches.getBranch(input.branchId))throw new Error('Create a Branch before publishing its definition');
    const previousConfiguration=branches.configuration(input.branchId);
    configuration??=validateBranchConfiguration({parameters:Object.fromEntries(Object.entries(previousConfiguration.parameters).filter(([key])=>input.definition.parameters?.[key]?.type!=='secret'&&input.definition.parameters?.[key])),limits:previousConfiguration.limits,secretBindings:Object.fromEntries(Object.entries(previousConfiguration.secretBindings??{}).filter(([key])=>input.definition.parameters?.[key]?.type==='secret'))},input.definition);
    for(const step of input.definition.steps)if(step.kind==='script') {
      const directory=input.bindings.directories[step.cwdRef];
      const prefix=`Branch "${input.definition.name}" · Script "${step.label??step.id}": `;
      if(!directory?.trim())throw new Error(prefix+'Working directory is required. Choose an existing directory or use "." for the Engine’s current directory.');
      try {if(!statSync(realpathSync(interpolateBranchText(directory,input.definition,configuration))).isDirectory())throw new Error();}
      catch {throw new Error(prefix+'Working directory does not resolve to an accessible directory on this Engine. Check the path and permissions.');}
    }
    for(const agentId of Object.values(input.bindings.agents)){
      const agent=store.getAgent(agentId),chat=agent?.conversationId?store.getConversation(agent.conversationId):undefined;
      if(!chat || chat.branchId!==input.branchId || chat.executionId)throw new Error('Persistent Agents must belong to a persistent Chat in this Branch');
    }
    for(const step of input.definition.steps)if(step.kind==='branch_call' && !branches.getBranch(input.bindings.branches?.[step.branchRef]??''))throw new Error(`Branch "${input.definition.name}" · Step "${step.label??step.id}": Called Branch is missing or unavailable. Choose an existing Branch.`);
    for(const template of Object.values(input.definition.templates??{}))for(const member of template.agents){const engine=input.bindings.engines?.[member.engine];if(!engine||(context.engineAvailable&&!context.engineAvailable(engine)))throw new Error('Template engine is unavailable');}
    if(input.definition.trigger.kind==='manual')return undefined;
    const local=input.bindings.triggers?.[input.definition.trigger.configRef];if(!local)throw new Error('Local trigger configuration is required');
        const parsed = triggerSourceConfig(input.definition.trigger.kind, resolveBranchParameterReferences(local.sourceConfig,input.definition,configuration));
        const current = input.branchId ? branches.trigger(input.branchId) : undefined;
        const previous = input.branchId ? branches.localConfiguration(input.branchId)?.triggers?.[input.definition.trigger.configRef] : undefined;
        const same = current?.sourceKind === input.definition.trigger.kind && previous && stableJson(previous.sourceConfig) === stableJson(local.sourceConfig) && stableJson(current.sourceConfig)===stableJson(parsed);
        const keepSchedule = same && (previous.enabled === local.enabled || !local.enabled);
        const normalized = keepSchedule ? { config: current.sourceConfig, nextFireAt: current.nextFireAt } : normalizeTriggerSourceConfig(input.definition.trigger.kind, parsed);
    return {sourceConfig:normalized.config,nextFireAt:normalized.nextFireAt,resetSchedule:!keepSchedule,...(keepSchedule?{enabledOverride:local.enabled?current.enabled:false}:{})};
  }
  context.installations.setPublisher((input,configuration)=>{
    let trigger=validateLocal(input,configuration);
    const currentTrigger=input.branchId?branches.trigger(input.branchId):undefined;
    if(trigger&&input.definition.trigger.kind==='webhook'&&(!currentTrigger||currentTrigger.sourceKind!=='webhook'||!currentTrigger.secretFingerprint))trigger={...trigger,enabledOverride:false} as typeof trigger;
    return branches.deploy(input,new Date().toISOString(),trigger,configuration);
  },()=>sources.refresh());
  app.post<{Body:{package:unknown;bindings:import('@ponderosa/core').BranchBindings;branchId?:string}}>('/api/branches/install-preview',{bodyLimit:96*1024*1024},async(request,reply)=>{
    try{return context.installations.preview(request.body.package,request.body.bindings,request.body.branchId)}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.post<{Params:{id:string};Body?:{acknowledgeFullImport?:boolean}}>('/api/branches/installations/:id/confirm',async(request,reply)=>{
    try{const body=request.body??{};if(typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='acknowledgeFullImport')||(body.acknowledgeFullImport!==undefined&&typeof body.acknowledgeFullImport!=='boolean'))throw new Error('Invalid installation confirmation');const result=await context.installations.confirm(request.params.id,body.acknowledgeFullImport===true);await sources.refresh();notify();return result}catch(error){return reply.code(409).send({error:(error as Error).message})}
  });
  app.get<{Params:{id:string}}>('/api/branches/installations/:id',async(request,reply)=>context.installations.status(request.params.id)??reply.code(404).send({error:'Installation not found'}));
  app.post<{Params:{id:string}}>('/api/branches/installations/:id/cancel',async(request,reply)=>{
    try{const result=await context.installations.cancel(request.params.id);await sources.refresh();notify();return result}catch(error){return reply.code(409).send({error:(error as Error).message})}
  });
  app.get<{Params:{id:string};Querystring:{mode?:'template'|'full';includeValues?:string}}>('/api/branches/:id/package',async(request,reply)=>{
    try{return await context.installations.export(request.params.id,request.query.mode==='full'?'full':'template',request.query.includeValues==='true')}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.post<{Body:{name:string;idempotencyKey:string}}>('/api/branches',async(request,reply)=>{
    try{return branches.create(request.body.name,request.body.idempotencyKey)}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.get<{Params:{id:string};Querystring:{executionId?:string}}>('/api/branches/:id/chats',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    const rows=store.sqlite.prepare("SELECT id FROM conversations WHERE branch_id=? AND branch_execution_id IS ? AND archived=0 AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r WHERE r.local_id=conversations.id AND r.state IN ('retiring','staging','deleted')) ORDER BY created_at,id").all(request.params.id,request.query.executionId??null) as Array<{id:string}>;
    return rows.flatMap(({id})=>{const chat=store.getConversation(id),context=store.getChatContext(id);return chat&&context?[{...chat,workingDirectory:context.hostPath,defaultEngine:context.defaultEngine}]:[]});
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/execution-budget',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    try{return branches.executionBudget(request.params.id)}catch(error){return reply.code(409).send({error:(error as Error).message})}
  });
  const assertBudgetEditable=(id:string,commandKey:string)=>{
    // A committed receipt is a read-only replay, even while installation work fences new commands.
    if(!store.sqlite.prepare('SELECT 1 FROM branch_execution_budget_commands WHERE branch_id=? AND command_key=?').get(id,commandKey))assertEditable(id);
  };
  const budgetError=(error:unknown)=>({error:error instanceof Error?error.message:'Invalid execution budget'});
  const validateBudgetCommand=(body:unknown,allowed:string[])=>{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key)))throw new Error('Invalid execution budget command');
  };
  app.put<{Params:{id:string};Body:import('@ponderosa/core').BranchExecutionBudgetUpdate}>('/api/branches/:id/execution-budget',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    try{validateBudgetCommand(request.body,['commandKey','expectedRevision','expectedPeriodId','policy','acknowledgeNewPeriod']);assertBudgetEditable(request.params.id,request.body.commandKey);
      const result=branches.updateExecutionBudget(request.params.id,request.body);notify();return result;
    }catch(error){const body=budgetError(error);return reply.code(/conflict|applying|deleting/.test(body.error)?409:400).send(body)}
  });
  app.post<{Params:{id:string};Body:import('@ponderosa/core').BranchExecutionBudgetGrant}>('/api/branches/:id/execution-budget/allow',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    try{validateBudgetCommand(request.body,['commandKey','expectedRevision','expectedPeriodId','additional']);assertBudgetEditable(request.params.id,request.body.commandKey);
      const result=branches.grantExecutions(request.params.id,request.body);notify();return result;
    }catch(error){const body=budgetError(error);return reply.code(/conflict|applying|deleting/.test(body.error)?409:400).send(body)}
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/settings',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    return publicSettings(request.params.id);
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/capabilities',async(request,reply)=>{
    try{assertCapabilityOwner(request.params.id,'branch',request.params.id);return await capabilityResponse('branch',request.params.id,request.params.id)}catch(error){return reply.code(404).send({error:(error as Error).message})}
  });
  app.put<{Params:{id:string};Body:{revision:number;restrictedCapabilityIds:string[]}}>('/api/branches/:id/capabilities',async(request,reply)=>{
    try{return await putCapabilities('branch',request.params.id,request.params.id,request.body)}catch(error){return reply.code(error instanceof CapabilityPolicyRevisionConflictError?409:error instanceof BranchCapabilityOwnerError?404:400).send({error:(error as Error).message,...(error instanceof CapabilityPolicyRevisionConflictError?{current:error.current}:{})})}
  });
  app.get<{Params:{id:string;chatId:string}}>('/api/branches/:id/chats/:chatId/capabilities',async(request,reply)=>{
    try{assertCapabilityOwner(request.params.id,'chat',request.params.chatId);return await capabilityResponse('chat',request.params.chatId,request.params.id)}catch(error){return reply.code(404).send({error:(error as Error).message})}
  });
  app.put<{Params:{id:string;chatId:string};Body:{revision:number;restrictedCapabilityIds:string[]}}>('/api/branches/:id/chats/:chatId/capabilities',async(request,reply)=>{
    try{return await putCapabilities('chat',request.params.chatId,request.params.id,request.body)}catch(error){return reply.code(error instanceof CapabilityPolicyRevisionConflictError?409:error instanceof BranchCapabilityOwnerError?404:400).send({error:(error as Error).message,...(error instanceof CapabilityPolicyRevisionConflictError?{current:error.current}:{})})}
  });
  app.get<{Params:{id:string;agentId:string}}>('/api/branches/:id/agents/:agentId/capabilities',async(request,reply)=>{
    try{assertCapabilityOwner(request.params.id,'agent',request.params.agentId);return await capabilityResponse('agent',request.params.agentId,request.params.id)}catch(error){return reply.code(404).send({error:(error as Error).message})}
  });
  app.put<{Params:{id:string;agentId:string};Body:{revision:number;restrictedCapabilityIds:string[]}}>('/api/branches/:id/agents/:agentId/capabilities',async(request,reply)=>{
    try{return await putCapabilities('agent',request.params.agentId,request.params.id,request.body)}catch(error){return reply.code(error instanceof CapabilityPolicyRevisionConflictError?409:error instanceof BranchCapabilityOwnerError?404:400).send({error:(error as Error).message,...(error instanceof CapabilityPolicyRevisionConflictError?{current:error.current}:{})})}
  });
  app.put<{Params:{id:string};Body:{configuration:unknown;revision:number}}>('/api/branches/:id/settings',async(request,reply)=>{
    try{assertEditable(request.params.id);const configuration=request.body.configuration as Record<string,unknown>;if(!configuration||Object.hasOwn(configuration,'secretBindings'))throw new Error('Secret bindings are managed by Engine integrations');const id=request.params.id,branch=branches.getBranch(id);if(!branch)throw new Error('Branch not found');const definition=branches.version(id,branch.versionId)!.definition;
      const candidate=validateBranchConfiguration({...configuration,secretBindings:branches.configuration(id).secretBindings},definition);
      const trigger=validateLocal({chatId:'',branchId:id,expectedVersionId:branch.versionId,idempotencyKey:'configuration-validation',definition,bindings:branches.localConfiguration(id)!},candidate);
      branches.configure(id,candidate,request.body.revision,trigger);await sources.refresh();notify();return publicSettings(id)}catch(error){return reply.code(409).send({error:(error as Error).message})}
  });
  app.put<{Params:{id:string};Body:{enabled:boolean}}>('/api/branches/:id/availability',async(request,reply)=>{
    try{branches.setEnabled(request.params.id,request.body.enabled);await sources.refresh();notify();return branches.getBranch(request.params.id)}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/lifecycle',async(request,reply)=>{
    const id=request.params.id,row=store.sqlite.prepare('SELECT deleting FROM branches WHERE id=?').get(id) as {deleting:number}|undefined;
    if(!row)return reply.code(404).send({error:'Branch not found'});
    return {deleting:Boolean(row.deleting),chats:(store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_id=?').get(id) as {n:number}).n,
      activeExecutions:(store.sqlite.prepare("SELECT COUNT(*) n FROM branch_executions WHERE branch_id=? AND state IN ('queued','running','waiting')").get(id) as {n:number}).n,
      callers:store.sqlite.prepare('SELECT DISTINCT b.id,b.name FROM branch_dependencies d JOIN branches b ON b.id=d.branch_id WHERE d.target_branch_id=? AND d.branch_id!=?').all(id,id) as Array<{id:string;name:string}>,
      pendingRemoval:store.sqlite.prepare("SELECT r.local_id id,CASE WHEN r.agent_ref='' THEN 'Chat' ELSE 'Agent' END kind,e.error FROM branch_installation_resources r LEFT JOIN branch_retirement_errors e ON e.resource_id=r.local_id WHERE r.branch_id=? AND r.state='retiring'").all(id) as Array<{id:string;kind:'Chat'|'Agent';error?:string}>,
      updates:store.sqlite.prepare("SELECT id,error FROM branch_installation_plans WHERE branch_id=? AND state IN ('applying','canceling')").all(id) as Array<{id:string;error?:string}>} satisfies import('@ponderosa/core').BranchLifecycleDto;
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/dependencies',async request=>({
    calls:store.sqlite.prepare('SELECT target_branch_id id,ref FROM branch_dependencies WHERE branch_id=?').all(request.params.id),
    callers:store.sqlite.prepare('SELECT branch_id id,ref FROM branch_dependencies WHERE target_branch_id=?').all(request.params.id),
  }));
  app.get<{ Querystring: { chatId?: string;before?:string;search?:string } }>('/api/branches', async(request,reply)=>{try{return branches.listBranches(request.query.chatId,request.query.before,request.query.search)}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid workflow cursor'})}});
  app.get<{Querystring:{search?:string}}>('/api/branches/contexts',async request=>{
    const search=(request.query.search??'').trim().slice(0,200);
    const rows=store.sqlite.prepare("SELECT c.id FROM conversations c WHERE c.branch_id IS NOT NULL AND c.branch_execution_id IS NULL AND c.archived=0 AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r WHERE r.local_id=c.id AND r.state!='active') AND (?='' OR instr(lower(c.title),lower(?))>0) ORDER BY c.updated_at DESC LIMIT 100").all(search,search) as Array<{id:string}>;
    return rows.flatMap(({id})=>{const chat=store.getConversation(id),context=store.getChatContext(id);return chat&&context?[{...chat,workingDirectory:context.hostPath,defaultEngine:context.defaultEngine}]:[]});
  });
  app.get<{Params:{id:string}}>('/api/branches/contexts/:id',async(request,reply)=>{
    const inactive=store.sqlite.prepare("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND state!='active'").get(request.params.id);
    const chat=inactive?undefined:store.getConversation(request.params.id),binding=chat?store.getChatContext(request.params.id):undefined;
    return chat?.branchId&&binding?{...chat,workingDirectory:binding.hostPath,defaultEngine:binding.defaultEngine}:reply.code(404).send({error:'Chat not found'});
  });
  app.get<{Params:{id:string}}>('/api/branches/:id',async(request,reply)=>branches.getBranch(request.params.id)??reply.code(404).send({error:'Branch not found'}));
  app.get<{Params:{id:string}}>('/api/branches/:id/trigger',async(request,reply)=>branches.trigger(request.params.id)??reply.code(404).send({error:'Trigger not found'}));
  app.post<{ Body: DeployBranchRequest }>('/api/branches/preview', async (request, reply) => {
    try {
      validateLocal(request.body);
      return branches.preview(request.body);
    }catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid deployment preview'})}
  });
  app.post<{Body:unknown}>('/api/branches/import-preview',async(request,reply)=>{
    try{return importBranchPackage(request.body)}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid package'})}
  });
  app.get<{Params:{id:string};Querystring:{revisionId?:string}}>('/api/branches/:id/configuration',async(request,reply)=>{
    const bindings=request.query.revisionId?branches.bindingRevision(request.params.id,request.query.revisionId):branches.localConfiguration(request.params.id);
    return bindings??reply.code(404).send({error:'Branch configuration not found'});
  });
  app.get<{Params:{id:string};Querystring:{before?:string}}>('/api/branches/:id/versions',async(request,reply)=>{
    try{return branches.versions(request.params.id,request.query.before)}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid cursor'})}
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/export',async(request,reply)=>{
    const branch=branches.getBranch(request.params.id);if(!branch)return reply.code(404).send({error:'Branch not found'});
    return reply.header('content-disposition','attachment; filename="workflow.ponderosa.json"').send(exportBranchPackage(branches.version(branch.id,branch.versionId)!.definition));
  });
  app.post<{ Body: DeployBranchRequest }>('/api/branches/deploy', async (request, reply) => {
    try {
      const input = request.body;
      assertEditable(input.branchId!);
      const replay = branches.deploymentReplay(input);
      if (replay) { await sources.reconcileBranch(replay.id); return replay; }
      let trigger=validateLocal(input);
      const currentTrigger=input.branchId?branches.trigger(input.branchId):undefined;
      const secret=input.definition.trigger.kind==='webhook' && (!currentTrigger || currentTrigger.sourceKind!=='webhook' || !currentTrigger.secretFingerprint) ? sources.createWebhookSecret() : undefined;
      if(trigger&&secret)trigger={...trigger,secretCiphertext:secret.ciphertext,secretFingerprint:secret.fingerprint} as typeof trigger;
      const result = branches.deploy(input, new Date().toISOString(), trigger);
      await sources.applyDefinitionChange(currentTrigger,branches.trigger(result.id));
      notify();
      return { ...result, ...(secret && branches.trigger(result.id)?.secretFingerprint === secret.fingerprint ? { webhookSecret: secret.secret } : {}) };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid Branch deployment' }); }
  });
  app.post<{ Params: { id: string }; Body: { occurrenceKey: string; input: string } }>('/api/branches/:id/executions', async (request, reply) => {
    try { const execution = branches.accept(request.params.id, request.body.occurrenceKey, request.body.input); notify(); return execution; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid Branch input' }); }
  });
  app.post<{ Params: { id: string }; Body: BranchGateResolution }>('/api/branch-gates/:id/resolve', async (request, reply) => {
    try { const result = branches.resolveGate(request.params.id, request.body); notify(); return result; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'Gate resolution failed' }); }
  });
  app.post<{ Params: { id: string }; Body: BranchIntervention }>('/api/branch-executions/:id/intervene', async (request, reply) => {
    try { const result = branches.intervene(request.params.id, request.body); notify(); return result; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'Intervention failed' }); }
  });
  app.delete<{ Params: { id: string } }>('/api/branches/:id', async (request, reply) => {
    try { const result=await context.installations.delete(request.params.id); await sources.refresh();notify();return reply.code(result.pending?202:200).send(result); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'Branch cleanup pending' }); }
  });
  app.get<{ Params: { id: string; versionId: string } }>('/api/branches/:id/versions/:versionId', async (request, reply) => branches.version(request.params.id, request.params.versionId) ?? reply.code(404).send({ error: 'Branch version not found' }));
  app.get<{ Params: { id: string }; Querystring: { before?: string; state?: string } }>('/api/branches/:id/executions', async (request, reply) => {
    try { return branches.listExecutions(request.params.id, request.query.before, request.query.state); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid history cursor' }); }
  });
  app.get<{ Params: { id: string } }>("/api/branch-executions/:id/operations", async (request, reply) => {
    const execution=branches.execution(request.params.id);
    return execution?branchOperationalSummary(store.sqlite,execution,context.providerStatus):reply.code(404).send({error:"Execution not found"});
  });
  app.get<{ Params: { id: string };Querystring:{cursor?:string} }>('/api/branch-executions/:id', async (request, reply) => {
    try{const result = branches.detail(request.params.id,request.query.cursor);
    return result ? previewBranchExecutionDetail(result) : reply.code(404).send({ error: 'Branch execution not found' });}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid history cursor'})}
  });
  app.get<{ Params: { id: string; stepExecutionId: string } }>('/api/branch-executions/:id/steps/:stepExecutionId/evidence', async (request, reply) =>
    branches.stepEvidence(request.params.id,request.params.stepExecutionId) ?? reply.code(404).send({error:'Step evidence not found in this execution'}));
  app.get<{ Params: { id: string }; Querystring: { q?: string; offset?: string } }>('/api/branch-executions/:id/map-items/search', async (request, reply) => {
    try { const found=branches.searchMapItems(request.params.id,request.query.q??'',request.query.offset===undefined?0:Number(request.query.offset));return found?{...found,items:found.items.map(item=>({...item,input:Array.from(item.input).slice(0,128).join('')+(Array.from(item.input).length>128?'…':''),...(item.result?.output?{result:{...item.result,output:Array.from(item.result.output).slice(0,128).join('')+(Array.from(item.result.output).length>128?'…':'')}}:{})}))}:reply.code(404).send({error:'Execution not found'}); }
    catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.get<{ Params: { id: string; itemId: string } }>('/api/branch-executions/:id/map-items/:itemId/evidence', async (request, reply) =>
    branches.mapItemEvidence(request.params.id,request.params.itemId) ?? reply.code(404).send({error:'Map item not found in this execution'}));
  app.get<{ Params: { id: string };Querystring:{cursor?:string} }>('/api/branch-executions/:id/full-detail', async (request, reply) => {
    try { return branches.detail(request.params.id,request.query.cursor) ?? reply.code(404).send({error:'Execution not found'}); }
    catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.get<{ Params: { id: string } }>('/api/branch-executions/:id/input', async (request, reply) => {
    const execution=branches.execution(request.params.id);return execution?{input:execution.input}:reply.code(404).send({error:'Execution not found'});
  });
  app.get<{ Params: { id: string } }>('/api/branch-executions/:id/result', async (request, reply) => {
    const execution=branches.execution(request.params.id);
    return execution ? {output:execution.output??null} : reply.code(404).send({error:'Branch execution not found'});
  });
  app.get<{ Params: { id: string; bundleId: string } }>('/api/branch-executions/:id/result-bundles/:bundleId', async (request, reply) => {
    const result=branches.resultBundle(request.params.bundleId);
    return result?.executionId===request.params.id?result:reply.code(404).send({error:'Result bundle not found in this execution'});
  });
  app.post<{ Params: { id: string } }>('/api/branch-executions/:id/cancel', async (request, reply) => {
    try { branches.cancel(request.params.id); notify(); const detail=branches.detail(request.params.id);return detail?previewBranchExecutionDetail(detail):undefined; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Cancellation failed' }); }
  });
}
