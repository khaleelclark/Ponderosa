import {globalMemoryHash,selectGlobalMemory} from './portable-global-memory.js';
import {MEMORY_SNAPSHOT_MAX_BYTES} from './portable-memory-snapshot.js';
import type {GlobalMemorySelectionDto} from '@ponderosa/core';
import path from 'node:path';
import fs from '@ponderosa/native-host/fs';
import Database from 'better-sqlite3';
import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {CapabilityPolicyStore,CoordinationV3Store,readBranchExpertCopy,hasRetainedTemporaryChatScope,sourceMutationState,type AgentStore,type AgentDeletionReceipt,type BranchExpertCopyReceipt} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {type Chunk,type Inference} from '@local-memory/mcp-node-private';
import {HostMemoryRuntime,checkedCollection,createPlannedCollection,MemoryCollectionHold,MEMORY_CLEANUP_HOLD_REASONS,MEMORY_CLEANUP_UNKNOWN_HOLD,MEMORY_CLEANUP_PROVISION_HOLD,MEMORY_CLEANUP_RECEIPT_HOLD,type MemoryAuthority} from './local-memory-authority.js';
import {PonderosaMemory} from '@local-memory/mcp-node-private/ponderosa';
import {MemoryArgumentError,validateMemoryCall} from './local-memory-catalog.js';
const MEMORY_SCOPE_RECEIPT_MISMATCH='Memory scope creation receipt does not match current scope and installation';
type HostContext={chatId:string;actor:{kind:'agent'|'user';id:string;operator?:boolean};runId:string;fenceToken:string;active:boolean;sourceType:'user_statement'|'ai_inference';grants:{readChat:boolean;readGlobal:boolean;writeChat:boolean;writeGlobal:boolean}};
import type {CreateServerOptions,AgentMessageCapability,ActiveRun} from './app-contracts.js';
import {activeChatResourceOwner} from './branch-resource-owner.js';
import {requestProduct,resourceInProduct,type ProductScope} from './product-scope.js';

type Ports={opts:CreateServerOptions;store:AgentStore;capabilities:Map<string,AgentMessageCapability>;activeRuns:Map<string,ActiveRun>;ownsRun:(capability:AgentMessageCapability,run:ActiveRun|undefined)=>boolean;publishInvalidation?:(agentId:string,event:import('@ponderosa/core').MemoryChangedEvent)=>void;beforeGlobalMemoryRevocation?:(chatId:string)=>void};
class MemoryDenied extends Error{constructor(message:string,readonly statusCode=403){super(message);}}
export class MemoryHostClosing extends MemoryDenied{constructor(){super('Local memory host is closing');}}
/** Host authority view; physical sources/business operations stay in immutable private.6. No memory journal or command receipt state. */
export class LocalMemoryService{
 readonly core:HostMemoryRuntime;
 readonly principalId:string;
 private policy!:Database.Database;
 private readonly coordination:CoordinationV3Store;
 private expertFinalCustodyVerifier?: (chatId:string,projectId:string)=>void|Promise<void>;
 private closed=false;
 private calls=new Set<Promise<unknown>>();
 private policyCustodyCheck:()=>void=()=>{throw Error('Memory policy custody not initialized');};
 private knownScopes=new Set<string>();
 private missingExistingScopes=new Set<string>();
 private initialized?:Promise<void>;
 // One process-local aggregate per Agent; missing evidence never blocks
 // ordinary use and cannot authorize retained memory context.
 private readonly unusedMemoryRuns=new Map<string,{originRunId:string;lastRunId:string;previousRunId?:string;lastFence:number;count:number;projectId:string;chatId:string;signature:string;attempted:boolean;authorizationChanged:boolean;earliestUnsafeFence?:number;runs:Map<string,{pending:number;unsafe:boolean;read:boolean;fence:number}>}>();
 private readonly unobservedMemoryAttempts=new WeakSet<ActiveRun>();
 private readonly sourceCapture=new AsyncLocalStorage<Map<string,{id:string;scope:string;hash:string}>>();
 private deniedSpeech=new WeakSet<ActiveRun>();
 private speech=new Map<string,{authority:MemoryAuthority;signature:string;refs:Map<string,{id:string;scope:string;hash:string}>;invalid:boolean;expires:number;started:boolean}>();
 constructor(readonly ports:Ports,inference?:Inference){
  this.coordination=new CoordinationV3Store(ports.store.sqlite);
  const c=ports.opts.localMemory!;if('journalDirectory'in c)throw Error('Legacy journalDirectory is unsupported; preserve old files and configure a fresh ordinary stateDirectory');
  const directory=path.resolve(c.stateDirectory),canonical=fs.realpathSync(ports.opts.dataDir);if(directory===canonical||directory.startsWith(canonical+path.sep))throw Error('Memory policy state must be outside canonical dataDir');
  const initialWitness=ports.store.sqlite.prepare('SELECT * FROM local_memory_host_binding WHERE singleton=1').get() as {state:string;policy_custody:string|null;data_generation:string}|undefined;
  const initialGeneration=(ports.store.sqlite.prepare('SELECT generation_id FROM _state_generation WHERE singleton=1').get() as {generation_id:string}).generation_id;
  if(initialWitness&&initialWitness.data_generation!==initialGeneration)throw Error('Local memory host binding differs');
  // A bound policy directory is existing user data. Never create a replacement
  // directory before its exact custody has been checked.
  if(initialWitness?.state!=='bound')fs.mkdirSync(directory,{recursive:true,mode:0o700});
  try{if(fs.realpathSync(directory)!==directory)throw Error('Memory policy state aliases unsupported');}
  catch(error){if(initialWitness?.state==='bound'&&(error as NodeJS.ErrnoException).code==='ENOENT')throw Error('Established local memory policy is missing; existing memory was preserved');throw error;}
  const d=fs.lstatSync(directory);if(!d.isDirectory()||(d.mode&0o077))throw Error('Memory policy state must be private');
  const custody=(file:string)=>{
   const dir=fs.lstatSync(directory,{bigint:true}),policy=fs.lstatSync(file,{bigint:true});
   if(!dir.isDirectory()||!policy.isFile()||policy.nlink!==1n)throw Error('Memory policy requires private regular file');
   if(dir.dev<=0n||dir.ino<=0n||policy.dev<=0n||policy.ino<=0n)throw Error('Memory policy physical custody unavailable');
   return createHash('sha256').update(JSON.stringify([directory,dir.dev.toString(),dir.ino.toString(),policy.dev.toString(),policy.ino.toString()])).digest('hex');
  };
  if(initialWitness?.state==='bound'){
   let current;try{current=custody(path.join(directory,'host-policy.sqlite'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('Established local memory policy is missing; existing memory was preserved');throw error;}
   if(current!==initialWitness.policy_custody)throw Error('Memory policy custody changed; review before use');
  }
  if(['state.json','owner.lock','journal.sqlite'].some(n=>fs.readdirSync(directory).includes(n)))throw Error('Legacy journal directory refused; no adoption or cleanup');
  if(!fs.readdirSync(directory).includes('host-policy.sqlite')&&c.provision!==true)throw Error('Fresh policy requires explicit provision:true');
  this.core=new HostMemoryRuntime({storage:'chroma',chroma:{url:c.chromaUrl,collectionPrefix:c.collectionPrefix,create:false},modelDir:c.modelDir,inference,accessTracking:false,backupDir:path.join(directory,'backups')},signature=>{
   const file=path.join(directory,'host-policy.sqlite');
   const canonical=ports.store.sqlite;
   const witness=canonical.prepare('SELECT * FROM local_memory_host_binding WHERE singleton=1').get() as {data_generation:string;state:string;principal_id:string|null;storage_binding:string|null;policy_custody:string|null}|undefined;
   const currentGeneration=(canonical.prepare('SELECT generation_id FROM _state_generation WHERE singleton=1').get() as {generation_id:string}).generation_id;
   if(witness&&(witness.data_generation!==currentGeneration||witness.state==='never_configured'&&(witness.principal_id!==null||witness.storage_binding!==null||witness.policy_custody!==null)||witness.state==='bound'&&(typeof witness.principal_id!=='string'||typeof witness.storage_binding!=='string'||typeof witness.policy_custody!=='string'||! /^[0-9a-f]{64}$/.test(witness.policy_custody))||!['never_configured','bound'].includes(witness.state)))throw Error('Local memory host binding differs');
   let fresh=false;
   if(witness?.state==='bound'){
    // Never recreate a missing established policy, even if provision:true
    // remains in the operator's persistent configuration.
    try{const fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);fs.closeSync(fd);}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Error('Established local memory policy is missing; existing memory was preserved');throw e;}
   }else {
    // An unwitnessed old installation with a missing policy is ambiguous:
    // its prior memory may have been lost. Only a witnessed fresh bootstrap
    // may create a new policy without an explicit recovery decision.
    if(!witness&&!fs.readdirSync(directory).includes('host-policy.sqlite'))throw Error('Local memory policy has no first-install witness; review existing memory before provisioning');
    try{const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);fresh=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   }
   const st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1||(st.mode&0o077))throw Error('Memory policy requires private regular file');const physicalCustody=custody(file);if(witness?.state==='bound'&&witness.policy_custody!==physicalCustody)throw Error('Memory policy custody changed; review before use');let policy=new Database(file,{fileMustExist:true,readonly:!fresh});
   const installation='CREATE TABLE local_memory_installation(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL CHECK(format=2),principal_id TEXT NOT NULL UNIQUE,data_generation TEXT NOT NULL,storage_binding TEXT NOT NULL)';
   const grants='CREATE TABLE local_memory_chat_grants(chat_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,read_global INTEGER NOT NULL CHECK(read_global IN (0,1)),revision INTEGER NOT NULL CHECK(revision>0),updated_at TEXT NOT NULL)';
   const generation=(ports.store.sqlite.prepare('SELECT generation_id FROM _state_generation WHERE singleton=1').get() as {generation_id:string}).generation_id;
   const binding=createHash('sha256').update(JSON.stringify({url:c.chromaUrl,prefix:c.collectionPrefix,signature})).digest('hex');
   try{if(fresh){if(c.provision!==true)throw Error('Fresh policy requires explicit provision:true');policy.transaction(()=>{policy.exec(installation+';'+grants);policy.pragma('application_id=1280135220');policy.pragma('user_version=2');policy.prepare('INSERT INTO local_memory_installation VALUES(1,2,?,?,?)').run(randomUUID(),generation,binding);})();}
    if(policy.pragma('application_id',{simple:true})!==1280135220||policy.pragma('user_version',{simple:true})!==2)throw Error('Legacy/foreign policy format refused; no automatic migration');
    const tables=policy.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string;sql:string}[];if(tables.length!==2||tables.find(t=>t.name==='local_memory_installation')?.sql!==installation||tables.find(t=>t.name==='local_memory_chat_grants')?.sql!==grants)throw Error('Incompatible memory policy schema');
    const rows=policy.prepare('SELECT * FROM local_memory_installation').all() as any[],principal=rows[0];if(rows.length!==1||principal.id!==1||principal.format!==2||typeof principal.principal_id!=='string'||!/^[0-9a-f-]{36}$/.test(principal.principal_id)||principal.data_generation!==generation||principal.storage_binding!==binding)throw Error('Foreign memory policy installation/storage binding');
    if(policy.prepare('SELECT 1 FROM local_memory_chat_grants WHERE principal_id!=? OR revision<1 OR read_global NOT IN (0,1)').get(principal.principal_id))throw Error('Foreign memory policy grant');
    canonical.transaction(()=>{
     const existing=canonical.prepare('SELECT * FROM local_memory_host_binding WHERE singleton=1').get() as {data_generation:string;state:string;principal_id:string|null;storage_binding:string|null;policy_custody:string|null}|undefined;
     if(existing){
      if(existing.data_generation!==generation)throw Error('Local memory host binding differs');
      if(custody(file)!==physicalCustody)throw Error('Memory policy custody changed during binding');
      if(existing.state==='bound'){if(existing.principal_id!==principal.principal_id||existing.storage_binding!==binding||existing.policy_custody!==physicalCustody)throw Error('Local memory host binding differs');}
      else if(existing.state==='never_configured'&&existing.principal_id===null&&existing.storage_binding===null&&existing.policy_custody===null)canonical.prepare("UPDATE local_memory_host_binding SET state='bound',principal_id=?,storage_binding=?,policy_custody=? WHERE singleton=1 AND state='never_configured'").run(principal.principal_id,binding,physicalCustody);
      else throw Error('Local memory host binding differs');
     }else canonical.prepare("INSERT INTO local_memory_host_binding VALUES(1,?,'bound',?,?,?)").run(generation,principal.principal_id,binding,physicalCustody);
     if(fresh||existing?.state==='never_configured'){
      // Initial scopes are planned atomically with the first binding before
      // any remote create. Inactive durable Chats retain their plan until
      // their exact active owner is available; existing names are never adopted.
      const scopes=[{id:'global',project:'global'},...(canonical.prepare('SELECT id,project_id FROM conversations WHERE branch_execution_id IS NULL').all() as {id:string;project_id:string}[]).map(row=>({id:row.id,project:row.project_id}))];
      const insert=canonical.prepare("INSERT INTO local_memory_scope_provisioning(chat_id,project_id,data_generation,principal_id,storage_binding,intent_id,memory_state,log_state,created_at) VALUES(?,?,?,?,?,?,'planned','planned',?)");
      for(const scope of scopes)insert.run(scope.id,scope.project,generation,principal.principal_id,binding,randomUUID(),new Date().toISOString());
     }
    }).immediate();
    if(!fresh){policy.close();policy=new Database(file,{fileMustExist:true});}
    this.policyCustodyCheck=()=>{try{if(fs.realpathSync(directory)!==directory||custody(file)!==physicalCustody)throw Error('changed');}catch{throw Error('Memory policy custody changed; review before use');}};
    this.policyCustodyCheck();this.policy=policy;return principal.principal_id;
   }catch(e){policy.close();throw e;}
  },path.join(directory,'source-mutation-holds'));this.principalId=this.core.database.principal;
   this.core.database.setCollectionProof({
    check:(scope,log,metadata,collectionId,retiring)=>{
     const id=scope==='global'?'global':scope.startsWith('chat:')?scope.slice(5):'';
     if(!id)throw Error('Memory scope identity invalid');
     const intent=this.memoryIntent(id,retiring);if(!intent)return;
     const kind=log?'log':'memory',state=log?intent.log_state:intent.memory_state;
     const expectedId=log?intent.log_collection_id:intent.memory_collection_id;
     if(state!=='confirmed')throw new MemoryCollectionHold('Memory collection creation is unverified; review its provisioning hold');
     if(!expectedId||collectionId!==expectedId||metadata?.ponderosa_provision_intent!==intent.intent_id+':'+kind){
      this.missingExistingScopes.add(scope);
      throw new MemoryCollectionHold('Memory collection does not match its retained creation identity');
     }
    },
    missing:(scope,log,retiring)=>{
     const id=scope==='global'?'global':scope.startsWith('chat:')?scope.slice(5):'';
     if(!id)return;
     const intent=this.memoryIntent(id,retiring),state=intent&&(log?intent.log_state:intent.memory_state);
     if(!intent||state==='confirmed')this.missingExistingScopes.add(scope);
    },
   });
   this.core.database.packageVisible=id=>this.ports.store.getAgentCreationOperation(id)?.status==='completed'&&!this.ports.store.sqlite.prepare("SELECT 1 FROM branch_installation_resources r JOIN branch_installation_plans p ON p.id=r.staging_plan_id WHERE r.creation_operation_id=? AND p.state!='completed'").get(id);
   this.core.database.onRead=(a,row)=>this.noteSpeechRead(a,row);
   this.core.database.onMutation=(scope,id)=>{
    this.ports.store.sqlite.prepare(`UPDATE memory_exposure_runs SET mutation_epoch=mutation_epoch+1 WHERE run_id IN
     (SELECT run_id FROM memory_exposure_sources WHERE scope=? AND source_id=?)`).run(scope,id);
    for(const entry of this.speech.values())if(entry.refs.has(JSON.stringify([scope,id])))this.invalidateSpeech(entry,scope==='global'?'global':'chat');
   };
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
 private transitionChunkHash(row:Chunk){
  // Access counters and modification time can change without changing the
  // disclosed source or its access/deprecation authority.
  const metadata=Object.entries(row.metadata).filter(([key])=>!['last_modified','access_count','last_accessed'].includes(key))
   .sort(([a],[b])=>a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([row.id,row.scope,row.text,metadata])).digest('hex');
 }
 private noteSpeechRead(a:MemoryAuthority,row:Chunk){
  if(a.actor.kind!=='agent')return; // Operator browsing is not a provider Run exposure.
  const hash=this.chunkHash(row),sourceHash=this.transitionChunkHash(row),capture=this.sourceCapture.getStore(),key=JSON.stringify([row.scope,row.id]);
  if(capture){
   const previous=capture.get(key);
   if(previous&&previous.hash!==sourceHash)this.ports.store.sqlite.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE run_id=?').run(a.runId);
   else capture.set(key,{id:row.id,scope:row.scope,hash:sourceHash});
  }
  let entry;try{entry=this.speechEntry(a);}catch{this.denySpeech(a);return;}const prior=entry.refs.get(key);
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
 private exposureValid(runId:string,requireStarted:boolean){
  const e=this.speech.get(runId);if(!e||(requireStarted&&!e.started)||e.invalid||e.expires<Date.now())return false;
  try{if(e.signature!==this.speechSignature(e.authority))this.invalidateSpeech(e);}catch{this.invalidateSpeech(e);}return !e.invalid;
 }
 speechCommitValid(runId:string){return this.exposureValid(runId,true);}
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
 private async validateSpeechNow(runId:string,requireStarted=true):Promise<boolean>{
  const e=this.speech.get(runId);if(!e||!this.exposureValid(runId,requireStarted))return false;
  const guard=async()=>{if(!this.exposureValid(runId,requireStarted))throw new MemoryDenied('Speech memory context changed');};
  try{
   await this.core.database.run({...e.authority,observeExposure:false,guard},async()=>{
    for(const ref of e.refs.values()){const row=await this.core.database.get(ref.id,[ref.scope]);if(!row||this.chunkHash(row)!==ref.hash){this.invalidateSpeech(e,ref.scope==='global'?'global':'chat');throw new MemoryDenied('Speech memory source changed');}}
   });return this.exposureValid(runId,requireStarted);
  }catch{this.invalidateSpeech(e);return false;}
 }
 /** Installed by the Branch host; absent or unverifiable custody keeps cleanup held. */
 setExpertFinalCustodyVerifier(verify:(chatId:string,projectId:string)=>void|Promise<void>){
  if(this.expertFinalCustodyVerifier)throw Error('Temporary copy custody verifier is already installed');
  this.expertFinalCustodyVerifier=verify;
 }
 private async verifyExpertFinalCustody(chatId:string,projectId:string){
  if(!this.expertFinalCustodyVerifier)throw new MemoryCollectionHold('Temporary agent copy memory is retained until its final custody is confirmed');
  try{await this.expertFinalCustodyVerifier(chatId,projectId);}catch(error){throw new MemoryCollectionHold('Temporary agent copy memory is retained until its final custody is confirmed');}
 }
 private async retire(operation:()=>Promise<void>){
  this.live();const pending=operation();this.calls.add(pending);try{await pending;}finally{this.calls.delete(pending);}
 }
 async purgeChat(chatId:string){
  return this.retire(async()=>{
   await this.ready();
   let expertProject:string|undefined;
   const checkDeletion=()=>{this.live();const receipt=this.ports.store.getConversationDeletionReceipt(chatId);if(!receipt?.canonicalDeletionCompleted||this.ports.store.getConversation(chatId,{includeDeleting:true}))throw new MemoryDenied('Exact committed Chat deletion required');};
   const guard=async()=>{checkDeletion();if(expertProject){await this.verifyExpertFinalCustody(chatId,expertProject);checkDeletion();}};
   await guard();const receipt=this.ports.store.getConversationDeletionReceipt(chatId)!;
   if(this.hasExpertMemory(chatId,receipt.projectId)){expertProject=receipt.projectId;await guard();}
   if(!this.isProvenTemporaryChat(chatId,receipt.projectId,receipt.branchId)){
    // Serialize this no-effect proof with provisioning.
    const neverProvisioned=await this.core.database.raw.exclusive(async()=>{
     await guard();
     if(this.isProvenUnprovisionedChat(chatId,receipt.projectId))return true;
     const scope='chat:'+chatId;
     // A submitted remote mutation may still complete. Never turn that
     // uncertainty into an unverified delete or a repeated cleanup.
     if(this.core.database.scopeHasUnsettledMutation(scope))throw Error(MEMORY_CLEANUP_UNKNOWN_HOLD);
     const retained=this.ports.store.sqlite.prepare('SELECT 1 FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId);
     if(retained){
      let intent;try{intent=this.memoryIntent(chatId,true);}catch(error){
       const reason=error instanceof Error&&error.message===MEMORY_SCOPE_RECEIPT_MISMATCH?MEMORY_CLEANUP_RECEIPT_HOLD:MEMORY_CLEANUP_PROVISION_HOLD;
       throw new Error(reason,{cause:error});
      }
      const binding=this.ports.store.sqlite.prepare('SELECT state,data_generation,principal_id,storage_binding FROM local_memory_host_binding WHERE singleton=1').get() as {state:string;data_generation:string;principal_id:string;storage_binding:string}|undefined;
      if(!intent||intent.memory_state!=='confirmed'||intent.log_state!=='confirmed'||!intent.memory_collection_id||!intent.log_collection_id||!binding||binding.state!=='bound'||
         binding.data_generation!==intent.data_generation||binding.principal_id!==intent.principal_id||binding.storage_binding!==intent.storage_binding)throw Error(MEMORY_CLEANUP_PROVISION_HOLD);
     }
     // Pre-0044 scopes have no intent. They retain the existing configured
     // internal namespace behavior and are checked by the collection authority.
     return false;
    });
    if(!neverProvisioned)await this.core.database.purge('chat:'+chatId,guard);
    await guard();
   }else if(this.core.database.scopeHasUnsettledMutation('chat:'+chatId))throw Error(MEMORY_CLEANUP_UNKNOWN_HOLD);
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
   for(const target of targets)if(target.conversation_id){
    await guard();const chat=store.getConversation(target.conversation_id,{includeDeleting:true});
    const branchId=chat?.branchId??store.getConversationDeletionReceipt(target.conversation_id)?.branchId;
    const expert=this.hasExpertMemory(target.conversation_id,target.project_id);
    const scopedGuard=async()=>{await guard();if(expert){await this.verifyExpertFinalCustody(target.conversation_id!,target.project_id);await guard();}};
    if(this.isProvenTemporaryChat(target.conversation_id,target.project_id,branchId,target.id)){if(this.core.database.scopeHasUnsettledMutation('chat:'+target.conversation_id))throw Error(MEMORY_CLEANUP_UNKNOWN_HOLD);}
    else await this.core.database.purge('chat:'+target.conversation_id,scopedGuard,target.id);
   }
   for(const target of targets)this.unusedMemoryRuns.delete(target.id);
  });
 }
 async purgeProject(projectId:string){
  return this.retire(async()=>{
   await this.ready();const store=this.ports.store;
   const guard=async()=>{this.live();if(!store.sqlite.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(projectId))throw new MemoryDenied('Exact pending Project deletion required');};
   await guard();const chats=store.sqlite.prepare('SELECT id FROM conversations WHERE project_id=?').all(projectId) as {id:string}[];
   for(const {id}of chats){const chat=store.getConversation(id,{includeDeleting:true});await guard();const expert=this.hasExpertMemory(id,projectId),scopedGuard=async()=>{await guard();if(expert){await this.verifyExpertFinalCustody(id,projectId);await guard();}};if(chat&&this.isProvenTemporaryChat(id,projectId,chat.branchId)){if(this.core.database.scopeHasUnsettledMutation('chat:'+id))throw Error(MEMORY_CLEANUP_UNKNOWN_HOLD);}else await this.core.database.purge('chat:'+id,scopedGuard);await scopedGuard();this.policy.prepare('DELETE FROM local_memory_chat_grants WHERE chat_id=? AND principal_id=?').run(id,this.principalId);this.knownScopes.delete('chat:'+id);}
   for(const [id,entry]of this.unusedMemoryRuns)if(entry.projectId===projectId)this.unusedMemoryRuns.delete(id);
  });
 }
 // An exact, still-planned first-creation intent proves neither remote
 // collection create was submitted by this installation. Do not access any
 // independently created same-name collection. Caller holds the memory lock.
 private isProvenUnprovisionedChat(chatId:string,projectId:string):boolean{
  this.live();const db=this.ports.store.sqlite,scope='chat:'+chatId;
  if(this.core.database.scopeHasUnsettledMutation(scope))return false;
  const row=db.prepare('SELECT * FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId) as {project_id:string;data_generation:string;principal_id:string;storage_binding:string;intent_id:string;memory_state:string;log_state:string;memory_collection_id:string|null;log_collection_id:string|null}|undefined;
  const generation=(db.prepare('SELECT generation_id FROM _state_generation WHERE singleton=1').get() as {generation_id:string}).generation_id;
  const policy=this.policy.prepare('SELECT principal_id,data_generation,storage_binding FROM local_memory_installation WHERE id=1').get() as {principal_id:string;data_generation:string;storage_binding:string};
  const binding=db.prepare('SELECT state,data_generation,principal_id,storage_binding FROM local_memory_host_binding WHERE singleton=1').get() as {state:string;data_generation:string;principal_id:string;storage_binding:string}|undefined;
  return Boolean(row&&binding&&row.project_id===projectId&&row.data_generation===generation&&policy.data_generation===generation&&binding.data_generation===generation&&binding.state==='bound'&&row.principal_id===this.principalId&&row.principal_id===policy.principal_id&&row.principal_id===binding.principal_id&&row.storage_binding===policy.storage_binding&&row.storage_binding===binding.storage_binding&&/^[0-9a-f-]{36}$/.test(row.intent_id)&&row.memory_state==='planned'&&row.log_state==='planned'&&row.memory_collection_id===null&&row.log_collection_id===null);
 }
 // A retained resource generation proves this was an execution-only Chat. This
 // permits skipping backend cleanup, never accessing or deleting any collection.
 private isProvenTemporaryChat(chatId:string,projectId:string,branchId:string|undefined,agentId?:string):boolean{
  if(!branchId)return false;
  const db=this.ports.store.sqlite;
  const chat=db.prepare('SELECT project_id,branch_id,branch_execution_id FROM conversations WHERE id=?').get(chatId) as {project_id:string;branch_id:string|null;branch_execution_id:string|null}|undefined;
  const row=db.prepare(`SELECT r.execution_id FROM branch_resources r
   JOIN branch_ephemeral_contexts x ON x.step_execution_id=r.step_execution_id AND x.generation=r.generation AND x.chat_id=r.chat_id
   JOIN branch_executions e ON e.id=r.execution_id AND e.branch_id=?
   JOIN branches b ON b.id=e.branch_id
   WHERE r.chat_id=? AND NOT EXISTS(SELECT 1 FROM local_memory_scope_provisioning p WHERE p.chat_id=r.chat_id)
     AND (? IS NULL OR EXISTS(SELECT 1 FROM branch_resource_members m WHERE m.step_execution_id=r.step_execution_id AND m.agent_id=?))`).get(branchId,chatId,agentId??null,agentId??null) as {execution_id:string}|undefined;
  const deletedReceipt=!chat&&db.prepare('SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=? AND project_id=? AND branch_id=? AND canonical_deletion_completed=1').get(chatId,projectId,branchId);
  if(row&&(deletedReceipt||(chat&&chat.project_id===projectId&&chat.branch_id===branchId&&chat.branch_execution_id===row.execution_id)))return true;
  if(db.prepare('SELECT 1 FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId))return false;
  return hasRetainedTemporaryChatScope(db,{chatId,projectId,branchId,...(agentId?{agentId}:{})});
 }
 /** Retained expert memory must never be purged without its final custody. */
 private hasExpertMemory(chatId:string,projectId:string):boolean{
  const db=this.ports.store.sqlite;if(!db.prepare('SELECT 1 FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId))return false;
  const rows=db.prepare(`SELECT execution_id,substr(command_key,13) AS step_id FROM branch_commands WHERE command_key LIKE 'expert-copy:%' AND json_valid(result_json) AND json_extract(result_json,'$.copyChatId')=?`).all(chatId) as Array<{execution_id:string;step_id:string}>;
  if(rows.length>1)throw new MemoryCollectionHold('Temporary agent copy memory is retained until its final custody is confirmed');
  if(!rows.length)return false;
  const r=readBranchExpertCopy(db,rows[0]!.execution_id,rows[0]!.step_id);
  if(!r||r.copyChatId!==chatId||r.copyProjectId!==projectId)throw new MemoryCollectionHold('Temporary agent copy memory is retained until its final custody is confirmed');
  return true;
 }
 /** Exact Branch-owned copy only; ordinary temporary Chats remain unsupported. */
 private expertChat(chatId:string,allowReserved=false,allowRetiring=false):BranchExpertCopyReceipt|undefined{
  const db=this.ports.store.sqlite,rows=db.prepare(`SELECT r.step_execution_id,r.execution_id,r.state,e.branch_id,e.cancel_requested,b.deleting FROM branch_resources r JOIN branch_executions e ON e.id=r.execution_id JOIN branches b ON b.id=e.branch_id WHERE r.chat_id=?`).all(chatId) as Array<{step_execution_id:string;execution_id:string;state:string;branch_id:string;cancel_requested:number;deleting:number}>;
  if(rows.length!==1)return;const row=rows[0]!;if((!allowRetiring&&(row.cancel_requested||row.deleting))||!['reserved','active'].includes(row.state))return;
  const receipt=readBranchExpertCopy(db,row.execution_id,row.step_execution_id);if(!receipt||!receipt.snapshotReceipt||receipt.copyChatId!==chatId||!receipt.copyProjectId||(!allowReserved&&receipt.state!=='active'))return;
  const chat=db.prepare('SELECT project_id,branch_id,branch_execution_id FROM conversations WHERE id=?').get(chatId) as {project_id:string;branch_id:string|null;branch_execution_id:string|null}|undefined;
  if(!chat||chat.project_id!==receipt.copyProjectId||chat.branch_id!==row.branch_id||chat.branch_execution_id!==row.execution_id)return;
  if(receipt.state==='active'){
   if(!receipt.copyAgentId||!receipt.requestId||!receipt.creationOperationId||row.state!=='active'||!db.prepare('SELECT 1 FROM branch_resource_members WHERE step_execution_id=? AND agent_id=?').get(row.step_execution_id,receipt.copyAgentId))return;
   if(!allowRetiring&&!db.prepare(`SELECT 1 FROM branch_attempts a JOIN coordination_requests q ON q.id=a.request_id WHERE a.id=? AND a.step_execution_id=? AND a.cancel_requested=0 AND a.state='waiting' AND q.id=? AND q.recipient_agent_id=? AND q.project_id=? AND q.conversation_id=? AND q.state IN ('open','in_progress','waiting_dependency','awaiting_answer')`).get(receipt.attemptId,row.step_execution_id,receipt.requestId,receipt.copyAgentId,receipt.copyProjectId,chatId))return;
  }
  return receipt;
 }
 private expertSourceLive(receipt:BranchExpertCopyReceipt):boolean{
  const source=this.ports.store.getAgent(receipt.sourceAgentId),owner=activeChatResourceOwner(this.ports.store,'agent',receipt.sourceAgentId);
  return Boolean(source&&owner&&source.projectId===receipt.sourceProjectId&&source.conversationId===receipt.sourceChatId);
 }
 private expertConsent(receipt:BranchExpertCopyReceipt|undefined,kind:'copySourceMemory'|'allowFindingsWriteback'):boolean{
  const consent=receipt?.consent,review=receipt?.accessReview,choice=receipt?.accessChoice;
  return Boolean(consent&&review&&choice&&receipt?.snapshotReceipt&&consent.snapshotSha256===receipt.snapshotReceipt.sha256&&consent.reviewSha256===review.reviewSha256&&choice.reviewSha256===review.reviewSha256&&consent[kind]===true);
 }
 private live(){if(this.closed)throw new MemoryHostClosing();this.policyCustodyCheck();}
 private chat(chatId:string,product?:ProductScope,allowExpert=false){
  this.live();const chat=this.ports.store.getConversation(chatId),owner=activeChatResourceOwner(this.ports.store,'chat',chatId);
  if(!chat||!owner||product&&!resourceInProduct(this.ports.store,'chat',chatId,product))throw new MemoryDenied('Canonical Chat is unavailable in this product',404);
  // ponytail: execution Chats retire with their temporary Agents; no durable memory target is invented.
  if(owner.executionId&&(!allowExpert||!this.expertChat(chatId)))throw new MemoryDenied('Temporary execution Chat memory is unsupported by the durable Chat lifetime policy');
  return {chat,owner};
 }
 private assertProvisioningSettled(){if(this.missingExistingScopes.size||this.ports.store.sqlite.prepare("SELECT 1 FROM local_memory_scope_provisioning WHERE memory_state='submitted' OR log_state='submitted' LIMIT 1").get())throw Error('Memory collection creation or deletion requires reconciliation or existing data is missing');}
 async checkpointSourceDatabases():Promise<Database.Database[]>{await this.ready();this.live();this.assertProvisioningSettled();this.core.database.assertSourceSettled();return [this.policy];}
 assertCheckpointSourceSettled(){this.live();this.assertProvisioningSettled();this.core.database.assertSourceSettled();}
 // Read-only shutdown evidence; it grants no memory access and works after the
 // normal host fence. Any unclassified/missing/changing custody stays held.
 checkpointMutationHoldWitness():string|undefined{
  this.policyCustodyCheck();this.assertProvisioningSettled();
  const before=sourceMutationState();if(before.activeWriters||this.core.database.hasUnidentifiedMutationHold())return;
  const holds=this.core.database.listMutationHolds();if(!holds.length)return;
  const after=sourceMutationState();
  if(after.activeWriters||before.epoch!==after.epoch||before.uncertainWriters!==after.uncertainWriters)return;
  return createHash('sha256').update(JSON.stringify({holds})).digest('hex');
 }
 provisioningHolds():import('@ponderosa/core').MemoryProvisioningHoldDto[]{
  this.live();
  const holds:import('@ponderosa/core').MemoryProvisioningHoldDto[]=(this.ports.store.sqlite.prepare("SELECT chat_id,project_id,memory_state,log_state FROM local_memory_scope_provisioning WHERE memory_state='submitted' OR log_state='submitted' ORDER BY chat_id").all() as {chat_id:string;project_id:string;memory_state:string;log_state:string}[]).map(row=>{
   const active=row.chat_id==='global'||Boolean(activeChatResourceOwner(this.ports.store,'chat',row.chat_id));
   return {scope:row.chat_id==='global'?'global' as const:active?'chat' as const:'unknown' as const,...(row.chat_id!=='global'&&active?{chatId:row.chat_id,projectId:row.project_id}:{}),memoryState:row.memory_state as 'planned'|'submitted'|'confirmed',logState:row.log_state as 'planned'|'submitted'|'confirmed',reason:'A collection creation was submitted but is not fully reconciled. It will not be automatically repeated.'};
  });
  for(const scope of this.missingExistingScopes){const chatId=scope==='global'?undefined:scope.slice(5),chat=chatId?this.ports.store.getConversation(chatId):undefined,active=chatId&&chat&&activeChatResourceOwner(this.ports.store,'chat',chatId);holds.push({scope:scope==='global'?'global':active?'chat':'unknown',...(active?{chatId,projectId:chat.projectId}:{}),memoryState:'unknown',logState:'unknown',reason:'Memory collection unavailable or conflicts with its retained creation record. No collection was recreated or adopted. Review the backend; restart after resolving.'});}
  // Once a Chat is gone, product filtering cannot safely expose its identity.
  // Retain a non-identifying operator-global warning instead of hiding the hold.
  const receiptMismatch=this.ports.store.sqlite.prepare('SELECT 1 FROM conversation_deletion_receipts WHERE canonical_deletion_completed=1 AND server_cleanup_completed=0 AND last_error=? LIMIT 1').get(MEMORY_CLEANUP_RECEIPT_HOLD);
  const deleted=this.ports.store.sqlite.prepare(`SELECT 1 FROM conversation_deletion_receipts WHERE canonical_deletion_completed=1 AND server_cleanup_completed=0 AND last_error IN (${MEMORY_CLEANUP_HOLD_REASONS.map(()=>'?').join(',')}) AND last_error<>? LIMIT 1`).get(...MEMORY_CLEANUP_HOLD_REASONS,MEMORY_CLEANUP_RECEIPT_HOLD);
  const deletedAgent=this.ports.store.sqlite.prepare(`SELECT 1 FROM agent_deletion_receipts WHERE server_cleanup_completed=0 AND last_error IN (${MEMORY_CLEANUP_HOLD_REASONS.map(()=>'?').join(',')}) LIMIT 1`).get(...MEMORY_CLEANUP_HOLD_REASONS);
  const pendingProject=this.ports.store.sqlite.prepare(`SELECT 1 FROM project_deletion_pending WHERE last_error IN (${MEMORY_CLEANUP_HOLD_REASONS.map(()=>'?').join(',')}) LIMIT 1`).get(...MEMORY_CLEANUP_HOLD_REASONS);
  const pendingImport=this.ports.store.sqlite.prepare(`SELECT 1 FROM agent_creation_operations WHERE status='rolling_back' AND last_error IN (${MEMORY_CLEANUP_HOLD_REASONS.map(()=>'?').join(',')}) LIMIT 1`).get(...MEMORY_CLEANUP_HOLD_REASONS);
  const branchHold=this.ports.store.sqlite.prepare(`SELECT 1 FROM branch_retirement_errors WHERE error IN (${MEMORY_CLEANUP_HOLD_REASONS.map(()=>'?').join(',')}) UNION ALL SELECT 1 FROM branch_installation_plans WHERE error IN (${MEMORY_CLEANUP_HOLD_REASONS.map(()=>'?').join(',')}) UNION ALL SELECT 1 FROM branch_resources WHERE error IN (${MEMORY_CLEANUP_HOLD_REASONS.map(()=>'?').join(',')}) LIMIT 1`).get(...MEMORY_CLEANUP_HOLD_REASONS,...MEMORY_CLEANUP_HOLD_REASONS,...MEMORY_CLEANUP_HOLD_REASONS);
  const orphanEffect=!this.core.database.hasUnidentifiedMutationHold()&&this.core.database.listMutationHolds().some(hold=>{const scope=hold.effect?.scope;return typeof scope==='string'&&scope.startsWith('chat:')&&!activeChatResourceOwner(this.ports.store,'chat',scope.slice(5));});
  if(receiptMismatch)holds.push({scope:'unknown',memoryState:'unknown',logState:'unknown',reason:MEMORY_CLEANUP_RECEIPT_HOLD});
  if(deleted||deletedAgent||pendingProject||pendingImport||branchHold||orphanEffect)holds.push({scope:'unknown',memoryState:'unknown',logState:'unknown',reason:'Memory cleanup remains held for review; saved data may remain.'});
  if(this.core.database.hasUnidentifiedMutationHold())holds.push({scope:'unknown',memoryState:'submitted',logState:'submitted',reason:'Unidentified memory hold evidence is preserved and blocks all memory scopes. Operator review is required.'});
  return holds;
 }
 ready(){return this.initialized??=this.initialize();}
 private async initialize(){
  this.live();await this.core.inference.embed('synthetic local-memory readiness');
  if(!await this.core.inference.rerank([['synthetic readiness','synthetic readiness']]))throw new Error('Local reranker unavailable');
  await this.provisionInventory();
 }
 /** Called inside the canonical transaction that inserted exactly this Chat. */
 reserveNewChat(chatId:string){
  this.live();const db=this.ports.store.sqlite;if(!db.inTransaction)throw Error('Memory scope intent requires the Chat creation transaction');
  const chat=db.prepare('SELECT project_id,branch_execution_id FROM conversations WHERE id=?').get(chatId) as {project_id:string;branch_execution_id:string|null}|undefined;
  if(!chat)throw Error('New memory scope Chat is unavailable');if(chat.branch_execution_id&&!this.expertConsent(this.expertChat(chatId,true),'copySourceMemory'))return;
  const generation=(db.prepare('SELECT generation_id FROM _state_generation WHERE singleton=1').get() as {generation_id:string}).generation_id;
  const policy=this.policy.prepare('SELECT principal_id,data_generation,storage_binding FROM local_memory_installation WHERE id=1').get() as {principal_id:string;data_generation:string;storage_binding:string};
  if(policy.principal_id!==this.principalId||policy.data_generation!==generation)throw Error('Memory scope installation binding differs');
  db.prepare("INSERT INTO local_memory_scope_provisioning(chat_id,project_id,data_generation,principal_id,storage_binding,intent_id,memory_state,log_state,created_at) VALUES(?,?,?,?,?,?,'planned','planned',?)").run(chatId,chat.project_id,generation,policy.principal_id,policy.storage_binding,randomUUID(),new Date().toISOString());
 }
 async provisionInventory(){
  return this.core.database.raw.exclusive(async()=>{
   this.live();
   const eligible=(this.ports.store.sqlite.prepare('SELECT id,branch_execution_id FROM conversations').all() as {id:string;branch_execution_id:string|null}[]).filter(({id,branch_execution_id})=>branch_execution_id?this.expertConsent(this.expertChat(id,true),'copySourceMemory'):Boolean(activeChatResourceOwner(this.ports.store,'chat',id)));
   for(const scope of ['global',...eligible.map(({id})=>'chat:'+id)]){
    const id=scope==='global'?'global':scope.slice(5);
    try{if(this.memoryIntent(id))await this.provisionIntent(id,undefined,true);
     else await this.provisionScope(scope);
    }catch(error){if(error instanceof MemoryCollectionHold||error instanceof Error&&error.name==='ChromaNotFoundError'){this.missingExistingScopes.add(scope);continue;}throw error;}
   }
  });
 }
 /** Reserve only canonical local intent, after the per-copy human review. */
 reserveExpertChatMemory(chatId:string){
  this.live();const db=this.ports.store.sqlite;const reserve=()=>{
   const expert=this.expertChat(chatId,true);if(!this.expertConsent(expert,'copySourceMemory')||!expert||!this.expertSourceLive(expert))throw new MemoryDenied('Temporary agent copy memory requires explicit access review and a live source',409);
   if(this.memoryIntent(chatId))return;
   this.reserveNewChat(chatId);
   if(!this.memoryIntent(chatId))throw new MemoryDenied('Expert copy memory intent was not recorded',409);
  };if(db.inTransaction)reserve();else db.transaction(reserve).immediate();
 }
 async provisionNewChat(chatId:string){await this.ready();return this.core.database.raw.exclusive(()=>this.provisionIntent(chatId));}
 async verifyChat(chatId:string){await this.ready();return this.core.database.raw.exclusive(async()=>{if(this.memoryIntent(chatId))await this.provisionIntent(chatId);else await this.provisionScope('chat:'+chatId);});}
 private async ensureGlobalScope(){if(this.missingExistingScopes.has('global'))throw Error('Existing global memory is missing or changed; restore its original backend and restart to recheck it');const intent=this.memoryIntent('global');if(intent&&(intent.memory_state!=='confirmed'||intent.log_state!=='confirmed'))await this.core.database.raw.exclusive(()=>this.provisionIntent('global'));}
 private async ensurePlannedChat(chatId:string,ownerCheck?:()=>void){const scope='chat:'+chatId;if(this.missingExistingScopes.has(scope))throw Error('Existing Chat memory is missing or changed; restore its original backend and restart to recheck it');const intent=this.memoryIntent(chatId);if(intent&&(intent.memory_state!=='confirmed'||intent.log_state!=='confirmed')){if(ownerCheck)await this.core.database.raw.exclusive(()=>this.provisionIntent(chatId,ownerCheck));else await this.verifyChat(chatId);}else if(!intent&&!this.knownScopes.has(scope)&&!ownerCheck){try{await this.verifyChat(chatId);}catch(error){if(error instanceof Error&&error.name==='ChromaNotFoundError')this.missingExistingScopes.add(scope);throw error;}}}
 private scopeGuard(scope:string){return async()=>{this.live();if(scope!=='global'){const owner=activeChatResourceOwner(this.ports.store,'chat',scope.slice(5));if(!owner||(owner.executionId&&!this.expertConsent(this.expertChat(scope.slice(5),true),'copySourceMemory')))throw Error('Canonical durable Chat unavailable during provisioning');}};}
 private memoryIntent(chatId:string,retiring=false){
  this.live();const db=this.ports.store.sqlite;
  const intent=db.prepare('SELECT * FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId) as {chat_id:string;project_id:string;data_generation:string;principal_id:string;storage_binding:string;intent_id:string;memory_state:string;log_state:string;memory_collection_id:string|null;log_collection_id:string|null}|undefined;
  if(!intent)return;
  const chat=chatId==='global'?undefined:db.prepare('SELECT project_id,branch_execution_id FROM conversations WHERE id=?').get(chatId) as {project_id:string;branch_execution_id:string|null}|undefined;
  const generation=(db.prepare('SELECT generation_id FROM _state_generation WHERE singleton=1').get() as {generation_id:string}).generation_id;
  const policy=this.policy.prepare('SELECT principal_id,data_generation,storage_binding FROM local_memory_installation WHERE id=1').get() as {principal_id:string;data_generation:string;storage_binding:string};
  // Canonical Chat deletion precedes memory cleanup. Only that cleanup may
  // use the committed receipt in place of the removed Chat row; ordinary
  // provisioning and reads continue to require the live owner.
  const receipt=!chat&&retiring&&chatId!=='global'?this.ports.store.getConversationDeletionReceipt(chatId):undefined;
  const ownerMatches=chatId==='global'?intent.project_id==='global':chat
   ? (!chat.branch_execution_id||Boolean(this.expertChat(chatId,true,retiring)))&&chat.project_id===intent.project_id
   : Boolean(receipt?.canonicalDeletionCompleted&&receipt.conversationId===chatId&&receipt.projectId===intent.project_id);
  if(!ownerMatches||intent.data_generation!==generation||policy.data_generation!==generation||intent.principal_id!==this.principalId||intent.principal_id!==policy.principal_id||intent.storage_binding!==policy.storage_binding||!/^[0-9a-f-]{36}$/.test(intent.intent_id))throw Error(MEMORY_SCOPE_RECEIPT_MISMATCH);
  return intent;
 }
 private async provisionIntent(chatId:string,ownerCheck?:()=>void,allowHeld=false){
  const scope=chatId==='global'?'global':'chat:'+chatId,baseGuard=this.scopeGuard(scope),db=this.ports.store.sqlite;
  if(this.core.database.scopeHasUnsettledMutation(scope)){if(allowHeld)return;throw Error('Memory scope has an unsettled remote write; review memory health before use');}
  const expected=this.memoryIntent(chatId);if(!expected)throw Error('Exact memory scope creation receipt required');
  const guard=async()=>{if(ownerCheck)ownerCheck();else await baseGuard();const current=this.memoryIntent(chatId);if(!current||current.intent_id!==expected.intent_id)throw Error('Memory scope creation ownership changed');};
  const transition=(column:'memory_state'|'log_state',from:'planned'|'submitted',to:'submitted'|'confirmed',collectionId?:string)=>db.transaction(()=>{
   const current=this.memoryIntent(chatId),owner=chatId==='global'?undefined:activeChatResourceOwner(this.ports.store,'chat',chatId);
   if(ownerCheck)ownerCheck();
   if(!current||current.intent_id!==expected.intent_id||!ownerCheck&&chatId!=='global'&&(!owner||(owner.executionId&&!this.expertConsent(this.expertChat(chatId,true),'copySourceMemory')))||current[column]!==from)throw Error('Memory scope creation ownership changed');
   if(to==='confirmed'&&(typeof collectionId!=='string'||!collectionId))throw Error('Confirmed memory collection identity required');
   const idColumn=column==='memory_state'?'memory_collection_id':'log_collection_id';
   const changed=db.prepare(`UPDATE local_memory_scope_provisioning SET ${column}=?,${idColumn}=? WHERE chat_id=? AND intent_id=? AND ${column}=?`).run(to,collectionId??null,chatId,expected.intent_id,from).changes;
   if(changed!==1)throw Error('Memory scope creation ownership changed');
  }).immediate();
  for(const kind of ['memory','log'] as const){
   await guard();const intent=this.memoryIntent(chatId);if(!intent)throw Error('Exact memory scope creation receipt required');
   const column=kind==='memory'?'memory_state':'log_state',state=intent[column],token=intent.intent_id+':'+kind;
   if(state==='planned'){
    const createdId=await createPlannedCollection(this.core.database.raw,scope,kind==='log',guard,token,()=>transition(column,'planned','submitted'));
    await guard();transition(column,'submitted','confirmed',createdId);
   }else if(state==='submitted'){
    // A metadata token is copyable and cannot prove a lost create response.
    // Never adopt or reissue an unacknowledged backend effect.
    if(allowHeld)return;
    throw new MemoryCollectionHold('Memory collection creation is unverified and was not repeated; review its provisioning hold');
   }else if(state==='confirmed'){
    try{await checkedCollection(this.core.database.raw,scope,kind==='log',guard);}
    catch(error){
     if(error instanceof Error&&error.name==='ChromaNotFoundError'){
      this.missingExistingScopes.add(scope);
      if(allowHeld)return;
      throw new MemoryCollectionHold('Existing memory collection is missing; restore its original backend and restart to recheck it');
     }
     throw error;
    }
   }else throw Error('Memory scope creation receipt has an unsupported state');
  }
  this.missingExistingScopes.delete(scope);this.knownScopes.add(scope);
 }
 private async provisionScope(scope:string){
  const guard=this.scopeGuard(scope);
  await checkedCollection(this.core.database.raw,scope,false,guard);
  await checkedCollection(this.core.database.raw,scope,true,guard);
  this.missingExistingScopes.delete(scope);this.knownScopes.add(scope);
 }

 private unusedMemorySignature(agentId:string,chatId:string,runId:string,writeOnlyCopyWitness=false):string{
  this.live();const store=this.ports.store,agent=store.getAgent(agentId),owner=activeChatResourceOwner(store,'agent',agentId);
  if(!agent||!owner||agent.conversationId!==chatId)throw Error('Memory witness owner changed');
  const policies=new CapabilityPolicyStore(store.sqlite),policy=policies.resolveForAgent(agentId,runId);
  const expert=owner.executionId?this.expertChat(chatId):undefined;
  if(owner.executionId&&(!expert||expert.copyAgentId!==agentId||!expert.requestId||!this.expertSourceLive(expert)||
     (!writeOnlyCopyWitness&&!this.expertConsent(expert,'copySourceMemory')&&!this.expertConsent(expert,'allowFindingsWriteback'))||
     this.coordination.requestSteeringAdmission(runId,agentId,expert.requestId)!=='turn'))throw Error('Temporary agent copy memory witness is not authorized');
  const grant=expert?{readGlobal:false,writeGlobal:false}:this.getGrant(chatId,owner.branchId?'branches':'dev');
  const sourcePolicy=expert?policies.resolveForAgent(expert.sourceAgentId).layers.flatMap(layer=>{const saved=policies.get(layer.scopeKind,layer.scopeId);return saved?[[layer.scopeKind,layer.scopeId,saved]]:[];}):undefined;
  const reset=(store.sqlite.prepare("SELECT COALESCE(MAX(seq),0) seq FROM events WHERE agent_id=? AND type='session_reset'").get(agentId) as {seq:number}).seq;
  return JSON.stringify([agentId,agent.projectId,chatId,owner.branchId,reset,grant,
   policy.layers.flatMap(layer=>{const saved=policies.get(layer.scopeKind,layer.scopeId);return saved?[[layer.scopeKind,layer.scopeId,saved]]:[];}),...(expert?[expert,sourcePolicy]:[])]);
 }
 beginUnusedMemoryWitness(token:string):void{
  try{
   const cap=this.ports.capabilities.get(token),active=cap&&this.ports.activeRuns.get(cap.agentId);
   if(!cap||!active||!cap.conversationId||active.messageCapability!==token||!this.ports.ownsRun(cap,active))return;
   const agent=this.ports.store.getAgent(cap.agentId);if(!agent)return;
   // Stamp write-only copy attempts too; reader/admission validators keep their consent fence.
   const signature=this.unusedMemorySignature(cap.agentId,cap.conversationId,cap.v3SchedulerRunId,true);
   const db=this.ports.store.sqlite,hash=createHash('sha256').update(signature).digest('hex');
   db.prepare('INSERT OR IGNORE INTO memory_exposure_runs(run_id,agent_id,chat_id,fencing_token,authorization_hash) VALUES(?,?,?,?,?)')
    .run(cap.v3SchedulerRunId,cap.agentId,cap.conversationId,cap.v3FencingToken,hash);
   const receipt=db.prepare('SELECT agent_id,chat_id,fencing_token,authorization_hash FROM memory_exposure_runs WHERE run_id=?').get(cap.v3SchedulerRunId) as {agent_id:string;chat_id:string;fencing_token:number;authorization_hash:string}|undefined;
   if(!receipt||receipt.agent_id!==cap.agentId||receipt.chat_id!==cap.conversationId||receipt.fencing_token!==cap.v3FencingToken||receipt.authorization_hash!==hash)throw Error('Memory exposure receipt identity changed');
   const prior=this.unusedMemoryRuns.get(cap.agentId);
   if(!prior){this.unusedMemoryRuns.set(cap.agentId,{originRunId:cap.v3SchedulerRunId,lastRunId:cap.v3SchedulerRunId,lastFence:cap.v3FencingToken,count:1,projectId:agent.projectId,chatId:cap.conversationId,signature,attempted:this.unobservedMemoryAttempts.has(active),authorizationChanged:this.unobservedMemoryAttempts.has(active),runs:new Map()});return;}
   // Re-entry must never erase an observed attempt or manufacture coverage.
   if(prior.lastRunId===cap.v3SchedulerRunId){if(prior.lastFence!==cap.v3FencingToken||prior.signature!==signature||prior.chatId!==cap.conversationId){prior.attempted=true;prior.authorizationChanged=true;}return;}
   if(cap.v3FencingToken<=prior.lastFence||prior.signature!==signature||prior.chatId!==cap.conversationId){prior.attempted=true;prior.authorizationChanged=true;}
   prior.previousRunId=prior.lastRunId;prior.lastRunId=cap.v3SchedulerRunId;prior.lastFence=cap.v3FencingToken;prior.count++;
  }catch{/* No complete witness means no retained-memory optimization. */}
 }
 /** Exact per-Run receipts survive a normal restart. Missing, unfinished, or
  * conflicting receipts cannot prove that the provider context is reusable. */
 transitionAuthorization(agentId:string,chatId:string,sessionId:string,originRunId:string,sourceRunId:string):{signature:string;attempted:boolean}|undefined{
  try{
   const db=this.ports.store.sqlite,signature=createHash('sha256').update(this.unusedMemorySignature(agentId,chatId,sourceRunId)).digest('hex');
   const origin=db.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(originRunId,agentId) as {fencing_token:number;scope_key:string}|undefined;
   const source=db.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(sourceRunId,agentId) as {fencing_token:number;scope_key:string}|undefined;
   if(!origin||!source||origin.scope_key!==source.scope_key||origin.fencing_token>source.fencing_token)return undefined;
   // A previously unknown provider outcome can invalidate the supposedly
   // complete session boundary, including while a handoff resume is paused.
   if(db.prepare(`SELECT 1 FROM scheduler_runs r WHERE r.agent_id=? AND r.fencing_token<? AND
      (r.status IN ('leased','running','outcome_unknown') OR r.prompt_injection_state='injecting'
       OR EXISTS(SELECT 1 FROM scheduler_prompt_injections i WHERE i.run_id=r.id AND i.state='outcome_unknown')) LIMIT 1`)
      .get(agentId,origin.fencing_token))return undefined;
   let first:string|undefined,last:string|undefined,attempted=false;
   const rows=db.prepare(`SELECT r.id,r.scope_key,r.status,r.provider_session_id,r.prompt_injection_state,r.fencing_token,
    e.agent_id AS receipt_agent,e.chat_id,e.fencing_token AS receipt_fence,e.authorization_hash,e.attempted,e.pending,e.uncertain,e.unverified
    FROM scheduler_runs r LEFT JOIN memory_exposure_runs e ON e.run_id=r.id
    WHERE r.agent_id=? AND r.fencing_token>=? AND r.fencing_token<=? ORDER BY r.fencing_token,r.id`).iterate(agentId,origin.fencing_token,source.fencing_token) as Iterable<any>;
   for(const row of rows){
    first??=row.id;last=row.id;attempted ||= Boolean(row.attempted);
    if(row.scope_key!==origin.scope_key||row.status!=='completed'||row.provider_session_id!==sessionId||row.prompt_injection_state!=='injected'||
       row.receipt_agent!==agentId||row.chat_id!==chatId||row.receipt_fence!==row.fencing_token||! /^[0-9a-f]{64}$/.test(row.authorization_hash??'')||
       row.pending!==0||row.uncertain!==0||row.unverified!==0)return undefined;
   }
   return first===originRunId&&last===sourceRunId?{signature,attempted}:undefined;
  }catch{return undefined;}
 }
 /** Only canonical settings lineage or a fully bound folder intent may carry
  * inherited memory. Ambiguous/malformed payloads remain fail-closed. */
 private memoryTransitionMarker(payload:any):any|undefined{
  if(payload&&Object.hasOwn(payload,'settingsTransition'))
   return Object.hasOwn(payload,'workingCopyTransition')?undefined:payload.settingsTransition;
  const m=payload?.workingCopyTransition;
  if(!m||!['shared','separate_git'].includes(m.mode)||!['shared','separate_git'].includes(m.oldCopy?.mode)||
     typeof m.oldCopy?.id!=='string'||!m.oldCopy.id||typeof m.oldCopy.rootPath!=='string'||!m.oldCopy.rootPath||
     typeof m.sourceRunId!=='string'||!m.sourceRunId||typeof m.oldSessionId!=='string'||!m.oldSessionId||
     !Number.isSafeInteger(m.sourceFence)||m.sourceFence<1||! /^[0-9a-f]{64}$/.test(m.oldContractHash??'')||
     ! /^[0-9a-f]{64}$/.test(m.settingsHash??'')||! /^[0-9a-f]{64}$/.test(m.authorizationSignatureHash??'')||
     typeof m.authorizationOriginRunId!=='string'||!m.authorizationOriginRunId)return undefined;
  return m;
 }
 private memoryLineageStart(agentId:string,chatId:string,originRunId:string):number|undefined{
  const db=this.ports.store.sqlite,seen=new Set<string>();
  let cursor=originRunId;
  while(!seen.has(cursor)){
   seen.add(cursor);
   const run=db.prepare('SELECT fencing_token,scope_key,provider_session_id FROM scheduler_runs WHERE id=? AND agent_id=?')
    .get(cursor,agentId) as {fencing_token:number;scope_key:string;provider_session_id:string|null}|undefined;
   if(!run)return undefined;
   const parents=db.prepare(`SELECT r.old_provider_session_id,r.source_run_id,r.scope_key,r.conversation_id,r.replacement_session_id,
       r.state,r.completion_reason,h.payload_json FROM context_rollovers r
      JOIN activation_sources x ON x.source_kind='context_rollover' AND x.source_id=r.id
      JOIN agent_activations h ON h.id=x.activation_id AND h.kind='context_rollover_handoff'
      WHERE r.agent_id=? AND r.replacement_run_id=?`).all(agentId,cursor) as Array<any>;
   if(!parents.length)return run.fencing_token;
   if(parents.length!==1)return undefined;
   const p=parents[0],payload=JSON.parse(p.payload_json),m=this.memoryTransitionMarker(payload);
   if(p.state!=='completed'||p.completion_reason!=='replacement_verified'||p.scope_key!==run.scope_key||
      p.conversation_id!==chatId||p.replacement_session_id!==run.provider_session_id||!m||
      m.oldSessionId!==p.old_provider_session_id||m.sourceRunId!==p.source_run_id||
      typeof m.authorizationOriginRunId!=='string')return undefined;
   const prior=db.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=? AND agent_id=?').get(p.source_run_id,agentId) as {fencing_token:number}|undefined;
   if(!prior||prior.fencing_token>=run.fencing_token||payload?.workingCopyTransition&&m.sourceFence!==prior.fencing_token)return undefined;
   cursor=m.authorizationOriginRunId;
  }
  return undefined;
 }
 private transitionSourceEpochs(agentId:string,first:number,last:number){
  return this.ports.store.sqlite.prepare(`SELECT e.run_id,e.mutation_epoch FROM memory_exposure_runs e JOIN scheduler_runs r ON r.id=e.run_id
   WHERE r.agent_id=? AND r.fencing_token>=? AND r.fencing_token<=?`).all(agentId,first,last) as Array<{run_id:string;mutation_epoch:number}>;
 }
 private acceptTransitionSourceEpochs(rows:Array<{run_id:string;mutation_epoch:number}>):boolean{
  const db=this.ports.store.sqlite;
  return db.transaction(()=>{
   for(const row of rows)if(db.prepare('UPDATE memory_exposure_runs SET checked_epoch=? WHERE run_id=? AND mutation_epoch=?')
    .run(row.mutation_epoch,row.run_id,row.mutation_epoch).changes!==1)return false;
   return true;
  })();
 }
 transitionAuthorizationStillValid(agentId:string,chatId:string,originRunId:string,sourceRunId:string,runId:string,expected:string,allowDirty=false):boolean{
  try{
   const db=this.ports.store.sqlite,source=db.prepare('SELECT provider_session_id FROM scheduler_runs WHERE id=? AND agent_id=?').get(sourceRunId,agentId) as {provider_session_id:string|null}|undefined;
   if(!source?.provider_session_id||createHash('sha256').update(this.unusedMemorySignature(agentId,chatId,runId)).digest('hex')!==expected)return false;
   const lineageStart=this.memoryLineageStart(agentId,chatId,originRunId);
   if(lineageStart===undefined)return false;
   if(!allowDirty&&db.prepare(`SELECT 1 FROM memory_exposure_runs e JOIN scheduler_runs r ON r.id=e.run_id
    WHERE r.agent_id=? AND r.fencing_token>=?
    AND r.fencing_token<=(SELECT fencing_token FROM scheduler_runs WHERE id=?) AND e.mutation_epoch<>e.checked_epoch LIMIT 1`)
    .get(agentId,lineageStart,sourceRunId))return false;
   return this.transitionAuthorization(agentId,chatId,source.provider_session_id,originRunId,sourceRunId)?.signature===expected;
  }catch{return false;}
 }
 async validateTransitionReads(agentId:string,chatId:string,originRunId:string,sourceRunId:string,runId:string,expected:string):Promise<boolean>{
  const pending=this.validateTransitionReadsNow(agentId,chatId,originRunId,sourceRunId,runId,expected);this.calls.add(pending);
  try{return await pending;}finally{this.calls.delete(pending);}
 }
 private async validateTransitionReadsNow(agentId:string,chatId:string,originRunId:string,sourceRunId:string,runId:string,expected:string):Promise<boolean>{
  const valid=()=>this.transitionAuthorizationStillValid(agentId,chatId,originRunId,sourceRunId,runId,expected,true);
  if(!valid())return false;
  try{
   const db=this.ports.store.sqlite,source=db.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=? AND agent_id=?').get(sourceRunId,agentId) as {fencing_token:number}|undefined;
   const origin=db.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=? AND agent_id=?').get(originRunId,agentId) as {fencing_token:number}|undefined;
   const lineageStart=this.memoryLineageStart(agentId,chatId,originRunId);
   if(!source||!origin||lineageStart===undefined)return false;
   const epochs=this.transitionSourceEpochs(agentId,lineageStart,source.fencing_token);
   const refs=db.prepare(`SELECT DISTINCT e.scope,e.source_id,e.content_hash FROM memory_exposure_sources e
    JOIN scheduler_runs r ON r.id=e.run_id WHERE r.agent_id=? AND r.fencing_token>=? AND r.fencing_token<=?`)
    .all(agentId,lineageStart,source.fencing_token) as Array<{scope:string;source_id:string;content_hash:string}>;
   const guard=async()=>{if(!valid())throw new MemoryDenied('Memory transition authority changed');};
   const authority:MemoryAuthority={chatId,actor:{kind:'agent',id:agentId},runId:sourceRunId,fenceToken:String(source.fencing_token),
    sourceType:'ai_inference',readChat:true,readGlobal:refs.some(ref=>ref.scope==='global'),observeExposure:false,guard};
   await this.core.database.run(authority,async()=>{
    for(const ref of refs){const row=await this.core.database.get(ref.source_id,[ref.scope]);if(!row||this.transitionChunkHash(row)!==ref.content_hash)throw new MemoryDenied('Memory source changed');}
   });
   return valid()&&this.acceptTransitionSourceEpochs(epochs)&&
    this.transitionAuthorizationStillValid(agentId,chatId,originRunId,sourceRunId,runId,expected);
  }catch{return false;}
 }
 /** Legacy sessions have no exposure receipts. A later explicit setting of
  * global read to false is a possible revocation, not proof that the session
  * read global memory or that the previous value was true. */
 legacyPossibleGlobalRevocation(agentId:string,chatId:string,originRunId:string):boolean{
  const origin=this.ports.store.sqlite.prepare('SELECT created_at FROM scheduler_runs WHERE id=? AND agent_id=?').get(originRunId,agentId) as {created_at:string}|undefined;
  const grant=this.grant(chatId);
  if(!origin||!grant||grant.principal_id!==this.principalId||grant.read_global!==0)return false;
  const started=Date.parse(origin.created_at),updated=Date.parse(grant.updated_at);
  return Number.isFinite(started)&&Number.isFinite(updated)&&updated>=started;
 }
 /** Inspect the actual previously disclosed sources before reusing a retained
  * provider session after authorization changes. No source text is persisted. */
 async retainedMemoryExposureStatus(agentId:string,chatId:string,sessionId:string,originRunId:string,sourceRunId:string,seen=new Set<string>()):Promise<'valid'|'changed'|'unknown'|'unavailable'>{
  let recordedSources=false;
  try{
   const db=this.ports.store.sqlite,origin=db.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(originRunId,agentId) as {fencing_token:number;scope_key:string}|undefined;
   const source=db.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(sourceRunId,agentId) as {fencing_token:number;scope_key:string}|undefined;
   if(!origin||!source||origin.scope_key!==source.scope_key||origin.fencing_token>source.fencing_token||seen.has(originRunId))return 'unknown';
   seen.add(originRunId);
   // A verified replacement may inherit memory through its managed handoff.
   // Recheck the exact recorded source generation instead of treating the
   // replacement's own empty receipt as proof that it has no earlier sources.
   const parents=db.prepare(`SELECT r.old_provider_session_id,r.source_run_id,r.scope_key,r.conversation_id,
      r.replacement_session_id,r.state,r.completion_reason,h.payload_json
    FROM context_rollovers r JOIN activation_sources x ON x.source_kind='context_rollover' AND x.source_id=r.id
    JOIN agent_activations h ON h.id=x.activation_id AND h.kind='context_rollover_handoff'
    WHERE r.agent_id=? AND r.replacement_run_id=?`).all(agentId,originRunId) as Array<{
     old_provider_session_id:string;source_run_id:string;scope_key:string;conversation_id:string|null;
     replacement_session_id:string|null;state:string;completion_reason:string|null;payload_json:string}>;
   const inheritedRecorded=Boolean(db.prepare(`SELECT 1 FROM scheduler_runs r JOIN memory_exposure_runs receipt ON receipt.run_id=r.id
    WHERE r.agent_id=? AND r.scope_key=? AND r.fencing_token<?
     AND (receipt.pending<>0 OR receipt.uncertain<>0 OR receipt.unverified<>0
       OR EXISTS(SELECT 1 FROM memory_exposure_sources e WHERE e.run_id=r.id)) LIMIT 1`)
    .get(agentId,origin.scope_key,origin.fencing_token));
   recordedSources=parents.length>0&&inheritedRecorded;
   if(parents.length>1)return inheritedRecorded?'unavailable':'unknown';
   if(parents.length){
    const parent=parents[0]!,payload=JSON.parse(parent.payload_json),marker=this.memoryTransitionMarker(payload);
    if(parent.state!=='completed'||parent.completion_reason!=='replacement_verified'||parent.scope_key!==origin.scope_key||
       parent.conversation_id!==chatId||parent.replacement_session_id!==sessionId||!marker||
       marker.oldSessionId!==parent.old_provider_session_id||marker.sourceRunId!==parent.source_run_id||
       typeof marker.authorizationOriginRunId!=='string')return inheritedRecorded?'unavailable':'unknown';
    const parentSource=db.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=? AND agent_id=?').get(parent.source_run_id,agentId) as {fencing_token:number}|undefined;
    if(!parentSource||parentSource.fencing_token>=origin.fencing_token||payload?.workingCopyTransition&&marker.sourceFence!==parentSource.fencing_token)return inheritedRecorded?'unavailable':'unknown';
    const inherited=await this.retainedMemoryExposureStatus(agentId,chatId,parent.old_provider_session_id,
      marker.authorizationOriginRunId,parent.source_run_id,seen);
    if(inherited!=='valid')return inherited==='unknown'&&inheritedRecorded?'unavailable':inherited;
   }
   recordedSources=recordedSources||Boolean(db.prepare(`SELECT 1 FROM memory_exposure_sources e JOIN scheduler_runs r ON r.id=e.run_id
    WHERE r.agent_id=? AND r.fencing_token>=? AND r.fencing_token<=? LIMIT 1`).get(agentId,origin.fencing_token,source.fencing_token));
   const incomplete=()=>recordedSources?'unavailable' as const:'unknown' as const;
   const signature=this.unusedMemorySignature(agentId,chatId,sourceRunId);
   const epochs=this.transitionSourceEpochs(agentId,origin.fencing_token,source.fencing_token);
   const rows=db.prepare(`SELECT r.id,r.scope_key,r.status,r.provider_session_id,r.prompt_injection_state,r.fencing_token,
    e.agent_id AS receipt_agent,e.chat_id,e.fencing_token AS receipt_fence,e.authorization_hash,e.pending,e.uncertain,e.unverified
    FROM scheduler_runs r LEFT JOIN memory_exposure_runs e ON e.run_id=r.id
    WHERE r.agent_id=? AND r.fencing_token>=? AND r.fencing_token<=? ORDER BY r.fencing_token,r.id`)
    .all(agentId,origin.fencing_token,source.fencing_token) as Array<any>;
   if(!rows.length||rows[0].id!==originRunId||rows.at(-1)?.id!==sourceRunId)return incomplete();
   for(const row of rows){
    if(row.receipt_agent!=null&&(row.pending!==0||row.uncertain!==0||row.unverified!==0))return 'unavailable';
    if(row.scope_key!==origin.scope_key||row.status!=='completed'||row.provider_session_id!==sessionId||
     row.prompt_injection_state!=='injected'||row.receipt_agent!==agentId||row.chat_id!==chatId||
     row.receipt_fence!==row.fencing_token||! /^[0-9a-f]{64}$/.test(row.authorization_hash??''))return incomplete();
   }
   const refs=db.prepare(`SELECT DISTINCT e.scope,e.source_id,e.content_hash FROM memory_exposure_sources e
    JOIN scheduler_runs r ON r.id=e.run_id WHERE r.agent_id=? AND r.fencing_token>=? AND r.fencing_token<=?`)
    .all(agentId,origin.fencing_token,source.fencing_token) as Array<{scope:string;source_id:string;content_hash:string}>;
   recordedSources ||= refs.length>0;
   const owner=activeChatResourceOwner(this.ports.store,'agent',agentId);
   if(!owner)return recordedSources?'unavailable':'unknown';
   const policy=new CapabilityPolicyStore(db).resolveForAgent(agentId,sourceRunId);
   if(refs.length&&policy.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead))return 'changed';
   if(refs.some(ref=>ref.scope==='global')&&!this.getGrant(chatId,owner.branchId?'branches':'dev').readGlobal)return 'changed';
   const guard=async()=>{if(this.unusedMemorySignature(agentId,chatId,sourceRunId)!==signature)throw new MemoryDenied('Memory authority changed');};
   const authority:MemoryAuthority={chatId,actor:{kind:'agent',id:agentId},runId:sourceRunId,fenceToken:String(source.fencing_token),
    sourceType:'ai_inference',readChat:true,readGlobal:refs.some(ref=>ref.scope==='global'),observeExposure:false,guard};
   let changed=false;
   await this.core.database.run(authority,async()=>{
    for(const ref of refs){const row=await this.core.database.get(ref.source_id,[ref.scope]);if(!row||this.transitionChunkHash(row)!==ref.content_hash){changed=true;break;}}
   });
   await guard();
   return changed?'changed':this.acceptTransitionSourceEpochs(epochs)?'valid':recordedSources?'unavailable':'unknown';
  }catch{return recordedSources?'unavailable':'unknown';}
 }
 /** Revalidate retained, actually disclosed memory before provider admission.
  * The returned synchronous fence is suitable for the native open/write
  * boundaries; it stores only source scopes and mutation epochs. The caller
  * must separately fence the exact current Run and lease at each boundary. */
 async prepareRetainedInputProof(input:{agentId:string;chatId:string;sessionId:string;originRunId:string;sourceRunId:string;currentRunId:string}):
  Promise<{status:'valid'|'unknown'|'changed'|'unavailable';isCurrent:()=>boolean}>{
  const {agentId,chatId,sessionId,originRunId,sourceRunId,currentRunId}=input;
  const status=await this.retainedMemoryExposureStatus(agentId,chatId,sessionId,originRunId,sourceRunId);
  if(status==='changed'||status==='unavailable')return {status,isCurrent:()=>false};
  try{
   const db=this.ports.store.sqlite,agent=this.ports.store.getAgent(agentId),owner=activeChatResourceOwner(this.ports.store,'agent',agentId);
   const runRow=db.prepare('SELECT fencing_token,scope_key,provider_session_id,status,prompt_injection_state FROM scheduler_runs WHERE id=? AND agent_id=?');
   const origin=runRow.get(originRunId,agentId) as {fencing_token:number;scope_key:string;provider_session_id:string|null;status:string;prompt_injection_state:string}|undefined;
   const source=runRow.get(sourceRunId,agentId) as typeof origin;
   if(!agent||agent.conversationId!==chatId||!owner||owner.executionId||!origin||!source||
      origin.scope_key!==source.scope_key||origin.fencing_token>source.fencing_token||
      origin.provider_session_id!==sessionId||source.provider_session_id!==sessionId||
      origin.status!=='completed'||source.status!=='completed'||origin.prompt_injection_state!=='injected'||source.prompt_injection_state!=='injected'||
      this.ports.store.resumeSessionState(agentId)?.sessionId!==sessionId)return {status:'unavailable',isCurrent:()=>false};
   const product:ProductScope=owner.branchId?'branches':'dev',initialGrant=this.getGrant(chatId,product);
   const initialReadDenied=new CapabilityPolicyStore(db).resolveForAgent(agentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead);
   const sameOwner=()=>{
    const current=this.ports.store.getAgent(agentId),currentOwner=activeChatResourceOwner(this.ports.store,'agent',agentId);
    const latest=db.prepare(`SELECT id,fencing_token FROM scheduler_runs WHERE agent_id=? AND scope_key=?
      AND provider_session_id=? AND status='completed' AND prompt_injection_state='injected' ORDER BY fencing_token DESC LIMIT 1`)
      .get(agentId,source.scope_key,sessionId) as {id:string;fencing_token:number}|undefined;
    const uncertain=db.prepare(`SELECT 1 FROM scheduler_runs r WHERE r.agent_id=? AND r.scope_key=? AND r.id<>? AND
      (r.status IN ('leased','running','outcome_unknown') OR r.prompt_injection_state='injecting'
       OR EXISTS(SELECT 1 FROM scheduler_prompt_injections i WHERE i.run_id=r.id AND i.state='outcome_unknown')) LIMIT 1`)
      .get(agentId,source.scope_key,currentRunId);
    return !uncertain&&!!current&&current.projectId===agent.projectId&&current.conversationId===chatId&&!!currentOwner&&
      currentOwner.projectId===owner.projectId&&currentOwner.branchId===owner.branchId&&!currentOwner.executionId&&
      this.ports.store.resumeSessionState(agentId)?.sessionId===sessionId&&
      this.ports.store.acceptedProviderSessionInput(agentId)?.executionId===originRunId&&
      latest?.id===sourceRunId&&latest.fencing_token===source.fencing_token;
   };
   if(status==='unknown'){
    // An older session may lack source receipts. Preserve ordinary behavior,
    // but hold on an observed possible prior revocation or a new one.
    const manifest=this.ports.store.getProviderInput(originRunId,true)?.sourceManifest;
    const oldRestrictions=manifest?.schemaVersion===3?manifest.normalRuntimeContract?.capabilityRestrictions:undefined;
    if(this.legacyPossibleGlobalRevocation(agentId,chatId,originRunId)||
       initialReadDenied&&oldRestrictions&&!oldRestrictions.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead))
      return {status:'unavailable',isCurrent:()=>false};
    return {status,isCurrent:()=>{try{
     this.live();if(!sameOwner())return false;
     const denied=new CapabilityPolicyStore(db).resolveForAgent(agentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead);
     return (initialReadDenied||!denied)&&(!initialGrant.readGlobal||this.getGrant(chatId,product).readGlobal);
    }catch{return false;}}};
   }
   const floor=this.memoryLineageStart(agentId,chatId,originRunId);
   if(floor===undefined)return {status:'unavailable',isCurrent:()=>false};
   const refs=db.prepare(`SELECT DISTINCT e.scope FROM memory_exposure_sources e JOIN scheduler_runs r ON r.id=e.run_id
    WHERE r.agent_id=? AND r.scope_key=? AND r.fencing_token>=? AND r.fencing_token<=?`)
    .all(agentId,source.scope_key,floor,source.fencing_token) as Array<{scope:string}>;
   const epochs=db.prepare(`SELECT e.run_id,e.mutation_epoch,e.checked_epoch FROM memory_exposure_runs e JOIN scheduler_runs r ON r.id=e.run_id
    WHERE r.agent_id=? AND r.scope_key=? AND r.fencing_token>=? AND r.fencing_token<=?`)
    .all(agentId,source.scope_key,floor,source.fencing_token) as Array<{run_id:string;mutation_epoch:number;checked_epoch:number}>;
   if(epochs.some(row=>row.mutation_epoch!==row.checked_epoch))return {status:'unavailable',isCurrent:()=>false};
   const global=refs.some(row=>row.scope==='global');
   return {status,isCurrent:()=>{try{
    this.live();if(!sameOwner())return false;
    if(refs.length&&new CapabilityPolicyStore(db).resolveForAgent(agentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead))return false;
    if(global&&!this.getGrant(chatId,product).readGlobal)return false;
    const check=db.prepare('SELECT mutation_epoch,checked_epoch FROM memory_exposure_runs WHERE run_id=?');
    return epochs.every(row=>{const live=check.get(row.run_id) as {mutation_epoch:number;checked_epoch:number}|undefined;
     return !!live&&live.mutation_epoch===row.mutation_epoch&&live.checked_epoch===row.mutation_epoch;});
   }catch{return false;}}};
  }catch{return {status:'unavailable',isCurrent:()=>false};}
 }
 private noteMemoryAttempt(token:string,operation:string){
  const cap=this.ports.capabilities.get(token),entry=cap&&this.unusedMemoryRuns.get(cap.agentId);
  if(!cap)return undefined;
  const active=this.ports.activeRuns.get(cap.agentId);
  if(!active||active.messageCapability!==token||!this.ports.ownsRun(cap,active))return undefined;
  // The pending count is committed before any remote effect. A crash leaves
  // the operation uncertain instead of inviting a replay.
  const marked=this.ports.store.sqlite.prepare('UPDATE memory_exposure_runs SET attempted=1,pending=pending+1 WHERE run_id=? AND agent_id=? AND chat_id=? AND fencing_token=?')
   .run(cap.v3SchedulerRunId,cap.agentId,cap.conversationId,cap.v3FencingToken);
  if(marked.changes!==1)throw new MemoryDenied('Memory exposure receipt unavailable');
  if(!entry){const run=this.ports.activeRuns.get(cap.agentId);if(run)this.unobservedMemoryAttempts.add(run);return {entry:undefined,state:undefined,runId:cap.v3SchedulerRunId};}
  entry.attempted=true;
  if(entry.lastRunId!==cap.v3SchedulerRunId||entry.lastFence!==cap.v3FencingToken){entry.authorizationChanged=true;return {entry:undefined,state:undefined,runId:cap.v3SchedulerRunId};}
  // Retain only evidence which still has an existing bounded exposure entry.
  // An expired record permanently disqualifies that older generation instead
  // of accumulating one entry for every idle Run.
  for(const [id,prior] of entry.runs){const exposure=this.speech.get(id);if(!prior.pending&&(!exposure||exposure.expires<Date.now())){
    entry.earliestUnsafeFence=Math.min(entry.earliestUnsafeFence??prior.fence,prior.fence);entry.runs.delete(id);
  }}
  let state=entry.runs.get(cap.v3SchedulerRunId);
  if(!state){state={pending:0,unsafe:false,read:false,fence:cap.v3FencingToken};entry.runs.set(cap.v3SchedulerRunId,state);}
  state.pending++;if(operation!=='search'&&operation!=='get')state.unsafe=true;
  return {state,entry,runId:cap.v3SchedulerRunId};
 }
 canRetainUnusedMemory(agentId:string,chatId:string,sessionId:string,originRunId:string,currentRunId:string):boolean{
  try{
   const db=this.ports.store.sqlite,entry=this.unusedMemoryRuns.get(agentId);
   if(!entry||entry.attempted||entry.chatId!==chatId||entry.originRunId!==originRunId||
      entry.signature!==this.unusedMemorySignature(agentId,chatId,currentRunId))return false;
   const origin=db.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(originRunId,agentId) as {fencing_token:number;scope_key:string}|undefined;
   const current=db.prepare("SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=? AND status IN ('leased','running')").get(currentRunId,agentId) as {fencing_token:number;scope_key:string}|undefined;
   if(!origin||!current||origin.fencing_token>=current.fencing_token||origin.scope_key!==current.scope_key)return false;
   const currentRegistered=entry.lastRunId===currentRunId;
   const expectedCount=entry.count-(currentRegistered?1:0),expectedLast=currentRegistered?entry.previousRunId:entry.lastRunId;
   let count=0,lastId:string|undefined;
   const rows=db.prepare('SELECT id,fencing_token,scope_key,status,provider_session_id,prompt_injection_state FROM scheduler_runs WHERE agent_id=? AND fencing_token>=? AND fencing_token<? ORDER BY fencing_token,id').iterate(agentId,origin.fencing_token,current.fencing_token) as Iterable<{id:string;fencing_token:number;scope_key:string;status:string;provider_session_id:string|null;prompt_injection_state:string}>;
   for(const row of rows){
    if(count===0&&row.id!==originRunId)return false;
    const packet=this.ports.store.getProviderInput(row.id,true),m=packet?.sourceManifest;
    if(row.status!=='completed'||row.prompt_injection_state!=='injected'||row.provider_session_id!==sessionId||row.scope_key!==current.scope_key||
       !packet||packet.schedulerRunId!==row.id||typeof packet.exactPrompt!=='string'||createHash('sha256').update(packet.exactPrompt).digest('hex')!==packet.promptHash||
       m?.schemaVersion!==3||m.conversationId!==chatId||!Array.isArray(m.sources)||m.sources.some(source=>source.kind==='continuation_handoff'||source.kind==='pause_checkpoint')||
       m.providerSessionDisposition!==(row.id===originRunId?'fresh_task':'continued_session'))return false;
    count++;lastId=row.id;
   }
   return count>0&&count===expectedCount&&lastId===expectedLast;
  }catch{return false;}
 }
 private grant(chatId:string){return this.policy.prepare('SELECT * FROM local_memory_chat_grants WHERE chat_id=?').get(chatId) as {principal_id:string;read_global:number;revision:number;updated_at:string}|undefined;}
 getGrant(chatId:string,product:ProductScope){this.chat(chatId,product);const g=this.grant(chatId);if(g&&g.principal_id!==this.principalId)throw new MemoryDenied('Foreign memory grant principal');return {chatId,readGlobal:g?.read_global===1,revision:g?.revision??0};}
 setGrant(chatId:string,readGlobal:boolean,expectedRevision:number,product:ProductScope){
  this.live();if(typeof readGlobal!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new MemoryDenied('Boolean readGlobal and nonnegative expectedRevision required',400);
  // The grant lives in a separate policy database. Fence first: if that
  // later write fails, the Run remains paused and its old context is retained.
  const prior=this.getGrant(chatId,product);
  if(prior.revision!==expectedRevision)throw new MemoryDenied('Global memory grant revision conflict',409);
  if(prior.readGlobal&&!readGlobal)this.ports.beforeGlobalMemoryRevocation?.(chatId);
  const result=this.policy.transaction(()=>{
   const current=this.getGrant(chatId,product);if(current.revision!==expectedRevision)throw new MemoryDenied('Global memory grant revision conflict',409);
   const revision=current.revision+1;this.policy.prepare(`INSERT INTO local_memory_chat_grants VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET principal_id=excluded.principal_id,read_global=excluded.read_global,revision=excluded.revision,updated_at=excluded.updated_at`).run(chatId,this.principalId,readGlobal?1:0,revision,new Date().toISOString());
   return {chatId,readGlobal,revision};
  })();
  for(const e of this.speech.values())if(e.authority.chatId===chatId&&e.authority.readGlobal)this.invalidateSpeech(e,'global');
  return result;
 }
 private agentContext(token:string,tool:string,write:boolean,finding=false,globalCreate=false):HostContext{
  this.live();const capability=this.ports.capabilities.get(token);if(!capability)throw new MemoryDenied('Unknown Agent capability',401);
  const run=this.ports.activeRuns.get(capability.agentId),agent=this.ports.store.getAgent(capability.agentId);
  if(!run||run.messageCapability!==token||run.controller.signal.aborted||!this.ports.ownsRun(capability,run))throw new MemoryDenied('Revoked or expired canonical Run');
  const lease=this.ports.store.sqlite.prepare('SELECT lease_expires_at FROM scheduler_runs WHERE id=? AND agent_id=? AND fencing_token=?').get(capability.v3SchedulerRunId,capability.agentId,capability.v3FencingToken) as {lease_expires_at:string}|undefined;
  if(!lease||!Number.isFinite(Date.parse(lease.lease_expires_at))||Date.parse(lease.lease_expires_at)<=Date.now())throw new MemoryDenied('Canonical scheduler lease expired');
  if(!agent||!agent.conversationId||capability.conversationId!==agent.conversationId||run.conversationId!==agent.conversationId||!activeChatResourceOwner(this.ports.store,'agent',agent.id))throw new MemoryDenied('Canonical Agent/Chat ownership unavailable');
  const owner=activeChatResourceOwner(this.ports.store,'agent',agent.id)!;
  const product:ProductScope=owner.branchId?'branches':'dev';
  this.chat(agent.conversationId,product,true);
  if(!capability.availableToolNames.includes(tool))throw new MemoryDenied('Tool not authorized for this Run');
  const policies=new CapabilityPolicyStore(this.ports.store.sqlite),policy=policies.resolveForAgent(agent.id,capability.v3SchedulerRunId),denied=new Set(policy.restrictedCapabilityIds);
  const expert=owner.executionId?this.expertChat(agent.conversationId):undefined;
  if(owner.executionId){
   if(!expert||expert.copyAgentId!==agent.id||!expert.requestId||this.coordination.requestSteeringAdmission(capability.v3SchedulerRunId,agent.id,expert.requestId)!=='turn')throw new MemoryDenied('Exact temporary agent copy Request is not active');
   const source=this.ports.store.getAgent(expert.sourceAgentId),sourceOwner=activeChatResourceOwner(this.ports.store,'agent',expert.sourceAgentId);
   if(!source||!sourceOwner||source.projectId!==expert.sourceProjectId||source.conversationId!==expert.sourceChatId)throw new MemoryDenied('Original agent is unavailable');
   for(const id of policies.resolveForAgent(source.id).restrictedCapabilityIds)denied.add(id);
  }
  if(denied.has(write?CAPABILITY_IDS.memoryWrite:CAPABILITY_IDS.memoryRead))throw new MemoryDenied('Live memory capability policy denies operation');
  if(expert&&!globalCreate&&!this.expertConsent(expert,finding?'allowFindingsWriteback':'copySourceMemory'))throw new MemoryDenied('Temporary agent copy memory requires explicit access review',409);
  const grant=expert?{readGlobal:false}:this.getGrant(agent.conversationId,product);
  return {chatId:agent.conversationId,actor:{kind:'agent',id:agent.id},runId:capability.v3SchedulerRunId,fenceToken:String(capability.v3FencingToken),active:true,grants:{readChat:!(expert&&globalCreate)&&!denied.has(CAPABILITY_IDS.memoryRead),readGlobal:!denied.has(CAPABILITY_IDS.memoryRead)&&grant.readGlobal,writeChat:!denied.has(CAPABILITY_IDS.memoryWrite),writeGlobal:(!expert||globalCreate)&&!denied.has(CAPABILITY_IDS.memoryWrite)},sourceType:'ai_inference'};
 }
 async executeAgent(token:string,operation:string,args:unknown){
  const observed=this.noteMemoryAttempt(token,operation);let completed=false,dispatched=false;
  const write=['save','update','forget'].includes(operation);
  try{
  const cap=this.ports.capabilities.get(token);
  if(cap && this.ports.store.sqlite.prepare(`SELECT 1 FROM scheduler_run_activations linked
     JOIN agent_activations activation ON activation.id=linked.activation_id
     WHERE linked.run_id=? AND activation.kind IN ('context_rollover_handoff','context_rollover_continuation')
       AND json_type(activation.payload_json,'$.settingsTransition')='object' LIMIT 1`).get(cap.v3SchedulerRunId))
    throw new MemoryDenied('Memory tools are unavailable during the isolated context handoff',403);
  const parsed=validateMemoryCall(operation,args),tool='ponderosa_local_memory_'+operation,finding=parsed.recipient==='original';
  // New global notes need write policy, not consent to read/copy source memory.
  const globalCreate=operation==='save'&&parsed.destination==='global'&&!finding;
  this.agentContext(token,tool,write,finding,globalCreate);await this.ready();const before=this.agentContext(token,tool,write,finding,globalCreate);
  if(!finding&&!(globalCreate&&this.expertChat(before.chatId)))await this.ensurePlannedChat(before.chatId);
  const initial=this.agentContext(token,tool,write,finding,globalCreate);
  const expertFinding=parsed.recipient==='original'?this.expertChat(initial.chatId):undefined;if(parsed.recipient==='original'&&!expertFinding)throw new MemoryDenied('Only the active temporary agent copy can save a finding to its original',403);const expertOwner=expertFinding??(globalCreate?this.expertChat(initial.chatId):undefined);const expertIdentity=expertOwner&&JSON.stringify(expertOwner);
  const globalWrite=write&&parsed.destination==='global';const usesGlobal=(globalWrite||!write&&parsed.source!=='chat')&&initial.grants.readGlobal;if(globalWrite&&parsed.visibility==='private')throw new MemoryDenied('Global private audience unsupported',400);if(globalWrite&&operation!=='save'&&!initial.grants.readGlobal)throw new MemoryDenied('Existing global source mutation requires read authority');const needsRead=!write||initial.grants.readChat;if(write&&operation!=='save'&&!initial.grants.readChat)throw new MemoryDenied('Existing source mutation requires read authority');const identity=JSON.stringify([initial.chatId,initial.actor,initial.runId,initial.fenceToken]);const guard=async()=>{const c=this.agentContext(token,tool,write,finding,globalCreate);if(JSON.stringify([c.chatId,c.actor,c.runId,c.fenceToken])!==identity)throw new MemoryDenied('Canonical memory binding changed');if(expertIdentity&&JSON.stringify(this.expertChat(c.chatId))!==expertIdentity)throw new MemoryDenied('Temporary agent copy binding changed');if((needsRead&&!c.grants.readChat)||(usesGlobal&&!c.grants.readGlobal)||(write&&!(globalWrite?c.grants.writeGlobal:c.grants.writeChat)))throw new MemoryDenied('Live memory grant revoked');};
  if(write&&!(globalWrite?initial.grants.writeGlobal:initial.grants.writeChat))throw new MemoryDenied('Memory write denied');if(!write&&parsed.source==='global'&&!initial.grants.readGlobal)throw new MemoryDenied('Global read denied');
  if(usesGlobal||globalWrite){await this.ensureGlobalScope();await guard();}
  if(expertFinding){await this.ensurePlannedChat(expertFinding.sourceChatId);await guard();}
  const authority:MemoryAuthority={...initial,...(expertFinding?{chatId:expertFinding.sourceChatId,privateFindingRecipientId:expertFinding.sourceAgentId}:{}),readChat:expertFinding?false:initial.grants.readChat,readGlobal:usesGlobal,writeScope:write?(globalWrite?'global':'chat:'+(expertFinding?.sourceChatId??initial.chatId)):undefined,targetId:write&&operation!=='save'?parsed.chunk_id:undefined,visibility:parsed.visibility??'team',guard};
  if(observed?.state&&(operation==='search'||operation==='get')){
   try{this.speechEntry(authority);observed.state.read=true;}catch{observed.state.unsafe=true;}
  }
  const captured=new Map<string,{id:string;scope:string;hash:string}>();
  dispatched=true;
  const promise=this.sourceCapture.run(captured,()=>this.perform(operation,parsed,authority));this.calls.add(promise);
  try{
   const result=await promise,value=result.structuredContent.result as any;
   const visible=operation==='search'||operation==='history'?(Array.isArray(value)?value:[]):
    operation==='get'?(value?.found?[value]:[]):[
     ...(Array.isArray(value?.candidate_update_targets)?value.candidate_update_targets:[]),
     ...(Array.isArray(value?.candidate_stale_parallel_chunks)?value.candidate_stale_parallel_chunks:[])];
   const db=this.ports.store.sqlite;
   db.transaction(()=>{
    for(const item of visible){
     const scope=typeof item?.memory_scope==='string'?item.memory_scope:authority.writeScope;
     const id=item?.chunk_id,ref=typeof id==='string'&&typeof scope==='string'?captured.get(JSON.stringify([scope,id])):undefined;
     if(!ref){db.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE run_id=?').run(authority.runId);continue;}
     const prior=db.prepare('SELECT content_hash FROM memory_exposure_sources WHERE run_id=? AND scope=? AND source_id=?').get(authority.runId,ref.scope,ref.id) as {content_hash:string}|undefined;
     if(prior&&prior.content_hash!==ref.hash)db.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE run_id=?').run(authority.runId);
     else if(!prior)db.prepare('INSERT INTO memory_exposure_sources VALUES(?,?,?,?)').run(authority.runId,ref.scope,ref.id,ref.hash);
    }
   })();
   completed=true;return result;
  }finally{this.calls.delete(promise);}
  }finally{if(observed){
   const {state,entry,runId}=observed;
   this.ports.store.sqlite.prepare('UPDATE memory_exposure_runs SET pending=pending-1,uncertain=CASE WHEN ? THEN uncertain ELSE 1 END WHERE run_id=? AND pending>0').run(completed||!write||!dispatched?1:0,runId);
   if(state&&entry){state.pending--;if(!completed)state.unsafe=true;
    if(state.unsafe&&!state.pending){entry.earliestUnsafeFence=Math.min(entry.earliestUnsafeFence??state.fence,state.fence);entry.runs.delete(runId);}}
  }}
 }
 private async perform(operation:string,args:Record<string,any>,authority:MemoryAuthority){
  return this.core.database.run(authority,async()=>{await authority.guard();const scope=args.source==='global'||args.destination==='global'?'global':'chat:'+authority.chatId;
   const receiptKey=createHash('sha256').update(JSON.stringify([authority.chatId,authority.actor,authority.runId,authority.fenceToken,authority.writeScope?args.visibility??'write':'read',scope])).digest('hex');
   const tool=({save:'store',update:'update',forget:'delete',get:'get_chunk',search:'search',history:'get_evolution_chain'}as Record<string,string>)[operation];
   const parameters=operation==='save'?{text:args.text,source_type:authority.sourceType}:operation==='update'?{chunk_id:args.chunk_id,new_text:args.text,strategy:'version',source_type:authority.sourceType}:operation==='forget'?{chunk_id:args.chunk_id,hard_delete:false}:operation==='search'?{query:args.query,top_k:args.top_k??5,include_deprecated:args.include_history??false}: {chunk_id:args.chunk_id};
   const bound=new PonderosaMemory(this.core).bindChat({chatId:authority.chatId,authorize:async()=>{await authority.guard();return{readGlobal:authority.readGlobal,writeChat:authority.writeScope===`chat:${authority.chatId}`,writeGlobal:authority.writeScope==='global'};},sourceType:()=>authority.sourceType});const result=await bound.call({tool:tool!,arguments:parameters,destination:args.destination,source:args.source},receiptKey);
   // A reaffirmation warning derives a judgment from the old source before
   // the update mutates it. Until that prior observation can be bound, only
   // this specific case is unqualified for retained-context handoff.
   if(authority.actor.kind==='agent'&&authority.writeScope&&Array.isArray((result as any).warnings)&&
      (result as any).warnings.some((warning:any)=>warning?.code==='possible_reaffirmation_version'))
    this.ports.store.sqlite.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE run_id=?').run(authority.runId);
   // Only returned write previews are provider context; internal reconciliation reads are not.
   if(authority.actor.kind==='agent'&&authority.writeScope)for(const candidate of [...((result as any).candidate_update_targets??[]),...((result as any).candidate_stale_parallel_chunks??[])]){
    try{const row=await this.core.database.get(candidate.chunk_id,[authority.writeScope]);
     if(row&&row.text.replace(/\s+/g,' ').slice(0,140)===candidate.text_preview&&row.metadata.deprecated===candidate.deprecated&&
      (row.metadata.last_modified||row.metadata.timestamp)===candidate.last_modified&&(row.metadata.supersedes||'')===candidate.supersedes)this.noteSpeechRead(authority,row);
     else {this.denySpeech(authority);this.ports.store.sqlite.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE run_id=?').run(authority.runId);}
    }catch{this.denySpeech(authority);this.ports.store.sqlite.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE run_id=?').run(authority.runId);} // Preserve the committed write even if its preview cannot be verified.
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
 async mutationReconciliation(request:FastifyRequest,id?:string,input?:import('@ponderosa/core').MemoryMutationReconcileInput){
  this.operator(request);await this.ready();
  const guard=async()=>{this.operator(request);};
  if(!id)return this.core.database.listMutationHolds();
  return input?this.core.database.reconcileMutationHold(id,input,guard):this.core.database.reviewMutationHold(id,guard);
 }
 async preserveUnknownMutation(request:FastifyRequest,id:string,input:import('@ponderosa/core').MemoryMutationPreserveUnknownInput){
  this.operator(request);await this.ready();return this.core.database.preserveUnknownMutationHold(id,input,async()=>{this.operator(request);});
 }
 async executeOperator(request:FastifyRequest,operation:string,args:Record<string,unknown>){
  this.operator(request);const parsed=validateMemoryCall(operation,args);await this.ready();await this.ensureGlobalScope();const write=['save','update','forget'].includes(operation);if(write?parsed.destination!=='global':parsed.source!=='global')throw new MemoryDenied('Explicit global scope required',400);if(parsed.visibility==='private')throw new MemoryDenied('Global private audience unsupported',400);
  const authority:MemoryAuthority={chatId:'operator-global',actor:{kind:'user',id:this.principalId},runId:'operator-request:'+request.id,fenceToken:request.id,sourceType:'user_statement',readChat:false,readGlobal:true,writeScope:write?'global':undefined,targetId:write&&operation!=='save'?parsed.chunk_id:undefined,guard:async()=>{this.operator(request);}};
  const promise=this.perform(operation,parsed,authority);this.calls.add(promise);try{return await promise;}finally{this.calls.delete(promise);}
 }

 /** Separate human-only selected global data transport, not Agent package authority. */
 async globalTransfer(request:FastifyRequest,action:'inventory'|'export'|'preview'|'import',body:Record<string,unknown>={}){
  this.operator(request);
  const allowed=action==='inventory'?[]:action==='export'?['selection','inventoryHash','acknowledge']:action==='preview'?['snapshot','selection']:['snapshot','selection','reviewHash','acknowledge'];
  if(Object.keys(body).some(k=>!allowed.includes(k)))throw new MemoryDenied('Unsupported global transfer arguments',400);
  if((action==='export'||action==='import')&&body.acknowledge!==true)throw new MemoryDenied('Explicit review acknowledgement required',409);
  await this.ready();await this.ensureGlobalScope();const guard=async()=>{this.operator(request);};
  const pending=(async()=>{
   const inventory=await this.core.database.exportGlobalMemory(guard);
   if(action==='inventory')return {snapshot:inventory,inventoryHash:globalMemoryHash(inventory)};
   if(action==='export'){
    if(body.inventoryHash!==globalMemoryHash(inventory))throw new MemoryDenied('Global records changed; reload and review selection',409);
    return selectGlobalMemory(inventory,body.selection as GlobalMemorySelectionDto,this.core.database.raw.signature);
   }
   const snapshot=selectGlobalMemory(body.snapshot,body.selection as GlobalMemorySelectionDto,this.core.database.raw.signature);
   if(action==='preview')return {snapshot,destination:inventory,reviewHash:globalMemoryHash({snapshot,destination:inventory})};
   if(typeof body.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(body.reviewHash))throw new MemoryDenied('Exact reviewed transfer required',409);
   return this.core.database.importGlobalMemory(snapshot,body.reviewHash,guard);
  })();
  this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }

 /** Internal final-custody capture only; the caller supplies the exact Branch fence. */
 async exportExpertFinalPackageMemory(chatId:string,agentIds:string[],assertFinal:()=>void){
  if(typeof assertFinal!=='function'||!agentIds.length||new Set(agentIds).size!==agentIds.length)throw new MemoryDenied('Exact temporary agent copy final capture required',409);
  let identity:string|undefined;
  const guard=async()=>{
   this.live();assertFinal();const receipt=this.expertChat(chatId,true,true);
   if(!receipt||receipt.state!=='active'||!this.expertConsent(receipt,'copySourceMemory'))throw new MemoryDenied('Exact reviewed temporary agent copy required for final capture',409);
   const members=(this.ports.store.sqlite.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(receipt.stepExecutionId) as Array<{agent_id:string}>).map(r=>r.agent_id);
   if(agentIds.some(id=>!members.includes(id)))throw new MemoryDenied('Temporary agent copy final capture membership changed',409);
   for(const id of agentIds){const agent=this.ports.store.getAgent(id);if(!agent||agent.conversationId!==chatId||agent.projectId!==receipt.copyProjectId||!activeChatResourceOwner(this.ports.store,'agent',id))throw new MemoryDenied('Temporary agent copy final capture Agent unavailable',409);}
   const current=JSON.stringify([receipt,members]);if(identity!==undefined&&identity!==current)throw new MemoryDenied('Temporary agent copy final capture changed',409);identity=current;
  };
  await guard();await this.ready();await guard();const pending=this.core.database.exportPackageMemory(chatId,agentIds,guard,true);this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }

 /** Host package inventory only. Callers must complete their human import/export admission first. */
 async exportPackageMemory(chatId:string,agentIds:string[]){
  const guard=async()=>{this.chat(chatId);for(const id of agentIds){const agent=this.ports.store.getAgent(id);if(!agent||agent.conversationId!==chatId||!activeChatResourceOwner(this.ports.store,'agent',id))throw new MemoryDenied('Package Agent ownership changed');}};
  await guard();await this.ready();await this.ensurePlannedChat(chatId);await guard();const pending=this.core.database.exportPackageMemory(chatId,agentIds,guard);this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }
 async restorePackageMemory(snapshot:unknown,chatId:string,agents:Readonly<Record<string,string>>,operationId:string){
  const guard=async()=>{this.chat(chatId);for(const id of Object.values(agents)){const agent=this.ports.store.getAgent(id);if(!agent||agent.conversationId!==chatId||!activeChatResourceOwner(this.ports.store,'agent',id))throw new MemoryDenied('Package destination Agent ownership changed');}};
  await guard();await this.ready();await this.ensurePlannedChat(chatId);await guard();const pending=this.core.database.restorePackageMemory(snapshot,chatId,agents,operationId,guard);this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }

 private importMemoryCheck(operationId:string,agents?:Readonly<Record<string,string>>,signal?:AbortSignal,stagedReceipt=false){
   this.live();signal?.throwIfAborted();const store=this.ports.store,op=store.getAgentCreationOperation(operationId);
   const completedStaging=stagedReceipt&&op?.status==='completed'&&op.agentIds.length>0&&op.agentIds.every(id=>store.sqlite.prepare("SELECT 1 FROM branch_installation_resources r JOIN branch_installation_plans p ON p.id=r.staging_plan_id WHERE r.local_id=? AND r.creation_operation_id=? AND r.state='staging' AND p.state='applying'").get(id,operationId));
   if(!op||op.kind!=='import'||op.status!=='preparing'&&!completedStaging||!op.conversationId)throw new MemoryDenied('Exact preparing package import required');
   const chat=store.getConversation(op.conversationId);
   const temporary=chat&&store.sqlite.prepare('SELECT 1 FROM conversations WHERE id=? AND branch_execution_id IS NOT NULL').get(chat.id),expert=temporary&&chat?this.expertChat(chat.id,true):undefined;
   if(temporary&&(!expert||expert.creationOperationId!==op.id||!this.expertConsent(expert,'copySourceMemory')||!this.expertSourceLive(expert)))throw new MemoryDenied('Temporary agent copy memory requires explicit access review',409);
   if(!chat||chat.projectId!==op.projectId||store.sqlite.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(op.projectId)||store.sqlite.prepare('SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=?').get(chat.id))throw new MemoryDenied('Package memory destination retired');
   if(chat.branchId&&!store.sqlite.prepare('SELECT 1 FROM branches WHERE id=? AND deleting=0').get(chat.branchId))throw new MemoryDenied('Package Branch retired');
   if(!activeChatResourceOwner(store,'chat',chat.id)){
    const staged=store.sqlite.prepare("SELECT r.staging_plan_id AS plan FROM branch_installation_resources r JOIN branch_installation_plans p ON p.id=r.staging_plan_id WHERE r.local_id=? AND r.agent_ref='' AND r.state='staging' AND p.state='applying' AND r.branch_id=?").get(chat.id,chat.branchId) as {plan:string}|undefined;
    if(!staged||!op.agentIds.length||op.agentIds.some(id=>!store.sqlite.prepare("SELECT 1 FROM branch_installation_resources WHERE local_id=? AND state='staging' AND staging_plan_id=? AND creation_operation_id=?").get(id,staged.plan,op.id)))throw new MemoryDenied('Exact staged Branch import ownership required');
   }
   for(const id of Object.values(agents??{})){
    const agent=store.getAgent(id);
    if(!op.agentIds.includes(id)||!agent||agent.projectId!==op.projectId||agent.conversationId!==chat.id||store.sqlite.prepare('SELECT 1 FROM agent_deletion_pending WHERE agent_id=?').get(id))throw new MemoryDenied('Exact pending package Agent membership required');
   }
 }
 private importMemoryGuard(operationId:string,agents?:Readonly<Record<string,string>>,signal?:AbortSignal,stagedReceipt=false){
  return async()=>this.importMemoryCheck(operationId,agents,signal,stagedReceipt);
 }
 prepareImportMemory(operationId:string,memory:NonNullable<import('@ponderosa/core').AgentPortablePackageDto['memory']>){
  const op=this.ports.store.getAgentCreationOperation(operationId);if(!op?.conversationId||op.status!=='preparing')throw new MemoryDenied('Preparing package import required');
  return memory.map((entry,index)=>({...this.core.database.packageMemoryIds(entry.snapshot,op.conversationId!,operationId+':m:'+index),namespace:operationId+':m:'+index}));
 }
 async restoreImportMemory(operationId:string,entry:NonNullable<import('@ponderosa/core').AgentPortablePackageDto['memory']>[number],agents:Readonly<Record<string,string>>,namespace:string,signal?:AbortSignal){
  const op=this.ports.store.getAgentCreationOperation(operationId);if(!op?.conversationId)throw new MemoryDenied('Package import missing destination');
  const guard=this.importMemoryGuard(operationId,agents,signal);await guard();await this.ready();await this.ensurePlannedChat(op.conversationId,()=>this.importMemoryCheck(operationId,agents,signal));await guard();
  const pending=this.core.database.restorePackageMemory(entry.snapshot,op.conversationId,agents,namespace,guard,operationId);this.calls.add(pending);try{return await pending;}finally{this.calls.delete(pending);}
 }
 async verifyStagedMemory(operationId:string,pkg:import('@ponderosa/core').AgentPortablePackageDto){
  if(!pkg.memory?.length)return;const op=this.ports.store.getAgentCreationOperation(operationId);if(!op?.conversationId||op.agentIds.length!==pkg.agents.length)throw new MemoryDenied('Exact staged memory receipt required');
  const agentMap=Object.fromEntries(op.agentIds.map(id=>[id,id]));const guard=this.importMemoryGuard(operationId,agentMap,undefined,true);await guard();await this.ready();await this.ensurePlannedChat(op.conversationId,()=>this.importMemoryCheck(operationId,agentMap,undefined,true));await guard();
  const destinations=new Map(pkg.agents.map((node,index)=>[node.ref,op.agentIds[index]!]));
  for(const [index,entry] of pkg.memory.entries()){const mapping=Object.fromEntries(Object.entries(entry.agentRefs).map(([id,ref])=>{const destination=destinations.get(ref);if(!destination)throw new MemoryDenied('Missing staged memory Agent binding');return [id,destination];}));const pending=this.core.database.restorePackageMemory(entry.snapshot,op.conversationId,mapping,operationId+':m:'+index,guard,operationId);this.calls.add(pending);try{await pending;}finally{this.calls.delete(pending);}}
 }
 async rollbackImportMemory(operationId:string){
  const store=this.ports.store,op=store.getAgentCreationOperation(operationId);const plan=(op?.result as {memoryPlan?:Array<{chatId:string;namespace:string;chunkIds:string[];conflictIds:string[]}>}|undefined)?.memoryPlan;
  if(!plan?.length)return;
  const guard=async()=>{this.live();const current=store.getAgentCreationOperation(operationId);const staged=current?.status==='completed'&&current.agentIds.length>0&&current.agentIds.every(id=>store.sqlite.prepare("SELECT 1 FROM branch_installation_resources r JOIN branch_installation_plans p ON p.id=r.staging_plan_id WHERE r.local_id=? AND r.creation_operation_id=? AND r.state='retiring' AND p.state IN ('canceling','review_required')").get(id,operationId));if(!current||current.kind!=='import'||current.status!=='rolling_back'&&!staged||current.projectId!==op!.projectId||current.conversationId!==op!.conversationId)throw new MemoryDenied('Exact failed package import cleanup required');};
  const pending=(async()=>{for(const item of plan){if(item.chatId!==op!.conversationId)throw new MemoryDenied('Memory cleanup Chat mismatch');await this.core.database.rollbackPackageMemory(item,operationId,guard);}await guard();store.updateAgentCreationOperation(operationId,{result:op!.status==='completed'?Object.fromEntries(Object.entries(op!.result as object).filter(([key])=>key!=='memoryPlan')):{phase:'memory_rolled_back'}});})();
  this.calls.add(pending);try{await pending;}finally{this.calls.delete(pending);}
 }

 fence(){this.closed=true;this.unusedMemoryRuns.clear();for(const e of this.speech.values())e.invalid=true;}
 async close(){this.fence();await Promise.allSettled([...this.calls]);try{await this.core.close();}finally{if(this.policy.open)this.policy.close();}}
}
const services=new WeakMap<FastifyInstance,LocalMemoryService>();
export const localMemoryFor=(app:FastifyInstance)=>services.get(app);
export function registerLocalMemory(app:FastifyInstance,ports:Ports){
 if(!ports.opts.localMemory)return;
 const memory=new LocalMemoryService(ports);services.set(app,memory);
 app.addHook('onReady',()=>memory.ready());app.addHook('preClose',async()=>memory.fence());app.addHook('onClose',()=>memory.close());
 app.addHook('onSend',async(request,reply)=>{if(!['GET','HEAD'].includes(request.method)&&reply.statusCode<300)memory.checkSpeechAuthorities();});
 const error=(reply:any,e:unknown)=>reply.code(e instanceof MemoryDenied?e.statusCode:e instanceof MemoryArgumentError?400:500).send({error:e instanceof Error?e.message:String(e)});
 app.get('/api/local-memory/provisioning-holds',async(request,reply)=>{try{memory.operator(request);await memory.ready();return memory.provisioningHolds();}catch(e){return error(reply,e);}});
 app.get('/api/local-memory/mutation-holds',async(request,reply)=>{try{return await memory.mutationReconciliation(request);}catch(e){return error(reply,e);}});
 app.get<{Params:{id:string}}>('/api/local-memory/mutation-holds/:id',async(request,reply)=>{try{return await memory.mutationReconciliation(request,request.params.id);}catch(e){return reply.code(409).send({error:(e as Error).message});}});
 app.post<{Params:{id:string};Body:import('@ponderosa/core').MemoryMutationReconcileInput}>('/api/local-memory/mutation-holds/:id/reconcile',async(request,reply)=>{
  try{const body=request.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['commandKey','reviewSha256','backendDrainEvidence','preserveCurrentBackend'].includes(key)))throw new MemoryDenied('Invalid memory reconciliation command',400);return await memory.mutationReconciliation(request,request.params.id,body);}
  catch(e){return reply.code(e instanceof MemoryDenied?e.statusCode:409).send({error:(e as Error).message});}
 });
 app.post<{Params:{id:string};Body:import('@ponderosa/core').MemoryMutationPreserveUnknownInput}>('/api/local-memory/mutation-holds/:id/preserve-unknown',async(request,reply)=>{
  try{const body=request.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['commandKey','reviewSha256','reason','preserveUnknown'].includes(key)))throw new MemoryDenied('Invalid preserve-unknown command',400);return await memory.preserveUnknownMutation(request,request.params.id,body);}
  catch(e){return reply.code(e instanceof MemoryDenied?e.statusCode:409).send({error:(e as Error).message});}
 });
 app.get('/api/local-memory/global-transfer',async(request,reply)=>{try{return await memory.globalTransfer(request,'inventory');}catch(e){return error(reply,e);}});
 app.post<{Params:{action:string};Body:Record<string,unknown>}>('/api/local-memory/global-transfer/:action',{bodyLimit:MEMORY_SNAPSHOT_MAX_BYTES+65536},async(request,reply)=>{
  try{
   const action=request.params.action,body=request.body;
   if(!['export','preview','import'].includes(action)||!body||typeof body!=='object'||Array.isArray(body))throw new MemoryDenied('Invalid global transfer request',400);
   return await memory.globalTransfer(request,action as 'export'|'preview'|'import',body);
  }catch(e){if(!(e instanceof MemoryDenied))return reply.code(409).send({error:e instanceof Error?e.message:String(e)});return error(reply,e);}
 });
 app.post('/api/agent-local-memory',async(request,reply)=>{try{const body=request.body as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))throw new MemoryDenied('Invalid memory call',400);const {operation,...args}=body;return await memory.executeAgent(request.headers.authorization?.replace(/^Bearer\s+/i,'')??'',String(operation),args);}catch(e){return error(reply,e);}});
 app.post('/api/local-memory/global',async(request,reply)=>{try{const body=request.body as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))throw new MemoryDenied('Invalid global memory call',400);const {operation,...args}=body;return await memory.executeOperator(request,String(operation),args);}catch(e){return error(reply,e);}});
 app.get<{Params:{chatId:string}}>('/api/local-memory/grants/:chatId',async(request,reply)=>{try{memory.operator(request);return memory.getGrant(request.params.chatId,requestProduct(request));}catch(e){return error(reply,e);}});
 app.put<{Params:{chatId:string};Body:{readGlobal:boolean;expectedRevision:number}}>('/api/local-memory/grants/:chatId',async(request,reply)=>{try{memory.operator(request);const b=request.body;if(!b||Object.keys(b).some(k=>!['readGlobal','expectedRevision'].includes(k)))throw new MemoryDenied('Unsupported grant arguments',400);return memory.setGrant(request.params.chatId,b.readGlobal,b.expectedRevision,requestProduct(request));}catch(e){return error(reply,e);}});
 return memory;
}
