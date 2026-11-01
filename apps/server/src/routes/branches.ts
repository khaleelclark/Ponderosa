import {BranchIssuedGroupDestinationService} from '../branch-issued-group-destination.js';
import {BranchIssuedDestinationService} from '../branch-issued-destination.js';
import {BranchDisclosureReviewService} from '../branch-disclosure-review.js';
import type {BranchResourceService} from '../branch-resource-service.js';
import type {OutputAgentApps} from '../output-agent-apps.js';
import type {BranchInstallationService} from '../branch-installation-service.js';
import type {ChatCreator} from './projects.js';
import { normalizeTriggerSourceConfig, type BranchTriggerSourceService } from '../branch-trigger-service.js';
import { triggerSourceConfig } from '../branch-trigger-config.js';
import { realpathSync, statSync } from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {validatedObject,exactObjectFields} from '../object-validation.js';
import { readBranchRunCounts, workspaceRecencyCte, exportBranchPackage, importBranchPackage, stableJson, validateBranchDefinition, validateBranchBindings, validateBranchConfiguration, resolveBranchParameterReferences, interpolateBranchText, type CoordinationV3Store, type AgentStore, type BranchStore, type WorkspaceStore } from '@ponderosa/agents';
import { BranchValidationError, FULL_PACKAGE_EXPORT_WARNING, AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_METADATA_MAX_BYTES,type BranchGateResolution, type BranchHomeDto, type BranchIntervention, type DeployBranchRequest, type WorkspacePreferencesDto } from '@ponderosa/core';
import {activeChatResourceOwner} from '../branch-resource-owner.js';
import {previewBranchExecutionActions,previewBranchExecutionDetail} from '../branch-detail-preview.js';
import {branchOperationalSummary, type ProviderIntakeStatus} from '../branch-operations.js';
import {activeChatProductSql,activeAgentProductSql} from '@ponderosa/agents';
import {sqliteCollectionGeneration,StaleCollectionCursorError,sqliteCollectionPage,applyCollectionPageHeaders,sendCollectionPageError,type CollectionQuery} from '../collection-page.js';
import {parseTokenUsageRange} from '../token-usage.js';
import {workspaceNotificationPage} from './notifications.js';

export function registerBranchRoutes(app: FastifyInstance, context: { coordination:CoordinationV3Store;resources:BranchResourceService;outputApps:OutputAgentApps; branches: BranchStore; installations:BranchInstallationService; store: AgentStore; workspace:WorkspaceStore; sources: BranchTriggerSourceService;createChat:ChatCreator; engineAvailable?(id:string):boolean; providerStatus?(id:string):Promise<ProviderIntakeStatus|undefined>; preferences?():WorkspacePreferencesDto; notify(): void }): void {
  const { branches, store, sources, notify } = context;
  // These routes inherit the existing operator-only request hook. Agent capability
  // tokens cannot turn Branch read access into private historical Request access.
  const hostArtifactGrant=(projectId:string,artifactId:string,recipientAgentId:string)=>store.operatorCanReadProjectArtifact(projectId,artifactId)&&store.agentCanReadProjectArtifact(projectId,artifactId,recipientAgentId);
  const disclosures=new BranchDisclosureReviewService(store,branches,context.coordination,(executionId,checkpointId,expectedHash)=>context.resources.verifyHistoricalCustody(executionId,checkpointId,expectedHash));
  const destinations=new BranchIssuedDestinationService(store,branches,context.coordination,disclosures,()=>context.resources.destinationPackageEngine(),context.createChat);
  const groups=new BranchIssuedGroupDestinationService(store,branches,context.coordination,()=>context.resources.destinationPackageEngine());
  const groupPath='/api/branches/:id/executions/:executionId/destination-groups';
  type GroupParams={id:string;executionId:string;admissionId:string};
  app.get<{Params:GroupParams;Querystring:{commandKey:string}}>(groupPath+'/capture',(request,reply)=>{
    try{const p=request.params;return groups.captureStatus(p.id,p.executionId,request.query.commandKey);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:GroupParams;Body:unknown}>(groupPath+'/capture',async(request,reply)=>{
    try{const p=request.params,body=validatedObject(request.body,'Issued group capture');exactObjectFields(body,['commandKey'],'Issued group capture');
      if(typeof body.commandKey!=='string')throw Error('Capture command key required');const result=await groups.capture(p.id,p.executionId,body.commandKey);notify();return result;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:GroupParams;Querystring:{commandKey:string}}>(groupPath,(request,reply)=>{
    try{const p=request.params;if(typeof request.query.commandKey!=='string')throw Error('Exact group command key required');return groups.inspect(p.id,p.executionId,request.query.commandKey);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:GroupParams;Body:unknown}>(groupPath,async(request,reply)=>{
    try{const p=request.params,body=validatedObject(request.body,'Issued group destination');exactObjectFields(body,['commandKey','checkpointId','expectedHash','reconcileEffects','accessSettingsResolution'],'Issued group destination');
      const result=await groups.prepare(p.id,p.executionId,body as unknown as import('@ponderosa/core').BranchIssuedDestinationInput);notify();return result;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:GroupParams;Body:unknown}>(groupPath+'/admit',async(request,reply)=>{
    try{const p=request.params,body=validatedObject(request.body,'Issued group admission');exactObjectFields(body,['commandKey','reviewHash'],'Issued group admission');
      if(typeof body.commandKey!=='string'||typeof body.reviewHash!=='string')throw Error('Exact group command/review required');const result=await groups.admit(p.id,p.executionId,body.commandKey,body.reviewHash);notify();return result;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:GroupParams;Querystring:{commandKey?:string}}>(groupPath+'/:admissionId/disclosure',async(request,reply)=>{
    try{const p=request.params;return request.query.commandKey!==undefined?groups.disclosures.readCommand(p.id,p.executionId,p.admissionId,request.query.commandKey):await groups.disclosures.prepare(p.id,p.executionId,p.admissionId);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:GroupParams;Body:unknown}>(groupPath+'/:admissionId/disclosure',async(request,reply)=>{
    try{const p=request.params,body=validatedObject(request.body,'Human group disclosure');exactObjectFields(body,['commandKey','action','reviewHash','expectedRevision'],'Human group disclosure');return await groups.disclosures.choose(p.id,p.executionId,p.admissionId,body as unknown as import('@ponderosa/core').BranchDisclosureChoice);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  const destinationPath='/api/branches/:id/executions/:executionId/destinations';
  type DestinationParams={id:string;executionId:string};
  app.get<{Params:DestinationParams;Querystring:{commandKey?:string}}>(destinationPath,(request,reply)=>{
    try{const p=request.params;return request.query.commandKey!==undefined?destinations.inspect(p.id,p.executionId,request.query.commandKey):destinations.list(p.id,p.executionId);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:DestinationParams;Body:unknown}>(destinationPath,async(request,reply)=>{
    try{const p=request.params,body=validatedObject(request.body,'Issued destination preparation');
      exactObjectFields(body,['commandKey','checkpointId','expectedHash','reconcileEffects','accessSettingsResolution'],'Issued destination preparation');
      const result=await destinations.prepare(p.id,p.executionId,body as unknown as import('@ponderosa/core').BranchIssuedDestinationInput);notify();return result;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:DestinationParams;Body:unknown}>(destinationPath+'/admit',async(request,reply)=>{
    try{const p=request.params,body=validatedObject(request.body,'Issued destination admission');
      exactObjectFields(body,['commandKey','reviewHash'],'Issued destination admission');
      if(typeof body.commandKey!=='string'||typeof body.reviewHash!=='string')throw Error('Exact destination command and human review hash required');
      const result=await destinations.admit(p.id,p.executionId,body.commandKey,body.reviewHash);notify();return result;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  const disclosurePath='/api/branches/:id/executions/:executionId/destinations/:admissionId/disclosure';
  type DisclosureParams={id:string;executionId:string;admissionId:string};
  app.get<{Params:DisclosureParams;Querystring:{commandKey?:string}}>(disclosurePath,async(request,reply)=>{
    try{const p=request.params;
      return request.query.commandKey!==undefined?disclosures.readCommand(p.id,p.executionId,p.admissionId,request.query.commandKey)
        :await disclosures.prepare(p.id,p.executionId,p.admissionId);
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Disclosure review unavailable'});}
  });
  app.post<{Params:DisclosureParams;Body:unknown}>(disclosurePath,async(request,reply)=>{
    try{const p=request.params,body=validatedObject(request.body,'Human disclosure choice');
      exactObjectFields(body,['commandKey','action','reviewHash','expectedRevision'],'Human disclosure choice');
      const result=await disclosures.choose(p.id,p.executionId,p.admissionId,body as unknown as import('@ponderosa/core').BranchDisclosureChoice);
      return result;
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Human disclosure choice refused'});}
  });
  // Explicit operator selection; no automatic retirement of historical checkpoints.
  app.post<{Body:import('@ponderosa/core').BranchCustodyReviewInput}>('/api/lifecycle/branch-custody/review',(request,reply)=>{
    try{const body=validatedObject(request.body,'Branch custody review');exactObjectFields(body,['source'],'Branch custody review');
      return store.sqlite.transaction(()=>branches.custodyLifecycle.inspect(body.source as import('@ponderosa/core').CheckpointPackageSource))();
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Body:import('@ponderosa/core').BranchCustodyCheckpointRetirementInput}>('/api/lifecycle/branch-custody/retire-checkpoints',(request,reply)=>{
    try{const body=validatedObject(request.body,'Branch checkpoint retirement');exactObjectFields(body,['source','commandKey','expectedRevision','checkpoints'],'Branch checkpoint retirement');
      if(typeof body.commandKey!=='string'||typeof body.expectedRevision!=='string'||!Array.isArray(body.checkpoints)||body.checkpoints.length>128)throw Error('Exact bounded checkpoint selection required');
      for(const checkpoint of body.checkpoints){const cp=validatedObject(checkpoint,'Checkpoint');exactObjectFields(cp,['id','sha256'],'Checkpoint');}
      const input=request.body;return branches.custodyLifecycle.retireCheckpoints(input.source,{commandKey:input.commandKey,expectedRevision:input.expectedRevision,checkpoints:input.checkpoints});
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
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
    configuration??=validateBranchConfiguration({parameters:Object.fromEntries(Object.entries(previousConfiguration.parameters).filter(([key])=>input.definition.parameters?.[key]?.type!=='secret'&&input.definition.parameters?.[key])),limits:previousConfiguration.limits,checkpointMode:previousConfiguration.checkpointMode,secretBindings:Object.fromEntries(Object.entries(previousConfiguration.secretBindings??{}).filter(([key])=>input.definition.parameters?.[key]?.type==='secret'))},input.definition);
    for(const step of input.definition.steps)if(step.kind==='script') {
      const directory=input.bindings.directories[step.cwdRef];
      const prefix=`Branch "${input.definition.name}" · Script "${step.label??step.id}": `;
      if(!directory?.trim())throw new BranchValidationError(prefix+'Working directory is required. Choose an existing directory or use "." for the Engine’s current directory.', {nodeId:step.id,section:'advanced',field:'cwdRef'});
      try {if(!statSync(realpathSync(interpolateBranchText(directory,input.definition,configuration))).isDirectory())throw new Error();}
      catch {throw new BranchValidationError(prefix+'Working directory does not resolve to an accessible directory on this Engine. Check the path and permissions.', {nodeId:step.id,section:'advanced',field:'cwdRef'});}
    }
    for(const agentId of Object.values(input.bindings.agents)){
      const agent=store.getAgent(agentId),chat=agent?.conversationId?store.getConversation(agent.conversationId):undefined;
      if(!chat || chat.branchId!==input.branchId || chat.executionId){
        const step=input.definition.steps.find(step=>step.kind==='agent'&&'ref'in step.target&&input.bindings.agents[step.target.ref]===agentId);
        const recovery=input.definition.steps.find(step=>step.failure?.action==='recover'&&input.bindings.agents[step.failure.agentRef]===agentId);
        throw new BranchValidationError('Persistent Agents must belong to a persistent Chat in this Branch', {nodeId:step?.id??recovery?.id,section:step?'task':recovery?'failure':'settings',field:step?'target':'failure.agentRef'});
      }
    }
    for(const step of input.definition.steps)if(step.kind==='branch_call' && !branches.getBranch(input.bindings.branches?.[step.branchRef]??''))throw new BranchValidationError(`Branch "${input.definition.name}" · Step "${step.label??step.id}": Called Branch is missing or unavailable. Choose an existing Branch.`, {nodeId:step.id,section:'task',field:'branchRef'});
    for(const template of Object.values(input.definition.templates??{}))for(const member of template.agents){const engine=input.bindings.engines?.[member.engine];if(!engine||(context.engineAvailable&&!context.engineAvailable(engine))){const step=input.definition.steps.find(step=>step.kind==='agent'&&'templateRef'in step.target&&input.definition.templates?.[step.target.templateRef]===template);throw new BranchValidationError('Template engine is unavailable',{nodeId:step?.id,section:'agent_setup',field:'engine',templateMemberRef:member.ref});}}
    if(input.definition.trigger.kind==='manual')return undefined;
    const local=input.bindings.triggers?.[input.definition.trigger.configRef];if(!local)throw new Error('Local trigger configuration is required');
        const parsed = triggerSourceConfig(input.definition.trigger.kind, resolveBranchParameterReferences(local.sourceConfig,input.definition,configuration));
        const current = input.branchId ? branches.trigger(input.branchId) : undefined;
        const previous = input.branchId ? branches.localConfiguration(input.branchId)?.triggers?.[input.definition.trigger.configRef] : undefined;
        const same = current?.sourceKind === input.definition.trigger.kind && previous && stableJson(previous.sourceConfig) === stableJson(local.sourceConfig) && stableJson(current.sourceConfig)===stableJson(parsed);
        const cadence=(value:import('@ponderosa/core').TriggerSourceConfig)=>{const {whenRunning,...timing}=value as import('@ponderosa/core').TriggerSourceConfig & {whenRunning?:string};return timing};
        const sameCadence=current?.sourceKind==='schedule'&&input.definition.trigger.kind==='schedule'&&previous&&
          stableJson(cadence(previous.sourceConfig))===stableJson(cadence(local.sourceConfig))&&stableJson(cadence(current.sourceConfig))===stableJson(cadence(parsed));
        const keepSchedule = (same||sameCadence) && previous && (previous.enabled === local.enabled || !local.enabled);
        const normalized = keepSchedule ? { config: same?current!.sourceConfig:parsed, nextFireAt: current!.nextFireAt } : normalizeTriggerSourceConfig(input.definition.trigger.kind, parsed);
    return {sourceConfig:normalized.config,nextFireAt:normalized.nextFireAt,resetSchedule:!keepSchedule,...(keepSchedule?{enabledOverride:local.enabled?current!.enabled:false}:{})};
  }
  context.installations.setPublisher((input,configuration)=>{
    const trigger=validateLocal(input,configuration);
    return branches.deploy(input,new Date().toISOString(),trigger,configuration);
  },()=>sources.refresh());
  // Provision metadata on first server start, even before the Assistant page is opened.
  // Provider/session work still belongs to the ordinary scheduler after its first due time.
  app.addHook('onReady',async()=>{
    try{await context.outputApps.initialize();}
    catch(error){app.log.error({err:error},'Assistant setup failed; see Assistant settings');}
  });
  app.get('/api/branches/assistant',async()=>context.outputApps.status());
  app.post<{Body:{agentId:string;expectedSpeakerId:string|null}}>('/api/branches/assistant/speaker',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Ponderosa speaker');exactObjectFields(body,['agentId','expectedSpeakerId'],'Ponderosa speaker');
      if(typeof body.agentId!=='string'||!body.agentId||(body.expectedSpeakerId!==null&&typeof body.expectedSpeakerId!=='string'))throw Error('Agent and reviewed current speaker are required');
      const result=context.outputApps.moveSpeaker(body.agentId,body.expectedSpeakerId);await sources.refresh();notify();return result;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Body?:{enabled?:boolean;initialize?:boolean}}>('/api/branches/assistant',async(request,reply)=>{
    try{
      const body=validatedObject(request.body??{},'Assistant settings');exactObjectFields(body,['enabled','initialize'],'Assistant settings');
      if((body.enabled!==undefined&&typeof body.enabled!=='boolean')||(body.initialize!==undefined&&typeof body.initialize!=='boolean'))throw new Error('Invalid Assistant setting');
      const result=body.enabled===false?context.outputApps.disable():await context.outputApps.initialize(body.initialize!==true);
      await sources.refresh();notify();return result;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:{id:string}}>('/api/branches/output-apps/:id',async(request,reply)=>{
    try{return context.outputApps.get(request.params.id);}catch(error){return reply.code(404).send({error:(error as Error).message});}
  });
  app.put<{Params:{id:string};Body:{enabled:boolean;speaker?:boolean}}>('/api/branches/output-apps/:id',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'output settings');exactObjectFields(body,['enabled','speaker'],'output settings');
      if(typeof body.enabled!=='boolean'||(body.speaker!==undefined&&typeof body.speaker!=='boolean'))throw new Error('Invalid output designation');
      const app=context.outputApps.designate(request.params.id,body.enabled,body.speaker===true);await sources.refresh();notify();return {app:app??null};
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.put<{Params:{id:string};Body:{expectedVersionId:string;expectedSettingsRevision:string;automatic:boolean;everyMs:number}}>('/api/branches/output-apps/:id/schedule',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'output settings');exactObjectFields(body,['expectedVersionId','expectedSettingsRevision','automatic','everyMs'],'schedule settings');
      if(typeof body.expectedVersionId!=='string'||typeof body.expectedSettingsRevision!=='string'||typeof body.automatic!=='boolean'||(typeof body.everyMs!=='number'||!Number.isInteger(body.everyMs)))throw new Error('Invalid schedule settings');
      const output=context.outputApps.get(request.params.id),branch=branches.getBranch(output.branchId)!;assertEditable(branch.id);
      if(body.expectedVersionId!==branch.versionId||body.expectedSettingsRevision!==output.settingsRevision)throw new Error('Workflow changed. Reload settings.');
      const version=branches.version(branch.id,branch.versionId);if(!version)throw new Error('Publish this workflow before changing its schedule');
      if(version.definition.trigger.kind!=='manual'&&version.definition.trigger.kind!=='schedule')throw new Error('Open More options to change an event-triggered workflow');
      if(body.automatic&&!branch.enabled)throw new Error('Workflow is disabled. Enable it in More options before turning on automatic runs.');
      const priorConfig=branches.trigger(branch.id)?.sourceConfig;
      const schedule=priorConfig&&'scheduleKind'in priorConfig?priorConfig:undefined;
      const config={scheduleKind:'interval' as const,everyMs:body.everyMs,startsAt:schedule?.scheduleKind==='interval'&&schedule.everyMs===body.everyMs?schedule.startsAt:new Date(Date.now()+body.everyMs).toISOString(),...(schedule&&'whenRunning'in schedule&&schedule.whenRunning?{whenRunning:schedule.whenRunning}:{})};
      normalizeTriggerSourceConfig('schedule',config);
      const ref=version.definition.trigger.kind==='schedule'?version.definition.trigger.configRef:'output_schedule';
      const bindings=branches.localConfiguration(branch.id);if(!bindings)throw new Error('Workflow bindings are unavailable');
      const input:DeployBranchRequest={chatId:'',branchId:branch.id,expectedVersionId:body.expectedVersionId,idempotencyKey:randomUUID(),definition:{...version.definition,trigger:{kind:'schedule',configRef:ref}},bindings:{...bindings,triggers:{...bindings.triggers,[ref]:{sourceConfig:config,enabled:body.automatic}}}};
      const previous=branches.trigger(branch.id);branches.deploy(input,new Date().toISOString(),validateLocal(input));
      await sources.applyDefinitionChange(previous,branches.trigger(branch.id));notify();return context.outputApps.get(request.params.id);
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Body:{package:unknown;bindings:import('@ponderosa/core').BranchBindings;branchId?:string;memorySelection?:import('@ponderosa/core').BranchMemoryUpdateSelectionDto;fileSelections?:import('@ponderosa/core').BranchImportFileSelections}}>('/api/branches/install-preview',{bodyLimit:AGENT_PACKAGE_MAX_BYTES+AGENT_PACKAGE_METADATA_MAX_BYTES+1},async(request,reply)=>{
    try{return await context.installations.preview(request.body.package,request.body.bindings,request.body.branchId,request.body.memorySelection,request.body.fileSelections)}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.post<{Params:{id:string}}>('/api/branches/installations/:id/role-review',async(request,reply)=>{try{return context.installations.reviewPublishedRoles(request.params.id);}catch(error){return reply.code(409).send({error:(error as Error).message});}});
  app.post<{Params:{id:string};Body?:{acknowledgeFullImport?:boolean;acknowledgeMemoryUpdate?:boolean;outputRoleReviewId?:string}}>('/api/branches/installations/:id/confirm',async(request,reply)=>{
    try{const body=request.body??{};if(typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['acknowledgeFullImport','acknowledgeMemoryUpdate','outputRoleReviewId'].includes(key))||(body.outputRoleReviewId!==undefined&&typeof body.outputRoleReviewId!=='string')||(body.acknowledgeMemoryUpdate!==undefined&&typeof body.acknowledgeMemoryUpdate!=='boolean')||(body.acknowledgeFullImport!==undefined&&typeof body.acknowledgeFullImport!=='boolean'))throw new Error('Invalid installation confirmation');const result=await context.installations.confirm(request.params.id,body.acknowledgeFullImport===true,body.outputRoleReviewId,body.acknowledgeMemoryUpdate===true);await sources.refresh();notify();return result}catch(error){return reply.code(409).send({error:(error as Error).message})}
  });
  app.post<{Params:{id:string};Body:{chatRef:string;agentRef:string;resolution:NonNullable<import('@ponderosa/core').ImportAgentPackageRequest['accessSettingsResolution']>}}>('/api/branches/installations/:id/access-review',async(request,reply)=>{
    try{const body=validatedObject(request.body,'Installation access review');exactObjectFields(body,['chatRef','agentRef','resolution'],'Installation access review');if(typeof body.chatRef!=='string'||typeof body.agentRef!=='string')throw new Error('Choose an installation Agent');const resolution=validatedObject(body.resolution,'Access resolution');exactObjectFields(resolution,['action','reviewSha256','agentActions'],'Access resolution');const result=await context.installations.resolveAccess(request.params.id,body.chatRef,body.agentRef,resolution as unknown as NonNullable<import('@ponderosa/core').ImportAgentPackageRequest['accessSettingsResolution']>);notify();return result;}catch(error){return reply.code(409).send({error:(error as Error).message,...context.installations.status(request.params.id)});}
  });
  app.post<{Params:{id:string};Body:{chatRef:string;agentRef:string;sharedRoot:string}}>('/api/branches/installations/:id/working-root-review',async(request,reply)=>{
    try{const body=validatedObject(request.body,'Installation working-root review');exactObjectFields(body,['chatRef','agentRef','sharedRoot'],'Installation working-root review');if(typeof body.chatRef!=='string'||typeof body.agentRef!=='string'||typeof body.sharedRoot!=='string')throw new Error('Confirm the created installation root');const result=context.installations.resolveWorkingRoot(request.params.id,body.chatRef,body.agentRef,body.sharedRoot);notify();return result;}catch(error){return reply.code(409).send({error:(error as Error).message,...context.installations.status(request.params.id)});}
  });
  app.get<{Params:{id:string}}>('/api/branches/installations/:id',async(request,reply)=>context.installations.status(request.params.id)??reply.code(404).send({error:'Installation not found'}));
  app.post<{Params:{id:string}}>('/api/branches/installations/:id/cancel',async(request,reply)=>{
    try{const result=await context.installations.cancel(request.params.id);await sources.refresh();notify();return result}catch(error){return reply.code(409).send({error:(error as Error).message})}
  });
  app.get<{Params:{id:string};Querystring:{mode?:'template'|'full';includeValues?:string;fileSelections?:string}}>('/api/branches/:id/package',async(request,reply)=>{
    try{const result=await context.installations.export(request.params.id,request.query.mode==='full'?'full':'template',request.query.includeValues==='true',request.query.fileSelections?JSON.parse(request.query.fileSelections):undefined);if(request.query.mode==='full')reply.header('x-ponderosa-export-warning',FULL_PACKAGE_EXPORT_WARNING);return result}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.post<{Body:{name:string;idempotencyKey:string}}>('/api/branches',async(request,reply)=>{
    try{return branches.create(request.body.name,request.body.idempotencyKey)}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.post<{Params:{id:string};Body:import('@ponderosa/core').CreateProjectRequest}>('/api/branches/:id/chats',async(request,reply)=>{
    try{
      assertEditable(request.params.id);
      const key=request.headers['idempotency-key'];
      if(typeof key!=='string')return reply.code(400).send({error:'A Chat creation idempotency key is required'});
      return await context.createChat(request.body,key,{branchId:request.params.id});
    }catch(error){return reply.code((error as {statusCode?:number}).statusCode??400).send({error:error instanceof Error?error.message:'Chat creation failed'});}
  });
  app.get<{Params:{id:string};Querystring:CollectionQuery&{executionId?:string}}>('/api/branches/:id/chats',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    try{
      const search=request.query.search?.trim()??'';
      if(search.length>200)throw new Error('Chat search must be at most 200 characters');
      const recency=context.workspace.resourceRecencySnapshot('conversation');
      const page=sqliteCollectionPage(store.sqlite,request.query,{
        baseSql:`WITH ${workspaceRecencyCte} SELECT c.id,c.title,max(c.updated_at,COALESCE(recent_use.last_used_at,'')) AS updated_at FROM conversations c LEFT JOIN recent_use ON recent_use.id=c.id WHERE c.branch_id=? AND c.branch_execution_id IS ? AND ${activeChatProductSql('c','branches')} ${search?'AND instr(lower(c.title),lower(?))>0':''}`,
        params:[recency.json,request.params.id,request.query.executionId??null,...(search?[search]:[])],order:'updated',scope:`branch-chats:${request.params.id}:${request.query.executionId??'persistent'}`,
        generationKeys:['conversations','projects'],revisionSuffix:recency.revision,
        hydrate:id=>{const chat=store.getConversation(id),owner=store.getChatContext(id);return chat&&owner?{...chat,workingDirectory:owner.hostPath,defaultEngine:owner.defaultEngine}:undefined},
      });
      applyCollectionPageHeaders(reply,page);return page.items;
    }catch(error){return sendCollectionPageError(reply,error);}
  });
  app.get<{Params:{id:string};Querystring:CollectionQuery}>('/api/branches/:id/agents',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    try{
      const search=request.query.search?.trim()??'';
      if(search.length>200)throw new Error('Agent search must be at most 200 characters');
      const hasTeam=store.sqlite.prepare(`SELECT 1 FROM agents member WHERE member.manager_agent_id=? AND member.conversation_id=? AND ${activeAgentProductSql('member','branches')} LIMIT 1`);
      const page=sqliteCollectionPage(store.sqlite,request.query,{
        baseSql:`SELECT a.id,a.title,a.updated_at FROM agents a JOIN conversations c ON c.id=a.conversation_id
          WHERE c.branch_id=? AND c.branch_execution_id IS NULL AND ${activeAgentProductSql('a','branches')}
          ${search?"AND instr(lower(a.title),lower(?))>0":''}`,
        params:[request.params.id,...(search?[search]:[])],order:'title',scope:`branch-agents:${request.params.id}`,generationKeys:['agents','conversations','projects'],hydrate:id=>{const agent=store.getAgent(id);if(!agent)return undefined;const chat=store.getConversation(agent.conversationId),manager=agent.managerAgentId?store.getAgent(agent.managerAgentId):undefined;return {...agent,chatTitle:chat?.title??'Branch Chat',...(manager?{managerTitle:manager.title}:{}),hasTeam:Boolean(hasTeam.get(id,agent.conversationId))} satisfies import('@ponderosa/core').BranchAgentChoiceDto},
      });
      applyCollectionPageHeaders(reply,page);return page.items;
    }catch(error){return sendCollectionPageError(reply,error);}
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/execution-budget',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    try{return branches.executionBudget(request.params.id)}catch(error){return reply.code(409).send({error:(error as Error).message})}
  });
  app.get<{Params:{id:string};Querystring:{from?:string;to?:string}}>('/api/branches/:id/usage',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    try{return store.getTokenUsage({type:'branch',id:request.params.id,productScope:'branches'},parseTokenUsageRange(request.query));}
    catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid usage range'});}
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
    return {sourceDiagnostics:context.workspace.listNotificationPage({limit:10,include:item=>Boolean(item.dedupeKey?.startsWith('branch-source:')) &&
      (item.branchId===id||item.dedupeKey?.startsWith('branch-source:poller:schedule_polling')===true)}).items.map(({id,title,body,createdAt})=>({id,title,body,createdAt})),
      deleting:Boolean(row.deleting),runCounts:readBranchRunCounts(store.sqlite,[id]).get(id)!,chats:(store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_id=?').get(id) as {n:number}).n,
      activeExecutions:(store.sqlite.prepare("SELECT COUNT(*) n FROM branch_executions WHERE branch_id=? AND state IN ('queued','running','waiting')").get(id) as {n:number}).n,
      callers:store.sqlite.prepare('SELECT DISTINCT b.id,b.name FROM branch_dependencies d JOIN branches b ON b.id=d.branch_id WHERE d.target_branch_id=? AND d.branch_id!=?').all(id,id) as Array<{id:string;name:string}>,
      pendingRemoval:store.sqlite.prepare("SELECT r.local_id id,CASE WHEN r.agent_ref='' THEN 'Chat' ELSE 'Agent' END kind,e.error FROM branch_installation_resources r LEFT JOIN branch_retirement_errors e ON e.resource_id=r.local_id WHERE r.branch_id=? AND r.state='retiring'").all(id) as Array<{id:string;kind:'Chat'|'Agent';error?:string}>,
      updates:store.sqlite.prepare("SELECT id,error FROM branch_installation_plans WHERE branch_id=? AND state IN ('applying','canceling')").all(id) as Array<{id:string;error?:string}>} satisfies import('@ponderosa/core').BranchLifecycleDto;
  });
  app.get<{Params:{id:string}}>('/api/branches/:id/dependencies',async request=>({
    calls:store.sqlite.prepare('SELECT target_branch_id id,ref FROM branch_dependencies WHERE branch_id=?').all(request.params.id),
    callers:store.sqlite.prepare('SELECT branch_id id,ref FROM branch_dependencies WHERE target_branch_id=?').all(request.params.id),
  }));
  app.get<{ Querystring: { chatId?: string;cursor?:string;before?:string;search?:string;section?:string } }>('/api/branches', async(request,reply)=>{
    if(Object.values(request.query).some(value=>typeof value!=='string'))return reply.code(400).send({error:'Workflow query values must be strings'});
    if(request.query.before!==undefined)return reply.code(400).send({error:'Workflow pagination changed. Reload the application.'});
    if(request.query.section!==undefined&&request.query.section!=='organized')return reply.code(400).send({error:'Invalid workflow section'});
    const preferences=context.preferences?.(),organized=request.query.section==='organized';
    const ids=organized?[...new Set([
      ...(preferences?.starredResourceIds??[]).filter(id=>id.startsWith('branch:')).map(id=>id.slice(7)),
      ...(preferences?.branchFolders??[]).flatMap(folder=>folder.branchIds),
    ])].sort():undefined;
    const sort=preferences?.branchSort??'last_used',search=(request.query.search??'').trim().slice(0,240);
    const recency=context.workspace.resourceRecencySnapshot('branch');
    const scope=createHash('sha256').update(stableJson({product:'branches',chatId:request.query.chatId??'',search,ids,sort,order:preferences?.branchOrder??[]})).digest('base64url');
    const collection=branches.branchDirectoryRevision(request.query.chatId,search,ids);
    const revision=sqliteCollectionGeneration(store.sqlite,[])+':'+collection.revision+(sort==='last_used'?':'+recency.revision:'');
    try {
      let before:string|undefined;
      if(request.query.cursor){
        if(organized||request.query.cursor.length>2048)throw new Error('Invalid workflow cursor');
        const cursor=JSON.parse(Buffer.from(request.query.cursor,'base64url').toString('utf8'));
        if(cursor?.v!==1||cursor.scope!==scope||typeof cursor.revision!=='string'||typeof cursor.before!=='string'||!cursor.before||cursor.before.length>200)throw new Error('Invalid workflow cursor');
        if(cursor.revision!==revision)throw new StaleCollectionCursorError();
        before=cursor.before;
      }
      const rows=branches.listBranches(request.query.chatId,before,search,{ids,sort,order:preferences?.branchOrder,recency:recency.json,completeOrganized:organized,limit:101});
      const hasMore=!organized&&rows.length>100,items=organized?rows:rows.slice(0,100);
      applyCollectionPageHeaders(reply,{items,total:collection.total,limit:organized?items.length:100,hasMore,...(hasMore?{cursor:Buffer.from(JSON.stringify({v:1,scope,revision,before:items.at(-1)!.id})).toString('base64url')}:{})});
      return items;
    } catch(error){return sendCollectionPageError(reply,error,'Invalid workflow cursor');}
  });
  app.get<{Querystring:{activeCursor?:string;outcomeCursor?:string;attentionCursor?:string}}>('/api/branches/home',async(request,reply)=>{
    const decode=(value:string|undefined,section:string):{at:string;id:string}|undefined=>{
      if(value===undefined)return undefined;
      if(!value||value.length>512)throw new Error('Invalid Home cursor');
      const cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
      if(!cursor||cursor.version!==1||cursor.product!=='branches'||cursor.section!==section||typeof cursor.at!=='string'||!cursor.at||cursor.at.length>64||typeof cursor.id!=='string'||!cursor.id||cursor.id.length>200)throw new Error('Invalid Home cursor');
      return {at:cursor.at,id:cursor.id};
    };
    const encode=(section:string,next:{at:string;id:string}|undefined)=>next?Buffer.from(JSON.stringify({version:1,product:'branches',section,...next})).toString('base64url'):undefined;
    let activeBefore,outcomeBefore,attentionBefore;
    try{activeBefore=decode(request.query.activeCursor,'active');outcomeBefore=decode(request.query.outcomeCursor,'outcomes');attentionBefore=decode(request.query.attentionCursor,'attention');}
    catch{return reply.code(400).send({error:'Invalid Home cursor'});}
    const executions=branches.homeExecutions({activeBefore,outcomeBefore});
    const attention=workspaceNotificationPage(context,'branches',{limit:6,kind:'attention',...(attentionBefore?{before:{createdAt:attentionBefore.at,id:attentionBefore.id}}:{})});
    const providers=new Map<string,Promise<ProviderIntakeStatus|undefined>>();
    const providerStatus=(id:string)=>{
      if(!providers.has(id))providers.set(id,Promise.resolve().then(()=>context.providerStatus?.(id)));
      return providers.get(id)!;
    };
    const project=async(items:typeof executions.activeExecutions.items)=>Promise.all(items.map(async({budgetWait,...item})=>{
      const summary=await branchOperationalSummary(store.sqlite,{id:item.id,state:item.state,...(budgetWait?{budgetWait}:{})},providerStatus,false);
      return {...item,operational:{state:summary.state,label:summary.label}};
    }));
    const branchIds=[...new Set(attention.items.flatMap(item=>item.branchId?[item.branchId]:[]))];
    const names=store.sqlite.prepare('SELECT id,name FROM branches WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(branchIds)) as Array<{id:string;name:string}>;
    return {observedAt:new Date().toISOString(),workflowCount:executions.workflowCount,activeExecutionCount:executions.activeExecutionCount,openActionCount:attention.openActionCount,
      activeExecutions:{items:await project(executions.activeExecutions.items),nextCursor:encode('active',executions.activeExecutions.next)},
      recentOutcomes:{items:await project(executions.recentOutcomes.items),nextCursor:encode('outcomes',executions.recentOutcomes.next)},
      attention:{items:attention.items,nextCursor:encode('attention',attention.nextCursor?{at:attention.nextCursor.createdAt,id:attention.nextCursor.id}:undefined)},
      branchNames:Object.fromEntries(names.map(row=>[row.id,row.name])),
    } satisfies BranchHomeDto;
  });
  app.get<{Querystring:{search?:string}}>('/api/branches/contexts',async request=>{
    const search=(request.query.search??'').trim().slice(0,200);
    const rows=store.sqlite.prepare(`SELECT c.id FROM conversations c WHERE ${activeChatProductSql('c','branches')} AND c.branch_execution_id IS NULL AND (?='' OR instr(lower(c.title),lower(?))>0) ORDER BY c.updated_at DESC LIMIT 100`).all(search,search) as Array<{id:string}>;
    return rows.flatMap(({id})=>{const chat=store.getConversation(id),context=store.getChatContext(id);return chat&&context?[{...chat,workingDirectory:context.hostPath,defaultEngine:context.defaultEngine}]:[]});
  });
  app.get<{Params:{id:string}}>('/api/branches/contexts/:id',async(request,reply)=>{
    const owner=activeChatResourceOwner(store,'chat',request.params.id);
    const chat=owner?.branchId?store.getConversation(request.params.id):undefined,binding=chat?store.getChatContext(request.params.id):undefined;
    return chat?.branchId&&binding?{...chat,workingDirectory:binding.hostPath,defaultEngine:binding.defaultEngine}:reply.code(404).send({error:'Chat not found'});
  });
  app.get<{Params:{id:string}}>('/api/branches/:id',async(request,reply)=>branches.getBranch(request.params.id)??reply.code(404).send({error:'Branch not found'}));
  app.get<{Params:{id:string}}>('/api/branches/:id/trigger',async(request,reply)=>branches.trigger(request.params.id)??reply.code(404).send({error:'Trigger not found'}));
  app.get<{Params:{id:string};Querystring:{limit?:string;before?:string}}>('/api/branches/:id/trigger/occurrences',async(request,reply)=>{
    if(!branches.getBranch(request.params.id))return reply.code(404).send({error:'Branch not found'});
    const limit=Number(request.query.limit??50);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)return reply.code(400).send({error:'limit must be between 1 and 100'});
    const before=request.query.before;
    const boundary=before&&before.length<=200?store.sqlite.prepare('SELECT occurrence.created_at FROM trigger_occurrences occurrence JOIN trigger_definitions owner ON owner.id=occurrence.trigger_id WHERE occurrence.id=? AND owner.branch_id=?').get(before,request.params.id) as {created_at:string}|undefined:undefined;
    if(before&&!boundary)return reply.code(400).send({error:'Invalid trigger occurrence cursor'});
    const rows=store.sqlite.prepare(`SELECT occurrence.id FROM trigger_occurrences occurrence JOIN trigger_definitions owner ON owner.id=occurrence.trigger_id WHERE owner.branch_id=? ${boundary?'AND (occurrence.created_at<? OR (occurrence.created_at=? AND occurrence.id<?))':''} ORDER BY occurrence.created_at DESC,occurrence.id DESC LIMIT ?`).all(request.params.id,...(boundary?[boundary.created_at,boundary.created_at,before]:[]),limit) as Array<{id:string}>;
    return rows.map(row=>branches.triggers.getTriggerOccurrence(row.id)!);
  });
  app.patch<{Params:{id:string};Body:unknown}>('/api/branches/:id/trigger',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Branch trigger');exactObjectFields(body,['enabled','reviewedTrigger'],'Branch trigger');
      if(typeof body.enabled!=='boolean'||!body.reviewedTrigger)throw new Error('An enabled switch and reviewed trigger snapshot are required');
      assertEditable(request.params.id);
      const current=branches.trigger(request.params.id);if(!current)return reply.code(404).send({error:'Trigger not found'});
      if(stableJson(current)!==stableJson(body.reviewedTrigger))return reply.code(409).send({error:'Branch trigger changed; refresh before editing intake'});
      const normalized=body.enabled&&!current.enabled?normalizeTriggerSourceConfig(current.sourceKind,current.sourceConfig):undefined;
      const trigger=branches.triggers.updateTriggerDefinition(current.id,{enabled:body.enabled,...(normalized?{sourceConfig:normalized.config,nextFireAt:normalized.nextFireAt??null}:{})});
      await sources.applyDefinitionChange(current,trigger);await sources.refresh();notify();return trigger;
    }catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid Branch trigger switch'});}
  });
  // Webhooks share the ordinary Origin and request admission checks.
  app.post<{Params:{id:string};Body:unknown}>('/api/trigger-webhooks/:id',{bodyLimit:1024*1024},async(request,reply)=>{
    if(!request.headers['content-type']?.split(';')[0]?.trim().match(/^application\/json$/i))return reply.code(415).send({error:'Branch webhooks require application/json'});
    const eventId=request.headers['x-ponderosa-event-id'];
    try{
      const result=sources.verifyAndRecordWebhook({triggerId:request.params.id,eventId:typeof eventId==='string'?eventId:'',payload:request.body,remoteAddress:request.ip});
      return reply.code(result.replayed?200:202).send(result);
    }catch(error){const message=error instanceof Error?error.message:'Webhook rejected';return reply.code(message.includes('idempotency conflict')?409:message.includes('unavailable')?503:message.includes('not found')?404:400).send({error:message});}
  });
  app.post<{ Body: DeployBranchRequest }>('/api/branches/preview', async (request, reply) => {
    try {
      validateLocal(request.body);
      return branches.preview(request.body);
    }catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid deployment preview',...(error instanceof BranchValidationError?{issues:[error.issue]}:{})})}
  });
  app.post<{Body:unknown}>('/api/branches/import-preview',{bodyLimit:AGENT_PACKAGE_MAX_BYTES+AGENT_PACKAGE_METADATA_MAX_BYTES+1},async(request,reply)=>{
    try{return request.body&&typeof request.body==='object'&&'schema'in request.body&&request.body.schema==='ponderosa.branch-installation.v1'?context.installations.validate(request.body):importBranchPackage(request.body)}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Invalid package'})}
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
      const trigger=validateLocal(input);
      const currentTrigger=input.branchId?branches.trigger(input.branchId):undefined;
      const result = branches.deploy(input, new Date().toISOString(), trigger);
      await sources.applyDefinitionChange(currentTrigger,branches.trigger(result.id));
      notify();
      return result;
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid Branch deployment', ...(error instanceof BranchValidationError?{issues:[error.issue]}:{}) }); }
  });
  app.post<{ Params: { id: string }; Body: { occurrenceKey: string; input: string } }>('/api/branches/:id/executions', async (request, reply) => {
    try { const execution = branches.accept(request.params.id, request.body.occurrenceKey, request.body.input); notify(); return execution; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid Branch input' }); }
  });
  app.post<{Params:{id:string;executionId:string}}>('/api/branches/:id/executions/:executionId/initial-checkpoint',async(request,reply)=>{
    try{
      const body=validatedObject(request.body??{},'Initial checkpoint');exactObjectFields(body,[],'Initial checkpoint');
      return branches.saveInitialCheckpoint(request.params.id,request.params.executionId);
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Initial checkpoint capture failed'});}
  });
  app.get<{Params:{id:string;executionId:string}}>('/api/branches/:id/executions/:executionId/initial-checkpoint',async(request,reply)=>{
    try{return branches.initialCheckpoint(request.params.id,request.params.executionId)??reply.code(404).send({error:'Initial checkpoint not found'});}
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Invalid initial checkpoint'});}
  });
  app.post<{Params:{id:string;executionId:string};Body:{checkpointId:number;expectedHash:string;commandKey:string}}>('/api/branches/:id/executions/:executionId/rewind-initial',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Initial rewind');exactObjectFields(body,['checkpointId','expectedHash','commandKey'],'Initial rewind');
      if(typeof body.checkpointId!=='number'||typeof body.expectedHash!=='string'||typeof body.commandKey!=='string')throw new Error('Invalid initial rewind command');
      const result=branches.rewindInitial(request.params.id,request.params.executionId,body.checkpointId,body.expectedHash,body.commandKey);notify();return result;
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Initial rewind failed'});}
  });
  app.post<{Params:{id:string;executionId:string};Body:unknown}>('/api/branches/:id/executions/:executionId/checkpoint-interruption',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Checkpoint interruption');exactObjectFields(body,['action','expectedId','commandKey'],'Checkpoint interruption');
      if(!['interrupt','resume'].includes(String(body.action))||typeof body.expectedId!=='string'||typeof body.commandKey!=='string')throw Error('Invalid checkpoint interruption command');
      const result=branches.checkpointInterruption(request.params.id,request.params.executionId,body.action as 'interrupt'|'resume',body.expectedId,body.commandKey);notify();return result;
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Checkpoint interruption failed'});}
  });
  app.get<{Params:{id:string;executionId:string};Querystring:{before?:string}}>('/api/branches/:id/executions/:executionId/historical-checkpoints',async(request,reply)=>{
    try{return branches.historicalCheckpoints(request.params.id,request.params.executionId,request.query.before===undefined?undefined:Number(request.query.before));}
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Historical checkpoints unavailable'});}
  });
  app.post<{Params:{id:string;executionId:string};Body:unknown}>('/api/branches/:id/executions/:executionId/host-graph-review',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Host graph review');exactObjectFields(body,['checkpointId','expectedHash'],'Host graph review');
      if(typeof body.checkpointId!=='number'||typeof body.expectedHash!=='string')throw Error('Invalid host graph selection');
      return branches.reviewHostGraph(request.params.id,request.params.executionId,{checkpointId:body.checkpointId,expectedHash:body.expectedHash},hostArtifactGrant);
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Host graph review unavailable'});}
  });
  app.post<{Params:{id:string;executionId:string};Body:unknown}>('/api/branches/:id/executions/:executionId/restore-host-graph',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Host graph restore');exactObjectFields(body,['checkpointId','expectedHash','reviewHash','commandKey','reconcileEffects'],'Host graph restore');
      if(typeof body.checkpointId!=='number'||typeof body.expectedHash!=='string'||typeof body.reviewHash!=='string'||typeof body.commandKey!=='string'||body.reconcileEffects!==true)throw Error('Invalid reviewed graph reconciliation');
      const result=branches.restoreHostGraph(request.params.id,request.params.executionId,body as unknown as import('@ponderosa/core').BranchHostGraphRestoreInput,hostArtifactGrant);notify();return result;
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Host graph restoration refused'});}
  });
  app.post<{Params:{id:string;executionId:string};Body:unknown}>('/api/branches/:id/executions/:executionId/host-request-review',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Host Request review');exactObjectFields(body,['checkpointId','expectedHash','requestId'],'Host Request review');
      if(typeof body.checkpointId!=='number'||typeof body.expectedHash!=='string'||typeof body.requestId!=='string')throw Error('Invalid host Request selection');
      return branches.reviewHostRequest(request.params.id,request.params.executionId,{checkpointId:body.checkpointId,expectedHash:body.expectedHash,requestId:body.requestId},hostArtifactGrant);
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Host Request review unavailable'});}
  });
  app.post<{Params:{id:string;executionId:string};Body:unknown}>('/api/branches/:id/executions/:executionId/adopt-host-request',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Host Request adoption');exactObjectFields(body,['checkpointId','expectedHash','requestId','reviewHash','commandKey','instruction','mode','acknowledgeChangedBindings','acknowledgeSecretBindings'],'Host Request adoption');
      if(typeof body.checkpointId!=='number'||typeof body.expectedHash!=='string'||typeof body.requestId!=='string'||typeof body.reviewHash!=='string'||typeof body.commandKey!=='string'||typeof body.instruction!=='string'||!['reconcile','independent'].includes(String(body.mode)))throw Error('Invalid host Request adoption');
      for(const key of ['acknowledgeChangedBindings','acknowledgeSecretBindings'])if(body[key]!==undefined&&typeof body[key]!=='boolean')throw Error('Invalid authority acknowledgement');
      const result=branches.adoptHostRequest(request.params.id,request.params.executionId,body as unknown as import('@ponderosa/core').BranchHostRequestAdoption,hostArtifactGrant);notify();return result;
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Host Request adoption refused'});}
  });
  const ownedResource=(branchId:string,executionId:string,stepId:string)=>{
    if(!store.sqlite.prepare('SELECT 1 FROM branch_resources r JOIN branch_executions e ON e.id=r.execution_id WHERE r.step_execution_id=? AND e.id=? AND e.branch_id=?').get(stepId,executionId,branchId))throw Error('Resource owner unavailable');
  };
  app.get<{Params:{id:string;executionId:string;stepId:string};Querystring:{commandKey:string}}>('/api/branches/:id/executions/:executionId/resources/:stepId/issued-checkpoint',async(request,reply)=>{
    try{const p=request.params;ownedResource(p.id,p.executionId,p.stepId);if(typeof request.query.commandKey!=='string'||!request.query.commandKey.trim()||request.query.commandKey.length>200)throw Error('Capture command key required');return context.resources.issuedResourceCaptureStatus(p.executionId,p.stepId,request.query.commandKey);}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:{id:string;executionId:string;stepId:string};Body:import('@ponderosa/core').BranchIssuedResourceCaptureInput}>('/api/branches/:id/executions/:executionId/resources/:stepId/issued-checkpoint',async(request,reply)=>{
    try{const p=request.params;ownedResource(p.id,p.executionId,p.stepId);const body=validatedObject(request.body,'Issued capture');exactObjectFields(body,['commandKey','expectedGeneration'],'Issued capture');
      if(typeof body.commandKey!=='string'||typeof body.expectedGeneration!=='number')throw Error('Exact issued capture identity required');
      return await context.resources.captureIssuedResource(p.executionId,p.stepId,body.expectedGeneration,body.commandKey);
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:{id:string;executionId:string;stepId:string}}>('/api/branches/:id/executions/:executionId/resources/:stepId',async(request,reply)=>{
    try{const p=request.params;ownedResource(p.id,p.executionId,p.stepId);return await context.resources.inspectResource(p.stepId);}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:{id:string;executionId:string;stepId:string};Querystring:{commandKey:string}}>('/api/branches/:id/executions/:executionId/resources/:stepId/checkpoint-custody',async(request,reply)=>{
    try{const p=request.params;ownedResource(p.id,p.executionId,p.stepId);return branches.resourceCustodyReleaseStatus(p.stepId,request.query.commandKey);}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:{id:string;executionId:string;stepId:string}}>('/api/branches/:id/executions/:executionId/resources/:stepId/access-review',async(request,reply)=>{
    try{const p=request.params;ownedResource(p.id,p.executionId,p.stepId);return await context.resources.reviewRestoreAccess(p.stepId);}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:{id:string;executionId:string;stepId:string};Body:NonNullable<import('@ponderosa/core').ImportAgentPackageRequest['accessSettingsResolution']>}>('/api/branches/:id/executions/:executionId/resources/:stepId/access-review',async(request,reply)=>{
    try{const p=request.params;ownedResource(p.id,p.executionId,p.stepId);if(!request.body||typeof request.body.reviewSha256!=='string'||!['keep_destination','use_source'].includes(request.body.action))throw Error('Explicit current destination access choice required');const result=await context.resources.reviewRestoreAccess(p.stepId,request.body);notify();return result;}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.delete<{Params:{id:string;executionId:string;stepId:string};Body:import('@ponderosa/core').BranchResourceCustodyReleaseInput}>('/api/branches/:id/executions/:executionId/resources/:stepId/checkpoint-custody',async(request,reply)=>{
    try{const p=request.params;ownedResource(p.id,p.executionId,p.stepId);const body=validatedObject(request.body,'Resource custody release');exactObjectFields(body,['commandKey','expectedGeneration','expectedCustodyId','expectedReceiptSha256'],'Resource custody release');return await context.resources.releaseCapture(p.stepId,body as unknown as import('@ponderosa/core').BranchResourceCustodyReleaseInput);}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:{id:string;executionId:string};Body:import('@ponderosa/core').BranchHistoricalRewindInput}>('/api/branches/:id/executions/:executionId/rewind-historical',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'Historical rewind');exactObjectFields(body,['checkpointId','expectedHash','commandKey','graphReview'],'Historical rewind');
      if(typeof body.checkpointId!=='number'||typeof body.expectedHash!=='string'||typeof body.commandKey!=='string')throw Error('Invalid historical rewind command');
      let graph: {reviewHash:string;reconcileEffects:true;grant:typeof hostArtifactGrant}|undefined;
      if(body.graphReview!==undefined){
        const review=validatedObject(body.graphReview,'Historical graph review');exactObjectFields(review,['reviewHash','reconcileEffects'],'Historical graph review');
        if(typeof review.reviewHash!=='string'||review.reconcileEffects!==true)throw Error('Invalid historical graph review');
        graph={reviewHash:review.reviewHash,reconcileEffects:true,grant:hostArtifactGrant};
      }
      await context.resources.verifyHistoricalCustody(request.params.executionId,body.checkpointId,body.expectedHash);
      const result=branches.rewindHistorical(request.params.id,request.params.executionId,body.checkpointId,body.expectedHash,body.commandKey,undefined,graph);notify();return result;
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Historical rewind failed'});}
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
  app.get<{ Params: { id: string }; Querystring: { before?: string; state?: string; mergeFor?:string } }>('/api/branches/:id/executions', async (request, reply) => {
    try { return branches.listExecutions(request.params.id, request.query.before, request.query.state,request.query.mergeFor); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid history cursor' }); }
  });
  app.get<{ Params: { id: string } }>("/api/branch-executions/:id/operations", async (request, reply) => {
    const execution=branches.execution(request.params.id);
    return execution?branchOperationalSummary(store.sqlite,execution,context.providerStatus):reply.code(404).send({error:"Execution not found"});
  });
  app.get<{Params:{id:string};Querystring:{cursor?:string}}>('/api/branch-executions/:id/actions',async(request,reply)=>{
    try{const page=branches.currentActions(request.params.id,request.query.cursor,context.workspace);return page?previewBranchExecutionActions(page):reply.code(404).send({error:'Branch execution not found'});}
    catch(error){const message=error instanceof Error?error.message:'Invalid execution actions cursor';return reply.code(message==='Execution actions changed; reload current actions'?409:400).send({error:message});}
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
