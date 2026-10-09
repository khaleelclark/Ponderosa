import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {AgentStore,CoordinationV3Store,CapabilityPolicyStore,BranchStore} from '@ponderosa/agents';
import {createServer} from '../dist/app.js';
export const helper='agents.create_managed';
export async function fixture(t,{restricted=false,pinecone=false,branch=false,authToken,maxConcurrentRuns=1}={}) {
 const dir=await mkdtemp(join(tmpdir(),'managed-helper-policy-')),store=new AgentStore(dir);
 const p=store.createProject({label:'Canonical inert fixture',hostPath:dir,defaultEngine:'codex'});
 const chat=store.getConversation(p.lastConversationId);
 const coordination=new CoordinationV3Store(store.sqlite),policies=new CapabilityPolicyStore(store.sqlite);
 if(branch){const b=new BranchStore(store.sqlite,coordination).create('Fixture branch','helper-fixture');store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(b.id,chat.id);chat.branchId=b.id;}
 let captured,release,entered,starts=0,abortEffect=()=>{},stopResponseEffect=()=>{};
 const waiters=new Map();
 const nextAdmission=agentId=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(agentId);reject(Error('inert admission timed out'));},10000);waiters.set(agentId,options=>{clearTimeout(timer);resolve(options);});});
 const parked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const run=async function*(options){starts++;captured=options;entered(options);waiters.get(options.agentId)?.(options);waiters.delete(options.agentId);options.signal?.addEventListener('abort',()=>abortEffect(options.agentId),{once:true});await Promise.race([starts===1?parked:new Promise(()=>{}),new Promise(r=>options.signal?.addEventListener('abort',r,{once:true}))]);yield {type:'turn_done'};};
 const adapter={id:'codex',displayName:'Inert subscription Adapter',trustedSystemPromptChannel:'developer',listModels:()=>[],listEfforts:()=>[],seed:run,continue:run};
 const app=createServer({dataDir:dir,store,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,authToken,communicationV3:{pollMs:10,maxConcurrentRuns}});
 app.addHook('preSerialization',async(request,_reply,payload)=>{
  if(request.routeOptions.url==='/api/agents/:id/cancel')await stopResponseEffect(request.params.id);
  return payload;
 });
 await app.ready();
 t.after(async()=>{release();app.prepareForShutdown();await app.close();store.close();await rm(dir,{recursive:true,force:true});});
 const operatorHeaders=authToken?{authorization:`Bearer ${authToken}`}:{},prefix=branch?'/api/branches/engine':'/api';
 const create=await app.inject({method:'POST',url:`${prefix}/projects/${p.id}/agents`,headers:operatorHeaders,payload:{title:'Fixture owner',engine:'codex',conversationId:chat.id,idempotencyKey:'owner',...(pinecone?{experience:'pinecone'}:{})}});
 assert.equal(create.statusCode,200,create.body);const owner=create.json();
 if(restricted&&!pinecone)policies.put({scopeKind:'agent',scopeId:owner.id,expectedRevision:0,restrictedCapabilityIds:[helper]});
 const sent=await app.inject({method:'POST',url:`${prefix}/agents/${owner.id}/messages`,headers:operatorHeaders,payload:{text:'Canonical private inert fixture task',idempotencyKey:'parent',activeRunDelivery:'queue'}});assert.ok(sent.statusCode<300,sent.body);
 let timer;try{await Promise.race([started,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('canonical parent admission timed out')),10000))]);}finally{clearTimeout(timer);}
 const token=captured.environment.PONDEROSA_AGENT_MESSAGE_TOKEN,headers={authorization:`Bearer ${token}`};
 const spawn=(key='child',extra={})=>app.inject({method:'POST',url:'/api/agent-spawn',headers,payload:{idempotencyKey:key,title:'Fixture child',engine:'codex',text:'Bounded inert assignment',lifetime:{kind:'indefinite'},...extra}});
 const manage=payload=>app.inject({method:'POST',url:'/api/agent-management',headers,payload});
 const runRow=()=>store.sqlite.prepare("SELECT * FROM scheduler_runs WHERE agent_id=? AND status='running'").get(owner.id);
 return {dir,store,p,chat,app,owner,coordination,policies,headers,token,spawn,manage,runRow,release,starts:()=>starts,tools:JSON.parse(captured.environment.PONDEROSA_AGENT_TOOL_NAMES),operatorHeaders,nextAdmission,setAbortEffect:fn=>abortEffect=fn,setStopResponseEffect:fn=>stopResponseEffect=fn};
}
export async function counters(f){
 const tables=['agents','pinecone_profiles','agent_handle_reservations','agent_creation_operations','agent_creation_operation_members','coordination_requests','coordination_joins','runtime_communications','runtime_communication_activation_intake','agent_activations','activation_outbox','scheduler_runs','agent_management_plans','agent_management_approvals'];
 const state={};for(const table of tables)state[table]=f.store.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>{
  if(table==='activation_outbox'){const {attempts,processed_at,claimed_at,claimed_by,available_at,last_error,...intake}=row;return intake;}
  if(table==='scheduler_runs'){const {heartbeat_at,lease_expires_at,updated_at,...authority}=row;return authority;}return row;
 });
 const files={};async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())await walk(path);else if(!path.endsWith('ponderosa.db')&&!path.endsWith('ponderosa.db-wal')&&!path.endsWith('ponderosa.db-shm'))files[relative(f.dir,path)]=createHash('sha256').update(await readFile(path)).digest('hex');}}
 await walk(f.dir);state.files=files;return state;
}
export async function inertDenied(f,action,status,{cancellation=false}={}){
 const before=await counters(f);const r=await action();assert.equal(r.statusCode,status,r.body);const after=await counters(f);
 if(cancellation){for(const key of Object.keys(before).filter(k=>k!=='files'))assert.equal(after[key].length,before[key].length,key);}else assert.deepEqual(after,before);
 console.log(JSON.stringify({deniedStatus:status,cancellationBoundary:cancellation,countsBefore:Object.fromEntries(Object.entries(before).filter(([k])=>k!=='files').map(([k,v])=>[k,v.length])),countsAfter:Object.fromEntries(Object.entries(after).filter(([k])=>k!=='files').map(([k,v])=>[k,v.length])),ownedFilesBefore:Object.keys(before.files).length,ownedFilesAfter:Object.keys(after.files).length}));return r;
}
