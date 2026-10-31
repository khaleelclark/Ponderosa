import type {OutputAgentApps} from '../output-agent-apps.js';
import type {BranchInstallationService} from '../branch-installation-service.js';
import type {ChatCreator} from './projects.js';
import { normalizeTriggerSourceConfig, type BranchTriggerSourceService } from '../branch-trigger-service.js';
import { triggerSourceConfig } from '../branch-trigger-config.js';
import { realpathSync, statSync } from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {validatedObject,exactObjectFields} from '../object-validation.js';
import { readBranchRunCounts, workspaceRecencyCte, exportBranchPackage, importBranchPackage, stableJson, validateBranchDefinition, validateBranchBindings, validateBranchConfiguration, resolveBranchParameterReferences, interpolateBranchText, type AgentStore, type BranchStore, type WorkspaceStore } from '@ponderosa/agents';
import { BranchValidationError, AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_METADATA_MAX_BYTES,type BranchGateResolution, type BranchHomeDto, type BranchIntervention, type DeployBranchRequest, type WorkspacePreferencesDto } from '@ponderosa/core';
import {activeChatResourceOwner} from '../branch-resource-owner.js';
import {previewBranchExecutionActions,previewBranchExecutionDetail} from '../branch-detail-preview.js';
import {branchOperationalSummary, type ProviderIntakeStatus} from '../branch-operations.js';
import {activeChatProductSql,activeAgentProductSql} from '@ponderosa/agents';
import {sqliteCollectionGeneration,StaleCollectionCursorError,sqliteCollectionPage,applyCollectionPageHeaders,sendCollectionPageError,type CollectionQuery} from '../collection-page.js';
import {parseTokenUsageRange} from '../token-usage.js';
import {workspaceNotificationPage} from './notifications.js';

export function registerBranchRoutes(app: FastifyInstance, context: { outputApps:OutputAgentApps; branches: BranchStore; installations:BranchInstallationService; store: AgentStore; workspace:WorkspaceStore; sources: BranchTriggerSourceService;createChat:ChatCreator; engineAvailable?(id:string):boolean; providerStatus?(id:string):Promise<ProviderIntakeStatus|undefined>; preferences?():WorkspacePreferencesDto; notify(): void }): void {
  const { branches, store, sources, notify } = context;
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
  app.get('/api/branches/assistant',async()=>context.outputApps.status());
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
  app.put<{Params:{id:string};Body:{expectedVersionId:string;automatic:boolean;everyMs:number}}>('/api/branches/output-apps/:id/schedule',async(request,reply)=>{
    try{
      const body=validatedObject(request.body,'output settings');exactObjectFields(body,['expectedVersionId','automatic','everyMs'],'schedule settings');
      if(typeof body.expectedVersionId!=='string'||typeof body.automatic!=='boolean'||(typeof body.everyMs!=='number'||!Number.isInteger(body.everyMs)))throw new Error('Invalid schedule settings');
      const output=context.outputApps.get(request.params.id),branch=branches.getBranch(output.branchId)!;assertEditable(branch.id);
      if(body.expectedVersionId!==branch.versionId)throw new Error('Workflow changed. Reload settings.');
      const version=branches.version(branch.id,branch.versionId);if(!version)throw new Error('Publish this workflow before changing its schedule');
      if(version.definition.trigger.kind!=='manual'&&version.definition.trigger.kind!=='schedule')throw new Error('Open More options to change an event-triggered workflow');
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
  app.post<{Body:{package:unknown;bindings:import('@ponderosa/core').BranchBindings;branchId?:string}}>('/api/branches/install-preview',{bodyLimit:AGENT_PACKAGE_MAX_BYTES+AGENT_PACKAGE_METADATA_MAX_BYTES+1},async(request,reply)=>{
    try{return context.installations.preview(request.body.package,request.body.bindings,request.body.branchId)}catch(error){return reply.code(400).send({error:(error as Error).message})}
  });
  app.post<{Params:{id:string}}>('/api/branches/installations/:id/role-review',async(request,reply)=>{try{return context.installations.reviewPublishedRoles(request.params.id);}catch(error){return reply.code(409).send({error:(error as Error).message});}});
  app.post<{Params:{id:string};Body?:{acknowledgeFullImport?:boolean;outputRoleReviewId?:string}}>('/api/branches/installations/:id/confirm',async(request,reply)=>{
    try{const body=request.body??{};if(typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['acknowledgeFullImport','outputRoleReviewId'].includes(key))||(body.outputRoleReviewId!==undefined&&typeof body.outputRoleReviewId!=='string')||(body.acknowledgeFullImport!==undefined&&typeof body.acknowledgeFullImport!=='boolean'))throw new Error('Invalid installation confirmation');const result=await context.installations.confirm(request.params.id,body.acknowledgeFullImport===true,body.outputRoleReviewId);await sources.refresh();notify();return result}catch(error){return reply.code(409).send({error:(error as Error).message})}
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
