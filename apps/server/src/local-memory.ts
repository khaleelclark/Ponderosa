import path from 'node:path';
import fs from '@ponderosa/native-host/fs';
import Database from 'better-sqlite3';
import {randomUUID,createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {CapabilityPolicyStore,type AgentStore,type AgentDeletionReceipt} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {type Chunk,type Inference} from '@local-memory/mcp-node-private';
import {HostMemoryRuntime,checkedCollection,type MemoryAuthority} from './local-memory-authority.js';
import {PonderosaMemory} from '@local-memory/mcp-node-private/ponderosa';
import {validateMemoryCall} from './local-memory-catalog.js';
type HostContext={chatId:string;actor:{kind:'agent'|'user';id:string;operator?:boolean};runId:string;fenceToken:string;active:boolean;sourceType:'user_statement'|'ai_inference';grants:{readChat:boolean;readGlobal:boolean;writeChat:boolean;writeGlobal:boolean}};
import type {CreateServerOptions,AgentMessageCapability,ActiveRun} from './app-contracts.js';
import {activeChatResourceOwner} from './branch-resource-owner.js';
import {requestProduct,resourceInProduct,type ProductScope} from './product-scope.js';

type Ports={opts:CreateServerOptions;store:AgentStore;capabilities:Map<string,AgentMessageCapability>;activeRuns:Map<string,ActiveRun>;ownsRun:(capability:AgentMessageCapability,run:ActiveRun|undefined)=>boolean;publishInvalidation?:(agentId:string,event:import('@ponderosa/core').MemoryChangedEvent)=>void};
class MemoryDenied extends Error{constructor(message:string,readonly statusCode=403){super(message);}}
/** Host authority view; physical sources/business operations stay in immutable private.6. No memory journal or command receipt state. */
export class LocalMemoryService{
 readonly core:HostMemoryRuntime;
 readonly principalId:string;
 private policy!:Database.Database;
 private closed=false;
 private calls=new Set<Promise<unknown>>();
 private knownScopes=new Set<string>();
 private freshPolicy=false;
 private initialized?:Promise<void>;
 private deniedSpeech=new WeakSet<ActiveRun>();
 private speech=new Map<string,{authority:MemoryAuthority;signature:string;refs:Map<string,{id:string;scope:string;hash:string}>;invalid:boolean;expires:number;started:boolean}>();
 constructor(readonly ports:Ports,inference?:Inference){
  const c=ports.opts.localMemory!;if('journalDirectory'in c)throw Error('Legacy journalDirectory is unsupported; preserve old files and configure a fresh ordinary stateDirectory');
  const directory=path.resolve(c.stateDirectory),canonical=fs.realpathSync(ports.opts.dataDir);if(directory===canonical||directory.startsWith(canonical+path.sep))throw Error('Memory policy state must be outside canonical dataDir');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.realpathSync(directory)!==directory)throw Error('Memory policy state aliases unsupported');const d=fs.lstatSync(directory);if(!d.isDirectory()||(d.mode&0o077))throw Error('Memory policy state must be private');
  if(['state.json','owner.lock','journal.sqlite'].some(n=>fs.readdirSync(directory).includes(n)))throw Error('Legacy journal directory refused; no adoption or cleanup');
  if(!fs.readdirSync(directory).includes('host-policy.sqlite')&&c.provision!==true)throw Error('Fresh policy requires explicit provision:true');
  this.core=new HostMemoryRuntime({storage:'chroma',chroma:{url:c.chromaUrl,collectionPrefix:c.collectionPrefix,create:false},modelDir:c.modelDir,inference,accessTracking:false,backupDir:path.join(directory,'backups')},signature=>{
   const file=path.join(directory,'host-policy.sqlite');let fresh=false;try{const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);fresh=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   const st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1||(st.mode&0o077))throw Error('Memory policy requires private regular file');let policy=new Database(file,{fileMustExist:true,readonly:!fresh});
   const installation='CREATE TABLE local_memory_installation(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL CHECK(format=2),principal_id TEXT NOT NULL UNIQUE,data_generation TEXT NOT NULL,storage_binding TEXT NOT NULL)';
   const grants='CREATE TABLE local_memory_chat_grants(chat_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,read_global INTEGER NOT NULL CHECK(read_global IN (0,1)),revision INTEGER NOT NULL CHECK(revision>0),updated_at TEXT NOT NULL)';
   const generation=(ports.store.sqlite.prepare('SELECT generation_id FROM _state_generation WHERE singleton=1').get() as {generation_id:string}).generation_id;
   const binding=createHash('sha256').update(JSON.stringify({url:c.chromaUrl,prefix:c.collectionPrefix,signature})).digest('hex');
   try{if(fresh){if(c.provision!==true)throw Error('Fresh policy requires explicit provision:true');policy.transaction(()=>{policy.exec(installation+';'+grants);policy.pragma('application_id=1280135220');policy.pragma('user_version=2');policy.prepare('INSERT INTO local_memory_installation VALUES(1,2,?,?,?)').run(randomUUID(),generation,binding);})();}
    if(policy.pragma('application_id',{simple:true})!==1280135220||policy.pragma('user_version',{simple:true})!==2)throw Error('Legacy/foreign policy format refused; no automatic migration');
    const tables=policy.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string;sql:string}[];if(tables.length!==2||tables.find(t=>t.name==='local_memory_installation')?.sql!==installation||tables.find(t=>t.name==='local_memory_chat_grants')?.sql!==grants)throw Error('Incompatible memory policy schema');
    const rows=policy.prepare('SELECT * FROM local_memory_installation').all() as any[],principal=rows[0];if(rows.length!==1||principal.id!==1||principal.format!==2||typeof principal.principal_id!=='string'||!/^[0-9a-f-]{36}$/.test(principal.principal_id)||principal.data_generation!==generation||principal.storage_binding!==binding)throw Error('Foreign memory policy installation/storage binding');
    if(policy.prepare('SELECT 1 FROM local_memory_chat_grants WHERE principal_id!=? OR revision<1 OR read_global NOT IN (0,1)').get(principal.principal_id))throw Error('Foreign memory policy grant');
    if(!fresh){policy.close();policy=new Database(file,{fileMustExist:true});}this.policy=policy;this.freshPolicy=fresh;return principal.principal_id;
   }catch(e){policy.close();throw e;}
  });this.principalId=this.core.database.principal;
   this.core.database.packageVisible=id=>this.ports.store.getAgentCreationOperation(id)?.status==='completed'&&!this.ports.store.sqlite.prepare("SELECT 1 FROM branch_installation_resources r JOIN branch_installation_plans p ON p.id=r.staging_plan_id WHERE r.creation_operation_id=? AND p.state!='completed'").get(id);
   this.core.database.onRead=(a,row)=>this.noteSpeechRead(a,row);
   this.core.database.onMutation=(scope,id)=>{for(const entry of this.speech.values())if(entry.refs.has(JSON.stringify([scope,id])))this.invalidateSpeech(entry,scope==='global'?'global':'chat');};
 }


 // ponytail: bounded ephemeral speech exposure:128 Runs,100 sources each,one hour.
 // No operation journal, replay receipt, logical revision or crash recovery.
 private invalidateSpeech(entry:{authority:MemoryAuthority;invalid:boolean;started:boolean},scope:'chat'|'global'='chat'){
  const prior=entry.invalid;entry.invalid=true;
  if(!prior&&entry.started){const agent=this.ports.store.getAgent(entry.authority.actor.id);if(agent)try{this.ports.publishInvalidation?.(agent.id,{type:'memory_changed',projectId:agent.projectId,conversationId:entry.authority.chatId,runId:entry.authority.runId,scope});}catch{/* Invalid authority remains fenced even if telemetry cannot be published. */}}
 }
 checkSpeechAuthorities(){for(const [runId,e]of this.speech)if(e.started&&!this.speechCommitValid(runId))this.invalidateSpeech(e);}
 private speechSignature(a:MemoryAuthority):string{
  this.live();const agent=this.ports.store.getAgent(a.actor.id),owner=activeChatResourceOwner(this.ports.store,'agent',a.actor.id);
  if(!agent||!owner||agent.conversationId!==a.chatId||owner.executionId)throw new MemoryDenied('Speech Chat authority changed');
  this.chat(a.chatId);
  const run=this.ports.store.sqlite.prepare('SELECT agent_id,fencing_token,status,lease_expires_at FROM scheduler_runs WHERE id=?').get(a.runId) as {agent_id:string;fencing_token:number;status:string;lease_expires_at:string}|undefined;
  if(!run||run.agent_id!==agent.id||String(run.fencing_token)!==a.fenceToken||['cancelled','failed','interrupted'].includes(run.status))throw new MemoryDenied('Speech Run authority changed');
  if(run.status!=='completed'){
   const active=this.ports.activeRuns.get(agent.id),cap=active?.messageCapability?this.ports.capabilities.get(active.messageCapability):undefined;
   if(!active||!cap||cap.runId!==a.runId||active.controller.signal.aborted||!this.ports.ownsRun(cap,active)||Date.parse(run.lease_expires_at)<=Date.now())throw new MemoryDenied('Speech Run lease expired');
  }
  const policies=new CapabilityPolicyStore(this.ports.store.sqlite),effective=policies.resolveForAgent(agent.id,a.runId);
  if(a.readChat&&effective.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead))throw new MemoryDenied('Speech memory read revoked');
  const grant=this.getGrant(a.chatId,owner.branchId?'branches':'dev');
  if(a.readGlobal&&!grant.readGlobal)throw new MemoryDenied('Speech global memory revoked');
  const reset=this.ports.store.sqlite.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE agent_id=? AND type='session_reset'").get(agent.id);
  return JSON.stringify([agent.id,agent.projectId,a.chatId,owner.branchId,reset,
   effective.layers.map(l=>[l.scopeKind,l.scopeId,policies.get(l.scopeKind,l.scopeId)??null]),a.readGlobal?grant:null]);
 }
 private denySpeech(a:MemoryAuthority){
  const entry=this.speech.get(a.runId);if(entry)this.invalidateSpeech(entry);
  const run=this.ports.activeRuns.get(a.actor.id);if(run?.v3SchedulerRunId===a.runId)this.deniedSpeech.add(run);
 }
 private speechEntry(a:MemoryAuthority){
  let entry=this.speech.get(a.runId);
  if(!entry){
   for(const [id,e]of this.speech)if(e.expires<Date.now()){this.denySpeech(e.authority);this.speech.delete(id);}
   if(this.speech.size>=128)throw new MemoryDenied('Speech exposure bound exceeded; retry after existing calls expire');
   entry={authority:{...a,writeScope:undefined,observeExposure:false},signature:this.speechSignature(a),refs:new Map(),invalid:false,expires:Date.now()+3600000,started:false};
   this.speech.set(a.runId,entry);
  }
  try{if(entry.signature!==this.speechSignature(entry.authority)||entry.expires<Date.now())entry.invalid=true;}catch{entry.invalid=true;}
  return entry;
 }
 private chunkHash(row:Chunk){return createHash('sha256').update(JSON.stringify([row.id,row.scope,row.text,Object.entries(row.metadata).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');}
 private noteSpeechRead(a:MemoryAuthority,row:Chunk){
  if(a.actor.kind!=='agent')return; // Operator browsing is not a provider Run exposure.
  let entry;try{entry=this.speechEntry(a);}catch{this.denySpeech(a);return;}const key=JSON.stringify([row.scope,row.id]),hash=this.chunkHash(row),prior=entry.refs.get(key);
  if(row.scope==='global'&&!entry.authority.readGlobal){entry.authority={...entry.authority,readGlobal:true};entry.signature=this.speechSignature(entry.authority);}
  if(prior&&prior.hash!==hash)entry.invalid=true;
  if(!prior){if(entry.refs.size>=100){entry.invalid=true;return;}entry.refs.set(key,{id:row.id,scope:row.scope,hash});}
 }
 beginSpeech(token:string){
  const cap=this.ports.capabilities.get(token),run=cap?this.ports.activeRuns.get(cap.agentId):undefined;
  if(!cap||!run||!this.ports.ownsRun(cap,run)||run.messageCapability!==token||!cap.conversationId)throw new MemoryDenied('Invalid speech Run');
  if(this.deniedSpeech.has(run))throw new MemoryDenied('Speech exposure unavailable for this Run; start a fresh voice request');
  const policy=new CapabilityPolicyStore(this.ports.store.sqlite).resolveForAgent(cap.agentId,cap.runId),readChat=!policy.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead);
  const owner=activeChatResourceOwner(this.ports.store,'agent',cap.agentId),grant=this.getGrant(cap.conversationId,owner?.branchId?'branches':'dev');
  const authority:MemoryAuthority={chatId:cap.conversationId,actor:{kind:'agent',id:cap.agentId},runId:cap.runId,fenceToken:String(cap.v3FencingToken),sourceType:'ai_inference',readChat,readGlobal:readChat&&grant.readGlobal,guard:async()=>{}};
  const entry=this.speechEntry(authority);entry.started=true;if(entry.invalid)throw new MemoryDenied('Memory changed before speech authorization');
 }
 speechCommitValid(runId:string){
  const e=this.speech.get(runId);if(!e||!e.started||e.invalid||e.expires<Date.now())return false;
  try{if(e.signature!==this.speechSignature(e.authority))this.invalidateSpeech(e);}catch{this.invalidateSpeech(e);}return !e.invalid;
 }
 async speechStatus(runId:string):Promise<boolean|undefined>{
  if(!this.speech.get(runId)?.started){
   const row=this.ports.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(runId) as {status:string}|undefined;
   return row&&['completed','failed','cancelled'].includes(row.status)?false:undefined;
  }
  return this.validateSpeech(runId);
 }
 async validateSpeech(runId:string):Promise<boolean>{
  const pending=this.validateSpeechNow(runId);this.calls.add(pending);
  try{return await pending;}finally{this.calls.delete(pending);}
 }
 private async validateSpeechNow(runId:string):Promise<boolean>{
  const e=this.speech.get(runId);if(!e||!this.speechCommitValid(runId))return false;
  const guard=async()=>{if(!this.speechCommitValid(runId))throw new MemoryDenied('Speech memory context changed');};
  try{
   await this.core.database.run({...e.authority,observeExposure:false,guard},async()=>{
    for(const ref of e.refs.values()){const row=await this.core.database.get(ref.id,[ref.scope]);if(!row||this.chunkHash(row)!==ref.hash){this.invalidateSpeech(e,ref.scope==='global'?'global':'chat');throw new MemoryDenied('Speech memory source changed');}}
   });return this.speechCommitValid(runId);
  }catch{this.invalidateSpeech(e);return false;}
 }
 private async retire(operation:()=>Promise<void>){
  this.live();const pending=operation();this.calls.add(pending);try{await pending;}finally{this.calls.delete(pending);}
 }
 async purgeChat(chatId:string){
  return this.retire(async()=>{
   await this.ready();
   const guard=async()=>{this.live();const receipt=this.ports.store.getConversationDeletionReceipt(chatId);if(!receipt?.canonicalDeletionCompleted||this.ports.store.getConversation(chatId,{includeDeleting:true}))throw new MemoryDenied('Exact committed Chat deletion required');};
   await this.core.database.purge('chat:'+chatId,guard);await guard();
   this.policy.prepare('DELETE FROM local_memory_chat_grants WHERE chat_id=? AND principal_id=?').run(chatId,this.principalId);this.knownScopes.delete('chat:'+chatId);
  });
 }
 async purgeAgents(receipt:AgentDeletionReceipt){
  return this.retire(async()=>{
   await this.ready();const store=this.ports.store;
   const targets=receipt.deletedAgentIds.map(id=>{
    const row=store.sqlite.prepare('SELECT project_id,conversation_id,ownership_token FROM agent_deletion_tombstones WHERE agent_id=?').get(id) as {project_id:string;conversation_id:string|null;ownership_token:string}|undefined;
    if(!row?.ownership_token||row.project_id!==receipt.projectId)throw new MemoryDenied('Exact Agent deletion tombstone required');return {id,...row};
   });
   const guard=async()=>{this.live();const current=store.getAgentDeletionReceiptByPreviewHash(receipt.previewHash);if(!current?.storageCleanupCompleted||current.id!==receipt.id||JSON.stringify(current.deletedAgentIds)!==JSON.stringify(receipt.deletedAgentIds)||targets.some(t=>store.getAgent(t.id)))throw new MemoryDenied('Exact committed Agent deletion required');};
   for(const target of targets)if(target.conversation_id)await this.core.database.purge('chat:'+target.conversation_id,guard,target.id);
  });
 }
 async purgeProject(projectId:string){
  return this.retire(async()=>{
   await this.ready();const store=this.ports.store;
   const guard=async()=>{this.live();if(!store.sqlite.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(projectId))throw new MemoryDenied('Exact pending Project deletion required');};
   await guard();const chats=store.sqlite.prepare('SELECT id FROM conversations WHERE project_id=?').all(projectId) as {id:string}[];
   for(const {id}of chats){await this.core.database.purge('chat:'+id,guard);await guard();this.policy.prepare('DELETE FROM local_memory_chat_grants WHERE chat_id=? AND principal_id=?').run(id,this.principalId);this.knownScopes.delete('chat:'+id);}
  });
 }
 private live(){if(this.closed)throw new MemoryDenied('Local memory host is closing');}
 private chat(chatId:string,product?:ProductScope){
  this.live();const chat=this.ports.store.getConversation(chatId),owner=activeChatResourceOwner(this.ports.store,'chat',chatId);
  if(!chat||!owner||product&&!resourceInProduct(this.ports.store,'chat',chatId,product))throw new MemoryDenied('Canonical Chat is unavailable in this product',404);
  // ponytail: execution Chats retire with their temporary Agents; no durable memory target is invented.
  if(owner.executionId)throw new MemoryDenied('Temporary execution Chat memory is unsupported by the durable Chat lifetime policy');
  return {chat,owner};
 }
 ready(){return this.initialized??=this.initialize();}
 private async initialize(){
  this.live();await this.core.inference.embed('synthetic local-memory readiness');
  if(!await this.core.inference.rerank([['synthetic readiness','synthetic readiness']]))throw new Error('Local reranker unavailable');
  await this.provisionInventory();
 }
 async provisionInventory(){
  return this.core.database.raw.exclusive(async()=>{
  this.live();const eligible=(this.ports.store.sqlite.prepare('SELECT id FROM conversations WHERE branch_execution_id IS NULL').all() as {id:string}[]).filter(({id})=>Boolean(activeChatResourceOwner(this.ports.store,'chat',id)));
  const scopes=['global',...eligible.map(({id})=>'chat:'+id)];const initial=this.knownScopes.size===0;
  for(const scope of scopes){const guard=async()=>{this.live();if(scope!=='global'&&!activeChatResourceOwner(this.ports.store,'chat',scope.slice(5)))throw Error('Canonical Chat unavailable during provisioning');};const create=initial?this.freshPolicy:!this.knownScopes.has(scope);await checkedCollection(this.core.database.raw,scope,false,guard,create);await checkedCollection(this.core.database.raw,scope,true,guard,create);this.knownScopes.add(scope);}
  this.freshPolicy=false;
  });
 }

 private grant(chatId:string){return this.policy.prepare('SELECT * FROM local_memory_chat_grants WHERE chat_id=?').get(chatId) as {principal_id:string;read_global:number;revision:number;updated_at:string}|undefined;}
 getGrant(chatId:string,product:ProductScope){this.chat(chatId,product);const g=this.grant(chatId);if(g&&g.principal_id!==this.principalId)throw new MemoryDenied('Foreign memory grant principal');return {chatId,readGlobal:g?.read_global===1,revision:g?.revision??0};}
 setGrant(chatId:string,readGlobal:boolean,expectedRevision:number,product:ProductScope){
  if(typeof readGlobal!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new MemoryDenied('Boolean readGlobal and nonnegative expectedRevision required',400);
  const result=this.policy.transaction(()=>{
   const current=this.getGrant(chatId,product);if(current.revision!==expectedRevision)throw new MemoryDenied('Global memory grant revision conflict',409);
   const revision=current.revision+1;this.policy.prepare(`INSERT INTO local_memory_chat_grants VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET principal_id=excluded.principal_id,read_global=excluded.read_global,revision=excluded.revision,updated_at=excluded.updated_at`).run(chatId,this.principalId,readGlobal?1:0,revision,new Date().toISOString());
   return {chatId,readGlobal,revision};
  })();
  for(const e of this.speech.values())if(e.authority.chatId===chatId&&e.authority.readGlobal)this.invalidateSpeech(e,'global');
  return result;
 }
 private agentContext(token:string,tool:string,write:boolean):HostContext{
  this.live();const capability=this.ports.capabilities.get(token);if(!capability)throw new MemoryDenied('Unknown Agent capability',401);
  const run=this.ports.activeRuns.get(capability.agentId),agent=this.ports.store.getAgent(capability.agentId);
  if(!run||run.messageCapability!==token||run.controller.signal.aborted||!this.ports.ownsRun(capability,run))throw new MemoryDenied('Revoked or expired canonical Run');
  const lease=this.ports.store.sqlite.prepare('SELECT lease_expires_at FROM scheduler_runs WHERE id=? AND agent_id=? AND fencing_token=?').get(capability.v3SchedulerRunId,capability.agentId,capability.v3FencingToken) as {lease_expires_at:string}|undefined;
  if(!lease||!Number.isFinite(Date.parse(lease.lease_expires_at))||Date.parse(lease.lease_expires_at)<=Date.now())throw new MemoryDenied('Canonical scheduler lease expired');
  if(!agent||!agent.conversationId||capability.conversationId!==agent.conversationId||run.conversationId!==agent.conversationId||!activeChatResourceOwner(this.ports.store,'agent',agent.id))throw new MemoryDenied('Canonical Agent/Chat ownership unavailable');
  const owner=activeChatResourceOwner(this.ports.store,'agent',agent.id)!;
  const product:ProductScope=owner.branchId?'branches':'dev';
  this.chat(agent.conversationId,product);
  if(!capability.availableToolNames.includes(tool))throw new MemoryDenied('Tool not authorized for this Run');
  const policy=new CapabilityPolicyStore(this.ports.store.sqlite).resolveForAgent(agent.id,capability.v3SchedulerRunId),denied=new Set(policy.restrictedCapabilityIds);
  if(denied.has(write?CAPABILITY_IDS.memoryWrite:CAPABILITY_IDS.memoryRead))throw new MemoryDenied('Live memory capability policy denies operation');
  const grant=this.getGrant(agent.conversationId,product);
  return {chatId:agent.conversationId,actor:{kind:'agent',id:agent.id},runId:capability.v3SchedulerRunId,fenceToken:String(capability.v3FencingToken),active:true,grants:{readChat:!denied.has(CAPABILITY_IDS.memoryRead),readGlobal:!denied.has(CAPABILITY_IDS.memoryRead)&&grant.readGlobal,writeChat:!denied.has(CAPABILITY_IDS.memoryWrite),writeGlobal:!denied.has(CAPABILITY_IDS.memoryWrite)},sourceType:'ai_inference'};
 }
 async executeAgent(token:string,operation:string,args:unknown){
  const parsed=validateMemoryCall(operation,args),tool='ponderosa_local_memory_'+operation,write=['save','update','forget'].includes(operation);this.agentContext(token,tool,write);await this.ready();const initial=this.agentContext(token,tool,write);
  const globalWrite=write&&parsed.destination==='global';const usesGlobal=(globalWrite||!write&&parsed.source!=='chat')&&initial.grants.readGlobal;if(globalWrite&&parsed.visibility==='private')throw new MemoryDenied('Global private audience unsupported',400);if(globalWrite&&operation!=='save'&&!initial.grants.readGlobal)throw new MemoryDenied('Existing global source mutation requires read authority');const needsRead=!write||initial.grants.readChat;if(write&&operation!=='save'&&!initial.grants.readChat)throw new MemoryDenied('Existing source mutation requires read authority');const identity=JSON.stringify([initial.chatId,initial.actor,initial.runId,initial.fenceToken]);const guard=async()=>{const c=this.agentContext(token,tool,write);if(JSON.stringify([c.chatId,c.actor,c.runId,c.fenceToken])!==identity)throw new MemoryDenied('Canonical memory binding changed');if((needsRead&&!c.grants.readChat)||(usesGlobal&&!c.grants.readGlobal)||(write&&!(globalWrite?c.grants.writeGlobal:c.grants.writeChat)))throw new MemoryDenied('Live memory grant revoked');};
  if(write&&!(globalWrite?initial.grants.writeGlobal:initial.grants.writeChat))throw new MemoryDenied('Memory write denied');if(!write&&parsed.source==='global'&&!initial.grants.readGlobal)throw new MemoryDenied('Global read denied');
  const authority:MemoryAuthority={...initial,readChat:initial.grants.readChat,readGlobal:usesGlobal,writeScope:write?(globalWrite?'global':'chat:'+initial.chatId):undefined,targetId:write&&operation!=='save'?parsed.chunk_id:undefined,visibility:parsed.visibility??'team',guard};
  const promise=this.perform(operation,parsed,authority);this.calls.add(promise);try{return await promise;}finally{this.calls.delete(promise);}
 }
 private async perform(operation:string,args:Record<string,any>,authority:MemoryAuthority){
  return this.core.database.run(authority,async()=>{await authority.guard();const scope=args.source==='global'||args.destination==='global'?'global':'chat:'+authority.chatId;
   const receiptKey=createHash('sha256').update(JSON.stringify([authority.chatId,authority.actor,authority.runId,authority.fenceToken,authority.writeScope?args.visibility??'write':'read',scope])).digest('hex');
   const tool=({save:'store',update:'update',forget:'delete',get:'get_chunk',search:'search',history:'get_evolution_chain'}as Record<string,string>)[operation];
   const parameters=operation==='save'?{text:args.text,source_type:authority.sourceType}:operation==='update'?{chunk_id:args.chunk_id,new_text:args.text,strategy:'version',source_type:authority.sourceType}:operation==='forget'?{chunk_id:args.chunk_id,hard_delete:false}:operation==='search'?{query:args.query,top_k:args.top_k??5,include_deprecated:args.include_history??false}: {chunk_id:args.chunk_id};
   const bound=new PonderosaMemory(this.core).bindChat({chatId:authority.chatId,authorize:async()=>{await authority.guard();return{readGlobal:authority.readGlobal,writeChat:authority.writeScope===`chat:${authority.chatId}`,writeGlobal:authority.writeScope==='global'};},sourceType:()=>authority.sourceType});const result=await bound.call({tool:tool!,arguments:parameters,destination:args.destination,source:args.source},receiptKey);
   // Only returned write previews are provider context; internal reconciliation reads are not.
   if(authority.actor.kind==='agent'&&authority.writeScope)for(const candidate of [...((result as any).candidate_update_targets??[]),...((result as any).candidate_stale_parallel_chunks??[])]){
    try{const row=await this.core.database.get(candidate.chunk_id,[authority.writeScope]);
     if(row&&row.text.replace(/\s+/g,' ').slice(0,140)===candidate.text_preview&&row.metadata.deprecated===candidate.deprecated&&
      (row.metadata.last_modified||row.metadata.timestamp)===candidate.last_modified&&(row.metadata.supersedes||'')===candidate.supersedes)this.noteSpeechRead(authority,row);
     else this.denySpeech(authority);
    }catch{this.denySpeech(authority);} // Preserve the committed write even if speech cannot be verified.
   }
   await authority.guard();return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:{result},isError:false};
  });
 }

 operator(request:FastifyRequest){
  this.live();if(request.raw.aborted)throw new MemoryDenied('Operator request aborted');
  const token=request.headers.authorization?.replace(/^Bearer\s+/i,'');if(token&&this.ports.capabilities.has(token))throw new MemoryDenied('Agent capability is not operator authority',401);
  // Origin checks apply at the request boundary; no operator login is required.
  return this.principalId;
 }
 async executeOperator(request:FastifyRequest,operation:string,args:Record<string,unknown>){
  this.operator(request);const parsed=validateMemoryCall(operation,args);await this.ready();const write=['save','update','forget'].includes(operation);if(write?parsed.destination!=='global':parsed.source!=='global')throw new MemoryDenied('Explicit global scope required',400);if(parsed.visibility==='private')throw new MemoryDenied('Global private audience unsupported',400);
  const authority:MemoryAuthority={chatId:'operator-global',actor:{kind:'user',id:this.principalId},runId:'operator-request:'+request.id,fenceToken:request.id,sourceType:'user_statement',readChat:false,readGlobal:true,writeScope:write?'global':undefined,targetId:write&&operation!=='save'?parsed.chunk_id:undefined,guard:async()=>{this.operator(request);}};
  const promise=this.perform(operation,parsed,authority);this.calls.add(promise);try{return await promise;}finally{this.calls.delete(promise);}
 }

 /** Host package inventory only. Callers must complete their human import/export admission first. */
 async exportPackageMemory(chatId:string,agentIds:string[]){
  const guard=async()=>{this.chat(chatId);for(const id of agentIds){const agent=this.ports.store.getAgent(id);if(!agent||agent.conversationId!==chatId||!activeChatResourceOwner(this.ports.store,'agent',id))throw new MemoryDenied('Package Agent ownership changed');}};
  await guard();await this.ready();const pending=this.core.database.exportPackageMemory(chatId,agentIds,guard);this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }
 async restorePackageMemory(snapshot:unknown,chatId:string,agents:Readonly<Record<string,string>>,operationId:string){
  const guard=async()=>{this.chat(chatId);for(const id of Object.values(agents)){const agent=this.ports.store.getAgent(id);if(!agent||agent.conversationId!==chatId||!activeChatResourceOwner(this.ports.store,'agent',id))throw new MemoryDenied('Package destination Agent ownership changed');}};
  await guard();await this.ready();const pending=this.core.database.restorePackageMemory(snapshot,chatId,agents,operationId,guard);this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }

 private importMemoryGuard(operationId:string,agents?:Readonly<Record<string,string>>,signal?:AbortSignal){
  return async()=>{
   this.live();signal?.throwIfAborted();const store=this.ports.store,op=store.getAgentCreationOperation(operationId);
   if(!op||op.kind!=='import'||op.status!=='preparing'||!op.conversationId)throw new MemoryDenied('Exact preparing package import required');
   const chat=store.getConversation(op.conversationId);
   if(!chat||chat.projectId!==op.projectId||store.sqlite.prepare('SELECT 1 FROM conversations WHERE id=? AND branch_execution_id IS NOT NULL').get(chat.id)||store.sqlite.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(op.projectId)||store.sqlite.prepare('SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=?').get(chat.id))throw new MemoryDenied('Package memory destination retired');
   if(chat.branchId&&!store.sqlite.prepare('SELECT 1 FROM branches WHERE id=? AND deleting=0').get(chat.branchId))throw new MemoryDenied('Package Branch retired');
   if(!activeChatResourceOwner(store,'chat',chat.id)){
    const staged=store.sqlite.prepare("SELECT r.staging_plan_id AS plan FROM branch_installation_resources r JOIN branch_installation_plans p ON p.id=r.staging_plan_id WHERE r.local_id=? AND r.agent_ref='' AND r.state='staging' AND p.state='applying' AND r.branch_id=?").get(chat.id,chat.branchId) as {plan:string}|undefined;
    if(!staged||op.agentIds.some(id=>!store.sqlite.prepare("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND state='staging' AND staging_plan_id=? AND creation_operation_id=?").get(id,staged.plan,op.id)))throw new MemoryDenied('Exact staged Branch import ownership required');
   }
   for(const id of Object.values(agents??{})){
    const agent=store.getAgent(id);
    if(!op.agentIds.includes(id)||!agent||agent.projectId!==op.projectId||agent.conversationId!==chat.id||store.sqlite.prepare('SELECT 1 FROM agent_deletion_pending WHERE agent_id=?').get(id))throw new MemoryDenied('Exact pending package Agent membership required');
   }
  };
 }
 prepareImportMemory(operationId:string,memory:NonNullable<import('@ponderosa/core').AgentPortablePackageDto['memory']>){
  const op=this.ports.store.getAgentCreationOperation(operationId);if(!op?.conversationId||op.status!=='preparing')throw new MemoryDenied('Preparing package import required');
  return memory.map((entry,index)=>({...this.core.database.packageMemoryIds(entry.snapshot,op.conversationId!,operationId+':m:'+index),namespace:operationId+':m:'+index}));
 }
 async restoreImportMemory(operationId:string,entry:NonNullable<import('@ponderosa/core').AgentPortablePackageDto['memory']>[number],agents:Readonly<Record<string,string>>,namespace:string,signal?:AbortSignal){
  const op=this.ports.store.getAgentCreationOperation(operationId);if(!op?.conversationId)throw new MemoryDenied('Package import missing destination');
  const guard=this.importMemoryGuard(operationId,agents,signal);await guard();await this.ready();
  const pending=this.core.database.restorePackageMemory(entry.snapshot,op.conversationId,agents,namespace,guard,operationId);this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }
 async rollbackImportMemory(operationId:string){
  const store=this.ports.store,op=store.getAgentCreationOperation(operationId);const plan=(op?.result as {memoryPlan?:Array<{chatId:string;namespace:string;chunkIds:string[];conflictIds:string[]}>}|undefined)?.memoryPlan;
  if(!plan?.length)return;
  const guard=async()=>{this.live();const current=store.getAgentCreationOperation(operationId);if(!current||current.kind!=='import'||!['preparing','rolling_back'].includes(current.status)||current.projectId!==op!.projectId||current.conversationId!==op!.conversationId)throw new MemoryDenied('Exact failed package import cleanup required');};
  const pending=(async()=>{for(const item of plan){if(item.chatId!==op!.conversationId)throw new MemoryDenied('Memory cleanup Chat mismatch');await this.core.database.rollbackPackageMemory(item,operationId,guard);}await guard();store.updateAgentCreationOperation(operationId,{result:{phase:'memory_rolled_back'}});})();
  this.calls.add(pending);try{await pending;}finally{this.calls.delete(pending);}
 }

 fence(){this.closed=true;for(const e of this.speech.values())e.invalid=true;}
 async close(){this.fence();await Promise.allSettled([...this.calls]);try{await this.core.close();}finally{if(this.policy.open)this.policy.close();}}
}
const services=new WeakMap<FastifyInstance,LocalMemoryService>();
export const localMemoryFor=(app:FastifyInstance)=>services.get(app);
export function registerLocalMemory(app:FastifyInstance,ports:Ports){
 if(!ports.opts.localMemory)return;
 const memory=new LocalMemoryService(ports);services.set(app,memory);
 app.addHook('onReady',()=>memory.ready());app.addHook('preClose',async()=>memory.fence());app.addHook('onClose',()=>memory.close());
 app.addHook('onSend',async(request,reply)=>{if(!['GET','HEAD'].includes(request.method)&&reply.statusCode<300)memory.checkSpeechAuthorities();if(request.method==='POST'&&reply.statusCode<300&&['/api/chats','/api/branches/:id/chats','/api/branches/installations/:id/confirm'].includes(request.routeOptions.url??''))await memory.provisionInventory();});
 const error=(reply:any,e:unknown)=>reply.code(e instanceof MemoryDenied?e.statusCode:500).send({error:e instanceof Error?e.message:String(e)});
 app.post('/api/agent-local-memory',async(request,reply)=>{try{const body=request.body as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))throw new MemoryDenied('Invalid memory call',400);const {operation,...args}=body;return await memory.executeAgent(request.headers.authorization?.replace(/^Bearer\s+/i,'')??'',String(operation),args);}catch(e){return error(reply,e);}});
 app.post('/api/local-memory/global',async(request,reply)=>{try{const body=request.body as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))throw new MemoryDenied('Invalid global memory call',400);const {operation,...args}=body;return await memory.executeOperator(request,String(operation),args);}catch(e){return error(reply,e);}});
 app.get<{Params:{chatId:string}}>('/api/local-memory/grants/:chatId',async(request,reply)=>{try{memory.operator(request);return memory.getGrant(request.params.chatId,requestProduct(request));}catch(e){return error(reply,e);}});
 app.put<{Params:{chatId:string};Body:{readGlobal:boolean;expectedRevision:number}}>('/api/local-memory/grants/:chatId',async(request,reply)=>{try{memory.operator(request);const b=request.body;if(!b||Object.keys(b).some(k=>!['readGlobal','expectedRevision'].includes(k)))throw new MemoryDenied('Unsupported grant arguments',400);return memory.setGrant(request.params.chatId,b.readGlobal,b.expectedRevision,requestProduct(request));}catch(e){return error(reply,e);}});
 return memory;
}
