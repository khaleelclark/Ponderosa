import {validateGlobalMemory,globalMemoryHash} from './portable-global-memory.js';
import {withSourceMutation} from '@ponderosa/agents';
import {memorySourceMutations} from './memory-source-mutations.js';
import type {PortableGlobalMemorySnapshotDto,MemoryMutationEffect,MemoryMutationReconcileInput} from '@ponderosa/core';
import {withoutPortableSecrets} from './portable-secrets.js';
import {createHash} from 'node:crypto';
import {MEMORY_SNAPSHOT_MAX_BYTES,validateMemorySnapshot,type PortableMemorySnapshot,type PortableMemoryRow} from './portable-memory-snapshot.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {MemoryRuntime,ChromaStorage,type MemoryStorage,type Chunk,type Conflict,type Inference} from '@local-memory/mcp-node-private';
export type {PortableMemorySourceStamp as SourceStamp} from '@ponderosa/core';
import type {PortableMemorySourceStamp as SourceStamp} from '@ponderosa/core';
export type MemoryAuthority={chatId:string;actor:{kind:'agent'|'user';id:string};runId:string;fenceToken:string;sourceType:'user_statement'|'ai_inference';readGlobal:boolean;readChat:boolean;writeScope?:string;visibility?:'team'|'private';targetId?:string;observeExposure?:boolean;guard:()=>Promise<void>};
type Frame={owner:AuthorityStorage;authority:MemoryAuthority;all:Map<string,SourceStamp|null>;allowed:Map<string,SourceStamp>;scopes:string[];parents:Map<string,string>;created:Set<string>};
const context=new AsyncLocalStorage<Frame>();const key=(scope:string,id:string)=>JSON.stringify([scope,id]);
const denied=()=>new Error('Memory source unavailable or unauthorized');
export const MEMORY_CLEANUP_HOLD='Memory cleanup held: backend lacks atomic identity and content checks; staged and existing data was preserved';
export const MEMORY_CLEANUP_UNKNOWN_HOLD='Memory cleanup held: a backend write has an unknown outcome. It was not repeated; review memory health.';
export function isMemoryCleanupHold(value:unknown):boolean{
 const message=value instanceof Error?value.message:value;
 return message===MEMORY_CLEANUP_HOLD||message===MEMORY_CLEANUP_UNKNOWN_HOLD;
}
export class MemoryCollectionHold extends Error{constructor(message:string){super(message);this.name='MemoryCollectionHold';}}
const noGeneration={name:'local-memory-precomputed',generate:async():Promise<number[][]>=>{throw Error('Explicit embeddings required');}};
// Separate app instances in one process can share an admitted store. Serialize
// all their memory work for a Chroma origin; each raw storage retains its own
// close/queue behavior. Same-directory processes use the existing state lease.
const originQueues=new Map<string,Promise<void>>(),sharedQueueStorages=new WeakSet<ChromaStorage>();
function shareOriginQueue(raw:ChromaStorage){
 if(sharedQueueStorages.has(raw))return;sharedQueueStorages.add(raw);
 const origin=new URL(raw.options.url).origin,exclusive=raw.exclusive.bind(raw);
 raw.exclusive=<T>(fn:()=>Promise<T>):Promise<T>=>{
  const pending=(originQueues.get(origin)??Promise.resolve()).then(()=>exclusive(fn));
  const tail=pending.then(()=>undefined,()=>undefined);originQueues.set(origin,tail);
  void tail.then(()=>{if(originQueues.get(origin)===tail)originQueues.delete(origin);});
  return pending;
 };
}
const mutationBoundaries=new WeakMap<ChromaStorage,ReturnType<typeof memorySourceMutations>>();
type CollectionProof={check:(scope:string,log:boolean,metadata:Record<string,unknown>|null|undefined,collectionId:string)=>void;missing:(scope:string,log:boolean)=>void};
const collectionProofs=new WeakMap<ChromaStorage,CollectionProof>();
const mutate=<T>(raw:ChromaStorage,work:()=>Promise<T>,effect?:MemoryMutationEffect,acknowledged?:()=>void)=>{const boundary=mutationBoundaries.get(raw);if(!boundary&&acknowledged)throw Error('Memory mutation journal unavailable');return boundary?.run(work,effect,acknowledged)??withSourceMutation(work);};
function trackedCollection<T extends object>(raw:ChromaStorage,collection:T,scope:string,log:boolean):T{
 return new Proxy(collection,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return (...args:unknown[])=>['upsert','add','update','delete','modify'].includes(String(key))?mutate(raw,()=>Reflect.apply(value,target,args),{scope,log,operation:String(key) as MemoryMutationEffect['operation']}):Reflect.apply(value,target,args);}});
}
export async function checkedCollection(raw:ChromaStorage,scope:string,log:boolean,guard:()=>Promise<void>):Promise<Awaited<ReturnType<ChromaStorage["client"]["getCollection"]>>>{
 await guard();let c;try{c=await raw.client.getCollection({name:raw.names(scope)[log?'log':'memory'],embeddingFunction:noGeneration});}catch(e){if(e instanceof Error&&e.name==='ChromaNotFoundError')collectionProofs.get(raw)?.missing(scope,log);throw e;}await guard();
 if((c.configuration?.hnsw?.space??c.metadata?.['hnsw:space'])!=='cosine'||c.metadata?.embedding_signature!==raw.signature||(c.metadata?.dimensions!==undefined&&c.metadata.dimensions!==384)){collectionProofs.get(raw)?.missing(scope,log);throw new MemoryCollectionHold('Incompatible memory collection binding');}collectionProofs.get(raw)?.check(scope,log,c.metadata,c.id);return trackedCollection(raw,c,scope,log);
}
/** Issue one durably planned collection creation. An existing name is never
 * adopted as a fresh result; a lost response is resolved separately by token. */
export async function createPlannedCollection(raw:ChromaStorage,scope:string,log:boolean,guard:()=>Promise<void>,token:string,beforeDispatch:()=>void){
 await guard();
 try{await raw.client.getCollection({name:raw.names(scope)[log?'log':'memory'],embeddingFunction:noGeneration});throw new MemoryCollectionHold('Fresh memory collection already exists without its exact creation receipt');}
 catch(error){if(!(error instanceof Error)||error.name!=='ChromaNotFoundError')throw error;}
 await guard();beforeDispatch();
 const c=await mutate(raw,()=>raw.client.createCollection({name:raw.names(scope)[log?'log':'memory'],embeddingFunction:noGeneration,configuration:{hnsw:{space:'cosine'}},metadata:{'hnsw:space':'cosine',embedding_signature:raw.signature,dimensions:384,ponderosa_provision_intent:token}}),{scope,log,operation:'create_collection'});
 await guard();
 if((c.configuration?.hnsw?.space??c.metadata?.['hnsw:space'])!=='cosine'||c.metadata?.embedding_signature!==raw.signature||c.metadata?.ponderosa_provision_intent!==token||(c.metadata?.dimensions!==undefined&&c.metadata.dimensions!==384)||typeof c.id!=='string'||!c.id)throw Error('Created memory collection proof differs');
 // Confirm the name still resolves to the exact UUID returned by this request.
 // A lost response is never reconstructed from copyable metadata alone.
 await guard();const observed=await raw.client.getCollection({name:raw.names(scope)[log?'log':'memory'],embeddingFunction:noGeneration});await guard();
 if(observed.id!==c.id||observed.metadata?.ponderosa_provision_intent!==token)throw Error('Created memory collection identity changed');
 return c.id;
}
/** A per-call storage view, not persistence, a journal, a transaction or a recovery coordinator. */
export class AuthorityStorage implements MemoryStorage{
 constructor(readonly raw:ChromaStorage,readonly principal:string,readonly inference:Inference,mutationDirectory?:string){shareOriginQueue(raw);if(mutationDirectory)mutationBoundaries.set(raw,memorySourceMutations(mutationDirectory));}
 assertSourceSettled(){const boundary=mutationBoundaries.get(this.raw);if(!boundary)throw Error('Checkpoint memory source boundary unavailable');boundary.assertSettled();}
 private mutationBoundary(){const boundary=mutationBoundaries.get(this.raw);if(!boundary)throw Error('Memory reconciliation unavailable');return boundary;}
 setCollectionProof(proof:CollectionProof){collectionProofs.set(this.raw,proof);}
 listMutationHolds(){return this.mutationBoundary().list();}
 hasUnidentifiedMutationHold(){return this.mutationBoundary().hasUnidentifiedHold();}
 scopeHasUnsettledMutation(scope:string){return this.mutationBoundary().hasScopeHold(scope);}
 assertScopeSettled(scope:string){if(this.scopeHasUnsettledMutation(scope))throw Error('Memory scope has an unsettled remote write; review memory health before use');}

 private async observeMutation(effect:MemoryMutationEffect,guard:()=>Promise<void>){
  if(!/^(global|chat:.+)$/.test(effect.scope)||effect.scope.length>512||typeof effect.log!=='boolean')throw Error('Memory effect scope invalid');
  await guard();let collection;
  try{collection=await checkedCollection(this.raw,effect.scope,effect.log,guard);}catch(error){if(error instanceof Error&&error.name==='ChromaNotFoundError')return {rows:{scope:effect.scope,log:effect.log,absent:true},rowCount:0};throw error;}
  const rows:Array<{id:string;document:unknown;metadata:unknown;embedding:unknown}>=[];let bytes=0;
  for(let offset=0;;offset+=100){
   await guard();const page=await collection.get({offset,limit:100,include:['documents','metadatas','embeddings'] as any});await guard();
   for(let index=0;index<page.ids.length;index++){const row={id:page.ids[index]!,document:page.documents[index],metadata:page.metadatas[index],embedding:Array.from(page.embeddings?.[index]??[])};bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>MEMORY_SNAPSHOT_MAX_BYTES||rows.length>=10000)throw Error('Memory reconciliation inventory bound exceeded');rows.push(row);}
   if(page.ids.length<100)break;
  }
  rows.sort((a,b)=>a.id.localeCompare(b.id));if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Memory reconciliation inventory changed');
  return {rows:{scope:effect.scope,log:effect.log,rows},rowCount:rows.length};
 }
 reviewMutationHold(id:string,guard:()=>Promise<void>){return this.raw.exclusive(()=>this.mutationBoundary().review(id,effect=>this.observeMutation(effect,guard)));}
 preserveUnknownMutationHold(id:string,input:import('@ponderosa/core').MemoryMutationPreserveUnknownInput,guard:()=>Promise<void>){return this.raw.exclusive(async()=>{await guard();return this.mutationBoundary().preserveUnknown(id,input);});}
 reconcileMutationHold(id:string,input:MemoryMutationReconcileInput,guard:()=>Promise<void>){return this.raw.exclusive(()=>this.mutationBoundary().reconcile(id,input,effect=>this.observeMutation(effect,guard)));}
 packageVisible?:(operationId:string)=>boolean;
 onRead?:(authority:MemoryAuthority,row:Chunk)=>void;
 onMutation?:(scope:string,id:string)=>void;
 private frame(){const f=context.getStore();if(!f||f.owner!==this)throw new Error('Trusted memory call boundary required');return f;}
 private async guard(){await this.frame().authority.guard();}
 private parse(id:string,scope:string,m:any,includePending=false):SourceStamp|null{try{if(m?.host_package_operation!==undefined&&(typeof m.host_package_operation!=='string'||!includePending&&!this.packageVisible?.(m.host_package_operation)))return null;const str=(v:unknown,max=512)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!v.includes('\0');const provenance=(v:any)=>v&&Object.keys(v).every(k=>['actor','runId','fenceToken','at'].includes(k))&&v.actor&&Object.keys(v.actor).every(k=>['kind','id'].includes(k))&&['agent','user'].includes(v.actor?.kind)&&str(v.actor.id)&&str(v.runId)&&str(v.fenceToken)&&str(v.at,64)&&Number.isFinite(Date.parse(v.at));if(typeof m?.host_source_authority!=='string'||m.host_source_authority.length>8192)return null;const s=JSON.parse(m.host_source_authority);if(Object.keys(s??{}).some(k=>!['format','principal','id','scope','audience','ownerChat','sourceType','provenance','origin'].includes(k)))return null;if(s?.format!==1||s.principal!==this.principal||s.id!==id||s.scope!==scope||!str(id)||!str(scope)||s.sourceType!==m.source_type||!['user_statement','ai_inference'].includes(s.sourceType)||!str(s.ownerChat)||!str(s.audience)||!provenance(s.provenance)||(s.origin!==undefined&&!provenance(s.origin)))return null;if(scope==='global'&&(s.ownerChat!=='global'||s.audience!=='installation-global'||(s.provenance.actor.kind==='agent'?s.sourceType!=='ai_inference':s.sourceType!=='user_statement')))return null;return s;}catch{return null;}}
 private readable(s:SourceStamp,a:MemoryAuthority){return s.scope==='global'?a.readGlobal&&s.ownerChat==='global'&&s.audience==='installation-global':a.readChat&&s.scope===`chat:${a.chatId}`&&s.ownerChat===a.chatId&&(s.audience===`chat:${a.chatId}:team`||(a.actor.kind==='agent'&&s.audience===`chat:${a.chatId}:agent:${a.actor.id}`));}
 private async collection(scope:string,log=false){return checkedCollection(this.raw,scope,log,()=>this.guard());}
 private vector(v:unknown):number[]{const a=Array.from(v as ArrayLike<number>??[]);if(a.length!==384||!a.every(Number.isFinite)||!a.some(n=>n!==0))throw Error('Invalid memory vector');return a;}
 // Existing finite zero embeddings are readable for legacy inspection; queries,
 // new writes, and portable import/export retain the nonzero requirement.
 private storedVector(v:unknown):number[]{const a=Array.from(v as ArrayLike<number>??[]);if(a.length!==384||!a.every(Number.isFinite))throw Error('Invalid memory vector');return a;}
 private decode(id:string,scope:string,text:unknown,metadata:any,embedding:unknown):Chunk{const stamp=this.parse(id,scope,metadata),expected=this.frame().allowed.get(key(scope,id));if(!stamp||!expected||JSON.stringify(stamp)!==JSON.stringify(expected)||typeof text!=='string'||typeof metadata.confidence!=='number'||!Number.isFinite(metadata.confidence)||typeof metadata.deprecated!=='boolean')throw denied();if(metadata.supersedes){const parent=this.frame().allowed.get(key(scope,metadata.supersedes));if(!parent||parent.audience!==stamp.audience||JSON.stringify(stamp.origin??stamp.provenance)!==JSON.stringify(parent.origin??parent.provenance))throw denied();}const row={id,scope,text,metadata,embedding:this.storedVector(embedding)};if(this.frame().authority.observeExposure!==false&&!this.frame().authority.writeScope)this.onRead?.(this.frame().authority,row);return row;}
 private async refresh(c:Awaited<ReturnType<AuthorityStorage['collection']>>,scope:string,ids:string[]){
  const f=this.frame();await this.guard();const p=await c.get({ids,include:['metadatas'] as any});await this.guard();if(p.ids.length!==p.metadatas.length||p.ids.some(id=>!ids.includes(id)))throw denied();const result:string[]=[];for(let i=0;i<p.ids.length;i++){const id=p.ids[i]!,stamp=this.parse(id,scope,p.metadatas[i]),expected=f.allowed.get(key(scope,id));if(stamp&&expected&&JSON.stringify(stamp)===JSON.stringify(expected))result.push(id);}return result;
 }

 async run<T>(authority:MemoryAuthority,fn:()=>Promise<T>):Promise<T>{
  return this.raw.exclusive(async()=>{const scopes=authority.writeScope?[authority.writeScope]:[...(authority.readChat?[`chat:${authority.chatId}`]:[]),...(authority.readGlobal?['global']:[])];if(authority.writeScope==='global'&&!scopes.includes('global'))scopes.push('global');for(const scope of scopes)this.assertScopeSettled(scope);const f:Frame={owner:this,authority,all:new Map(),allowed:new Map(),scopes,parents:new Map(),created:new Set()};return context.run(f,async()=>{
   await this.guard();for(const scope of scopes){const c=await this.collection(scope);for(let offset=0;;offset+=500){await this.guard();const p=await c.get({offset,limit:500,include:['metadatas'] as any});await this.guard();if(p.ids.length!==p.metadatas.length||new Set(p.ids).size!==p.ids.length||p.ids.some(id=>f.all.has(key(scope,id))))throw denied();for(let i=0;i<p.ids.length;i++){const s=this.parse(p.ids[i]!,scope,p.metadatas[i]);f.all.set(key(scope,p.ids[i]!),s);if(typeof (p.metadatas[i] as any)?.supersedes==='string'&&(p.metadatas[i] as any).supersedes)f.parents.set(key(scope,p.ids[i]!),(p.metadatas[i] as any).supersedes);if(s&&this.readable(s,authority))f.allowed.set(key(scope,p.ids[i]!),s);}if(f.all.size>10000)throw Error('Memory authority inventory bound exceeded');if(p.ids.length<500)break;}}for(let pass=0,bound=f.allowed.size;pass<=bound;pass++){let removed=false;for(const [k,s]of f.allowed){const parent=f.parents.get(k);if(parent){const ancestor=f.allowed.get(key(s.scope,parent));if(!ancestor||ancestor.audience!==s.audience||JSON.stringify(s.origin??s.provenance)!==JSON.stringify(ancestor.origin??ancestor.provenance)){f.allowed.delete(k);removed=true;}}}if(!removed)break;}for(const stamp of f.allowed.values()){const seen=new Set<string>();let id=stamp.id;while(f.parents.has(key(stamp.scope,id))){if(seen.has(id)){for(const visited of seen)f.allowed.delete(key(stamp.scope,visited));break;}seen.add(id);id=f.parents.get(key(stamp.scope,id))!;}}if(authority.writeScope){const target=authority.targetId?f.allowed.get(key(authority.writeScope,authority.targetId)):undefined;if(authority.targetId&&!target)throw denied();const audience=target?.audience??(authority.writeScope==='global'?'installation-global':authority.visibility==='private'?`chat:${authority.chatId}:agent:${authority.actor.id}`:`chat:${authority.chatId}:team`);for(const [k,s]of f.allowed)if(s.scope!==authority.writeScope||s.audience!==audience)f.allowed.delete(k);}const result=await fn();await this.guard();return result;
  });});
 }
 async ensureScope(scope:string){if(!this.frame().scopes.includes(scope))throw denied();await this.collection(scope);await this.collection(scope,true);}
 exclusive<T>(fn:()=>Promise<T>){this.frame();return fn();}
 // Core Chroma mutations remain non-atomic. No unguarded compensation after revocation.
 async transaction<T>(fn:()=>T|Promise<T>){await this.guard();const result=await fn();await this.guard();return result;}
 async get(id:string,scopes:string[]){const f=this.frame(),found:Chunk[]=[];for(const scope of scopes){if(!f.allowed.has(key(scope,id)))continue;const c=await this.collection(scope);if(!(await this.refresh(c,scope,[id])).length)continue;await this.guard();const p=await c.get({ids:[id],include:['documents','metadatas','embeddings'] as any});await this.guard();if(p.ids.some(x=>x!==id))throw denied();if(p.ids.length)found.push(this.decode(id,scope,p.documents[0],p.metadatas[0],p.embeddings?.[0]));}if(found.length>1)throw Error('Ambiguous authorized source; choose Chat or global');return found[0]??null;}

 async list(scopes:string[]){const f=this.frame(),rows:Chunk[]=[];for(const s of f.allowed.values())if(scopes.includes(s.scope)){const row=await this.get(s.id,[s.scope]);if(row)rows.push(row);}return rows;}
 async sourceIds(scopes:string[]){await this.guard();return [...this.frame().allowed.values()].filter(s=>scopes.includes(s.scope)).map(s=>({id:s.id,scope:s.scope}));}
 async candidates(scopes:string[],v:number[],budget:number,history:boolean,_confidence:number,permitted?:Readonly<Record<string,readonly string[]>>){
  this.vector(v);const f=this.frame(),rows:Chunk[]=[];for(const scope of scopes){if(!f.scopes.includes(scope))throw denied();let ids=[...f.allowed.values()].filter(s=>s.scope===scope&&(!permitted||permitted[scope]?.includes(s.id))).map(s=>s.id);if(!ids.length)continue;const c=await this.collection(scope);ids=await this.refresh(c,scope,ids);if(!ids.length)continue;await this.guard();const p=await c.query({queryEmbeddings:[v],ids,nResults:Math.min(budget,ids.length),...(history?{}:{where:{deprecated:false}}),include:['documents','metadatas','embeddings'] as any});await this.guard();for(let i=0;i<(p.ids[0]?.length??0);i++){const id=p.ids[0]![i]!;if(!ids.includes(id))throw denied();rows.push(this.decode(id,scope,p.documents[0]![i],p.metadatas[0]![i],p.embeddings?.[0]?.[i]));}}return rows;
 }

 async put(row:Chunk){
  const f=this.frame(),a=f.authority,k=key(row.scope,row.id);if(a.writeScope!==row.scope)throw denied();await this.guard();let stamp=f.allowed.get(k);const c=await this.collection(row.scope);
  if(stamp){if(!(await this.refresh(c,row.scope,[row.id])).length)throw denied();}else{if(f.all.has(k))throw denied();await this.guard();const existing=await c.get({ids:[row.id],include:['metadatas'] as any});await this.guard();if(existing.ids.length)throw denied();const parent=row.metadata.supersedes?f.allowed.get(key(row.scope,row.metadata.supersedes)):undefined;if(row.metadata.supersedes&&!parent)throw denied();const provenance={actor:structuredClone(a.actor),runId:a.runId,fenceToken:a.fenceToken,at:new Date().toISOString()};stamp={format:1,principal:this.principal,id:row.id,scope:row.scope,ownerChat:row.scope==='global'?'global':a.chatId,audience:parent?.audience??(row.scope==='global'?'installation-global':a.visibility==='private'?`chat:${a.chatId}:agent:${a.actor.id}`:`chat:${a.chatId}:team`),sourceType:a.sourceType,provenance,origin:parent?.origin??parent?.provenance??provenance};}
  if(row.metadata.supersedes){const parent=f.allowed.get(key(row.scope,row.metadata.supersedes));if(!parent||parent.audience!==stamp.audience)throw denied();const expectedOrigin=parent.origin??parent.provenance;if(f.parents.get(k)!==row.metadata.supersedes){if(!f.created.has(k)&&f.all.has(k))throw denied();stamp={...stamp,origin:structuredClone(expectedOrigin)};}else if(JSON.stringify(stamp.origin??stamp.provenance)!==JSON.stringify(expectedOrigin))throw denied();}else if(f.parents.has(k))throw denied();if(row.metadata.source_type!==stamp.sourceType)throw denied();const vector=this.vector(row.embedding);await this.guard();this.onMutation?.(row.scope,row.id);await c.upsert({ids:[row.id],documents:[row.text],metadatas:[{...row.metadata,host_source_authority:JSON.stringify(stamp)}],embeddings:[vector]});if(!f.all.has(k))f.created.add(k);f.all.set(k,stamp);f.allowed.set(k,stamp);if(row.metadata.supersedes)f.parents.set(k,row.metadata.supersedes);(row.metadata as any).host_source_authority=JSON.stringify(stamp);await this.guard();
 }

 async remove(id:string,scope:string){if(this.frame().authority.writeScope!==scope||!this.frame().allowed.has(key(scope,id)))throw denied();const c=await this.collection(scope);if(!(await this.refresh(c,scope,[id])).length)throw denied();await this.guard();this.onMutation?.(scope,id);await c.delete({ids:[id]});this.frame().all.delete(key(scope,id));this.frame().allowed.delete(key(scope,id));await this.guard();}

 async conflicts(scope:string){const f=this.frame();if(!f.scopes.includes(scope))throw denied();const c=await this.collection(scope,true),ids:string[]=[];for(let offset=0;;offset+=500){await this.guard();const p=await c.get({offset,limit:500,include:['metadatas'] as any});await this.guard();for(let i=0;i<p.ids.length;i++){const m:any=p.metadatas[i];try{const logStamp=this.parse(p.ids[i]!,scope,{...m,host_source_authority:m.host_conflict_authority});if(!logStamp||!this.readable(logStamp,f.authority))continue;const affected=JSON.parse(m.chunk_ids_affected??m.chunk_ids);if(Array.isArray(affected)&&affected.length&&affected.every((id:unknown)=>typeof id==='string'&&f.allowed.has(key(scope,id)))&&new Set(affected.map((id:string)=>f.allowed.get(key(scope,id))!.audience)).size===1&&f.allowed.get(key(scope,affected[0]))!.audience===logStamp.audience)ids.push(p.ids[i]!);}catch{}}if(offset+p.ids.length>10000)throw Error('Memory conflict inventory bound exceeded');if(p.ids.length<500)break;}const rows:Conflict[]=[];for(let i=0;i<ids.length;i+=100){await this.guard();const p=await c.get({ids:ids.slice(i,i+100),include:['documents','metadatas','embeddings'] as any});await this.guard();for(let j=0;j<p.ids.length;j++){const m:any=p.metadatas[j];const stamp=this.parse(p.ids[j]!,scope,{...m,host_source_authority:m.host_conflict_authority});let affected:unknown;try{affected=JSON.parse(m.chunk_ids_affected??m.chunk_ids);}catch{throw denied();}if(!ids.slice(i,i+100).includes(p.ids[j]!)||!stamp||!this.readable(stamp,f.authority)||!Array.isArray(affected)||!affected.length||affected.some(id=>typeof id!=='string'||f.allowed.get(key(scope,id))?.audience!==stamp.audience))throw denied();rows.push({...m,id:p.ids[j],scope,reasoning:p.documents[j]??'',chunk_ids:JSON.parse(m.chunk_ids_affected??m.chunk_ids),snapshot_wire_metadata:structuredClone(m),embedding:Array.from(p.embeddings?.[j]??[]) as number[]});}}return rows;}
 async putConflict(row:Conflict){if(this.frame().authority.writeScope!==row.scope||!row.chunk_ids.length||row.chunk_ids.some(id=>!this.frame().allowed.has(key(row.scope,id))))throw denied();await this.guard();const c=await this.collection(row.scope,true);const firstStamp=this.frame().allowed.get(key(row.scope,row.chunk_ids[0]!))!;if(row.chunk_ids.some(id=>this.frame().allowed.get(key(row.scope,id))!.audience!==firstStamp.audience))throw denied();await this.guard();const prior=await c.get({ids:[row.id],include:['metadatas'] as any});await this.guard();if(prior.ids.length){const m:any=prior.metadatas[0],stamp=this.parse(row.id,row.scope,{...m,host_source_authority:m.host_conflict_authority});if(prior.ids.length!==1||prior.ids[0]!==row.id||!stamp||stamp.audience!==firstStamp.audience||!this.readable(stamp,this.frame().authority))throw denied();let affected;try{affected=JSON.parse(m.chunk_ids_affected??m.chunk_ids);}catch{throw denied();}if(!Array.isArray(affected)||!affected.length||affected.some(id=>typeof id!=='string'||this.frame().allowed.get(key(row.scope,id))?.audience!==firstStamp.audience))throw denied();}let vector=row.embedding;if(vector===undefined){await this.guard();const existing=await c.get({ids:[row.id],include:['metadatas'] as any});await this.guard();if(existing.ids.length){const m:any=existing.metadatas[0];let ids:unknown;try{ids=JSON.parse(m.chunk_ids_affected??m.chunk_ids);}catch{throw denied();}if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!this.frame().allowed.has(key(row.scope,id))))throw denied();await this.guard();const p=await c.get({ids:[row.id],include:['embeddings'] as any});await this.guard();vector=Array.from(p.embeddings?.[0]??[]) as number[];}else{await this.guard();vector=await this.inference.embed(row.reasoning);await this.guard();}}if(!Array.isArray(vector)||vector.length!==384||!vector.every(Number.isFinite)||!vector.some(n=>n!==0))throw Error('Conflict requires actual finite nonzero384vector');const {scope,embedding,...metadata}=row;delete (metadata as any).snapshot_wire_metadata;const a=this.frame().authority,first=this.frame().allowed.get(key(row.scope,row.chunk_ids[0]!))!,stamp:SourceStamp={format:1,principal:this.principal,id:row.id,scope:row.scope,ownerChat:first.ownerChat,audience:first.audience,sourceType:a.sourceType,provenance:{actor:a.actor,runId:a.runId,fenceToken:a.fenceToken,at:new Date().toISOString()}};const m={...((row as any).snapshot_wire_metadata??{}),...metadata,source_type:a.sourceType,host_conflict_authority:JSON.stringify(stamp),log_id:row.id,chunk_ids:JSON.stringify(row.chunk_ids),chunk_ids_affected:JSON.stringify(row.chunk_ids),chunks_affected:row.chunk_ids.length};await this.guard();await c.upsert({ids:[row.id],documents:[row.reasoning],embeddings:[vector],metadatas:[m as any]});await this.guard();}
 async removeConflict(id:string,scope:string){if(!(await this.conflicts(scope)).some(c=>c.id===id)||this.frame().authority.writeScope!==scope)throw denied();await this.guard();const c=await this.collection(scope,true);await this.guard();await c.delete({ids:[id]});await this.guard();}
 /** Trusted host inventory; deliberately separate from Agent read authority. No policy grants are read or changed. */
 async exportPackageMemory(chatId:string,agentIds:string[],guard:()=>Promise<void>):Promise<PortableMemorySnapshot>{
  return this.raw.exclusive(async()=>{
   const scope='chat:'+chatId,audiences=new Set([scope+':team',...agentIds.map(id=>scope+':agent:'+id)]);this.assertScopeSettled(scope);
   const snapshot:PortableMemorySnapshot={schema:'ponderosa.chat-memory.v1',signature:this.raw.signature,sourceChatId:chatId,agentIds:[...agentIds],excludedScopes:['global'],chunks:[],conflicts:[]};
   let bytes=Buffer.byteLength(JSON.stringify(snapshot));
   for(const log of [false,true]){
    const c=await checkedCollection(this.raw,scope,log,guard);
    for(let offset=0;;offset+=100){
     await guard();const p=await c.get({offset,limit:100,include:['documents','metadatas','embeddings'] as any});await guard();
     for(let i=0;i<p.ids.length;i++){
      const metadata:any=p.metadatas[i],stamp=this.parse(p.ids[i]!,scope,log?{...metadata,host_source_authority:metadata?.host_conflict_authority}:metadata);
      if(!stamp){if(typeof metadata?.host_package_operation==='string'&&!this.packageVisible?.(metadata.host_package_operation)&&this.parse(p.ids[i]!,scope,log?{...metadata,host_source_authority:metadata?.host_conflict_authority}:metadata,true))continue;throw Error('Memory snapshot: unclassified or foreign source prevents export');}
      if(!audiences.has(stamp.audience))continue;
      const clean={...metadata};delete clean.host_source_authority;delete clean.host_conflict_authority;delete clean.host_package_operation;
      const row:PortableMemoryRow={id:p.ids[i]!,text:p.documents[i] as string,metadata:withoutPortableSecrets(clean) as PortableMemoryRow['metadata'],embedding:this.vector(p.embeddings?.[i]),stamp:withoutPortableSecrets(stamp) as SourceStamp};
      bytes+=Buffer.byteLength(JSON.stringify(row))+1;if(bytes>MEMORY_SNAPSHOT_MAX_BYTES)throw Error('Memory snapshot: 16 MiB byte limit exceeded');
      (log?snapshot.conflicts:snapshot.chunks).push(row);
     }
     if(snapshot.chunks.length+snapshot.conflicts.length>10000)throw Error('Memory snapshot: 10000 row limit exceeded');
     if(offset+p.ids.length>10000)throw Error('Memory snapshot: inventory bound exceeded');
     if(p.ids.length<100)break;
    }
   }
   return validateMemorySnapshot(snapshot,this.raw.signature);
  });
 }
 /** Operator-only inventory. Foreign/unclassified rows fail closed, never become portable data. */
 async exportGlobalMemory(guard:()=>Promise<void>):Promise<PortableGlobalMemorySnapshotDto>{
  return this.raw.exclusive(()=>this.globalMemoryInventory(guard));
 }
 /** Caller holds raw.exclusive for the entire inventory/review/effect boundary; the queue is not reentrant. */
 private async globalMemoryInventory(guard:()=>Promise<void>):Promise<PortableGlobalMemorySnapshotDto>{
   this.assertScopeSettled('global');
   const snapshot:PortableGlobalMemorySnapshotDto={schema:'ponderosa.selected-global-memory.v1',signature:this.raw.signature,sourcePrincipal:this.principal,chunks:[],conflicts:[]};let bytes=0;
   for(const log of [false,true]){
    const c=await checkedCollection(this.raw,'global',log,guard);
    for(let offset=0;;offset+=100){
     await guard();const rows=await c.get({offset,limit:100,include:['documents','metadatas','embeddings'] as any});await guard();
     for(let i=0;i<rows.ids.length;i++){
      const m:any=rows.metadatas[i],stamp=this.parse(rows.ids[i]!,'global',log?{...m,host_source_authority:m?.host_conflict_authority}:m);
      if(!stamp)throw Error('Global memory transfer: foreign or unclassified record');
      const metadata={...m};delete metadata.host_source_authority;delete metadata.host_conflict_authority;delete metadata.host_package_operation;
      const row={id:rows.ids[i]!,text:rows.documents[i] as string,embedding:this.vector(rows.embeddings?.[i]),metadata:withoutPortableSecrets(metadata) as Record<string,string|number|boolean>,stamp:withoutPortableSecrets(stamp) as SourceStamp};
      bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>MEMORY_SNAPSHOT_MAX_BYTES||snapshot.chunks.length+snapshot.conflicts.length>=10000)throw Error('Global memory transfer: inventory bound exceeded');
      (log?snapshot.conflicts:snapshot.chunks).push(row);
     }
     if(rows.ids.length<100)break;
    }
   }
   snapshot.chunks.sort((a,b)=>a.id.localeCompare(b.id));snapshot.conflicts.sort((a,b)=>a.id.localeCompare(b.id));
   return validateGlobalMemory(snapshot,this.raw.signature);
 }
 /** Add parallel facts/conflicts only: no reconciliation, overwrites, grants or source authority. */
 async importGlobalMemory(value:unknown,reviewHash:string,guard:()=>Promise<void>){
  const snapshot=validateGlobalMemory(value,this.raw.signature);
  return this.raw.exclusive(async()=>{
   const destination=await this.globalMemoryInventory(guard);
   if(globalMemoryHash({snapshot,destination})!==reviewHash)throw Error('Global memory transfer: destination or selection changed; review again');
   const namespace=globalMemoryHash(snapshot),id=(kind:string,sourceId:string)=>globalMemoryHash([this.principal,'global-transfer',namespace,kind,sourceId]);
   const prepared=[snapshot.chunks,snapshot.conflicts].map((rows,index)=>rows.map(row=>{
    const metadata={...row.metadata},destinationId=id(index?'conflict':'chunk',row.id);
    if(metadata.supersedes)metadata.supersedes=id('chunk',String(metadata.supersedes));
    if(index){const refs=JSON.parse(String(metadata.chunk_ids_affected??metadata.chunk_ids)).map((ref:string)=>id('chunk',ref));metadata.chunk_ids=JSON.stringify(refs);metadata.chunk_ids_affected=JSON.stringify(refs);metadata.log_id=destinationId;metadata.chunks_affected=refs.length;}
    metadata.package_source_stamp=metadata.package_source_stamp??JSON.stringify(row.stamp);
    const stamp:SourceStamp={...row.stamp,principal:this.principal,id:destinationId,provenance:{actor:{kind:row.stamp.sourceType==='ai_inference'?'agent':'user',id:row.stamp.sourceType==='ai_inference'?'historical-global-import:'+this.principal:this.principal},runId:'global-transfer:'+namespace,fenceToken:'historical',at:row.stamp.provenance.at},origin:row.stamp.origin??row.stamp.provenance};
    metadata[index?'host_conflict_authority':'host_source_authority']=JSON.stringify(stamp);
    return {id:destinationId,text:row.text,metadata,embedding:row.embedding.map(Math.fround)};
   }));
   // Keep every partial prefix readable so a failed transfer can be re-reviewed without a repair path.
   const chunks=new Map(prepared[0]!.map(row=>[row.id,row])),depth=new Map<string,number>();
   for(const row of prepared[0]!){let current=row,level=0;while(current.metadata.supersedes){current=chunks.get(String(current.metadata.supersedes))!;level++;}depth.set(row.id,level);}
   prepared[0]!.sort((a,b)=>depth.get(a.id)!-depth.get(b.id)!||a.id.localeCompare(b.id));
   const pending:Array<{c:Awaited<ReturnType<typeof checkedCollection>>;row:typeof prepared[number][number]}>=[];
   for(const index of [0,1]){
    const c=await checkedCollection(this.raw,'global',Boolean(index),guard);
    for(const row of prepared[index]!){
     await guard();const existing=await c.get({ids:[row.id],include:['documents','metadatas','embeddings'] as any});await guard();
     if(existing.ids.length){if(existing.ids.length!==1||existing.ids[0]!==row.id||existing.documents[0]!==row.text||globalMemoryHash(existing.metadatas[0])!==globalMemoryHash(row.metadata)||globalMemoryHash(this.vector(existing.embeddings?.[0]).map(Math.fround))!==globalMemoryHash(row.embedding))throw Error('Global memory transfer: destination collision; existing record preserved');}
     else pending.push({c,row});
    }
   }
   // Same ordinary-memory contract: multiwrite failure may leave partial additions; re-review retries exact IDs.
   for(const {c,row}of pending){
    await guard();await c.add({ids:[row.id],documents:[row.text],metadatas:[row.metadata],embeddings:[row.embedding]});await guard();
    const actual=await c.get({ids:[row.id],include:['documents','metadatas','embeddings'] as any});await guard();
    if(actual.ids.length!==1||actual.ids[0]!==row.id||actual.documents[0]!==row.text||globalMemoryHash(actual.metadatas[0])!==globalMemoryHash(row.metadata)||globalMemoryHash(this.vector(actual.embeddings?.[0]).map(Math.fround))!==globalMemoryHash(row.embedding))throw Error('Global memory transfer: destination collision; existing record preserved');
    this.onMutation?.('global',row.id);
   }
   return {chunkIds:prepared[0]!.map(row=>row.id),conflictIds:prepared[1]!.map(row=>row.id),added:pending.length};
  });
 }
 /** Import only adds deterministic package-owned IDs; retries never overwrite another source. */
 async restorePackageMemory(value:unknown,chatId:string,agents:Readonly<Record<string,string>>,operationId:string,guard:()=>Promise<void>,packageOperationId?:string){
  const snapshot=validateMemorySnapshot(value,this.raw.signature),source=structuredClone(snapshot);
  if(!operationId||operationId.length>128||!chatId||Object.keys(agents).length!==source.agentIds.length||source.agentIds.some(id=>typeof agents[id]!=='string'||!agents[id])||new Set(Object.values(agents)).size!==source.agentIds.length)throw Error('Memory snapshot: exact destination Agent mapping required');
  const scope='chat:'+chatId;
  const id=(kind:string,sourceId:string)=>createHash('sha256').update(JSON.stringify([this.principal,chatId,operationId,source.sourceChatId,kind,sourceId])).digest('hex');
  const prepared=([false,true] as const).map(log=>(log?source.conflicts:source.chunks).map(row=>{
   const destinationId=id(log?'conflict':'chunk',row.id),privateAgent=source.agentIds.find(a=>row.stamp.audience==='chat:'+source.sourceChatId+':agent:'+a);
   const metadata={...row.metadata};if(packageOperationId)metadata.host_package_operation=packageOperationId;
   if(metadata.supersedes)metadata.supersedes=id('chunk',String(metadata.supersedes));
   if(log){const refs=JSON.parse(String(metadata.chunk_ids_affected??metadata.chunk_ids)).map((ref:string)=>id('chunk',ref));metadata.chunk_ids=JSON.stringify(refs);metadata.chunk_ids_affected=JSON.stringify(refs);metadata.log_id=destinationId;metadata.chunks_affected=refs.length;}
   // Original source identities remain inert provenance, never destination Run capabilities.
   metadata.package_source_stamp=metadata.package_source_stamp??JSON.stringify(row.stamp);
   const stamp:SourceStamp={format:1,principal:this.principal,id:destinationId,scope,ownerChat:chatId,audience:privateAgent?scope+':agent:'+agents[privateAgent]:scope+':team',sourceType:row.stamp.sourceType,provenance:{actor:{kind:'user',id:this.principal},runId:'package-import:'+operationId,fenceToken:'historical',at:row.stamp.provenance.at},origin:row.stamp.origin??row.stamp.provenance};
   metadata[log?'host_conflict_authority':'host_source_authority']=JSON.stringify(stamp);
   return {id:destinationId,text:row.text,metadata,embedding:row.embedding.map(Math.fround)};
  }));
  return this.raw.exclusive(async()=>{
   this.assertScopeSettled(scope);
   const collections=await Promise.all([false,true].map(log=>checkedCollection(this.raw,scope,log,guard))),pending:Array<{c:typeof collections[number];row:typeof prepared[number][number]}>=[];
   for(let index=0;index<2;index++)for(const row of prepared[index]!){
    const c=collections[index]!;await guard();const existing=await c.get({ids:[row.id],include:['documents','metadatas','embeddings'] as any});await guard();
    // Compare stored float32 values; Chroma's JSON decimals need not equal JS float32 doubles.
    if(existing.ids.length){const sorted=(v:any)=>JSON.stringify(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)));if(existing.ids.length!==1||existing.documents[0]!==row.text||sorted(existing.metadatas[0])!==sorted(row.metadata)||JSON.stringify(this.vector(existing.embeddings?.[0]).map(Math.fround))!==JSON.stringify(row.embedding))throw Error('Memory snapshot: destination ID collision; existing data preserved');}
    else pending.push({c,row});
   }
   const attempted:typeof pending=[];
   try{for(const item of pending){
    await guard();attempted.push(item);await item.c.add({ids:[item.row.id],documents:[item.row.text],metadatas:[item.row.metadata],embeddings:[item.row.embedding]});await guard();
    const actual=await item.c.get({ids:[item.row.id],include:['documents','metadatas','embeddings'] as any});await guard();
    const sorted=(v:any)=>JSON.stringify(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)));
    if(actual.ids.length!==1||actual.ids[0]!==item.row.id||actual.documents[0]!==item.row.text||sorted(actual.metadatas[0])!==sorted(item.row.metadata)||JSON.stringify(this.vector(actual.embeddings?.[0]).map(Math.fround))!==JSON.stringify(item.row.embedding))throw Error('Memory snapshot: destination ID collision; existing data preserved');
   }}
   catch(error){
    if(!attempted.length)throw error;
    // The queue is already held here. Only compensate a staged operation when
    // every dispatched write is settled and its source ownership remains live.
    // A rejected/lost remote write retains its mutation hold and is never replayed.
    if(!packageOperationId)throw new AggregateError([error],this.scopeHasUnsettledMutation(scope)?MEMORY_CLEANUP_UNKNOWN_HOLD:MEMORY_CLEANUP_HOLD);
    try {
     await this.rollbackPackageMemoryLocked({
      chatId,namespace:operationId,
      chunkIds:attempted.filter(item=>item.c===collections[0]).map(item=>item.row.id),
      conflictIds:attempted.filter(item=>item.c===collections[1]).map(item=>item.row.id),
     },packageOperationId,guard);
    } catch(cleanup) {throw new AggregateError([error,cleanup],isMemoryCleanupHold(cleanup)&&cleanup instanceof Error?cleanup.message:MEMORY_CLEANUP_HOLD);}
    throw error;
   }
   return {chunkIds:prepared[0]!.map(r=>r.id),conflictIds:prepared[1]!.map(r=>r.id),excludedScopes:source.excludedScopes};
  });
 }
 packageMemoryIds(value:unknown,chatId:string,namespace:string){
  const snapshot=validateMemorySnapshot(value,this.raw.signature);
  const id=(kind:string,sourceId:string)=>createHash('sha256').update(JSON.stringify([this.principal,chatId,namespace,snapshot.sourceChatId,kind,sourceId])).digest('hex');
  return {chatId,chunkIds:snapshot.chunks.map(r=>id('chunk',r.id)),conflictIds:snapshot.conflicts.map(r=>id('conflict',r.id))};
 }
 /** Caller owns raw.exclusive; the package plan predates any remote writes.
  * Staged rows are invisible to ordinary memory callers until publication. */
 private async rollbackPackageMemoryLocked(plan:{chatId:string;namespace?:string;chunkIds:string[];conflictIds:string[]},operationId:string,guard:()=>Promise<void>){
  await guard();
  if(!plan.chatId||!operationId||!Array.isArray(plan.chunkIds)||!Array.isArray(plan.conflictIds))throw Error(MEMORY_CLEANUP_HOLD);
  if(!plan.chunkIds.length&&!plan.conflictIds.length)return;
  if(typeof plan.namespace!=='string'||!plan.namespace.startsWith(operationId+':m:')||
     !/^(0|[1-9][0-9]*)$/.test(plan.namespace.slice((operationId+':m:').length))||
     [...plan.chunkIds,...plan.conflictIds].some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||
     new Set(plan.chunkIds).size!==plan.chunkIds.length||new Set(plan.conflictIds).size!==plan.conflictIds.length||
     plan.chunkIds.length+plan.conflictIds.length>10000||typeof this.packageVisible!=='function'||this.packageVisible(operationId))throw Error(MEMORY_CLEANUP_HOLD);
  const scope='chat:'+plan.chatId;
  if(this.scopeHasUnsettledMutation(scope))throw Error(MEMORY_CLEANUP_UNKNOWN_HOLD);
  const owned:Array<{c:Awaited<ReturnType<typeof checkedCollection>>;id:string;log:boolean}>=[];
  for(const [log,ids] of [[false,plan.chunkIds],[true,plan.conflictIds]] as const){
   if(!ids.length)continue;
   const c=await checkedCollection(this.raw,scope,log,guard);
   for(let offset=0;offset<ids.length;offset+=500){
    const requested=ids.slice(offset,offset+500);
    await guard();const found=await c.get({ids:requested,include:['metadatas'] as any});await guard();
    if(found.ids.length!==found.metadatas.length||new Set(found.ids).size!==found.ids.length||found.ids.some(id=>!requested.includes(id)))throw Error(MEMORY_CLEANUP_HOLD);
    for(let i=0;i<found.ids.length;i++){
     const id=found.ids[i]!,metadata:any=found.metadatas[i];
     // Another owner's row at the deterministic ID is not ours to remove.
     if(metadata?.host_package_operation!==operationId)continue;
     const stamp=this.parse(id,scope,log?{...metadata,host_source_authority:metadata?.host_conflict_authority}:metadata,true);
     if(!stamp||stamp.ownerChat!==plan.chatId||stamp.provenance.actor.kind!=='user'||
        stamp.provenance.actor.id!==this.principal||stamp.provenance.runId!=='package-import:'+plan.namespace||
        stamp.provenance.fenceToken!=='historical')throw Error(MEMORY_CLEANUP_HOLD);
     owned.push({c,id,log});
    }
   }
  }
  // The shared queue excludes concurrent Ponderosa writers between the
  // ownership inventory and the journaled, bounded deletes.
  for(const item of owned){
   await guard();
   if(this.scopeHasUnsettledMutation(scope))throw Error(MEMORY_CLEANUP_UNKNOWN_HOLD);
   if(!item.log)this.onMutation?.(scope,item.id);
   try{await item.c.delete({ids:[item.id]});}
   catch(error){if(this.scopeHasUnsettledMutation(scope))throw new AggregateError([error],MEMORY_CLEANUP_UNKNOWN_HOLD);throw error;}
   await guard();const remaining=await item.c.get({ids:[item.id],include:['metadatas'] as any});await guard();
   if(remaining.ids.length)throw Error(MEMORY_CLEANUP_HOLD);
  }
 }
 async rollbackPackageMemory(plan:{chatId:string;namespace?:string;chunkIds:string[];conflictIds:string[]},operationId:string,guard:()=>Promise<void>){
  return this.raw.exclusive(()=>this.rollbackPackageMemoryLocked(plan,operationId,guard));
 }
 /** Retire only the exact owned Chat scope, serialized with all memory calls
  * through this host. Any prior uncertain remote mutation remains held. */
 async purge(scope:string,guard:()=>Promise<void>,agentId?:string){
  await guard();if(!scope.startsWith('chat:')||!scope.slice(5))throw denied();
  return this.raw.exclusive(async()=>{
   await guard();this.assertScopeSettled(scope);
   const chatId=scope.slice(5),names=this.raw.names(scope),boundary=this.mutationBoundary();
   if(names.memory===names.log)throw Error('Memory collection bindings overlap; cleanup held');
   const identity=(log:boolean)=>({principal:this.principal,origin:new URL(this.raw.options.url).origin,scope,log,name:names[log?'log':'memory']});
   // Validate both collections and the full inventory before dispatching any
   // delete. A foreign or unclassified row is never treated as owned data.
   const collections=await Promise.all([false,true].map(async log=>{
    const prior=boundary.readCollectionDeletion(identity(log));
    if(prior){
     await guard();
     try{await this.raw.client.getCollection({name:names[log?'log':'memory'],embeddingFunction:noGeneration});}
     catch(error){if(error instanceof Error&&error.name==='ChromaNotFoundError')return {log,removed:true as const};throw error;}
     throw Error('Previously deleted memory collection exists again; cleanup held');
    }
    const collection=await checkedCollection(this.raw,scope,log,guard);
    await guard();const count=await collection.count();await guard();
    if(!Number.isSafeInteger(count)||count<0)throw Error('Memory cleanup inventory is unavailable');
    const seen=new Set<string>(),selected:string[]=[],rows=new Map<string,{audience:string;metadata:any}>();
    for(let offset=0;offset<count;offset+=500){
     await guard();const page=await collection.get({offset,limit:Math.min(500,count-offset),include:['metadatas'] as any});await guard();
     if(page.ids.length!==page.metadatas.length||!page.ids.length)throw Error('Memory cleanup inventory changed');
     for(let i=0;i<page.ids.length;i++){
      const id=page.ids[i]!,metadata:any=page.metadatas[i];
      if(seen.has(id))throw Error('Memory cleanup inventory changed');seen.add(id);
      const stamp=this.parse(id,scope,log?{...metadata,host_source_authority:metadata?.host_conflict_authority}:metadata,true);
      if(!stamp||stamp.ownerChat!==chatId||!(stamp.audience===scope+':team'||stamp.audience.startsWith(scope+':agent:')&&stamp.audience.length>(scope+':agent:').length))
       throw Error('Foreign or unclassified memory preserved; cleanup held');
      rows.set(id,{audience:stamp.audience,metadata});
      if(!agentId||stamp.audience===scope+':agent:'+agentId)selected.push(id);
     }
    }
    await guard();if(seen.size!==count||await collection.count()!==count)throw Error('Memory cleanup inventory changed');
    return {log,removed:false as const,collection,id:collection.id,selected,rows};
   }));
   if(agentId){
    const memory=collections.find(entry=>!entry.log)!,conflicts=collections.find(entry=>entry.log)!;
    if(!conflicts.removed)for(const id of conflicts.selected){
     const row=conflicts.rows.get(id)!;let affected:unknown;
     try{affected=JSON.parse(row.metadata?.chunk_ids_affected??row.metadata?.chunk_ids);}catch{throw Error('Unclassified memory conflict preserved; cleanup held');}
     if(!Array.isArray(affected)||!affected.length||affected.some(source=>typeof source!=='string'||memory.removed||memory.rows.get(source)?.audience!==row.audience))
      throw Error('Foreign or unclassified memory conflict preserved; cleanup held');
    }
   }
   // Retire conflict records before their source rows so a partial success
   // leaves a re-checkable inventory.
   for(const entry of agentId?[...collections].reverse():collections){
    if(entry.removed)continue;
    await guard();this.assertScopeSettled(scope);
    const current=await checkedCollection(this.raw,scope,entry.log,guard);
    if(current.id!==entry.id)throw Error('Memory collection identity changed; cleanup held');
    if(agentId){
     for(let offset=0;offset<entry.selected.length;offset+=500){
      await guard();const ids=entry.selected.slice(offset,offset+500);
      if(!entry.log)for(const id of ids)this.onMutation?.(scope,id);
      await current.delete({ids});await guard();
     }
    }else{
     if(!entry.log)for(const id of entry.selected)this.onMutation?.(scope,id);
     await mutate(this.raw,()=>this.raw.client.deleteCollection({name:names[entry.log?'log':'memory']}),{scope,log:entry.log,operation:'delete_collection'},()=>boundary.recordCollectionDeletion(identity(entry.log),entry.id));
     await guard();
    }
   }
  }).catch(error=>{
   // Keep the original error as a cause while using the existing stable hold
   // classification so periodic cleanup does not repeatedly retry uncertainty.
   if(this.scopeHasUnsettledMutation(scope))throw new AggregateError([error],MEMORY_CLEANUP_UNKNOWN_HOLD);
   throw error;
  });
 }
 async clear(_scope:string){throw Error('Host-wide replacement/backup restore is unavailable');}
 readIndex(_key:string):never{throw Error('Host semantic index is unavailable');}writeIndex(_key:string,_value:unknown):never{throw Error('Host semantic index is unavailable');}
 async close(){await this.raw.close();}
}
/** Uses the public runtime/storage extension surface; no sealed-core mutation. */
export class HostMemoryRuntime extends MemoryRuntime{
 declare readonly database:AuthorityStorage;
 constructor(options:ConstructorParameters<typeof MemoryRuntime>[0],principal:string|((signature:string)=>string),mutationDirectory?:string){super(options);const raw=this.database as unknown as ChromaStorage;this.database=new AuthorityStorage(raw,typeof principal==='function'?principal(this.inference.signature):principal,this.inference,mutationDirectory);}
}
