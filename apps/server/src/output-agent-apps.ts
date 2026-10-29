import {randomUUID} from 'node:crypto';
import {stableJson} from '@ponderosa/agents';
import type {PortableOutputRoleDto,OutputRoleImportReviewDto} from '@ponderosa/core';
import type {AgentStore,BranchStore,WorkspaceStore} from '@ponderosa/agents';
import type {AssistantStatusDto,OutputAgentAppDto,AgentPortablePackageDto} from '@ponderosa/core';
import type {ChatCreator} from './routes/projects.js';
import type {BranchPackageEngine} from './routes/agent-packages.js';
import {normalizeTriggerSourceConfig} from './branch-trigger-service.js';

class OutputAppUnavailableError extends Error {}

/** Local roles live in the existing canonical workspace journal; Agent imports carry no role authority. */
export class OutputAgentApps {
  private pending?:Promise<AssistantStatusDto>;
  constructor(private store:AgentStore,private branches:BranchStore,private workspace:WorkspaceStore,
    private createChat:ChatCreator,private packageEngine:BranchPackageEngine,private engine:()=>string|undefined,private publishSince?:(cursor:number)=>void){}
  private roles(){return this.workspace.getPreferences().outputApps??{agentIds:[],speakerAgentId:null,initialized:false};}
  private write(patch:Partial<NonNullable<ReturnType<WorkspaceStore['getPreferences']>['outputApps']>>){
    const cursor=this.workspace.cursor();
    this.workspace.updatePreferences({outputApps:{...this.roles(),...patch,...(!Object.keys(patch).every(key=>key==='importReviews')?{roleEpoch:(this.roles().roleEpoch??0)+1}:{})}});
    try{this.publishSince?.(cursor);}catch{/* Journal success is durable; notification is recoverable. */}
  }
  portableRoles(ids:string[]):PortableOutputRoleDto[]{
    const roles=this.roles();return ids.filter(id=>roles.agentIds.includes(id)).flatMap(id=>{try{this.owner(id);return [{ref:id,output:true,speaker:roles.speakerAgentId===id}];}catch(error){if(!(error instanceof OutputAppUnavailableError))throw error;return [];}});
  }
  private roleState(){return stableJson({epoch:this.roles().roleEpoch??0,speaker:this.status().app?.agentId??null,setup:this.roles().setup?.key??null});}
  reviewImport(targets:PortableOutputRoleDto[],binding:string,eligible:boolean,mapping:Record<string,string>={},keepInactive=false):OutputRoleImportReviewDto {
    const reviews={...this.roles().importReviews};
    for(const [key,value]of Object.entries(reviews)){
      const creation=value.operationId?this.store.getAgentCreationOperation(value.operationId):undefined;
      const plan=value.operationId?this.store.sqlite.prepare('SELECT state FROM branch_installation_plans WHERE id=?').get(value.operationId) as {state:string}|undefined:undefined;
      if((!value.operationId&&Date.parse(value.createdAt)<Date.now()-86400000)||creation?.status==='rolled_back'||(creation?.status==='completed'&&(creation.result as {outputRoleFinalization?:{done?:boolean}}|undefined)?.outputRoleFinalization?.done)||(plan&&(['canceled','expired','review_required'].includes(plan.state)||(plan.state==='completed'&&value.applied))))delete reviews[key];
    }
    if(Object.keys(reviews).length>=64)throw new Error('Too many pending output-role reviews; finish existing imports');
    const current=this.status().app?.agentId,proposed=targets.find(t=>t.speaker),same=proposed&&mapping[proposed.ref]===current;
    const collision=Boolean(proposed&&current&&!same),pending=Boolean(proposed&&this.roles().setup&&!same),inactive=!eligible||collision||pending||keepInactive;
    const warning=[collision?'You already have a Ponderosa speaker. The imported speaker will be disabled.':undefined,!eligible?'Output and speaker roles remain inactive in this Core Chat.':undefined,pending?'Assistant setup is pending. The imported speaker will be disabled.':undefined,keepInactive&&!collision&&!pending?'The previously reviewed imported speaker remains disabled.':undefined].filter(Boolean).join(' ')||undefined;
    const review:OutputRoleImportReviewDto={id:randomUUID(),warning,inactive,speaker:proposed?(inactive?'inactive':'activate'):'unchanged',targets};
    reviews[review.id]={binding,state:this.roleState(),targetEpochs:Object.fromEntries(targets.map(target=>[target.ref,this.roles().agentEpochs?.[mapping[target.ref]??'']??0])),eligible,createdAt:new Date().toISOString(),review};this.write({importReviews:reviews});return review;
  }
  checkImport(id:string,binding:string,operationId?:string){
    const entry=this.roles().importReviews?.[id];
    if(!entry||entry.binding!==binding||(entry.operationId&&entry.operationId!==operationId))throw Object.assign(new Error('Output role review changed; review the package again'),{statusCode:409});
    if(!entry.applied&&entry.review.speaker!=='inactive'&&entry.state!==this.roleState())throw Object.assign(new Error('Ponderosa speaker state changed; review the package again'),{statusCode:409});
    return entry;
  }
  reReviewImport(id:string,binding:string,operationId:string,mapping:Record<string,string>){
    const old=this.roles().importReviews?.[id];if(!old||old.binding!==binding||old.operationId!==operationId||old.applied)throw new Error('Import does not need a new role review');
    return this.reviewImport(old.review.targets,binding,old.eligible,mapping,old.review.speaker==='inactive');
  }
  abandonReview(id:string){const entry=this.roles().importReviews?.[id];if(!entry||entry.applied)return;const reviews={...this.roles().importReviews};delete reviews[id];this.write({importReviews:reviews});}
  claimImport(id:string,binding:string,operationId:string){const entry=this.checkImport(id,binding,operationId);if(!entry.operationId)this.write({importReviews:{...this.roles().importReviews,[id]:{...entry,operationId}}});}
  finalizeImport(id:string,binding:string,operationId:string,mapping:Record<string,string>){
    const entry=this.checkImport(id,binding,operationId);if(entry.applied)return;
    if(entry.operationId!==operationId)throw new Error('Output role import is not durably claimed');
    const roles=this.roles(),ids=new Set(roles.agentIds);let speaker=roles.speakerAgentId;
    if(entry.eligible)for(const target of entry.review.targets){
      const local=mapping[target.ref];if((roles.agentEpochs?.[local??'']??0)!==(entry.targetEpochs[target.ref]??0))throw Object.assign(new Error('An imported output designation changed; review the roles again'),{statusCode:409});
    }
    const agentEpochs={...roles.agentEpochs};
    if(entry.eligible)for(const target of entry.review.targets){
      const local=mapping[target.ref];if(!local)throw new Error('Imported output role mapping is incomplete');this.owner(local);
      agentEpochs[local]=(agentEpochs[local]??0)+1;
      if(target.output)ids.add(local);else ids.delete(local);
      if(speaker===local&&!target.speaker){this.pause(this.get(local));speaker=null;}
      if(target.speaker&&entry.review.speaker==='activate'){
        const current=this.status().app?.agentId;if(current&&current!==local)throw Object.assign(new Error('Ponderosa speaker changed; review the package again'),{statusCode:409});speaker=local;
      }
    }
    // Pin the report cursor once before the journal boundary; retry never resets it.
    this.initializeReportScan(speaker);
    // Role effects and applied marker share ONE journal append, never a SQLite callback.
    this.write({agentIds:[...ids],agentEpochs,speakerAgentId:speaker,initialized:speaker?true:roles.initialized,importReviews:{...roles.importReviews,[id]:{...entry,applied:true}}});
  }
  finishImport(id:string){const entry=this.roles().importReviews?.[id];if(!entry?.applied)return;const reviews={...this.roles().importReviews};delete reviews[id];this.write({importReviews:reviews});}
  private initializeReportScan(id:string|null){if(id)this.store.sqlite.prepare('INSERT OR IGNORE INTO assistant_report_scan(speaker_agent_id,after_sequence) SELECT ?,COALESCE(MAX(sequence),0) FROM assistant_status_sources').run(id);}
  private owner(id:string){
    const agent=this.store.getAgent(id),chat=agent&&this.store.getConversation(agent.conversationId??'');
    if(!agent||!chat?.branchId||chat.executionId||!this.store.sqlite.prepare('SELECT 1 FROM branches WHERE id=? AND deleting=0').get(chat.branchId)||
      this.store.sqlite.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(chat.projectId)||
      this.store.sqlite.prepare(`SELECT 1 FROM agent_deletion_pending WHERE agent_id=?`).get(id)||
      this.store.sqlite.prepare(`SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=?`).get(chat.id)||
      this.store.sqlite.prepare(`SELECT 1 FROM branch_installation_resources WHERE local_id IN (?,?) AND state!='active'`).get(id,chat.id))throw new OutputAppUnavailableError('Output Agent is unavailable');
    return {agent,chat};
  }
  get(id:string):OutputAgentAppDto{
    if(!this.roles().agentIds.includes(id))throw new OutputAppUnavailableError('Output Agent is not designated');
    const {agent,chat}=this.owner(id),branch=this.branches.getBranch(chat.branchId!)!,trigger=this.branches.trigger(branch.id);
    const config=trigger?.sourceConfig;
    return {agentId:id,branchId:branch.id,projectId:chat.projectId,chatId:chat.id,title:agent.title,url:`/apps/${encodeURIComponent(id)}`,
      speaker:this.roles().speakerAgentId===id,versionId:branch.versionId,model:agent.model??undefined,engine:agent.activeEngine,
      automatic:Boolean(trigger?.enabled&&branch.enabled),...(config&&'scheduleKind'in config&&config.scheduleKind==='interval'?{everyMs:config.everyMs}:{})};
  }
  private pause(app:OutputAgentAppDto){
    const trigger=this.branches.trigger(app.branchId);
    if(trigger)this.branches.triggers.updateTriggerDefinition(trigger.id,{enabled:false});
  }
  designate(id:string,enabled:boolean,speaker=false):OutputAgentAppDto|undefined{
    this.owner(id);
    const roles=this.roles();
    if(speaker&&!enabled)throw new Error('A speaker must be an output Agent');
    if(speaker&&roles.speakerAgentId&&roles.speakerAgentId!==id){
      let existing:OutputAgentAppDto|undefined;
      try{existing=this.get(roles.speakerAgentId);}catch(error){if(!(error instanceof OutputAppUnavailableError))throw error;}
      if(existing)throw new Error('A Ponderosa speaker already exists. Remove its speaker role first.');
    }
    if(roles.speakerAgentId===id&&!speaker)this.pause(this.get(id));
    this.write({agentEpochs:{...roles.agentEpochs,[id]:(roles.agentEpochs?.[id]??0)+1},agentIds:enabled?[...new Set([...roles.agentIds,id])]:roles.agentIds.filter(value=>value!==id),
      speakerAgentId:speaker?id:roles.speakerAgentId===id?null:roles.speakerAgentId,initialized:speaker||roles.initialized});
    if(speaker)this.initializeReportScan(id);
    return enabled?this.get(id):undefined;
  }
  status():AssistantStatusDto{
    const roles=this.roles();let app:OutputAgentAppDto|undefined;
    if(roles.speakerAgentId)try{app=this.get(roles.speakerAgentId);}catch(error){if(!(error instanceof OutputAppUnavailableError))throw error;}
    return {enabled:Boolean(app),initialized:roles.initialized,...(app?{app}:{})};
  }
  disable(){
    const roles=this.roles();let app:OutputAgentAppDto|undefined;
    if(roles.speakerAgentId)try{app=this.get(roles.speakerAgentId);}catch(error){if(!(error instanceof OutputAppUnavailableError))throw error;}
    if(app)this.pause(app);
    this.write({agentEpochs:{...roles.agentEpochs,...(roles.speakerAgentId?{[roles.speakerAgentId]:(roles.agentEpochs?.[roles.speakerAgentId]??0)+1}:{})},speakerAgentId:null,initialized:true,setup:undefined});return this.status();
  }
  initialize(force=false):Promise<AssistantStatusDto>{
    if(this.pending)return this.pending;
    if(this.status().enabled||(!force&&this.roles().initialized))return Promise.resolve(this.status());
    const operation=this.createDefault();this.pending=operation;
    return operation.finally(()=>{if(this.pending===operation)this.pending=undefined;});
  }
  private async createDefault():Promise<AssistantStatusDto>{
    let setup=this.roles().setup;
    if(!setup){
      const engine=this.engine();if(!engine)throw new Error('Choose an available provider before enabling Assistant');
      const defaults=this.workspace.getPreferences().engineDefaults?.[engine];
      const key=randomUUID(),branch=this.branches.create('Assistant',`assistant-${key}`);
      setup={key,branchId:branch.id,engine,model:defaults?.model,effort:defaults?.effort,createdAt:branch.createdAt};this.write({setup});
    }
    const {key,branchId,engine}=setup;
    const pkg:AgentPortablePackageDto={schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:setup.createdAt,sourceLabel:'Assistant',rootRef:'speaker',agents:[{
      ref:'speaker',title:'Assistant',engine,...(setup.model?{model:setup.model}:{}),...(setup.effort?{effort:setup.effort}:{}),
      initialInstructions:'You are Assistant, the user’s personal assistant in Ponderosa. Use only access granted by the human. Report completed work and issues concisely; do not repeat unchanged updates. A scheduled check is a request to inspect available project status, not permission to expand access.',
      managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
    this.packageEngine.validateAgent(pkg,{[engine]:engine});
    const chat=await this.createChat({label:'Assistant',defaultEngine:engine},`assistant-chat-${key}`,{branchId});
    const imported=await this.packageEngine.importAgent(chat.projectId,chat.id,pkg,{[engine]:engine},`assistant-agent-${key}`);
    if(this.roles().setup?.key!==key)return this.status(); // A human disabled it while provisioning.
    if(this.status().enabled){this.write({setup:undefined});return this.status();}
    const branch=this.branches.getBranch(branchId)!;
    if(!branch.versionId){
      const config={scheduleKind:'interval' as const,everyMs:600000,startsAt:new Date(Date.now()+600000).toISOString(),whenRunning:'run_latest' as const};
      const normalized=normalizeTriggerSourceConfig('schedule',config);
      this.branches.deploy({chatId:'',branchId,expectedVersionId:'',idempotencyKey:`assistant-workflow-${key}`,definition:{schema:'ponderosa.branch.v1',name:'Assistant',trigger:{kind:'schedule',configRef:'check'},entry:'speaker',steps:[{id:'speaker',kind:'agent',target:{kind:'persistent_agent',ref:'speaker'},instructions:'Call ponderosa_assistant_check to check granted Projects for explicit completed work and issues. It publishes a bounded deduplicated report through notification settings. If it reports no changes or deferred, stay quiet. Do not repeat its published digest. Complete this workflow Request with ponderosa_update_request after checking.',requireUserCommunication:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{speaker:imported.rootAgentId},directories:{},triggers:{check:{sourceConfig:config,enabled:true}}}},new Date().toISOString(),{sourceConfig:normalized.config,nextFireAt:normalized.nextFireAt});
    }
    this.designate(imported.rootAgentId,true,true);this.write({setup:undefined});return this.status();
  }
}
