import {composeBranchChat} from './branch-package-group.js';
import {isAbsolute,resolve,sep} from 'node:path';
import type {BranchPackageEngine} from './routes/agent-packages.js';
import {selectBranchMemory} from './branch-memory-update.js';
import {validateOutputRoles} from './portable-output-roles.js';
import type {OutputAgentApps} from './output-agent-apps.js';
import {agentPackageJsonUtf8Bytes} from '@ponderosa/core';
import type {ChatCreator} from "./routes/projects.js";
import {branchDefinitionChanges} from "@ponderosa/agents";
import {randomUUID,createHash} from 'node:crypto';
import type {AgentStore,BranchStore} from '@ponderosa/agents';
import {stableJson,validateBranchDefinition,validateBranchConfiguration,interpolateBranchText} from '@ponderosa/agents';
import type {AgentPortablePackageDto,BranchBindings,ImportAgentPackageResponse,DeployBranchRequest,BranchDto,BranchPackageChat,InstalledBranchPackage,BranchInstallationPreviewDto,BranchInstallationOperationDto} from '@ponderosa/core';
import {realpathSync,statSync} from 'node:fs';
import {portableBase64ByteLength} from './agent-package-codec.js';
import {validatePortableAgentPackage} from './portable-agent-package-validation.js';

type Row=Record<string,any>;
const PREVIEW_TTL_MS=24*60*60*1000;
const MAX_OUTSTANDING_PLANS=32;
const MAX_OUTSTANDING_PLANS_PER_BRANCH=8;
const MAX_RETAINED_PLAN_BYTES=512*1024*1024;
const TERMINAL_RECEIPT_TTL_MS=30*24*60*60*1000;
const MAX_TERMINAL_RECEIPTS=10_000;
const IMPORT_DEADLINE_MS=5*60*1000;
class InstallationStoppedError extends Error{}
class InstallationConflictError extends Error{}
type ChatSnapshot={id:string;title:string;instructions?:string};
type AgentSnapshot={id:string;title:string;handle:string;activeEngine:string;model:string|null;effort:string|null;speed:string|null;managementPermissions:unknown;managerAgentId:string|null};
type InstallationJournal={chats:Array<ChatSnapshot&{applied?:ChatSnapshot}>;agents:Array<AgentSnapshot&{applied?:Omit<AgentSnapshot,'managerAgentId'>;appliedManager?:string|null;configurationRestored?:boolean}>};
type AccessReview=import('@ponderosa/core').AgentAccessImportReviewDto;
type AccessChoice=NonNullable<import('@ponderosa/core').ImportAgentPackageRequest['accessSettingsResolution']>;
type PendingWorkingRoot={chatRef:string;agentRef:string;chatId:string;sharedRoot:string};
type PendingAccess={chatRef:string;agentRef:string;chatId:string;review:AccessReview;agentRefs?:string[]};
/** Coordinates existing Chat/Agent lifecycle operations. It never creates provider Runs. */
export class BranchInstallationService {
 private engine?:BranchPackageEngine;
 private outputApps?:OutputAgentApps;
 setOutputApps(owner:OutputAgentApps){this.outputApps=owner;}
 private roleBinding(pkg:InstalledBranchPackage,bindings:BranchBindings,branchId?:string){return createHash('sha256').update(stableJson({package:pkg,bindings,destination:branchId??'new'})).digest('hex');}
 private rolePlan(plan:Row):{review?:import('@ponderosa/core').OutputRoleImportReviewDto;binding?:string;published?:boolean;mapping?:Record<string,string>;accessChoices?:Record<string,AccessChoice>;pendingAccess?:PendingAccess;pendingWorkingRoot?:PendingWorkingRoot;fileSelections?:import('@ponderosa/core').BranchImportFileSelections;importResults?:Record<string,Pick<ImportAgentPackageResponse,'workingFilesDestination'|'workingRoots'|'accessSettingsToReview'|'liveWorkingRoots'>>;operations?:BranchInstallationOperationDto[];memoryUpdate?:{review:import('@ponderosa/core').BranchMemoryUpdateReviewDto;hash:string}} {const value=JSON.parse(plan.preview_json);return Array.isArray(value)?{operations:value}:value;}
 private finishRoles(plan:Row){
  const state=this.rolePlan(plan);if(state.review){if(!this.outputApps)throw new Error('Output role service unavailable');this.outputApps.finalizeImport(state.review.id,state.binding!,plan.id,state.mapping!);}
  this.compactPlan(plan.id,'completed');
  if(state.review)this.outputApps!.finishImport(state.review.id);
  this.runtimeRefreshPending=true;
 }

 private pending?:Promise<void>;
 private stopped=false;
 private readonly activeImports=new Map<string,AbortController>();
 private agentCleanupCursor=0;
 private chatCleanupCursor=0;
 private publish?:(input:DeployBranchRequest,configuration?:import('@ponderosa/core').BranchConfiguration)=>BranchDto;
 private refreshRuntime?:()=>Promise<void>;
 private runtimeRefreshPending=false;
 setPublisher(publish:(input:DeployBranchRequest,configuration?:import('@ponderosa/core').BranchConfiguration)=>BranchDto,refreshRuntime?:()=>Promise<void>):void{this.publish=publish;this.refreshRuntime=refreshRuntime;}
 status(id:string):{branchId?:string;state:string;error?:string;accessSettingsReview?:PendingAccess;workingRootReview?:PendingWorkingRoot;importResults?:Record<string,Pick<ImportAgentPackageResponse,'workingFilesDestination'|'workingRoots'|'accessSettingsToReview'|'liveWorkingRoots'>>}|undefined{const p=this.row("SELECT * FROM branch_installation_plans WHERE id=?",id);return p?{branchId:p.branch_id??undefined,state:p.state,error:p.error??undefined,importResults:this.rolePlan(p).importResults,workingRootReview:this.rolePlan(p).pendingWorkingRoot,...(this.rolePlan(p).pendingAccess?{accessSettingsReview:this.rolePlan(p).pendingAccess}:{})}:undefined;}
 constructor(private store:AgentStore,private branches:BranchStore,private deleteChat:(id:string)=>Promise<void>,private deleteAgent:(id:string)=>Promise<void>,private createChat:ChatCreator,private settleNotifications?:(branchId:string)=>void){}
 setEngine(engine:BranchPackageEngine):void{this.engine=engine;}
 private rows(sql:string,...args:unknown[]):Row[]{return this.store.sqlite.prepare(sql).all(...args) as Row[];}
 private row(sql:string,...args:unknown[]):Row|undefined{return this.store.sqlite.prepare(sql).get(...args) as Row|undefined;}
 private run(sql:string,...args:unknown[]):void{this.store.sqlite.prepare(sql).run(...args);}
 private planState(id:string):string|undefined{return this.row('SELECT state FROM branch_installation_plans WHERE id=?',id)?.state;}
 private compactPlan(id:string,state:string,error?:string):void{
  if(state!=='completed'&&this.journal(id))throw new Error('Installation compensation remains unresolved; its journal must be retained');
  const results=this.rolePlan(this.row('SELECT * FROM branch_installation_plans WHERE id=?',id)!).importResults;
  this.run("UPDATE branch_installation_plans SET state=?,error=?,package_json='{}',bindings_json='{}',preview_json=?,journal_json='{}',owned_resources_json='[]',expected_version_id=NULL,expected_configuration_revision=NULL,expected_resources_hash=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?",state,error??null,results?stableJson({importResults:results}):'[]',new Date().toISOString(),id);
 }
 private maintainPlans(now=new Date()):void{
  const cutoff=new Date(now.getTime()-PREVIEW_TTL_MS).toISOString();
  for(const plan of this.rows("SELECT id FROM branch_installation_plans WHERE state='preview' AND created_at<?",cutoff))this.compactPlan(plan.id,'expired','Installation preview expired; review the package again');
  for(const plan of this.rows("SELECT id,state,error FROM branch_installation_plans WHERE state IN ('completed','canceled','expired','review_required') AND journal_json='{}' AND (package_json!='{}' OR bindings_json!='{}' OR (preview_json!='[]' AND json_extract(preview_json,'$.importResults') IS NULL))"))this.compactPlan(plan.id,plan.state,plan.error??undefined);
  const receiptCutoff=new Date(now.getTime()-TERMINAL_RECEIPT_TTL_MS).toISOString();
  this.run("DELETE FROM branch_installation_plans WHERE state IN ('completed','canceled','expired','review_required') AND journal_json='{}' AND updated_at<?",receiptCutoff);
  this.run("DELETE FROM branch_installation_plans WHERE id IN (SELECT id FROM branch_installation_plans WHERE state IN ('completed','canceled','expired','review_required') AND journal_json='{}' ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET ?)",MAX_TERMINAL_RECEIPTS);
 }
 private assertPlanCapacity(branchId:string|undefined,incomingBytes:number):void{
  const global=this.row("SELECT COUNT(*) n FROM branch_installation_plans WHERE state IN ('preview','applying','canceling')")!.n as number;
  if(global>=MAX_OUTSTANDING_PLANS)throw new Error('Too many outstanding Branch installation plans; finish or stop an existing update');
  const retained=this.row("SELECT COALESCE(SUM(length(CAST(package_json AS BLOB))+length(CAST(bindings_json AS BLOB))+length(CAST(preview_json AS BLOB))),0) n FROM branch_installation_plans WHERE state IN ('preview','applying','canceling')")!.n as number;
  if(retained+incomingBytes>MAX_RETAINED_PLAN_BYTES)throw new Error('Outstanding Branch installation previews exceed the retained payload limit');
  if(branchId){const local=this.row("SELECT COUNT(*) n FROM branch_installation_plans WHERE branch_id=? AND state IN ('preview','applying','canceling')",branchId)!.n as number;if(local>=MAX_OUTSTANDING_PLANS_PER_BRANCH)throw new Error('Too many outstanding installation plans for this Branch');}
 }
 private stopStaging(branchId:string):void{this.run("UPDATE branch_installation_resources SET state='retiring' WHERE branch_id=? AND state='staging'",branchId);}
 private ensureApplying(id:string,branchId:string):void{
  if(this.stopped)throw new Error('Branch installation paused by server shutdown');
  if(this.planState(id)==='applying')return;
  this.stopStaging(branchId);
  throw new InstallationStoppedError('Installation update was stopped');
 }
 private identity(branchId:string,chatId:string,agentId?:string):{packageId:string;chatRef:string;agentRef?:string}{
  let b=this.row('SELECT package_id FROM branches WHERE id=?',branchId)!;
  if(!b.package_id){b={package_id:randomUUID()};this.run('UPDATE branches SET package_id=? WHERE id=?',b.package_id,branchId);}
  let c=this.row("SELECT * FROM branch_installation_resources WHERE branch_id=? AND local_id=? AND agent_ref='' AND state!='deleted'",branchId,chatId);
  if(!c){c={chat_ref:randomUUID()};this.run("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,'',?,'active')",branchId,b.package_id,c.chat_ref,chatId);}
  let a=agentId?this.row("SELECT * FROM branch_installation_resources WHERE branch_id=? AND local_id=? AND agent_ref!='' AND state!='deleted'",branchId,agentId):undefined;
  if(agentId&&!a){a={agent_ref:randomUUID()};this.run("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'active')",branchId,b.package_id,c.chat_ref,a.agent_ref,agentId);}
  return {packageId:b.package_id,chatRef:c.chat_ref,...(a?{agentRef:a.agent_ref}:{})};
 }
 resolveWorkingRoot(id:string,chatRef:string,agentRef:string,sharedRoot:string){
  this.store.sqlite.transaction(()=>{
   const plan=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);
   if(!plan||plan.state!=='applying')throw new Error('Installation is not awaiting working-root review');
   const state=this.rolePlan(plan),pending=state.pendingWorkingRoot;
   if(!pending||pending.chatRef!==chatRef||pending.agentRef!==agentRef||pending.sharedRoot!==sharedRoot)throw new Error('Working-root review changed');
   const chat=this.store.getConversation(pending.chatId),project=chat&&this.store.getProject(chat.projectId);
   if(!project||project.hostPath!==sharedRoot||this.store.listAgents(project.id).length)throw new Error('NEW managed Chat root changed or is no longer empty');
   const key=JSON.stringify([chatRef,agentRef]),selection=state.fileSelections?.[key];
   if(!selection?.newManagedChatFolderName)throw new Error('Managed destination creation choice unavailable');
   const root=resolve(sharedRoot);
   for(const file of Object.values(state.fileSelections??{}))for(const destination of [file.workingFilesDestination,...Object.values(file.workingRootDestinations??{})]){
    if(destination!==undefined){const retained=resolve(destination);if(retained===root||retained.startsWith(root+sep)||root.startsWith(retained+sep))throw new Error('Recovery destinations must be separate from the new live root');}
   }
   const {pendingWorkingRoot,...rest}=state;
   this.run('UPDATE branch_installation_plans SET preview_json=? WHERE id=?',stableJson({...rest,fileSelections:{...state.fileSelections,[key]:{...selection,workingFilesActivation:{sharedRoot}}}}),id);
  }).immediate();return this.status(id)!;
 }
 private retainImportResult(planId:string,key:string,result:ImportAgentPackageResponse){
  const current=this.row('SELECT * FROM branch_installation_plans WHERE id=?',planId)!;
  const state=this.rolePlan(current);
  this.run('UPDATE branch_installation_plans SET preview_json=? WHERE id=?',stableJson({...state,importResults:{...state.importResults,[key]:{workingFilesDestination:result.workingFilesDestination,workingRoots:result.workingRoots,accessSettingsToReview:result.accessSettingsToReview,liveWorkingRoots:result.liveWorkingRoots}}}),planId);
 }
 async export(branchId:string,mode:'template'|'full',includeValues=false,fileSelections:import('@ponderosa/core').BranchExportFileSelections={}):Promise<InstalledBranchPackage>{
  if(!this.engine)throw new Error('Package Engine unavailable');
  if(!fileSelections||typeof fileSelections!=='object'||Array.isArray(fileSelections))throw new Error('Invalid export file selections');
  const requested=new Set(Object.keys(fileSelections));
  for(const selection of Object.values(fileSelections)){
   if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(k=>!['selectedWorkingFiles','wholeWorkingFolder'].includes(k))||selection.wholeWorkingFolder!==undefined&&typeof selection.wholeWorkingFolder!=='boolean'||selection.selectedWorkingFiles!==undefined&&(!Array.isArray(selection.selectedWorkingFiles)||selection.selectedWorkingFiles.some(p=>typeof p!=='string')))throw new Error('Invalid export file selection');
  }
  const branch=this.branches.getBranch(branchId),definition=branch&&this.branches.version(branchId,branch.versionId)?.definition;
  if(!branch||!definition)throw new Error('Publish a Branch before exporting');
  const chats:BranchPackageChat[]=[],refs=new Map<string,{chatRef:string;agentRef:string}>();
  for(const row of this.rows("SELECT c.id FROM conversations c WHERE c.branch_id=? AND c.branch_execution_id IS NULL AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r WHERE r.local_id=c.id AND r.state!='active') ORDER BY c.created_at,c.id",branchId)){
   const c=this.store.getConversation(row.id)!;const identity=this.identity(branchId,c.id),agents=this.store.listAgents(c.projectId).filter(a=>a.conversationId===c.id&&!this.row("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND state!='active'",a.id));
   for(const a of agents){const id=this.identity(branchId,c.id,a.id);refs.set(a.id,{chatRef:id.chatRef,agentRef:id.agentRef!});}
   const nodes:BranchPackageChat['agents']=[];let exportedTeamMemory=false;
   for(const a of agents){requested.delete(a.id);const portable=await this.engine.exportAgent(a.id,mode,fileSelections[a.id]),ref=refs.get(a.id)!.agentRef;
    if(portable.memory){
      for(const entry of portable.memory){
        entry.agentRefs=Object.fromEntries(Object.keys(entry.agentRefs).map(id=>[id,ref]));
        if(exportedTeamMemory){const team='chat:'+entry.snapshot.sourceChatId+':team';entry.snapshot.chunks=entry.snapshot.chunks.filter(row=>row.stamp.audience!==team);entry.snapshot.conflicts=entry.snapshot.conflicts.filter(row=>row.stamp.audience!==team);}
      }
      exportedTeamMemory=true;
    }
    delete portable.outputRoles;
    nodes.push({ref,...(a.managerAgentId&&refs.has(a.managerAgentId)?{managerRef:refs.get(a.managerAgentId)!.agentRef}:{}),definition:{...portable,rootRef:ref,agents:portable.agents.map(n=>({...n,ref,managerRef:undefined}))}});
   }
   chats.push({ref:identity.chatRef,title:c.title,instructions:c.instructions,agents:nodes});
  }
  if(requested.size)throw new Error('Export selection Agent is not owned by this workflow');
  const configuration=this.branches.configuration(branchId),bindings=this.branches.localConfiguration(branchId)!,agentBindings:InstalledBranchPackage['agentBindings']={};
  for(const [ref,id] of Object.entries(bindings.agents)){const target=refs.get(id);if(!target)throw new Error(`Cannot export unavailable Agent binding: ${ref}`);agentBindings[ref]=target;}
  let packageId=this.row('SELECT package_id FROM branches WHERE id=?',branchId)!.package_id;
  if(!packageId){packageId=randomUUID();this.run('UPDATE branches SET package_id=? WHERE id=?',packageId,branchId);}
  const portable:InstalledBranchPackage={schema:'ponderosa.branch-installation.v1',packageId,mode,exportedAt:new Date().toISOString(),definition,chats,agentBindings,limits:configuration.limits,...(mode==='full'&&includeValues?{parameters:configuration.parameters}:{}),triggers:bindings.triggers,engines:bindings.engines};
  const roles=this.outputApps?.portableRoles([...refs.keys()]);
  if(roles?.length)portable.outputRoles=roles.map(role=>({...refs.get(role.ref)!,output:role.output,speaker:role.speaker}));
  agentPackageJsonUtf8Bytes(portable);return portable;
 }
 validate(value:unknown):InstalledBranchPackage{
  agentPackageJsonUtf8Bytes(value);
  const p=structuredClone(value) as InstalledBranchPackage;
  if(!p||p.schema!=='ponderosa.branch-installation.v1'||typeof p.packageId!=='string'||!p.packageId||!['template','full'].includes(p.mode)||!Array.isArray(p.chats)||p.chats.length>100||!p.agentBindings)throw new Error('Invalid Branch installation package');
  if(Object.keys(p).some(k=>!['schema','packageId','mode','exportedAt','definition','chats','agentBindings','limits','parameters','triggers','engines','outputRoles'].includes(k)))throw new Error('Unsupported package field');
  p.definition=validateBranchDefinition(p.definition);
  const seen=new Set<string>();let count=0;
  for(const c of p.chats){
   if(!c.ref||seen.has(c.ref)||typeof c.title!=='string'||!Array.isArray(c.agents))throw new Error('Invalid Chat identity');seen.add(c.ref);
   const agents=new Map(c.agents.map(a=>[a.ref,a]));if(agents.size!==c.agents.length)throw new Error('Duplicate Agent identity');
   for(const a of c.agents){validatePortableAgentPackage(a.definition);if(++count>1000||!a.ref||a.definition?.schema!=='ponderosa.agent-package.v1'||a.definition.agents.length!==1||a.definition.agents[0]?.ref!==a.ref||a.definition.rootRef!==a.ref||a.definition.agents[0]?.managerRef)throw new Error('Expected a single portable Agent for each logical identity');
    if(p.mode==='template'&&a.definition.mode!=='template')throw new Error('Template package cannot contain Agent history');
    const visited=new Set([a.ref]);let parent=a.managerRef;while(parent){if(!agents.has(parent)||visited.has(parent))throw new Error('Invalid organization relationships');visited.add(parent);parent=agents.get(parent)!.managerRef;}
   }
  }
  const key=(chat:string,agent:string)=>JSON.stringify([chat,agent]);
  const refs=new Set(p.chats.flatMap(c=>c.agents.map(a=>key(c.ref,a.ref))));
  const enclosing=p.outputRoles===undefined?undefined:(()=>{
    if(!Array.isArray(p.outputRoles))throw new Error('Invalid output roles');
    return p.outputRoles.map(value=>{if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['chatRef','agentRef','output','speaker'].includes(k))||typeof value.chatRef!=='string'||typeof value.agentRef!=='string')throw new Error('Invalid Branch output role identity');return {ref:key(value.chatRef,value.agentRef),output:value.output,speaker:value.speaker};});
  })();
  const nested=p.chats.flatMap(c=>c.agents.flatMap(a=>(a.definition.outputRoles??[]).map(role=>({...role,ref:key(c.ref,role.ref)}))));
  const normalized=validateOutputRoles(enclosing??nested,refs)!;
  if(enclosing)for(const role of nested)if(!normalized.some(v=>stableJson(v)===stableJson(role)))throw new Error('Nested output roles contradict enclosing Branch declarations');
  if(p.outputRoles!==undefined||nested.length)p.outputRoles=normalized.map(role=>{const [chatRef,agentRef]=JSON.parse(role.ref);return {chatRef,agentRef,output:role.output,speaker:role.speaker};});
  for(const c of p.chats)for(const a of c.agents)delete a.definition.outputRoles;
  for(const target of Object.values(p.agentBindings))if(!p.chats.find(c=>c.ref===target.chatRef)?.agents.some(a=>a.ref===target.agentRef))throw new Error('Agent binding refers to missing logical identity');
  for(const key of Object.keys(p.parameters??{}))if(p.definition.parameters?.[key]?.type==='secret')throw new Error('Secrets must never appear in a package');
  validateBranchConfiguration({parameters:p.parameters??{},limits:p.limits},p.definition);
  return p;
 }
 private resourceRevision(branchId:string):string {
  const resources=this.rows("SELECT c.id,c.project_id FROM conversations c WHERE c.branch_id=? AND c.branch_execution_id IS NULL AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r WHERE r.local_id=c.id AND r.state!='active') ORDER BY c.id",branchId).map(c=>{
   const chat=this.store.getConversation(c.id);
   return {id:c.id,title:chat?.title,instructions:chat?.instructions,agents:this.store.listAgents(c.project_id).filter(a=>a.conversationId===c.id&&!this.row("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND state!='active'",a.id)).map(a=>({id:a.id,title:a.title,engine:a.activeEngine,model:a.model,effort:a.effort,speed:a.speed,manager:a.managerAgentId,permissions:a.managementPermissions})).sort((a,b)=>a.id.localeCompare(b.id))};
  });
  return createHash('sha256').update(stableJson(resources)).digest('hex');
 }
 private journal(planId:string):InstallationJournal|undefined{const raw=this.row('SELECT journal_json FROM branch_installation_plans WHERE id=?',planId)?.journal_json;if(!raw||raw==='{}')return;return JSON.parse(raw) as InstallationJournal;}
 private chatSnapshot(chat:{id:string;title:string;instructions?:string}):ChatSnapshot{return {id:chat.id,title:chat.title,instructions:chat.instructions??''};}
 private agentSnapshot(agent:import('@ponderosa/core').AgentDto):AgentSnapshot{return {id:agent.id,title:agent.title,handle:agent.handle,activeEngine:agent.activeEngine,model:agent.model??null,effort:agent.effort??null,speed:agent.speed??null,managementPermissions:agent.managementPermissions,managerAgentId:agent.managerAgentId??null};}
 private saveJournal(planId:string,journal:InstallationJournal):void{
  this.run('UPDATE branch_installation_plans SET journal_json=?,updated_at=? WHERE id=?',journal.chats.length||journal.agents.length?stableJson(journal):'{}',new Date().toISOString(),planId);
 }
 private compensate(planId:string):void{
  const journal=this.journal(planId);if(!journal)return;
  const conflicts:string[]=[];
  // Each inverse write has its own durable progress. A crash after the canonical
  // write is safe: current==before proves it was already restored on the next pass.
  for(const before of [...journal.chats]){
   const current=this.store.getConversation(before.id);
   if(current&&stableJson(this.chatSnapshot(current))!==stableJson(this.chatSnapshot(before))){
    if(!before.applied||stableJson(this.chatSnapshot(current))!==stableJson(this.chatSnapshot(before.applied))){conflicts.push('Chat '+before.id);continue;}
    this.store.updateConversation(before.id,{title:before.title,instructions:before.instructions??''});
   }
   journal.chats.splice(journal.chats.indexOf(before),1);this.saveJournal(planId,journal);
  }
  for(const before of [...journal.agents]){
   const current=this.store.getAgent(before.id);
   if(!current){journal.agents.splice(journal.agents.indexOf(before),1);this.saveJournal(planId,journal);continue;}
   const {managerAgentId:beforeManager,applied,appliedManager,configurationRestored,...configuration}=before;
   const {managerAgentId:currentManager,...currentConfiguration}=this.agentSnapshot(current);
   if(!configurationRestored){
    if(stableJson(currentConfiguration)!==stableJson(configuration)){
     if(!applied||stableJson(currentConfiguration)!==stableJson(applied)){conflicts.push('Agent settings '+before.id);continue;}
     this.store.restoreAgentConfiguration(before.id,{...configuration,managementPermissions:configuration.managementPermissions as never});
    }
    before.configurationRestored=true;this.saveJournal(planId,journal);
   }
   if(currentManager!==beforeManager){
    if(!Object.prototype.hasOwnProperty.call(before,'appliedManager')||currentManager!==appliedManager){conflicts.push('Agent manager '+before.id);continue;}
    try { this.store.updateAgentOrganization(before.id,{managerAgentId:beforeManager}); }
    catch {
     // Another owned inverse may need to detach first (a valid tree reversal).
     // Continue independent restorations and retain this entry for the next pass.
     conflicts.push('Agent manager '+before.id);continue;
    }
   }
   journal.agents.splice(journal.agents.indexOf(before),1);this.saveJournal(planId,journal);
  }
  this.saveJournal(planId,journal);
  if(conflicts.length)throw new Error('Installation compensation needs review; newer or unproven changes were preserved: '+conflicts.slice(0,8).join(', '));
 }
 private cancelReady(plan:Row):boolean{
  return !this.row("SELECT 1 FROM branch_installation_resources WHERE staging_plan_id=? AND state IN ('staging','retiring')",plan.id);
 }
 private rememberOwned(planId:string,id:string):void{const row=this.row('SELECT owned_resources_json FROM branch_installation_plans WHERE id=?',planId);const ids=new Set<string>(JSON.parse(row?.owned_resources_json||'[]'));ids.add(id);this.run('UPDATE branch_installation_plans SET owned_resources_json=?,updated_at=? WHERE id=?',stableJson([...ids]),new Date().toISOString(),planId);}
 private configurationFor(pkg:InstalledBranchPackage,branchId?:string){
  const current=branchId?this.branches.configuration(branchId):undefined;
  const retained=Object.fromEntries(Object.entries(current?.parameters??{}).filter(([key,value])=>{
   const type=pkg.definition.parameters?.[key]?.type;return type==='text'||type==='path'?typeof value==='string':type==='number'?typeof value==='number':type==='boolean'?typeof value==='boolean':false;
  }));
  return validateBranchConfiguration({parameters:{...retained,...pkg.parameters},limits:pkg.limits,secretBindings:Object.fromEntries(Object.entries(current?.secretBindings??{}).filter(([key])=>pkg.definition.parameters?.[key]?.type==='secret'))},pkg.definition);
 }
 private async memoryInventory(branchId:string){
  const snapshots:import('@ponderosa/core').PortableChatMemorySnapshotDto[]=[];
  for(const chat of this.rows("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref='' AND state='active' ORDER BY local_id",branchId)){
   const ids=this.rows("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND chat_ref=(SELECT chat_ref FROM branch_installation_resources WHERE branch_id=? AND local_id=? AND agent_ref='') AND agent_ref!='' AND state='active' ORDER BY local_id",branchId,branchId,chat.local_id).map(r=>r.local_id as string);
   const snapshot=await this.engine!.exportMemory(chat.local_id,ids);snapshot.chunks.sort((a,b)=>a.id.localeCompare(b.id));snapshot.conflicts.sort((a,b)=>a.id.localeCompare(b.id));snapshots.push(snapshot);
  }
  return snapshots;
 }
 private async checkMemory(plan:Row){const update=this.rolePlan(plan).memoryUpdate;if(update&&createHash('sha256').update(stableJson(await this.memoryInventory(plan.branch_id))).digest('hex')!==update.hash)throw new InstallationConflictError('Destination memory changed; review a new additive preview');}
 async preview(value:unknown,bindings:BranchBindings,branchId?:string,memorySelection?:import('@ponderosa/core').BranchMemoryUpdateSelectionDto,fileSelections:import('@ponderosa/core').BranchImportFileSelections={}):Promise<BranchInstallationPreviewDto>{
  this.maintainPlans();
  if(!this.engine)throw new Error('Package Engine unavailable');
  const pkg=this.validate(value);
  if(!fileSelections||typeof fileSelections!=='object'||Array.isArray(fileSelections))throw new Error('Invalid working folder destinations');
  const targetKeys=new Set(pkg.chats.flatMap(c=>c.agents.map(a=>JSON.stringify([c.ref,a.ref])))),paths:string[]=[];
  for(const [key,selection] of Object.entries(fileSelections)){
   if(!targetKeys.has(key)||!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(k=>!['workingFilesDestination','workingRootDestinations','workingFilesActivation','newManagedChatFolderName'].includes(k)))throw new Error('Invalid working folder destination target');
   if(selection.workingFilesDestination&&selection.workingRootDestinations)throw new Error('Choose one folder destination format');
   if(selection.newManagedChatFolderName!==undefined){
    if(typeof selection.newManagedChatFolderName!=='string'||! /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(selection.newManagedChatFolderName))throw new Error('Choose a safe NEW managed Chat folder name');
    const [chatRef,agentRef]=JSON.parse(key),group=pkg.chats.find(c=>c.ref===chatRef)!;
    if(group.agents.length>1){const combined=await composeBranchChat(group,this.engine!);if(combined.rootRef!==agentRef||Object.keys(fileSelections).some(k=>k!==key&&JSON.parse(k)[0]===chatRef))throw new Error('Choose grouped activation and recovery destinations on the first authored reporting root only');}
    if(selection.workingFilesActivation===undefined||selection.workingFilesActivation.sharedRoot!==undefined)throw new Error('Choose live activation, then confirm the actual created root in the staged review');
   }
   if(selection.workingFilesActivation!==undefined){
    const activation=selection.workingFilesActivation;
    if(!activation||typeof activation!=='object'||Array.isArray(activation)||Object.keys(activation).some(k=>k!=='sharedRoot')
      ||activation.sharedRoot!==undefined&&(typeof activation.sharedRoot!=='string'||!isAbsolute(activation.sharedRoot)))throw new Error('Invalid live working-root activation');
    if(!selection.workingFilesDestination&&!Object.keys(selection.workingRootDestinations??{}).length)throw new Error('Live activation requires separate NEW recovery destinations');
    if(activation.sharedRoot!==undefined)throw new Error('Shared root confirmation is accepted only after NEW managed Chat creation in the staged working-root review');
   }
   if(selection.workingRootDestinations&&(typeof selection.workingRootDestinations!=='object'||Array.isArray(selection.workingRootDestinations)))throw new Error('Invalid working roots');
   for(const path of [selection.workingFilesDestination,...Object.values(selection.workingRootDestinations??{})].filter(p=>p!==undefined)){
    if(typeof path!=='string'||!isAbsolute(path))throw new Error('Choose NEW absolute working folder destinations');const canonical=resolve(path);
    if(paths.some(p=>p===canonical||p.startsWith(canonical+sep)||canonical.startsWith(p+sep)))throw new Error('Working folder destinations must be distinct and cannot nest');paths.push(canonical);
   }
  }
  const branch=branchId?this.branches.getBranch(branchId):undefined;
  if(branchId&&this.row('SELECT 1 FROM branches WHERE id=? AND deleting=1',branchId))throw new Error('Branch deletion is pending');
  if(branchId&&!branch)throw new Error('Branch unavailable');
  if(branchId&&memorySelection===undefined&&pkg.chats.some(c=>c.agents.some(a=>a.definition.memory?.some(m=>m.snapshot.chunks.length||m.snapshot.conflicts.length))))throw new Error('Memory-bearing workflow packages require fresh installation or explicit additive memory selections');
  if(memorySelection!==undefined&&(!branchId||pkg.mode!=='full'))throw new Error('Additive memory selection requires an existing workflow and full package');
  if(branchId&&this.row("SELECT 1 FROM branch_installation_plans WHERE branch_id=? AND state IN ('applying','canceling')",branchId))throw new Error('Another update is still applying');
  for(const directory of Object.values(bindings.directories))if(!statSync(realpathSync(interpolateBranchText(directory,pkg.definition,this.configurationFor(pkg,branchId)))).isDirectory())throw new Error('Working directories must exist');
  if(pkg.chats.length&&!bindings.directories.workspace)throw new Error('Choose a default working directory for imported Chats');
  for(const chat of pkg.chats)for(const agent of chat.agents)this.engine.validateAgent(agent.definition,bindings.engines??pkg.engines??{});
  for(const chat of pkg.chats)if(chat.agents.length>1&&chat.agents.some(a=>fileSelections[JSON.stringify([chat.ref,a.ref])]?.newManagedChatFolderName))this.engine.validateAgent(await composeBranchChat(chat,this.engine!),bindings.engines??pkg.engines??{});
  if(branchId&&branch){for(const c of this.rows("SELECT id,project_id FROM conversations WHERE branch_id=? AND branch_execution_id IS NULL AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r WHERE r.local_id=conversations.id AND r.state!='active')",branchId)){this.identity(branchId,c.id);for(const a of this.store.listAgents(c.project_id))if(a.conversationId===c.id)this.identity(branchId,c.id,a.id);}}
  const existing=branchId?this.rows("SELECT * FROM branch_installation_resources WHERE branch_id=? AND state='active'",branchId):[];
  if(memorySelection!==undefined&&existing.some(r=>r.package_id!==pkg.packageId))throw new Error('Additive memory update requires the same installed package identity');
  let memoryUpdate:ReturnType<BranchInstallationService['rolePlan']>['memoryUpdate'];
  if(memorySelection!==undefined){
   const chosen=selectBranchMemory(pkg,memorySelection,existing as Array<{chat_ref:string;agent_ref:string}>),destination=await this.memoryInventory(branchId!);
   memoryUpdate={review:{...chosen,destination},hash:createHash('sha256').update(stableJson(destination)).digest('hex')};
   for(const c of pkg.chats)for(const a of c.agents){const old=existing.find(r=>r.chat_ref===c.ref&&r.agent_ref===a.ref);if(old)a.definition.agents[0]!.managementPermissions=this.store.getAgent(old.local_id)!.managementPermissions;}
  }
  const keys=new Set<string>(),operations:BranchInstallationOperationDto[]=[];
  for(const [key,selection] of Object.entries(fileSelections)){
   const [chatRef,agentRef]=JSON.parse(key) as string[];
   if(selection.newManagedChatFolderName&&existing.some(r=>r.package_id===pkg.packageId&&r.chat_ref===chatRef))throw new Error('Choose a NEW installation Chat for managed live activation');
   if(existing.some(r=>r.package_id===pkg.packageId&&r.chat_ref===chatRef&&r.agent_ref===agentRef))throw new Error('Existing Agents retain their working roots; choose a new Agent for imported folder content');
   operations.push({kind:'retain-content',resource:'Working folder',label:selection.workingFilesActivation!==undefined?'Retain NEW recovery copies and activate fresh locally owned working roots':'Retain NEW recovery copies only',after:{target:key,...selection,...(selection.newManagedChatFolderName&&pkg.chats.find(c=>c.ref===chatRef)!.agents.length>1?{groupedAgentRefs:pkg.chats.find(c=>c.ref===chatRef)!.agents.map(a=>a.ref),workingRootRefs:[...new Set((await composeBranchChat(pkg.chats.find(c=>c.ref===chatRef)!,this.engine!)).agents.flatMap(a=>a.workingRootRef?[a.workingRootRef]:[]))]}:{})}});
  }
  const compare=(resource:string,label:string,before:unknown,after:unknown)=>{if(stableJson(before??null)!==stableJson(after??null))operations.push({kind:'change',resource,label,before:before??null,after:after??null});};
  for(const c of pkg.chats){for(const a of [{ref:'',title:c.title},...c.agents.map(a=>({ref:a.ref,title:a.definition.agents[0]!.title}))]){
    const key=stableJson([pkg.packageId,c.ref,a.ref]);keys.add(key);const old=existing.find(r=>r.package_id===pkg.packageId&&r.chat_ref===c.ref&&r.agent_ref===a.ref);
    operations.push({kind:old?'preserve-and-update':'create',resource:a.ref?'Agent':'Chat',label:a.title});
    if(a.ref){const node=c.agents.find(n=>n.ref===a.ref)!.definition.agents[0]!;
     operations.push({kind:'apply-settings',resource:'Agent',label:`${a.title}: Engine ${bindings.engines?.[node.engine]??pkg.engines?.[node.engine]??node.engine}; model ${node.model??'default'}; reasoning ${node.effort??'default'}; automatic descendant deletion ${node.managementPermissions.allowAutomaticDescendantDeletion?'enabled':'disabled'}; automatic reorganization ${node.managementPermissions.allowAutomaticDescendantReorganization?'enabled':'disabled'}`});
     if(old){const previous=this.store.getAgent(old.local_id);compare('Agent settings',a.title,previous?{title:previous.title,engine:previous.activeEngine,model:previous.model,effort:previous.effort,managementPermissions:previous.managementPermissions}:null,{title:node.title,engine:bindings.engines?.[node.engine]??pkg.engines?.[node.engine]??node.engine,model:node.model,effort:node.effort,managementPermissions:node.managementPermissions});}
     if(old)operations.push({kind:'preserve-context',resource:'Agent',label:`${a.title}: existing history and opening instructions remain; incoming history does not replace them`});
    }else{const previous=old?this.store.getConversation(old.local_id):undefined;compare('Chat instructions',c.title,previous?{title:previous.title,instructions:previous.instructions??''}:null,{title:c.title,instructions:c.instructions??''});}
  }}
  if(memoryUpdate)operations.push({kind:'preserve-context',resource:'Memory',label:'Existing Agent memory and destination permissions remain; only selected additions are imported',before:memoryUpdate.review.destination,after:memoryUpdate.review.incoming});
  for(const old of existing)if(!keys.has(stableJson([old.package_id,old.chat_ref,old.agent_ref])))operations.push({kind:'remove-after-active-executions-drain',resource:old.agent_ref?'Agent':'Chat',label:old.agent_ref?this.store.getAgent(old.local_id)?.title??old.agent_ref:this.store.getConversation(old.local_id)?.title??old.chat_ref});
  for(const resource of ['Workflow and scripts','Primary trigger','Parameter definitions','Branch dependencies','Organization relationships','Execution limits'])operations.push({kind:branch?'replace':'create',resource,label:resource});
  const previousDefinition=branch?.versionId?this.branches.version(branch.id,branch.versionId)?.definition:undefined;
  for(const change of branchDefinitionChanges(previousDefinition,pkg.definition))operations.push({...change,label:change.ref});
  const logicalAgent=(id:string)=>{const resource=existing.find(r=>r.local_id===id&&r.agent_ref);return resource?{chatRef:resource.chat_ref,agentRef:resource.agent_ref}:null;};
  const oldBindings=branch?this.branches.localConfiguration(branch.id):undefined;
  compare('Local bindings','Directories, Engines, called Branches and primary trigger',oldBindings?{...oldBindings,agents:Object.fromEntries(Object.entries(oldBindings.agents).map(([ref,id])=>[ref,logicalAgent(id)]))}:undefined,{...bindings,agents:pkg.agentBindings,triggers:bindings.triggers??pkg.triggers,engines:bindings.engines??pkg.engines});
  compare('Execution limits','Applied to new executions',branch?this.branches.configuration(branch.id).limits:undefined,pkg.limits);
  compare('Parameter values','Normal local configuration',branch?this.branches.configuration(branch.id).parameters:undefined,this.configurationFor(pkg,branchId).parameters);
  compare('Organization relationships','Exact logical Agent and manager identities',existing.filter(r=>r.agent_ref).sort((a,b)=>`${a.chat_ref}:${a.agent_ref}`.localeCompare(`${b.chat_ref}:${b.agent_ref}`)).map(r=>({chat:r.chat_ref,agent:r.agent_ref,manager:logicalAgent(this.store.getAgent(r.local_id)?.managerAgentId??'')?.agentRef??null})),pkg.chats.flatMap(c=>c.agents.map(a=>({chat:c.ref,agent:a.ref,manager:a.managerRef??null}))).sort((a,b)=>`${a.chat}:${a.agent}`.localeCompare(`${b.chat}:${b.agent}`)));
  const fullImportAgents:import('@ponderosa/core').BranchFullImportAgentReviewDto[]|undefined=pkg.mode==='full'?pkg.chats.flatMap(c=>c.agents.flatMap(a=>{
   const old=existing.find(r=>r.package_id===pkg.packageId&&r.chat_ref===c.ref&&r.agent_ref===a.ref);if(old)return [];
   const node=a.definition.agents[0]!,instructions=node.initialInstructions??'',history=node.history??[],artifacts=node.artifacts??[];
   const roles={user:0,assistant:0,system:0};for(const message of history)roles[message.role]++;
   return [{chat:c.title,agent:node.title,mode:a.definition.mode==='full'?'full':'template' as const,initialInstructions:{bytes:Buffer.byteLength(instructions),...(instructions?{preview:instructions.slice(0,2000)}:{}),truncated:instructions.length>2000},history:{messages:history.length,bytes:history.reduce((n,m)=>n+Buffer.byteLength(m.text),0),roles},artifacts:{count:artifacts.length,bytes:artifacts.reduce((n,item)=>n+portableBase64ByteLength(item.dataBase64),0),items:artifacts.map(item=>({name:item.path,kind:item.kind,mediaType:item.mediaType??'application/octet-stream',bytes:portableBase64ByteLength(item.dataBase64)}))}}];
  })):undefined;
  const fullImportReview=pkg.mode==='full'?{mode:'full' as const,warning:'Full import adds the listed opening instructions and conversation history to each new Agent context and writes the listed files into managed Branch storage. Imported context may affect future model responses. Review every Agent before continuing.',agents:fullImportAgents!}:undefined;
  const targets=pkg.outputRoles?.map(role=>({ref:JSON.stringify([role.chatRef,role.agentRef]),output:role.output,speaker:role.speaker}));
  const roleBinding=this.roleBinding(pkg,bindings,branchId);
  const mapping=Object.fromEntries(existing.filter(r=>r.package_id===pkg.packageId&&r.agent_ref).map(r=>[JSON.stringify([r.chat_ref,r.agent_ref]),r.local_id]));
  const outputRoleReview=targets?.length?this.outputApps?.reviewImport(targets,roleBinding,true,mapping):undefined;
  if(targets?.length&&!outputRoleReview)throw new Error('Output role service unavailable');
  if(targets)for(const target of targets)operations.push({kind:'change',resource:'Output role',label:target.ref,before:this.outputApps?.portableRoles(mapping[target.ref]?[mapping[target.ref]]:[]),after:target});
  const packageJson=stableJson(pkg),bindingsJson=stableJson(bindings),previewJson=stableJson(outputRoleReview||memoryUpdate||Object.keys(fileSelections).length?{...(Object.keys(fileSelections).length?{fileSelections}:{}),...(outputRoleReview?{review:outputRoleReview,binding:roleBinding}:{}),...(memoryUpdate?{memoryUpdate}:{}),operations}:operations);this.assertPlanCapacity(branchId,Buffer.byteLength(packageJson)+Buffer.byteLength(bindingsJson)+Buffer.byteLength(previewJson));
  const id=randomUUID(),createdAt=new Date().toISOString();this.run("INSERT INTO branch_installation_plans(id,branch_id,expected_version_id,expected_configuration_revision,package_json,bindings_json,preview_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",id,branchId??null,branch?.versionId??null,branchId?this.row('SELECT configuration_revision FROM branches WHERE id=?',branchId)!.configuration_revision:null,packageJson,bindingsJson,previewJson,createdAt,createdAt);
  if(branchId)this.run('UPDATE branch_installation_plans SET expected_resources_hash=? WHERE id=?',this.resourceRevision(branchId),id);
  return {id,operations,...(memoryUpdate?{memoryUpdateReview:memoryUpdate.review}:{}),...(outputRoleReview?{outputRoleReview}:{}),...(fullImportReview?{fullImportReview}:{})};
 }
 async resolveAccess(id:string,chatRef:string,agentRef:string,choice:AccessChoice){
  if(!choice||!['keep_destination','use_source'].includes(choice.action)||typeof choice.reviewSha256!=='string'||!/^[a-f0-9]{64}$/.test(choice.reviewSha256))throw new Error('Invalid access settings review');
  const plan=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);
  if(!plan||plan.state!=='applying'||!this.engine)throw new Error('Installation access review unavailable');
  const pending=this.rolePlan(plan).pendingAccess;
  if(!pending||pending.chatRef!==chatRef||pending.agentRef!==agentRef)throw new Error('Installation access review changed');
  const pkg=this.validate(JSON.parse(plan.package_json)),agent=pkg.chats.find(c=>c.ref===chatRef)?.agents.find(a=>a.ref===agentRef);
  if(!agent)throw new Error('Installation Agent unavailable');
  const group=pkg.chats.find(c=>c.ref===chatRef)!;
  const definition=pending.agentRefs?await composeBranchChat(group,this.engine!):agent.definition;
  if(pending.agentRefs&&stableJson(pending.agentRefs)!==stableJson(definition.agents.map(a=>a.ref)))throw new Error('Grouped access review identity changed');
  if(choice.agentActions!==undefined){
   const required=definition.agents.filter(a=>a.accessSettings).map(a=>a.ref).sort();
   if(!choice.agentActions||typeof choice.agentActions!=='object'||Array.isArray(choice.agentActions)||stableJson(Object.keys(choice.agentActions).sort())!==stableJson(required)||Object.values(choice.agentActions).some(action=>!['keep_destination','use_source'].includes(action)))throw new Error('Choose access settings for every reviewed source Agent');
  }
  const review=await this.engine.reviewAccess(definition,pending.chatId);
  this.store.sqlite.transaction(()=>{
   const current=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);
   if(!current||current.state!=='applying')throw new Error('Installation access review unavailable');
   const state=this.rolePlan(current);
   if(stableJson(state.pendingAccess)!==stableJson(pending))throw new Error('Installation access review changed');
   if(review.reviewSha256!==choice.reviewSha256||pending.review.reviewSha256!==choice.reviewSha256){
    this.run('UPDATE branch_installation_plans SET preview_json=? WHERE id=?',stableJson({...state,pendingAccess:{...pending,review}}),id);return;
   }
   const {pendingAccess,...rest}=state;
   this.run('UPDATE branch_installation_plans SET preview_json=?,error=NULL,next_attempt_at=NULL WHERE id=?',stableJson({...rest,accessChoices:{...state.accessChoices,[JSON.stringify([chatRef,agentRef])]:choice}}),id);
  })();
  const result=this.status(id)!;
  if(result.accessSettingsReview)throw new Error('Access settings changed. Review the current source and destination again.');
  return result;
 }
 private async importAccess(plan:Row,chatRef:string,agentRef:string,chatId:string,pkg:AgentPortablePackageDto):Promise<AccessChoice|undefined>{
  if(!pkg.agents.some(node=>node.accessSettings?.restrictedCapabilityIds.length))return;
  const review=await this.engine!.reviewAccess(pkg,chatId);
  this.ensureApplying(plan.id,plan.branch_id);
  const current=this.row('SELECT * FROM branch_installation_plans WHERE id=?',plan.id)!,state=this.rolePlan(current),choice=state.accessChoices?.[JSON.stringify([chatRef,agentRef])];
  if(choice?.reviewSha256===review.reviewSha256)return choice;
  this.run('UPDATE branch_installation_plans SET preview_json=? WHERE id=?',stableJson({...state,pendingAccess:{chatRef,agentRef,chatId,review,...(pkg.agents.length>1?{agentRefs:pkg.agents.map(a=>a.ref)}:{})}}),plan.id);
  throw new Error('Review imported Agent restrictions and destination access before continuing');
 }
 async cancel(id:string):Promise<{branchId?:string;state:string;error?:string}>{
  let plan=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);
  if(!plan)throw new Error('Installation update unavailable');
  if(this.rolePlan(plan).published)throw new Error('Import resources are already committed; finish output-role recovery before stopping');
  if(['completed','canceled'].includes(plan.state))return {branchId:plan.branch_id??undefined,state:plan.state,...(plan.error?{error:plan.error}:{})};
  if(plan.state!=='applying'&&plan.state!=='canceling')throw new Error('Only an applying update can be stopped');
  if(plan.state==='applying')this.run("UPDATE branch_installation_plans SET state='canceling',error=?,next_attempt_at=NULL,updated_at=? WHERE id=?",'Stopping update and restoring prior resource state',new Date().toISOString(),id);
  this.activeImports.get(id)?.abort(new Error('Installation update was stopped'));
  if(this.pending)void this.tick().then(()=>this.tick()).catch(()=>undefined);
  else await this.tick();
  plan=this.row('SELECT branch_id,state,error FROM branch_installation_plans WHERE id=?',id)!;
  return {branchId:plan.branch_id??undefined,state:plan.state,...(plan.error?{error:plan.error}:{})};
 }
 async delete(branchId:string):Promise<{deleted:boolean;pending:boolean}>{
  if(!this.branches.getBranch(branchId))return {deleted:true,pending:false};
  this.store.sqlite.transaction(()=>{
   this.branches.beginDeletion(branchId);
   for(const plan of this.rows("SELECT id FROM branch_installation_plans WHERE branch_id=? AND state='applying'",branchId))this.run("UPDATE branch_installation_plans SET state='canceling',error=?,next_attempt_at=NULL,updated_at=? WHERE id=?",'Branch deletion stopped this update',new Date().toISOString(),plan.id);
   for(const plan of this.rows("SELECT id,state,error FROM branch_installation_plans WHERE branch_id=? AND state NOT IN ('applying','canceling')",branchId))this.compactPlan(plan.id,plan.state==='preview'?'expired':plan.state,plan.state==='preview'?'Branch deletion invalidated this preview':plan.error??undefined);
   if(!this.row("SELECT 1 FROM branch_installation_plans WHERE branch_id=? AND state='canceling'",branchId))for(const c of this.rows('SELECT id FROM conversations WHERE branch_id=?',branchId)){const identity=this.identity(branchId,c.id);this.run("UPDATE branch_installation_resources SET state='retiring' WHERE branch_id=? AND package_id=? AND chat_ref=?",branchId,identity.packageId,identity.chatRef);}
  })();
  this.settleNotifications?.(branchId);
  this.activeImports.forEach((controller,id)=>{if(this.row('SELECT branch_id FROM branch_installation_plans WHERE id=?',id)?.branch_id===branchId)controller.abort(new Error('Branch deletion stopped this update'));});
  if(this.pending)void this.tick().then(()=>this.tick()).catch(()=>undefined);
  else await this.tick();
  return {deleted:!this.branches.getBranch(branchId),pending:Boolean(this.branches.getBranch(branchId))};
 }
 reviewPublishedRoles(id:string){const plan=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);if(!plan||plan.state!=='applying')throw new Error('Committed import unavailable');const state=this.rolePlan(plan);if(!state.published||!state.review)throw new Error('Import has no pending role finalization');return this.outputApps!.reReviewImport(state.review.id,state.binding!,id,state.mapping!);}
 async confirm(id:string,acknowledgeFullImport=false,outputRoleReviewId?:string,acknowledgeMemoryUpdate=false):Promise<{branchId:string;state:string;error?:string}>{
  const captured=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);if(!captured)throw new Error('Update preview unavailable');
  let plan=captured;
  if(plan.state==='completed')return {branchId:plan.branch_id,state:plan.state};
  if(plan.state!=='preview'&&plan.state!=='applying')throw new Error('Update preview is no longer available; review the package again');
  if(plan.state==='preview'&&(JSON.parse(plan.package_json) as InstalledBranchPackage).mode==='full'&&!acknowledgeFullImport)throw new Error('Explicit acknowledgement is required to import full Agent context and files');
  if(plan.state==='preview'&&this.rolePlan(plan).memoryUpdate&&!acknowledgeMemoryUpdate)throw new Error('Explicit acknowledgement is required for reviewed additive memory');
  if(plan.state==='preview')await this.checkMemory(plan);
  // Inventory IO must not let a delayed confirmation revive a stopped or expired plan.
  this.maintainPlans();
  const current=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);if(!current)throw new Error('Update preview unavailable');
  plan=current;
  if(plan.state==='completed')return {branchId:plan.branch_id,state:plan.state};
  if(plan.state!=='preview'&&plan.state!=='applying')throw new Error('Update preview is no longer available; review the package again');
  let roleState=this.rolePlan(plan);
  if(outputRoleReviewId){if(!roleState.published||!roleState.review)throw new Error('No committed role outcome to review');this.outputApps!.claimImport(outputRoleReviewId,roleState.binding!,plan.id);const old=roleState.review.id;roleState={...roleState,review:this.outputApps!.checkImport(outputRoleReviewId,roleState.binding!,plan.id).review};this.run('UPDATE branch_installation_plans SET preview_json=?,next_attempt_at=NULL,error=NULL WHERE id=?',stableJson(roleState),plan.id);this.outputApps!.abandonReview(old);}
  if(roleState.review)this.outputApps!.claimImport(roleState.review.id,roleState.binding!,plan.id);
  if(plan.state==='preview')this.store.sqlite.transaction(()=>{
   const current=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id);
   if(!current||current.state!=='preview')throw new Error('Update preview is no longer available; review the package again');
   plan=current;
   if(plan.branch_id&&this.row("SELECT 1 FROM branch_installation_plans WHERE branch_id=? AND state='applying' AND id!=?",plan.branch_id,id))throw new Error('Another update is still applying');
   if(plan.branch_id&&this.row('SELECT 1 FROM branches WHERE id=? AND deleting=1',plan.branch_id))throw new Error('Branch deletion is pending');
   if(plan.branch_id&&plan.expected_resources_hash!==this.resourceRevision(plan.branch_id))throw new Error('Chats or Agent settings changed; review a new preview');
   if(plan.branch_id){const b=this.branches.getBranch(plan.branch_id);if(!b||b.versionId!==plan.expected_version_id||this.row('SELECT configuration_revision FROM branches WHERE id=?',plan.branch_id)!.configuration_revision!==plan.expected_configuration_revision)throw new Error('Branch changed; review a new preview');}
   else {const pkg=JSON.parse(plan.package_json);plan.branch_id=this.branches.create(pkg.definition.name,`installation-${id}`).id;this.run('UPDATE branch_installation_plans SET branch_id=? WHERE id=?',plan.branch_id,id);}
   if(this.store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',error=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND state='preview'").run(new Date().toISOString(),id).changes!==1)throw new Error('Update preview is no longer available; review the package again');
  })();
  await this.tick();const next=this.row('SELECT * FROM branch_installation_plans WHERE id=?',id)!;return {branchId:next.branch_id,state:next.state,...(next.error?{error:next.error}:{})};
 }
 async tick():Promise<void>{if(this.stopped)return;if(this.pending)return this.pending;this.pending=this.work();try{await this.pending}finally{this.pending=undefined;}}
  activeOperationCount():number{return Number(Boolean(this.pending));}
 requestStop():void{
  this.stopped=true;
  for(const controller of this.activeImports.values())controller.abort(new Error('Branch workflow shutdown interrupted package import'));
 }
 async stop():Promise<void>{
  this.requestStop();
  if(this.pending)await this.pending;
 }
 private async work():Promise<void>{
  const now=new Date();this.maintainPlans(now);
  // Deletion fences request cancellation first so external canonical writes are compensated before receipts compact.
  for(const b of this.rows('SELECT id FROM branches WHERE deleting=1'))this.store.sqlite.transaction(()=>{
   for(const plan of this.rows("SELECT id FROM branch_installation_plans WHERE branch_id=? AND state='applying'",b.id))this.run("UPDATE branch_installation_plans SET state='canceling',error=?,next_attempt_at=NULL,updated_at=? WHERE id=?",'Branch deletion stopped this update',now.toISOString(),plan.id);
   this.activeImports.forEach((controller,id)=>{if(this.row('SELECT branch_id FROM branch_installation_plans WHERE id=?',id)?.branch_id===b.id)controller.abort(new Error('Branch deletion stopped this update'));});
   if(!this.row("SELECT 1 FROM branch_installation_plans WHERE branch_id=? AND state IN ('applying','canceling')",b.id))for(const c of this.rows('SELECT id FROM conversations WHERE branch_id=?',b.id)){const identity=this.identity(b.id,c.id);this.run("UPDATE branch_installation_resources SET state='retiring' WHERE branch_id=? AND package_id=? AND chat_ref=?",b.id,identity.packageId,identity.chatRef);}
  })();
  for(const plan of this.rows("SELECT * FROM branch_installation_plans WHERE state='canceling' ORDER BY updated_at,created_at"))try{
   this.compensate(plan.id);
   if(plan.branch_id)this.stopStaging(plan.branch_id);
  }catch(error){this.run('UPDATE branch_installation_plans SET error=?,updated_at=? WHERE id=?','Restoring the prior resource state remains pending: '+(error as Error).message,new Date().toISOString(),plan.id);}
  if(this.engine)for(const plan of this.rows("SELECT * FROM branch_installation_plans WHERE state='applying' AND json_extract(preview_json,'$.pendingAccess') IS NULL AND json_extract(preview_json,'$.pendingWorkingRoot') IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY COALESCE(next_attempt_at,created_at),created_at LIMIT 1",now.toISOString()))try{await this.apply(plan);}catch(error){
   if(error instanceof InstallationStoppedError||this.planState(plan.id)!=='applying')continue;
   if((error as import('./routes/agent-packages.js').BranchPackageImportError).accessSettingsReview){const current=this.row('SELECT * FROM branch_installation_plans WHERE id=?',plan.id)!;const state=this.rolePlan(current);this.run('UPDATE branch_installation_plans SET preview_json=? WHERE id=?',stableJson({...state,accessChoices:{}}),plan.id);}
   if(error instanceof InstallationConflictError){if(plan.branch_id)this.stopStaging(plan.branch_id);this.compactPlan(plan.id,'review_required',error.message);continue;}
   const attempt=(plan.attempt_count??0)+1,delay=Math.min(60_000,1000*2**Math.min(attempt-1,6));
   this.run('UPDATE branch_installation_plans SET error=?,attempt_count=?,next_attempt_at=?,updated_at=? WHERE id=?',(error as Error).message,attempt,new Date(now.getTime()+delay).toISOString(),now.toISOString(),plan.id);
  }
  for(const r of this.rows("SELECT r.rowid position,r.*,chat.local_id chat_id FROM branch_installation_resources r JOIN branch_installation_resources chat ON chat.branch_id=r.branch_id AND chat.package_id=r.package_id AND chat.chat_ref=r.chat_ref AND chat.agent_ref='' WHERE r.state='retiring' AND r.agent_ref!='' AND chat.state='active' AND NOT EXISTS(SELECT 1 FROM branch_retirement_references ref JOIN branch_executions e ON e.id=ref.execution_id WHERE ref.resource_id=r.local_id AND e.state IN ('queued','running','waiting')) ORDER BY CASE WHEN r.rowid>? THEN 0 ELSE 1 END,r.rowid LIMIT 5",this.agentCleanupCursor))try{
   this.agentCleanupCursor=r.position;
   if(r.staging_plan_id&&r.creation_operation_id&&this.engine)await this.engine.rollbackStagedMemory(r.creation_operation_id);
   await this.deleteAgent(r.local_id);this.run("UPDATE branch_installation_resources SET state='deleted' WHERE branch_id=? AND package_id=? AND chat_ref=? AND agent_ref=?",r.branch_id,r.package_id,r.chat_ref,r.agent_ref);
  }catch(error){this.retirementError(r.local_id,error)}
  for(const r of this.rows("SELECT r.rowid position,r.* FROM branch_installation_resources r WHERE r.state='retiring' AND r.agent_ref='' AND NOT EXISTS(SELECT 1 FROM branch_resource_references ref JOIN branch_executions e ON e.id=ref.execution_id WHERE ref.chat_id=r.local_id AND e.state IN ('queued','running','waiting')) ORDER BY CASE WHEN r.rowid>? THEN 0 ELSE 1 END,r.rowid LIMIT 5",this.chatCleanupCursor))try{
   this.chatCleanupCursor=r.position;
   await this.deleteChat(r.local_id);this.run("UPDATE branch_installation_resources SET state='deleted' WHERE branch_id=? AND package_id=? AND chat_ref=?",r.branch_id,r.package_id,r.chat_ref);this.run('DELETE FROM branch_retirement_errors WHERE resource_id=?',r.local_id);
  }catch(error){this.retirementError(r.local_id,error)}
  for(const plan of this.rows("SELECT * FROM branch_installation_plans WHERE state='canceling' ORDER BY updated_at,created_at"))if(!this.journal(plan.id)&&this.cancelReady(plan)){
   const removeEmptyImport=Boolean(plan.branch_id&&plan.expected_version_id==null);
   if(removeEmptyImport&&plan.branch_id)this.branches.beginDeletion(plan.branch_id);
   this.compactPlan(plan.id,'canceled',plan.error?.startsWith('Stopping update')?undefined:plan.error??undefined);
  }
  for(const b of this.rows('SELECT id FROM branches WHERE deleting=1 ORDER BY updated_at,id LIMIT 5'))try{
   if(this.row("SELECT 1 FROM branch_installation_plans WHERE branch_id=? AND state='canceling'",b.id))continue;
   for(const plan of this.rows("SELECT id,state,error FROM branch_installation_plans WHERE branch_id=?",b.id))this.compactPlan(plan.id,plan.state==='preview'?'expired':plan.state,plan.state==='preview'?'Branch deletion invalidated this preview':plan.error??undefined);
   this.settleNotifications?.(b.id);
   this.branches.deleteBranch(b.id);
  }catch{/* Fences remain until Engine cleanup and audit publication complete. */this.run('UPDATE branches SET updated_at=? WHERE id=?',now.toISOString(),b.id);}
  if(this.runtimeRefreshPending&&this.refreshRuntime)try{await this.refreshRuntime();this.runtimeRefreshPending=false;}catch{/* The next scheduler tick retries. Startup also reconciles every source. */}
 }
 private retirementError(id:string,error:unknown):void{this.run('INSERT INTO branch_retirement_errors VALUES(?,?,?) ON CONFLICT(resource_id) DO UPDATE SET error=excluded.error,updated_at=excluded.updated_at',id,(error as Error).message,new Date().toISOString());}
 private async apply(plan:Row):Promise<void>{
  if(this.rolePlan(plan).published){this.finishRoles(plan);return;}
  const pkg=this.validate(JSON.parse(plan.package_json)),bindings=JSON.parse(plan.bindings_json) as BranchBindings,branchId=plan.branch_id as string;
  const configuration=this.configurationFor(pkg,branchId);
  this.ensureApplying(plan.id,branchId);
  // A crashed attempt must finish compensating before any new mutation is admitted.
  this.compensate(plan.id);
  await this.checkMemory(plan);
  for(const c of pkg.chats)for(const a of c.agents)this.engine!.validateAgent(a.definition,bindings.engines??pkg.engines??{});
  for(const c of pkg.chats)for(const a of ['',...c.agents.map(a=>a.ref)])if(this.row("SELECT 1 FROM branch_installation_resources WHERE branch_id=? AND package_id=? AND chat_ref=? AND agent_ref=? AND state='retiring'",branchId,pkg.packageId,c.ref,a))throw new Error('A matching resource is still retiring; this update will resume after it drains');
  const bind=(chat:string,agent:string,id:string,creationOperationId?:string)=>this.store.sqlite.transaction(()=>{this.run("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state,staging_plan_id,creation_operation_id) VALUES(?,?,?,?,?,'staging',?,?) ON CONFLICT(branch_id,package_id,chat_ref,agent_ref) DO UPDATE SET local_id=excluded.local_id,state='staging',staging_plan_id=excluded.staging_plan_id,creation_operation_id=excluded.creation_operation_id",branchId,pkg.packageId,chat,agent,id,plan.id,creationOperationId??null);this.rememberOwned(plan.id,id);})();
  const get=(chat:string,agent:string)=>this.row("SELECT * FROM branch_installation_resources WHERE branch_id=? AND package_id=? AND chat_ref=? AND agent_ref=? AND state IN ('active','staging')",branchId,pkg.packageId,chat,agent);
  const controller=new AbortController();this.activeImports.set(plan.id,controller);
  const timer=setTimeout(()=>controller.abort(new Error('Branch package Agent import exceeded its deadline')),IMPORT_DEADLINE_MS);
  try{
   for(const c of pkg.chats){
    let chatResource=get(c.ref,''),chatId=chatResource?.local_id as string|undefined;
    if(!chatId){
     const first=c.agents[0]?.definition.agents[0];
     const folderChoice=this.rolePlan(this.row('SELECT * FROM branch_installation_plans WHERE id=?',plan.id)!).fileSelections?.[JSON.stringify([c.ref,c.agents.find(a=>!a.managerRef)?.ref])]?.newManagedChatFolderName;
     const created=await this.createChat({label:c.title,...(folderChoice?{createFolderName:folderChoice}:{hostPath:interpolateBranchText(bindings.directories.workspace!,pkg.definition,configuration)}),
       defaultEngine:bindings.engines?.[first?.engine??'default']??first?.engine??bindings.engines?.default??'codex'},
       'branch-install-'+createHash('sha256').update(plan.id+':'+c.ref).digest('hex'),{branchId});
     chatId=created.id;bind(c.ref,'',chatId);chatResource=get(c.ref,'');
     this.ensureApplying(plan.id,branchId);
    }
    const chat=this.store.getConversation(chatId);if(!chat)throw new Error('Installed Chat unavailable');
    if(chatResource?.state!=='active')this.store.updateConversation(chatId,{title:c.title,instructions:c.instructions??''});
    const groupState=this.rolePlan(this.row('SELECT * FROM branch_installation_plans WHERE id=?',plan.id)!),root=c.agents.find(a=>!a.managerRef),groupChoice=root&&groupState.fileSelections?.[JSON.stringify([c.ref,root.ref])];
    const grouped=c.agents.length>1&&!!groupChoice?.newManagedChatFolderName;
    if(grouped){
     const combined=await composeBranchChat(c,this.engine!),refs=combined.agents.map(a=>a.ref);
     if(groupChoice!.workingFilesActivation?.sharedRoot===undefined){
      const project=this.store.getProject(chat.projectId);if(!project)throw new Error('Created managed Project unavailable');
      this.run('UPDATE branch_installation_plans SET preview_json=? WHERE id=?',stableJson({...groupState,pendingWorkingRoot:{chatRef:c.ref,agentRef:root!.ref,chatId,sharedRoot:project.hostPath}}),plan.id);return;
     }
     let resources=refs.map(ref=>get(c.ref,ref));
     if(resources.some(Boolean)){
      const receiptId=resources[0]?.creation_operation_id;
      if(!receiptId||resources.some(r=>!r||r.state!=='staging'||r.creation_operation_id!==receiptId))throw new InstallationConflictError('Grouped import bindings require one complete staged creation receipt');
      const receipt=this.row('SELECT status,result_json FROM agent_creation_operations WHERE id=? AND project_id=?',receiptId,chat.projectId);
      if(!receipt)throw new InstallationConflictError('Grouped creation receipt unavailable');
      if(receipt.status==='rolled_back'){
       if(resources.some(r=>this.store.getAgent(r!.local_id)))throw new InstallationConflictError('Rolled-back group still owns live Agents');
       this.store.sqlite.transaction(()=>{for(const ref of refs)this.run("DELETE FROM branch_installation_resources WHERE branch_id=? AND package_id=? AND chat_ref=? AND agent_ref=? AND state='staging'",branchId,pkg.packageId,c.ref,ref);plan.attempt_count=(plan.attempt_count??0)+1;this.run('UPDATE branch_installation_plans SET attempt_count=? WHERE id=?',plan.attempt_count,plan.id);})();resources=[];
      }else {
       if(receipt.status!=='completed')throw new Error('Grouped import recovery is pending');
       const members=this.rows('SELECT agent_id FROM agent_creation_operation_members WHERE operation_id=? ORDER BY position',receiptId).map(row=>row.agent_id);
       const result=receipt.result_json?JSON.parse(receipt.result_json) as ImportAgentPackageResponse:undefined;
       if(!result||refs.some((ref,i)=>result.agentRefs?.[ref]!==result.agentIds[i])||stableJson(members)!==stableJson(result.agentIds))throw new InstallationConflictError('Grouped receipt membership mismatch');
       if(!result||result.agentIds.length!==refs.length||refs.some((ref,i)=>resources[i]!.local_id!==result.agentIds[i]||!this.store.getAgent(result.agentIds[i]!))||result.rootAgentId!==get(c.ref,combined.rootRef)?.local_id)throw new InstallationConflictError('Grouped receipt identity mismatch');
       await this.engine!.verifyStagedMemory(receiptId,combined);
       for(const ref of refs)this.retainImportResult(plan.id,JSON.stringify([c.ref,ref]),result);
      }
     }
     if(!resources.length||resources.every(r=>!r)){
      const accessSettingsResolution=await this.importAccess(plan,c.ref,combined.rootRef,chatId,combined);
      this.ensureApplying(plan.id,branchId);
      const result=await this.engine!.importAgent(chat.projectId,chatId,combined,bindings.engines??pkg.engines??{},'branch-install:'+plan.id+':'+(plan.attempt_count??0)+':'+c.ref+':group',{signal:controller.signal,accessSettingsResolution,workingFilesDestination:groupChoice!.workingFilesDestination,workingRootDestinations:groupChoice!.workingRootDestinations,workingFilesActivation:groupChoice!.workingFilesActivation,branchHooks:{
       plan:(ids,receiptId)=>{if(!receiptId||ids.length!==refs.length||new Set(ids).size!==ids.length)throw new Error('Grouped import identity plan mismatch');this.store.sqlite.transaction(()=>{refs.forEach((ref,i)=>bind(c.ref,ref,ids[i]!,receiptId));})();},
       commit:result=>{if(refs.some((ref,i)=>result.agentRefs?.[ref]!==result.agentIds[i])||result.agentIds.length!==refs.length||refs.some((ref,i)=>get(c.ref,ref)?.local_id!==result.agentIds[i])||get(c.ref,combined.rootRef)?.local_id!==result.rootAgentId)throw new Error('Grouped import commit identity mismatch');}
      }});
      this.ensureApplying(plan.id,branchId);for(const ref of refs)this.retainImportResult(plan.id,JSON.stringify([c.ref,ref]),result);
     }
    }
    for(const a of c.agents){
     const fileState=this.rolePlan(this.row('SELECT * FROM branch_installation_plans WHERE id=?',plan.id)!),fileChoice=fileState.fileSelections?.[JSON.stringify([c.ref,a.ref])];
     if(fileChoice?.newManagedChatFolderName&&fileChoice.workingFilesActivation?.sharedRoot===undefined){
      const project=this.store.getProject(chat.projectId);if(!project)throw new Error('Created managed Project unavailable');
      this.run('UPDATE branch_installation_plans SET preview_json=? WHERE id=?',stableJson({...fileState,pendingWorkingRoot:{chatRef:c.ref,agentRef:a.ref,chatId,sharedRoot:project.hostPath}}),plan.id);return;
     }
     let resource=get(c.ref,a.ref),id=resource?.local_id as string|undefined;
     if(grouped&&(!id||!this.store.getAgent(id)))throw new InstallationConflictError('Grouped Agent identity disappeared; individual retry is not allowed');
     if(id&&!this.store.getAgent(id)){
      if(resource?.state==='active')throw new InstallationConflictError('An installed Agent is missing; review the package again');
      if(resource?.creation_operation_id){const receipt=this.row('SELECT status FROM agent_creation_operations WHERE id=?',resource.creation_operation_id);if(!receipt)throw new InstallationConflictError('A staged Agent import receipt is unavailable; review the package again');if(receipt.status!=='rolled_back'){if(receipt.status==='completed')throw new InstallationConflictError('A completed Agent import is missing its Agent; review the package again');throw new Error('The staged Agent import is still being recovered');}}
      plan.attempt_count=(plan.attempt_count??0)+1;this.run('UPDATE branch_installation_plans SET attempt_count=?,updated_at=? WHERE id=?',plan.attempt_count,new Date().toISOString(),plan.id);
      this.run("DELETE FROM branch_installation_resources WHERE branch_id=? AND package_id=? AND chat_ref=? AND agent_ref=? AND state='staging'",branchId,pkg.packageId,c.ref,a.ref);resource=undefined;id=undefined;
     }
     if(id&&resource?.state==='staging'&&!grouped){
      if(!resource.creation_operation_id)throw new InstallationConflictError('A staged Agent has no durable import receipt; review the package again');
      const receipt=this.row('SELECT o.status,o.result_json FROM agent_creation_operations o JOIN agent_creation_operation_members m ON m.operation_id=o.id WHERE o.id=? AND o.project_id=? AND m.agent_id=?',resource.creation_operation_id,chat.projectId,id);
      if(!receipt)throw new InstallationConflictError('A staged Agent import receipt is unavailable; review the package again');
      if(receipt.status!=='completed')throw new Error('The staged Agent import is still being recovered');
      const result=receipt.result_json?JSON.parse(receipt.result_json) as ImportAgentPackageResponse:undefined;
      if(!result||result.rootAgentId!==id||result.agentIds.length!==1||result.agentIds[0]!==id)throw new InstallationConflictError('A staged Agent does not match its completed import receipt; review the package again');
      this.retainImportResult(plan.id,JSON.stringify([c.ref,a.ref]),result);
      await this.engine!.verifyStagedMemory(resource.creation_operation_id,a.definition);
     }
     if(!id){this.ensureApplying(plan.id,branchId);const accessSettingsResolution=await this.importAccess(plan,c.ref,a.ref,chatId,a.definition);const result=await this.engine!.importAgent(chat.projectId,chatId,a.definition,bindings.engines??pkg.engines??{},'branch-install:'+plan.id+':'+(plan.attempt_count??0)+':'+c.ref+':'+a.ref,{signal:controller.signal,accessSettingsResolution,...(fileChoice?{workingFilesDestination:fileChoice.workingFilesDestination,workingRootDestinations:fileChoice.workingRootDestinations,workingFilesActivation:fileChoice.workingFilesActivation}:{}),branchHooks:{plan:(ids,creationOperationId)=>{if(ids.length!==1)throw new Error('Expected one planned Agent identity');if(!creationOperationId)throw new Error('Expected a durable Agent import receipt');bind(c.ref,a.ref,ids[0]!,creationOperationId);},commit:result=>{const bound=get(c.ref,a.ref)?.local_id;if(bound!==result.rootAgentId||result.agentIds.length!==1||result.agentIds[0]!==bound)throw new Error('Imported Agent identity did not match its durable Branch binding');}}});this.ensureApplying(plan.id,branchId);this.retainImportResult(plan.id,JSON.stringify([c.ref,a.ref]),result);id=result.rootAgentId;resource=get(c.ref,a.ref);this.ensureApplying(plan.id,branchId);}
     const node=a.definition.agents[0]!;
     if(resource?.state!=='active')this.store.updateAgent(id,{title:node.title,activeEngine:bindings.engines?.[node.engine]??pkg.engines?.[node.engine]??node.engine,model:node.model??null,effort:node.effort??null,managementPermissions:node.managementPermissions});
    }
   }
   this.ensureApplying(plan.id,branchId);
   await this.checkMemory(plan);
   if(plan.expected_resources_hash&&this.resourceRevision(branchId)!==plan.expected_resources_hash)throw new InstallationConflictError('Chats or Agent settings changed while the update was applying; review the package again');
   const journal:InstallationJournal={chats:[],agents:[]};
   for(const c of pkg.chats){
    const chatResource=get(c.ref,'');
    if(chatResource?.state==='active'){const chat=this.store.getConversation(chatResource.local_id);if(chat)journal.chats.push({id:chat.id,title:chat.title,instructions:chat.instructions});}
    for(const a of c.agents){const resource=get(c.ref,a.ref);if(resource?.state==='active'){const agent=this.store.getAgent(resource.local_id);if(agent)journal.agents.push({id:agent.id,title:agent.title,handle:agent.handle,activeEngine:agent.activeEngine,model:agent.model??null,effort:agent.effort??null,speed:agent.speed??null,managementPermissions:agent.managementPermissions,managerAgentId:agent.managerAgentId??null});}}
   }
   this.run('UPDATE branch_installation_plans SET journal_json=?,updated_at=? WHERE id=?',stableJson(journal),new Date().toISOString(),plan.id);
   try{
    for(const c of pkg.chats){
     const chatResource=get(c.ref,'');
     if(chatResource?.state==='active'){
      const changed=this.store.updateConversation(chatResource.local_id,{title:c.title,instructions:c.instructions??''});
      const entry=journal.chats.find(row=>row.id===chatResource.local_id);if(entry&&changed){entry.applied=this.chatSnapshot(changed);this.saveJournal(plan.id,journal);}
     }
     for(const a of c.agents){const resource=get(c.ref,a.ref)!,node=a.definition.agents[0]!;if(resource.state==='active'){
      const changed=this.store.updateAgent(resource.local_id,{title:node.title,activeEngine:bindings.engines?.[node.engine]??pkg.engines?.[node.engine]??node.engine,model:node.model??null,effort:node.effort??null,managementPermissions:node.managementPermissions});
      const entry=journal.agents.find(row=>row.id===resource.local_id);if(entry&&changed){const {managerAgentId,...configuration}=this.agentSnapshot(changed);entry.applied=configuration;this.saveJournal(plan.id,journal);}
     }}
    }
    for(const c of pkg.chats)for(const a of c.agents){
     const id=get(c.ref,a.ref)!.local_id,manager=a.managerRef?get(c.ref,a.managerRef)!.local_id:null;
     this.store.updateAgentOrganization(id,{managerAgentId:manager});
     const entry=journal.agents.find(row=>row.id===id);if(entry){entry.appliedManager=manager;this.saveJournal(plan.id,journal);}
    }
    this.ensureApplying(plan.id,branchId);
    const agentBindings:Record<string,string>={};for(const [ref,target]of Object.entries(pkg.agentBindings))agentBindings[ref]=get(target.chatRef,target.agentRef)!.local_id;
    const roleState=this.rolePlan(plan);
    if(roleState.review)this.outputApps!.checkImport(roleState.review.id,roleState.binding!,plan.id);
    this.store.sqlite.transaction(()=>{
     this.ensureApplying(plan.id,branchId);
     const branch=this.branches.getBranch(branchId)!;
     if(!this.publish)throw new Error('Package publisher unavailable');
     if(branch.versionId!==(plan.expected_version_id??''))throw new InstallationConflictError('Branch changed while the update was applying; review the package again');
     const targetKeys=new Set(pkg.chats.flatMap(c=>['',...c.agents.map(a=>a.ref)].map(a=>stableJson([pkg.packageId,c.ref,a]))));
     for(const r of this.rows("SELECT * FROM branch_installation_resources WHERE branch_id=? AND state IN ('active','staging')",branchId)){
      const state=keys.has(stableJson([r.package_id,r.chat_ref,r.agent_ref]))?'active':'retiring';
      if(state==='retiring'&&r.agent_ref){const chat=this.row("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND package_id=? AND chat_ref=? AND agent_ref=''",branchId,r.package_id,r.chat_ref);this.run("INSERT OR IGNORE INTO branch_retirement_references SELECT ?,ref.execution_id FROM branch_resource_references ref JOIN branch_executions e ON e.id=ref.execution_id WHERE ref.chat_id=? AND e.state IN ('queued','running','waiting')",r.local_id,chat?.local_id??'');}
      this.run("UPDATE branch_installation_resources SET state=?,staging_plan_id=CASE WHEN ?='active' THEN NULL ELSE staging_plan_id END WHERE branch_id=? AND package_id=? AND chat_ref=? AND agent_ref=?",state,state,branchId,r.package_id,r.chat_ref,r.agent_ref);
     }
     // Publication validates Agent availability. Promote only inside this same
     // transaction so failed validation rolls back every resource transition.
     this.publish({chatId:'',branchId,expectedVersionId:branch.versionId,idempotencyKey:'install:'+plan.id,definition:pkg.definition,bindings:{...bindings,agents:agentBindings,triggers:bindings.triggers??pkg.triggers,engines:bindings.engines??pkg.engines}},configuration);
     this.run('UPDATE branches SET package_id=? WHERE id=?',pkg.packageId,branchId);
     if(roleState.review){const mapping=Object.fromEntries(pkg.chats.flatMap(c=>c.agents.map(a=>[JSON.stringify([c.ref,a.ref]),get(c.ref,a.ref)!.local_id])));
      this.run("UPDATE branch_installation_plans SET preview_json=?,journal_json='{}' WHERE id=?",stableJson({...roleState,published:true,mapping}),plan.id);
     }else this.compactPlan(plan.id,'completed');
    })();
    if(roleState.review)this.finishRoles(this.row('SELECT * FROM branch_installation_plans WHERE id=?',plan.id)!);
    this.runtimeRefreshPending=true;
   }catch(error){if(!this.rolePlan(this.row('SELECT * FROM branch_installation_plans WHERE id=?',plan.id)!).published)this.compensate(plan.id);throw error;}
  }finally{clearTimeout(timer);if(this.activeImports.get(plan.id)===controller)this.activeImports.delete(plan.id);}
 }

}
