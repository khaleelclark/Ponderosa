import {randomUUID} from 'node:crypto';
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
    this.workspace.updatePreferences({outputApps:{...this.roles(),...patch}});this.publishSince?.(cursor);
  }
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
    this.write({agentIds:enabled?[...new Set([...roles.agentIds,id])]:roles.agentIds.filter(value=>value!==id),
      speakerAgentId:speaker?id:roles.speakerAgentId===id?null:roles.speakerAgentId,initialized:speaker||roles.initialized});
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
    this.write({speakerAgentId:null,initialized:true,setup:undefined});return this.status();
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
    const branch=this.branches.getBranch(branchId)!;
    if(!branch.versionId){
      const config={scheduleKind:'interval' as const,everyMs:600000,startsAt:new Date(Date.now()+600000).toISOString(),whenRunning:'run_latest' as const};
      const normalized=normalizeTriggerSourceConfig('schedule',config);
      this.branches.deploy({chatId:'',branchId,expectedVersionId:'',idempotencyKey:`assistant-workflow-${key}`,definition:{schema:'ponderosa.branch.v1',name:'Assistant',trigger:{kind:'schedule',configRef:'check'},entry:'speaker',steps:[{id:'speaker',kind:'agent',target:{kind:'persistent_agent',ref:'speaker'},instructions:'Check available projects for newly completed work and issues. Report only useful changes through explicit user communication; respect notification settings.',requireUserCommunication:true}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{speaker:imported.rootAgentId},directories:{},triggers:{check:{sourceConfig:config,enabled:true}}}},new Date().toISOString(),{sourceConfig:normalized.config,nextFireAt:normalized.nextFireAt});
    }
    this.designate(imported.rootAgentId,true,true);this.write({setup:undefined});return this.status();
  }
}
